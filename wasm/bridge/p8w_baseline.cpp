#include "p8w_baseline.h"

#include <climits>
#include <cstdlib>
#include <cstring>
#include <new>

#include <emscripten/emscripten.h>

#include "lauxlib.h"
#include "lua.h"
#include "lualib.h"
#include "p8w_pico_memory.h"

namespace {

constexpr uint32_t kPhase0AAbiVersion = 0x00010000;
constexpr uint32_t kPhase0BAbiVersion = 0x00020000;
constexpr uint32_t kMaxContexts = 64;
constexpr uint32_t kHandleIndexBits = 8;
constexpr uint32_t kHandleIndexMask = (1u << kHandleIndexBits) - 1u;
constexpr uint32_t kMaxErrorLength = 1023;
constexpr char kContextRegistryKey[] = "__p8w_baseline_context";
constexpr char kBudgetError[] = "__p8w_instruction_budget_exceeded__";
constexpr char kOutOfMemoryError[] = "__p8w_out_of_memory__";
constexpr uint32_t kDefaultLuaHeapLimit = 1024u * 1024u;
constexpr uint32_t kMinimumLuaHeapLimit = 32u * 1024u;

struct AllocationStats {
  uint32_t live_bytes = 0;
  uint32_t limit_bytes = UINT32_MAX;
  uint32_t *aggregate_live_bytes = nullptr;
  bool denied = false;
};

struct Context {
  lua_State *state = nullptr;
  AllocationStats allocations;
  alignas(16) uint8_t ram[p8w::kPicoRamSize] = {};
  uint32_t result_count = 0;
  uint32_t remaining_budget = 0;
  uint32_t last_error_length = 0;
  bool host_oom = false;
  bool phase0b = false;
  char last_error[kMaxErrorLength + 1] = {};
};

struct ContextSlot {
  Context *context = nullptr;
  uint32_t generation = 0;
};

ContextSlot g_slots[kMaxContexts];
uint32_t g_live_phase0a_contexts = 0;
uint32_t g_live_phase0b_contexts = 0;
uint32_t g_live_phase0a_lua_bytes = 0;
uint32_t g_live_phase0b_lua_bytes = 0;

void update_allocation_counters(AllocationStats *stats, size_t old_size,
                                size_t new_size) {
  if (new_size >= old_size) {
    const auto increase = static_cast<uint32_t>(new_size - old_size);
    stats->live_bytes += increase;
    *stats->aggregate_live_bytes += increase;
  } else {
    const auto decrease = static_cast<uint32_t>(old_size - new_size);
    stats->live_bytes -= decrease;
    *stats->aggregate_live_bytes -= decrease;
  }
}

void *tracked_lua_allocator(void *user_data, void *pointer, size_t old_size,
                            size_t new_size) {
  auto *stats = static_cast<AllocationStats *>(user_data);
  const size_t accounted_old_size = pointer == nullptr ? 0 : old_size;

  if (new_size == 0) {
    std::free(pointer);
    update_allocation_counters(stats, accounted_old_size, 0);
    return nullptr;
  }

  if (new_size > accounted_old_size) {
    const size_t increase = new_size - accounted_old_size;
    if (stats->live_bytes >= stats->limit_bytes ||
        increase > stats->limit_bytes - stats->live_bytes) {
      stats->denied = true;
      return nullptr;
    }
  }

  void *replacement = std::realloc(pointer, new_size);
  if (replacement != nullptr) {
    update_allocation_counters(stats, accounted_old_size, new_size);
  } else {
    stats->denied = true;
  }
  return replacement;
}

Context *context_from_handle(uint32_t handle) {
  const uint32_t encoded_index = handle & kHandleIndexMask;
  if (encoded_index == 0 || encoded_index > kMaxContexts) {
    return nullptr;
  }

  const auto &slot = g_slots[encoded_index - 1];
  const uint32_t generation = handle >> kHandleIndexBits;
  if (slot.context == nullptr || slot.generation != generation) {
    return nullptr;
  }
  return slot.context;
}

Context *phase0b_context_from_handle(uint32_t handle) {
  Context *context = context_from_handle(handle);
  return context != nullptr && context->phase0b ? context : nullptr;
}

Context *phase0a_context_from_handle(uint32_t handle) {
  Context *context = context_from_handle(handle);
  return context != nullptr && !context->phase0b ? context : nullptr;
}

uint32_t make_handle(uint32_t slot_index) {
  auto &slot = g_slots[slot_index];
  slot.generation = (slot.generation + 1u) & 0x00ffffffu;
  if (slot.generation == 0) {
    slot.generation = 1;
  }
  return (slot.generation << kHandleIndexBits) | (slot_index + 1u);
}

void clear_error(Context *context) {
  context->last_error[0] = '\0';
  context->last_error_length = 0;
}

void set_error(Context *context, const char *message, size_t message_length) {
  const size_t copy_length =
      message_length < kMaxErrorLength ? message_length : kMaxErrorLength;
  if (message != nullptr && copy_length != 0) {
    std::memcpy(context->last_error, message, copy_length);
  }
  context->last_error[copy_length] = '\0';
  context->last_error_length = static_cast<uint32_t>(copy_length);
}

void copy_lua_error(Context *context) {
  size_t length = 0;
  const char *message = lua_tolstring(context->state, -1, &length);
  if (message == nullptr) {
    constexpr char kFallback[] = "unknown z8lua error";
    set_error(context, kFallback, sizeof(kFallback) - 1);
  } else {
    set_error(context, message, length);
  }
  lua_settop(context->state, 0);
}

void remove_global(lua_State *state, const char *name) {
  lua_pushnil(state);
  lua_setglobal(state, name);
}

int baseline_print(lua_State *) { return 0; }

Context *context_from_lua(lua_State *state);

uint32_t logical_address(lua_State *state, int index) {
  return p8w::normalize_address(
      static_cast<int32_t>(luaL_checknumber(state, index)));
}

uint32_t integer_value(lua_State *state, int index) {
  return static_cast<uint32_t>(
      static_cast<int32_t>(luaL_checknumber(state, index)));
}

int memory_peek(lua_State *state) {
  Context *context = context_from_lua(state);
  lua_pushinteger(state, p8w::read8(context->ram, logical_address(state, 1)));
  return 1;
}

int memory_peek2(lua_State *state) {
  Context *context = context_from_lua(state);
  const uint32_t raw =
      static_cast<uint32_t>(p8w::read16(context->ram, logical_address(state, 1)))
      << 16u;
  lua_pushnumber(state, lua_Number::frombits(static_cast<int32_t>(raw)));
  return 1;
}

int memory_peek4(lua_State *state) {
  Context *context = context_from_lua(state);
  lua_pushnumber(state, lua_Number::frombits(static_cast<int32_t>(
                            p8w::read32(context->ram,
                                        logical_address(state, 1)))));
  return 1;
}

int memory_poke(lua_State *state) {
  Context *context = context_from_lua(state);
  p8w::write8(context->ram, logical_address(state, 1),
              static_cast<uint8_t>(integer_value(state, 2)));
  return 0;
}

int memory_poke2(lua_State *state) {
  Context *context = context_from_lua(state);
  p8w::write16(context->ram, logical_address(state, 1),
               static_cast<uint16_t>(integer_value(state, 2)));
  return 0;
}

int memory_poke4(lua_State *state) {
  Context *context = context_from_lua(state);
  p8w::write32(context->ram, logical_address(state, 1),
               static_cast<uint32_t>(luaL_checknumber(state, 2).bits()));
  return 0;
}

int memory_memcpy(lua_State *state) {
  Context *context = context_from_lua(state);
  const uint32_t destination = logical_address(state, 1);
  const uint32_t source = logical_address(state, 2);
  const int32_t signed_length =
      static_cast<int32_t>(luaL_checknumber(state, 3));
  if (signed_length <= 0) {
    return 0;
  }

  const uint32_t length = static_cast<uint32_t>(signed_length);
  auto *snapshot = static_cast<uint8_t *>(std::malloc(length));
  if (snapshot == nullptr) {
    context->host_oom = true;
    return luaL_error(state, "%s", kOutOfMemoryError);
  }
  for (uint32_t index = 0; index < length; ++index) {
    snapshot[index] = p8w::read8(context->ram, source + index);
  }
  for (uint32_t index = 0; index < length; ++index) {
    p8w::write8(context->ram, destination + index, snapshot[index]);
  }
  std::free(snapshot);
  return 0;
}

void register_phase0b_memory_api(lua_State *state) {
  const struct {
    const char *name;
    lua_CFunction function;
  } functions[] = {
      {"peek", memory_peek},   {"peek2", memory_peek2},
      {"peek4", memory_peek4}, {"poke", memory_poke},
      {"poke2", memory_poke2}, {"poke4", memory_poke4},
      {"memcpy", memory_memcpy},
  };
  for (const auto &entry : functions) {
    lua_pushcfunction(state, entry.function);
    lua_setglobal(state, entry.name);
  }
}

void reset_phase0b_ram(Context *context) {
  std::memset(context->ram, 0, sizeof(context->ram));
  context->ram[p8w::kGfxMapRegister] = 0x00u;
  context->ram[p8w::kScreenMapRegister] = 0x60u;
}

void open_guest_libraries(lua_State *state) {
  luaL_requiref(state, "_G", luaopen_base, 1);
  lua_pop(state, 1);
  luaL_requiref(state, "_G", luaopen_pico8, 1);
  lua_pop(state, 1);
  luaL_requiref(state, LUA_COLIBNAME, luaopen_coroutine, 1);
  lua_pop(state, 1);
  luaL_requiref(state, LUA_TABLIBNAME, luaopen_table, 1);
  lua_pop(state, 1);
  luaL_requiref(state, LUA_STRLIBNAME, luaopen_string, 1);
  lua_pop(state, 1);

  remove_global(state, "collectgarbage");
  remove_global(state, "dofile");
  remove_global(state, "load");
  remove_global(state, "loadfile");
  remove_global(state, "loadstring");
  remove_global(state, "require");
  remove_global(state, "debug");
  remove_global(state, "eris");
  remove_global(state, "io");
  remove_global(state, "os");
  remove_global(state, "package");

  // Phase 0A has no graphics host API. Keep P8 `?` shorthand executable
  // without exposing Lua's stdout-oriented implementation.
  lua_pushcfunction(state, baseline_print);
  lua_setglobal(state, "print");
}

Context *context_from_lua(lua_State *state) {
  lua_getfield(state, LUA_REGISTRYINDEX, kContextRegistryKey);
  auto *context = static_cast<Context *>(lua_touserdata(state, -1));
  lua_pop(state, 1);
  return context;
}

void instruction_hook(lua_State *state, lua_Debug *) {
  Context *context = context_from_lua(state);
  if (context == nullptr || context->remaining_budget <= 1) {
    if (context != nullptr) {
      context->remaining_budget = 0;
    }
    luaL_error(state, "%s", kBudgetError);
    return;
  }
  --context->remaining_budget;
}

uint32_t create_context(uint32_t lua_heap_limit, bool bind_phase0b_ram) {
  uint32_t slot_index = kMaxContexts;
  for (uint32_t index = 0; index < kMaxContexts; ++index) {
    if (g_slots[index].context == nullptr) {
      slot_index = index;
      break;
    }
  }
  if (slot_index == kMaxContexts) {
    return 0;
  }

  auto *context = new (std::nothrow) Context();
  if (context == nullptr) {
    return 0;
  }
  context->allocations.limit_bytes = lua_heap_limit;
  context->allocations.aggregate_live_bytes =
      bind_phase0b_ram ? &g_live_phase0b_lua_bytes : &g_live_phase0a_lua_bytes;
  context->phase0b = bind_phase0b_ram;
  context->state =
      lua_newstate(tracked_lua_allocator, &context->allocations);
  if (context->state == nullptr) {
    delete context;
    return 0;
  }

  lua_pushlightuserdata(context->state, context);
  lua_setfield(context->state, LUA_REGISTRYINDEX, kContextRegistryKey);
  if (bind_phase0b_ram) {
    reset_phase0b_ram(context);
  }
  open_guest_libraries(context->state);
  if (bind_phase0b_ram) {
    register_phase0b_memory_api(context->state);
    lua_setpico8memory(context->state, context->ram);
  }

  const uint32_t handle = make_handle(slot_index);
  g_slots[slot_index].context = context;
  if (bind_phase0b_ram) {
    ++g_live_phase0b_contexts;
  } else {
    ++g_live_phase0a_contexts;
  }
  return handle;
}

uint32_t destroy_context(uint32_t handle, Context *context) {
  const uint32_t slot_index = (handle & kHandleIndexMask) - 1u;
  const bool phase0b = context->phase0b;
  lua_close(context->state);
  context->state = nullptr;
  delete context;
  g_slots[slot_index].context = nullptr;
  if (phase0b) {
    --g_live_phase0b_contexts;
  } else {
    --g_live_phase0a_contexts;
  }
  return P8W_OK;
}

uint32_t run_context(Context *context, const char *source,
                     uint32_t source_length, uint32_t instruction_budget,
                     const char *fixture_name) {
  lua_State *state = context->state;
  lua_settop(state, 0);
  context->result_count = 0;
  context->remaining_budget = 0;
  context->allocations.denied = false;
  context->host_oom = false;
  clear_error(context);
  if ((source == nullptr && source_length != 0) || instruction_budget == 0) {
    constexpr char kBadArgument[] = "invalid source buffer or instruction budget";
    set_error(context, kBadArgument, sizeof(kBadArgument) - 1);
    return P8W_BAD_ARGUMENT;
  }

  context->remaining_budget = instruction_budget;
  const char *safe_source = source == nullptr ? "" : source;
  int status =
      luaL_loadbufferx(state, safe_source, source_length, fixture_name, "t");
  if (status != LUA_OK) {
    copy_lua_error(context);
    return status == LUA_ERRMEM || context->allocations.denied
               ? P8W_OUT_OF_MEMORY
               : P8W_LOAD_ERROR;
  }

  lua_sethook(state, instruction_hook, LUA_MASKCOUNT, 1);
  status = lua_pcall(state, 0, LUA_MULTRET, 0);
  lua_sethook(state, nullptr, 0, 0);
  if (status != LUA_OK) {
    copy_lua_error(context);
    if (status == LUA_ERRMEM || context->allocations.denied ||
        context->host_oom) {
      return P8W_OUT_OF_MEMORY;
    }
    if (std::strstr(context->last_error, kBudgetError) != nullptr) {
      return P8W_BUDGET_EXCEEDED;
    }
    return P8W_RUNTIME_ERROR;
  }

  if (context->allocations.denied || context->host_oom) {
    lua_settop(state, 0);
    set_error(context, kOutOfMemoryError, sizeof(kOutOfMemoryError) - 1);
    return P8W_OUT_OF_MEMORY;
  }
  context->result_count = static_cast<uint32_t>(lua_gettop(state));
  return P8W_OK;
}

bool result_index_is_valid(Context *context, uint32_t result_index) {
  return context != nullptr && result_index < context->result_count;
}

int lua_result_index(uint32_t result_index) {
  return static_cast<int>(result_index + 1u);
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE uint32_t p8w0a_abi_version(void) {
  return kPhase0AAbiVersion;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0a_create(void) {
  return create_context(UINT32_MAX, false);
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0a_destroy(uint32_t handle) {
  Context *context = phase0a_context_from_handle(handle);
  if (context == nullptr) {
    return P8W_INVALID_HANDLE;
  }
  return destroy_context(handle, context);
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0a_run(uint32_t handle, const char *source,
                                       uint32_t source_length,
                                       uint32_t instruction_budget) {
  Context *context = phase0a_context_from_handle(handle);
  if (context == nullptr) {
    return P8W_INVALID_HANDLE;
  }
  return run_context(context, source, source_length, instruction_budget,
                     "@phase-0a-fixture.p8");
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0a_result_count(uint32_t handle) {
  Context *context = phase0a_context_from_handle(handle);
  return context == nullptr ? 0 : context->result_count;
}

EMSCRIPTEN_KEEPALIVE int32_t p8w0a_result_type(uint32_t handle,
                                              uint32_t result_index) {
  Context *context = phase0a_context_from_handle(handle);
  if (!result_index_is_valid(context, result_index)) {
    return LUA_TNONE;
  }
  return lua_type(context->state, lua_result_index(result_index));
}

EMSCRIPTEN_KEEPALIVE int32_t p8w0a_result_number_bits(uint32_t handle,
                                                     uint32_t result_index) {
  Context *context = phase0a_context_from_handle(handle);
  if (!result_index_is_valid(context, result_index) ||
      lua_type(context->state, lua_result_index(result_index)) != LUA_TNUMBER) {
    return 0;
  }
  return lua_tonumber(context->state, lua_result_index(result_index)).bits();
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0a_result_boolean(uint32_t handle,
                                                  uint32_t result_index) {
  Context *context = phase0a_context_from_handle(handle);
  if (!result_index_is_valid(context, result_index)) {
    return 0;
  }
  return lua_toboolean(context->state, lua_result_index(result_index)) ? 1u
                                                                       : 0u;
}

EMSCRIPTEN_KEEPALIVE const char *p8w0a_result_string_ptr(
    uint32_t handle, uint32_t result_index) {
  Context *context = phase0a_context_from_handle(handle);
  if (!result_index_is_valid(context, result_index) ||
      lua_type(context->state, lua_result_index(result_index)) != LUA_TSTRING) {
    return nullptr;
  }
  return lua_tostring(context->state, lua_result_index(result_index));
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0a_result_string_length(
    uint32_t handle, uint32_t result_index) {
  Context *context = phase0a_context_from_handle(handle);
  if (!result_index_is_valid(context, result_index) ||
      lua_type(context->state, lua_result_index(result_index)) != LUA_TSTRING) {
    return 0;
  }
  size_t length = 0;
  lua_tolstring(context->state, lua_result_index(result_index), &length);
  return static_cast<uint32_t>(length);
}

EMSCRIPTEN_KEEPALIVE const char *p8w0a_last_error_ptr(uint32_t handle) {
  Context *context = phase0a_context_from_handle(handle);
  return context == nullptr ? nullptr : context->last_error;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0a_last_error_length(uint32_t handle) {
  Context *context = phase0a_context_from_handle(handle);
  return context == nullptr ? 0 : context->last_error_length;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0a_live_contexts(void) {
  return g_live_phase0a_contexts;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0a_live_lua_bytes(void) {
  return g_live_phase0a_lua_bytes;
}

EMSCRIPTEN_KEEPALIVE void *p8w0a_alloc(uint32_t size) {
  return size == 0 ? nullptr : std::malloc(size);
}

EMSCRIPTEN_KEEPALIVE void p8w0a_free(void *pointer) { std::free(pointer); }

EMSCRIPTEN_KEEPALIVE uint32_t p8w0b_abi_version(void) {
  return kPhase0BAbiVersion;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0b_create(uint32_t lua_heap_limit) {
  const uint32_t resolved_limit =
      lua_heap_limit == 0 ? kDefaultLuaHeapLimit : lua_heap_limit;
  if (resolved_limit < kMinimumLuaHeapLimit) {
    return 0;
  }
  return create_context(resolved_limit, true);
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0b_destroy(uint32_t handle) {
  Context *context = phase0b_context_from_handle(handle);
  return context == nullptr ? P8W_INVALID_HANDLE
                            : destroy_context(handle, context);
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0b_run(uint32_t handle, const char *source,
                                       uint32_t source_length,
                                       uint32_t instruction_budget) {
  Context *context = phase0b_context_from_handle(handle);
  return context == nullptr
             ? P8W_INVALID_HANDLE
             : run_context(context, source, source_length, instruction_budget,
                           "@phase-0b-fixture.p8");
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0b_result_count(uint32_t handle) {
  Context *context = phase0b_context_from_handle(handle);
  return context == nullptr ? 0 : context->result_count;
}

EMSCRIPTEN_KEEPALIVE int32_t p8w0b_result_type(uint32_t handle,
                                              uint32_t result_index) {
  Context *context = phase0b_context_from_handle(handle);
  return !result_index_is_valid(context, result_index)
             ? LUA_TNONE
             : lua_type(context->state, lua_result_index(result_index));
}

EMSCRIPTEN_KEEPALIVE int32_t p8w0b_result_number_bits(
    uint32_t handle, uint32_t result_index) {
  Context *context = phase0b_context_from_handle(handle);
  if (!result_index_is_valid(context, result_index) ||
      lua_type(context->state, lua_result_index(result_index)) != LUA_TNUMBER) {
    return 0;
  }
  return lua_tonumber(context->state, lua_result_index(result_index)).bits();
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0b_result_boolean(uint32_t handle,
                                                  uint32_t result_index) {
  Context *context = phase0b_context_from_handle(handle);
  return !result_index_is_valid(context, result_index)
             ? 0
             : (lua_toboolean(context->state, lua_result_index(result_index))
                    ? 1u
                    : 0u);
}

EMSCRIPTEN_KEEPALIVE const char *p8w0b_result_string_ptr(
    uint32_t handle, uint32_t result_index) {
  Context *context = phase0b_context_from_handle(handle);
  if (!result_index_is_valid(context, result_index) ||
      lua_type(context->state, lua_result_index(result_index)) != LUA_TSTRING) {
    return nullptr;
  }
  return lua_tostring(context->state, lua_result_index(result_index));
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0b_result_string_length(
    uint32_t handle, uint32_t result_index) {
  Context *context = phase0b_context_from_handle(handle);
  if (!result_index_is_valid(context, result_index) ||
      lua_type(context->state, lua_result_index(result_index)) != LUA_TSTRING) {
    return 0;
  }
  size_t length = 0;
  lua_tolstring(context->state, lua_result_index(result_index), &length);
  return static_cast<uint32_t>(length);
}

EMSCRIPTEN_KEEPALIVE const char *p8w0b_last_error_ptr(uint32_t handle) {
  Context *context = phase0b_context_from_handle(handle);
  return context == nullptr ? nullptr : context->last_error;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0b_last_error_length(uint32_t handle) {
  Context *context = phase0b_context_from_handle(handle);
  return context == nullptr ? 0 : context->last_error_length;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0b_live_contexts(void) {
  return g_live_phase0b_contexts;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0b_live_lua_bytes(void) {
  return g_live_phase0b_lua_bytes;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0b_ram_ptr(uint32_t handle) {
  Context *context = phase0b_context_from_handle(handle);
  return context == nullptr
             ? 0
             : static_cast<uint32_t>(reinterpret_cast<uintptr_t>(context->ram));
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0b_ram_size(uint32_t handle) {
  return phase0b_context_from_handle(handle) == nullptr ? 0 : p8w::kPicoRamSize;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0b_ram_reset(uint32_t handle) {
  Context *context = phase0b_context_from_handle(handle);
  if (context == nullptr) {
    return P8W_INVALID_HANDLE;
  }
  reset_phase0b_ram(context);
  return P8W_OK;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0b_map_address(uint32_t handle,
                                               uint32_t logical_address) {
  Context *context = phase0b_context_from_handle(handle);
  return context == nullptr ? UINT32_MAX
                            : p8w::map_address(context->ram, logical_address);
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0b_read8(uint32_t handle,
                                         uint32_t logical_address) {
  Context *context = phase0b_context_from_handle(handle);
  return context == nullptr ? UINT32_MAX
                            : p8w::read8(context->ram, logical_address);
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0b_write8(uint32_t handle,
                                          uint32_t logical_address,
                                          uint32_t value) {
  Context *context = phase0b_context_from_handle(handle);
  if (context == nullptr) {
    return P8W_INVALID_HANDLE;
  }
  p8w::write8(context->ram, logical_address, static_cast<uint8_t>(value));
  return P8W_OK;
}

EMSCRIPTEN_KEEPALIVE void *p8w0b_alloc(uint32_t size) {
  return p8w0a_alloc(size);
}

EMSCRIPTEN_KEEPALIVE void p8w0b_free(void *pointer) { p8w0a_free(pointer); }

}  // extern "C"
