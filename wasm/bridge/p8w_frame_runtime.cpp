#include "p8w_frame_runtime.h"

#include <climits>
#include <cstdlib>
#include <cstring>
#include <new>

#include <emscripten/emscripten.h>

#include "lauxlib.h"
#include "lua.h"
#include "lualib.h"
#include "generated/p8w_host_bindings.generated.h"
#include "p8w_pico_memory.h"

namespace {

constexpr uint32_t kAbiVersion = 0x00010002u;
constexpr uint32_t kMaxContexts = 32;
constexpr uint32_t kHandleIndexBits = 8;
constexpr uint32_t kHandleIndexMask = (1u << kHandleIndexBits) - 1u;
constexpr uint32_t kDefaultLuaHeapLimit = 1024u * 1024u;
constexpr uint32_t kMinimumLuaHeapLimit = 32u * 1024u;
constexpr uint32_t kMaxMessageLength = 1023;
constexpr uint32_t kMaxTraceLength = 2047;
constexpr uint32_t kMaxHostBytes = 4096;
constexpr int32_t kMaxMemoryVector = 8192;
constexpr int32_t kMaxMemoryBlock = static_cast<int32_t>(p8w::kPicoRamSize);
constexpr char kContextRegistryKey[] = "__p8w_runtime_context";
constexpr char kBudgetSentinel[] = "__p8w_instruction_budget_exceeded__";
constexpr char kNestedSentinel[] = "__p8w_nested_host_suspend__";
constexpr char kChunkName[] = "@cart.p8";

EM_JS(uint32_t, dispatch_host_call,
      (uint32_t binding_id, P8wHostCallFrame *frame), {
        const dispatch = Module['p8wHostCall'];
        if (typeof dispatch !== 'function') return 1;
        try {
          return dispatch(binding_id, frame) >>> 0;
        } catch (error) {
          return 1;
        }
      });

enum class ActiveKind : uint8_t { None, TopLevel, Init, Update, Update60, Draw };

struct AllocationStats {
  uint32_t live_bytes = 0;
  uint32_t limit_bytes = UINT32_MAX;
  bool denied = false;
};

struct Context {
  lua_State *main = nullptr;
  lua_State *active = nullptr;
  int active_ref = LUA_NOREF;
  AllocationStats allocations;
  alignas(16) uint8_t ram[p8w::kPicoRamSize] = {};

  P8wVmState state = P8W_STATE_EMPTY;
  P8wVmState waiting_return_state = P8W_STATE_EMPTY;
  P8wVmMode mode = P8W_MODE_NONE;
  P8wYieldReason yield_reason = P8W_YIELD_NONE;
  P8wPhase phase = P8W_PHASE_NONE;
  ActiveKind active_kind = ActiveKind::None;
  uint32_t target_fps = 0;
  uint32_t button_mask = 0;
  int32_t time_raw = 0;
  uint32_t host_binding_id = 0;
  bool host_bound = false;

  uint32_t budget_start = 0;
  uint32_t remaining_budget = 0;
  bool budget_poisoned = false;
  bool nested_suspend_attempt = false;
  bool host_oom = false;
  bool host_response_failed = false;
  bool host_api_failed = false;

  bool pending_request = false;
  bool response_ready = false;
  bool response_is_error = false;
  uint32_t next_request_id = 0;
  uint32_t request_id = 0;
  uint32_t request_length = 0;
  uint32_t response_length = 0;
  uint8_t request_bytes[kMaxHostBytes] = {};
  uint8_t response_bytes[kMaxHostBytes] = {};

  P8wStatus error_status = P8W_STATUS_OK;
  int32_t error_line = -1;
  uint32_t error_message_length = 0;
  uint32_t error_trace_length = 0;
  char error_message[kMaxMessageLength + 1] = {};
  char error_trace[kMaxTraceLength + 1] = {};
};

struct ContextSlot {
  Context *context = nullptr;
  uint32_t generation = 0;
};

ContextSlot g_slots[kMaxContexts];

void update_allocation_counter(AllocationStats *stats, size_t old_size,
                               size_t new_size) {
  if (new_size >= old_size) {
    stats->live_bytes += static_cast<uint32_t>(new_size - old_size);
  } else {
    stats->live_bytes -= static_cast<uint32_t>(old_size - new_size);
  }
}

void *tracked_lua_allocator(void *user_data, void *pointer, size_t old_size,
                            size_t new_size) {
  auto *stats = static_cast<AllocationStats *>(user_data);
  const size_t accounted_old_size = pointer == nullptr ? 0 : old_size;
  if (new_size == 0) {
    std::free(pointer);
    update_allocation_counter(stats, accounted_old_size, 0);
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
  if (replacement == nullptr) {
    stats->denied = true;
    return nullptr;
  }
  update_allocation_counter(stats, accounted_old_size, new_size);
  return replacement;
}

Context *context_from_handle(uint32_t handle) {
  const uint32_t encoded_index = handle & kHandleIndexMask;
  if (encoded_index == 0 || encoded_index > kMaxContexts) return nullptr;
  const auto &slot = g_slots[encoded_index - 1];
  const uint32_t generation = handle >> kHandleIndexBits;
  return slot.context != nullptr && slot.generation == generation
             ? slot.context
             : nullptr;
}

uint32_t make_handle(uint32_t slot_index) {
  auto &slot = g_slots[slot_index];
  slot.generation = (slot.generation + 1u) & 0x00ffffffu;
  if (slot.generation == 0) slot.generation = 1;
  return (slot.generation << kHandleIndexBits) | (slot_index + 1u);
}

Context *context_from_lua(lua_State *state) {
  lua_getfield(state, LUA_REGISTRYINDEX, kContextRegistryKey);
  auto *context = static_cast<Context *>(lua_touserdata(state, -1));
  lua_pop(state, 1);
  return context;
}

void copy_bounded(char *target, uint32_t capacity, uint32_t *target_length,
                  const char *source, size_t length) {
  const size_t copy_length = length < capacity ? length : capacity;
  if (source != nullptr && copy_length != 0) {
    std::memcpy(target, source, copy_length);
  }
  target[copy_length] = '\0';
  *target_length = static_cast<uint32_t>(copy_length);
}

void clear_error(Context *context) {
  context->error_status = P8W_STATUS_OK;
  context->error_line = -1;
  context->error_message[0] = '\0';
  context->error_message_length = 0;
  context->error_trace[0] = '\0';
  context->error_trace_length = 0;
}

int32_t parse_cart_line(const char *message) {
  if (message == nullptr) return -1;
  const char *chunk = std::strstr(message, "cart.p8:");
  if (chunk == nullptr) return -1;
  chunk += std::strlen("cart.p8:");
  char *end = nullptr;
  const long line = std::strtol(chunk, &end, 10);
  return end == chunk || line < 0 || line > INT32_MAX
             ? -1
             : static_cast<int32_t>(line);
}

void set_plain_error(Context *context, P8wStatus status, const char *message) {
  context->error_status = status;
  copy_bounded(context->error_message, kMaxMessageLength,
               &context->error_message_length, message,
               message == nullptr ? 0 : std::strlen(message));
  context->error_line = parse_cart_line(context->error_message);
}

void fault(Context *context, P8wStatus status, const char *message) {
  set_plain_error(context, status, message);
  context->state = P8W_STATE_FAULTED;
  context->yield_reason = P8W_YIELD_NONE;
}

void copy_lua_error(Context *context, lua_State *thread, P8wStatus status) {
  size_t length = 0;
  const char *message = lua_tolstring(thread, -1, &length);
  constexpr char kFallback[] = "unknown z8lua error";
  if (message == nullptr) {
    message = kFallback;
    length = sizeof(kFallback) - 1;
  }
  copy_bounded(context->error_message, kMaxMessageLength,
               &context->error_message_length, message, length);
  context->error_line = parse_cart_line(context->error_message);
  luaL_traceback(context->main, thread, message, 1);
  size_t trace_length = 0;
  const char *trace = lua_tolstring(context->main, -1, &trace_length);
  copy_bounded(context->error_trace, kMaxTraceLength,
               &context->error_trace_length, trace, trace_length);
  lua_pop(context->main, 1);
  context->error_status = status;
  context->state = P8W_STATE_FAULTED;
  context->yield_reason = P8W_YIELD_NONE;
}

void reset_ram(Context *context) {
  std::memset(context->ram, 0, sizeof(context->ram));
  context->ram[p8w::kGfxMapRegister] = 0x00u;
  context->ram[p8w::kScreenMapRegister] = 0x60u;
  context->ram[p8w::kMapBaseRegister] = 0x20u;
  context->ram[p8w::kMapWidthRegister] = 0x80u;
}

void remove_global(lua_State *state, const char *name) {
  lua_pushnil(state);
  lua_setglobal(state, name);
}

uint32_t logical_address(lua_State *state, int index) {
  return p8w::normalize_address(
      static_cast<int32_t>(luaL_checknumber(state, index)));
}

uint32_t integer_value(lua_State *state, int index) {
  return static_cast<uint32_t>(
      static_cast<int32_t>(luaL_checknumber(state, index)));
}

int p8_peek(lua_State *state) {
  Context *context = context_from_lua(state);
  const uint32_t address = logical_address(state, 1);
  const int32_t count = lua_isnoneornil(state, 2)
                            ? 1
                            : static_cast<int32_t>(luaL_checknumber(state, 2));
  if (count <= 0) return 0;
  if (count > kMaxMemoryVector) {
    return luaL_error(state, "peek result count exceeds 8192");
  }
  if (!lua_checkstack(state, count)) {
    context->host_oom = true;
    return luaL_error(state, "peek result stack capacity exceeded");
  }
  for (int32_t index = 0; index < count; ++index) {
    lua_pushinteger(state, p8w::read8(context->ram, address + index));
  }
  return count;
}

int p8_peek2(lua_State *state) {
  Context *context = context_from_lua(state);
  const uint32_t raw =
      static_cast<uint32_t>(p8w::read16(context->ram, logical_address(state, 1)))
      << 16u;
  lua_pushnumber(state, lua_Number::frombits(static_cast<int32_t>(raw)));
  return 1;
}

int p8_poke(lua_State *state) {
  Context *context = context_from_lua(state);
  const uint32_t address = logical_address(state, 1);
  const int value_count = lua_gettop(state) - 1;
  if (value_count <= 0) {
    luaL_checknumber(state, 2);
    return 0;
  }
  if (value_count > kMaxMemoryVector) {
    return luaL_error(state, "poke value count exceeds 8192");
  }
  for (int index = 0; index < value_count; ++index) {
    p8w::write8(context->ram, address + static_cast<uint32_t>(index),
                static_cast<uint8_t>(integer_value(state, index + 2)));
  }
  return 0;
}

int p8_poke2(lua_State *state) {
  Context *context = context_from_lua(state);
  p8w::write16(context->ram, logical_address(state, 1),
               static_cast<uint16_t>(integer_value(state, 2)));
  return 0;
}

int p8_peek4(lua_State *state) {
  Context *context = context_from_lua(state);
  lua_pushnumber(state, lua_Number::frombits(static_cast<int32_t>(
                            p8w::read32(context->ram,
                                       logical_address(state, 1)))));
  return 1;
}

int p8_poke4(lua_State *state) {
  Context *context = context_from_lua(state);
  p8w::write32(context->ram, logical_address(state, 1),
               static_cast<uint32_t>(luaL_checknumber(state, 2).bits()));
  return 0;
}

int p8_memcpy(lua_State *state) {
  Context *context = context_from_lua(state);
  const uint32_t destination = logical_address(state, 1);
  const uint32_t source = logical_address(state, 2);
  const int32_t signed_length =
      static_cast<int32_t>(luaL_checknumber(state, 3));
  if (signed_length <= 0) return 0;
  if (signed_length > kMaxMemoryBlock) {
    return luaL_error(state, "memcpy length exceeds 65536");
  }
  if (destination == source) return 0;
  const uint32_t length = static_cast<uint32_t>(signed_length);
  auto *snapshot = static_cast<uint8_t *>(std::malloc(length));
  if (snapshot == nullptr) {
    context->host_oom = true;
    return luaL_error(state, "memcpy snapshot allocation failed");
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

int p8_memset(lua_State *state) {
  Context *context = context_from_lua(state);
  const uint32_t destination = logical_address(state, 1);
  const uint8_t value = static_cast<uint8_t>(integer_value(state, 2));
  const int32_t signed_length =
      static_cast<int32_t>(luaL_checknumber(state, 3));
  if (signed_length <= 0) return 0;
  if (signed_length > kMaxMemoryBlock) {
    return luaL_error(state, "memset length exceeds 65536");
  }
  for (int32_t index = 0; index < signed_length; ++index) {
    p8w::write8(context->ram, destination + static_cast<uint32_t>(index), value);
  }
  return 0;
}

int p8_host_call(lua_State *state) {
  auto *descriptor = static_cast<const P8wHostBindingDescriptor *>(
      lua_touserdata(state, lua_upvalueindex(1)));
  if (descriptor == nullptr) return luaL_error(state, "host binding invariant failed");
  P8wHostCallFrame frame = {};
  frame.byte_size = sizeof(frame);
  frame.operation_id = descriptor->operation_id;
  for (uint8_t index = 0; index < descriptor->maximum_arguments; ++index) {
    const int stack_index = static_cast<int>(index) + 1;
    if (lua_isnoneornil(state, stack_index)) {
      if (index < descriptor->minimum_arguments) {
        if ((descriptor->byte_string_mask & (1u << index)) != 0) {
          luaL_checklstring(state, stack_index, nullptr);
        } else if ((descriptor->boolean_mask & (1u << index)) != 0) {
          luaL_checkany(state, stack_index);
        } else {
          luaL_checknumber(state, stack_index);
        }
      }
      continue;
    }
    frame.presence_bits |= 1u << index;
    if ((descriptor->byte_string_mask & (1u << index)) != 0) {
      size_t length = 0;
      const char *bytes = luaL_checklstring(state, stack_index, &length);
      if (frame.byte_buffer_ptr != 0 || length > UINT32_MAX) {
        return luaL_error(state, "host byte-string frame invariant failed");
      }
      frame.byte_buffer_ptr =
          static_cast<uint32_t>(reinterpret_cast<uintptr_t>(bytes));
      frame.byte_buffer_len = static_cast<uint32_t>(length);
    } else {
      frame.scalar_slots[index] =
          (descriptor->boolean_mask & (1u << index)) != 0
              ? (lua_toboolean(state, stack_index) ? 1 : 0)
              : luaL_checknumber(state, stack_index).bits();
      frame.scalar_count += 1u;
    }
  }
  Context *context = context_from_lua(state);
  if (context == nullptr || !context->host_bound) {
    return luaL_error(state, "PicoApiHost is not bound");
  }
  const P8wPhase previous_phase = context->phase;
  context->phase = P8W_PHASE_HOST_CALL;
  const uint32_t status = dispatch_host_call(context->host_binding_id, &frame);
  if (status != 0) {
    context->host_api_failed = true;
    return luaL_error(state, "synchronous PicoApiHost call failed");
  }
  context->phase = previous_phase;
  if (descriptor->result_kind == P8W_HOST_RESULT_VOID) return 0;
  if (descriptor->result_kind == P8W_HOST_RESULT_STAT_INPUT) {
    const int32_t selector = frame.scalar_slots[0] >> 16;
    if (selector == 30) {
      lua_pushboolean(state, frame.result != 0);
    } else if (selector == 31) {
      if (frame.result < 0) {
        lua_pushliteral(state, "");
      } else {
        const char byte = static_cast<char>(frame.result & 0xff);
        lua_pushlstring(state, &byte, 1u);
      }
    } else if (selector == 34) {
      lua_pushinteger(state, static_cast<int16_t>(frame.result));
    } else if (selector == 32 || selector == 33 || selector == 36 ||
               selector == 38 || selector == 39) {
      lua_pushnumber(state, lua_Number::frombits(frame.result));
    } else {
      lua_pushboolean(state, 0);
    }
    return 1;
  }
  if (descriptor->result_kind == P8W_HOST_RESULT_BOOLEAN ||
      (descriptor->result_kind == P8W_HOST_RESULT_INTEGER_OR_BOOLEAN &&
       (frame.presence_bits & 1u) != 0) ||
      (descriptor->result_kind == P8W_HOST_RESULT_INTEGER_OR_BOOLEAN_SECOND &&
       (frame.presence_bits & 2u) != 0)) {
    lua_pushboolean(state, frame.result != 0);
    return 1;
  }
  if (descriptor->result_kind == P8W_HOST_RESULT_Q16) {
    lua_pushnumber(state, lua_Number::frombits(frame.result));
    return 1;
  }
  lua_pushinteger(state, static_cast<int16_t>(frame.result));
  return 1;
}

int p8_pal(lua_State *state) {
  if (!lua_istable(state, 1)) return p8_host_call(state);
  auto *descriptor = static_cast<const P8wHostBindingDescriptor *>(
      lua_touserdata(state, lua_upvalueindex(1)));
  Context *context = context_from_lua(state);
  if (descriptor == nullptr || context == nullptr || !context->host_bound) {
    if (context != nullptr) context->host_api_failed = true;
    return luaL_error(state, "host binding is not active");
  }
  const bool has_palette = !lua_isnoneornil(state, 2);
  const int32_t palette =
      has_palette ? luaL_checknumber(state, 2).bits() : 0;
  const P8wPhase previous_phase = context->phase;
  context->phase = P8W_PHASE_HOST_CALL;
  for (int table_index = 1; table_index <= 16; ++table_index) {
    lua_rawgeti(state, 1, table_index);
    if (!lua_isnil(state, -1)) {
      const int source = table_index == 16 ? 0 : table_index;
      P8wHostCallFrame frame = {};
      frame.byte_size = sizeof(frame);
      frame.operation_id = descriptor->operation_id;
      frame.presence_bits = has_palette ? 0x7u : 0x3u;
      frame.scalar_count = has_palette ? 3u : 2u;
      frame.scalar_slots[0] = source << 16;
      frame.scalar_slots[1] = luaL_checknumber(state, -1).bits();
      frame.scalar_slots[2] = palette;
      if (dispatch_host_call(context->host_binding_id, &frame) != 0) {
        context->host_api_failed = true;
        return luaL_error(state, "synchronous PicoApiHost call failed");
      }
    }
    lua_pop(state, 1);
  }
  context->phase = previous_phase;
  return 0;
}

int p8_time(lua_State *state) {
  Context *context = context_from_lua(state);
  lua_pushnumber(state, lua_Number::frombits(context->time_raw));
  return 1;
}

int control_continuation(lua_State *) { return 0; }

int p8_flip(lua_State *state) {
  Context *context = context_from_lua(state);
  if (state != context->active) {
    context->nested_suspend_attempt = true;
    return lua_yieldk(state, 0, 0, control_continuation);
  }
  context->yield_reason = P8W_YIELD_FLIP;
  return lua_yieldk(state, 0, 0, control_continuation);
}

int host_request_continuation(lua_State *state) {
  Context *context = context_from_lua(state);
  if (!context->response_ready) {
    return luaL_error(state, "host response invariant failed");
  }
  context->response_ready = false;
  if (context->response_is_error) {
    context->host_response_failed = true;
    return luaL_error(state, "host request failed");
  }
  lua_pushlstring(state,
                  reinterpret_cast<const char *>(context->response_bytes),
                  context->response_length);
  return 1;
}

int p8_probe_host_request(lua_State *state) {
  Context *context = context_from_lua(state);
  size_t length = 0;
  const char *bytes = luaL_checklstring(state, 1, &length);
  if (length > kMaxHostBytes) {
    return luaL_error(state, "host request payload exceeds Phase 0E limit");
  }
  if (state != context->active) {
    context->nested_suspend_attempt = true;
    return lua_yieldk(state, 0, 0, host_request_continuation);
  }
  if (context->pending_request) {
    return luaL_error(state, "host request already pending");
  }
  context->next_request_id += 1u;
  if (context->next_request_id == 0) context->next_request_id = 1;
  context->request_id = context->next_request_id;
  context->request_length = static_cast<uint32_t>(length);
  if (length != 0) std::memcpy(context->request_bytes, bytes, length);
  context->pending_request = true;
  context->yield_reason = P8W_YIELD_HOST_REQUEST;
  return lua_yieldk(state, 0, static_cast<int>(context->request_id),
                    host_request_continuation);
}

void alias_coroutine_function(lua_State *state, const char *field,
                              const char *global) {
  lua_getglobal(state, LUA_COLIBNAME);
  lua_getfield(state, -1, field);
  lua_setglobal(state, global);
  lua_pop(state, 1);
}

void register_function(lua_State *state, const char *name,
                       lua_CFunction function) {
  lua_pushcfunction(state, function);
  lua_setglobal(state, name);
}

void register_host_functions(lua_State *state) {
  for (const auto &binding : kP8wHostBindings) {
    lua_pushlightuserdata(
        state, const_cast<P8wHostBindingDescriptor *>(&binding));
    lua_pushcclosure(
        state,
        std::strcmp(binding.guest_name, "pal") == 0 ? p8_pal : p8_host_call,
        1);
    lua_setglobal(state, binding.guest_name);
  }
}

void open_guest_environment(lua_State *state) {
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

  for (const char *name : {"collectgarbage", "dofile", "load", "loadfile",
                           "loadstring", "require", "debug", "eris", "io",
                           "os", "package"}) {
    remove_global(state, name);
  }
  register_function(state, "peek", p8_peek);
  register_function(state, "peek2", p8_peek2);
  register_function(state, "peek4", p8_peek4);
  register_function(state, "poke", p8_poke);
  register_function(state, "poke2", p8_poke2);
  register_function(state, "poke4", p8_poke4);
  register_function(state, "memcpy", p8_memcpy);
  register_function(state, "memset", p8_memset);
  register_host_functions(state);
  register_function(state, "time", p8_time);
  register_function(state, "t", p8_time);
  register_function(state, "flip", p8_flip);
  // Phase 0E-only control-flow probe. It is deliberately not a PICO-8 API.
  register_function(state, "__p8w_probe_host_request", p8_probe_host_request);
  alias_coroutine_function(state, "create", "cocreate");
  alias_coroutine_function(state, "resume", "coresume");
  alias_coroutine_function(state, "status", "costatus");
  alias_coroutine_function(state, "yield", "yield");
}

void instruction_hook(lua_State *state, lua_Debug *) {
  Context *context = context_from_lua(state);
  if (context == nullptr) return;
  if (context->nested_suspend_attempt) {
    luaL_error(state, "%s", kNestedSentinel);
    return;
  }
  if (context->remaining_budget <= 1) {
    context->remaining_budget = 0;
    context->budget_poisoned = true;
    luaL_error(state, "%s", kBudgetSentinel);
    return;
  }
  --context->remaining_budget;
}

bool begin_budget(Context *context, uint32_t budget) {
  if (budget == 0) return false;
  context->budget_start = budget;
  context->remaining_budget = budget;
  context->budget_poisoned = false;
  context->nested_suspend_attempt = false;
  context->allocations.denied = false;
  context->host_oom = false;
  context->host_response_failed = false;
  context->host_api_failed = false;
  context->yield_reason = P8W_YIELD_NONE;
  clear_error(context);
  return true;
}

void release_active(Context *context) {
  if (context->active_ref != LUA_NOREF) {
    luaL_unref(context->main, LUA_REGISTRYINDEX, context->active_ref);
  }
  context->active_ref = LUA_NOREF;
  context->active = nullptr;
  context->active_kind = ActiveKind::None;
}

bool start_global(Context *context, const char *name, ActiveKind kind,
                  P8wPhase phase) {
  lua_getglobal(context->main, name);
  if (!lua_isfunction(context->main, -1)) {
    lua_pop(context->main, 1);
    return false;
  }
  lua_State *thread = lua_newthread(context->main);
  const int reference = luaL_ref(context->main, LUA_REGISTRYINDEX);
  lua_xmove(context->main, thread, 1);
  context->active = thread;
  context->active_ref = reference;
  context->active_kind = kind;
  context->phase = phase;
  return true;
}

bool global_is_function(Context *context, const char *name) {
  lua_getglobal(context->main, name);
  const bool result = lua_isfunction(context->main, -1);
  lua_pop(context->main, 1);
  return result;
}

void select_callback_mode(Context *context) {
  if (global_is_function(context, "_update60")) {
    context->target_fps = 60;
  } else {
    context->target_fps = 30;
  }
  context->mode = P8W_MODE_CALLBACK;
  context->state = P8W_STATE_CALLBACK_LOOP;
}

P8wStatus classify_resume_error(Context *context, lua_State *thread,
                                int lua_status) {
  if (context->budget_poisoned) {
    fault(context, P8W_STATUS_INSTRUCTION_BUDGET,
          "instruction budget exceeded");
    return P8W_STATUS_INSTRUCTION_BUDGET;
  }
  if (context->nested_suspend_attempt) {
    fault(context, P8W_STATUS_FEATURE_UNSUPPORTED,
          "nested-host-suspend");
    return P8W_STATUS_FEATURE_UNSUPPORTED;
  }
  if (context->host_response_failed) {
    copy_lua_error(context, thread, P8W_STATUS_HOST_ERROR);
    return P8W_STATUS_HOST_ERROR;
  }
  if (context->host_api_failed) {
    copy_lua_error(context, thread, P8W_STATUS_HOST_API_ERROR);
    return P8W_STATUS_HOST_API_ERROR;
  }
  if (lua_status == LUA_ERRMEM || context->allocations.denied ||
      context->host_oom) {
    copy_lua_error(context, thread, P8W_STATUS_OUT_OF_MEMORY);
    return P8W_STATUS_OUT_OF_MEMORY;
  }
  copy_lua_error(context, thread, P8W_STATUS_RUNTIME_ERROR);
  return P8W_STATUS_RUNTIME_ERROR;
}

P8wStatus resume_active(Context *context) {
  const ActiveKind completed_kind = context->active_kind;
  lua_State *thread = context->active;
  const int status = lua_resume(thread, context->main, 0);

  if (context->budget_poisoned || context->nested_suspend_attempt) {
    return classify_resume_error(context, thread, status);
  }
  if (status != LUA_OK && status != LUA_YIELD) {
    return classify_resume_error(context, thread, status);
  }
  if (status == LUA_YIELD) {
    if (context->yield_reason == P8W_YIELD_HOST_REQUEST &&
        context->pending_request) {
      context->waiting_return_state = context->state;
      context->state = P8W_STATE_WAITING_HOST;
      return P8W_STATUS_YIELDED;
    }
    if (context->yield_reason == P8W_YIELD_FLIP &&
        completed_kind == ActiveKind::TopLevel) {
      context->mode = P8W_MODE_CUSTOM;
      context->target_fps = 30;
      context->phase = P8W_PHASE_CUSTOM_LOOP;
      context->state = P8W_STATE_CUSTOM_LOOP;
      return P8W_STATUS_YIELDED;
    }
    fault(context, P8W_STATUS_FEATURE_UNSUPPORTED,
          "uncontrolled or nested yield");
    return P8W_STATUS_FEATURE_UNSUPPORTED;
  }
  release_active(context);
  return P8W_STATUS_OK;
}

P8wStatus finish_callback_sequence(Context *context) {
  while (true) {
    const ActiveKind completed = context->active_kind;
    const P8wStatus status = resume_active(context);
    if (status != P8W_STATUS_OK) return status;
    if (completed == ActiveKind::Init) {
      select_callback_mode(context);
      return P8W_STATUS_OK;
    }
    if (completed == ActiveKind::Update ||
        completed == ActiveKind::Update60) {
      if (start_global(context, "_draw", ActiveKind::Draw,
                       P8W_PHASE_DRAW)) {
        continue;
      }
      context->yield_reason = P8W_YIELD_FRAME_END;
      return P8W_STATUS_OK;
    }
    if (completed == ActiveKind::Draw) {
      context->yield_reason = P8W_YIELD_FRAME_END;
      return P8W_STATUS_OK;
    }
    return P8W_STATUS_OK;
  }
}

P8wStatus run_callback_step(Context *context) {
  const bool has_update60 = global_is_function(context, "_update60");
  context->target_fps = has_update60 ? 60 : 30;
  if (has_update60) {
    start_global(context, "_update60", ActiveKind::Update60,
                 P8W_PHASE_UPDATE60);
  } else {
    start_global(context, "_update", ActiveKind::Update, P8W_PHASE_UPDATE);
  }
  if (context->active == nullptr) {
    if (!start_global(context, "_draw", ActiveKind::Draw, P8W_PHASE_DRAW)) {
      context->state = P8W_STATE_STOPPED;
      context->yield_reason = P8W_YIELD_STOP;
      return P8W_STATUS_STOPPED;
    }
  }
  return finish_callback_sequence(context);
}

P8wStatus continue_after_host_response(Context *context) {
  context->state = context->waiting_return_state;
  const ActiveKind active_kind = context->active_kind;
  const P8wStatus status = resume_active(context);
  if (status != P8W_STATUS_OK) return status;
  if (active_kind == ActiveKind::TopLevel) {
    if (context->mode == P8W_MODE_CUSTOM) return P8W_STATUS_OK;
    if (start_global(context, "_init", ActiveKind::Init, P8W_PHASE_INIT)) {
      return finish_callback_sequence(context);
    }
    select_callback_mode(context);
    return P8W_STATUS_OK;
  }
  if (active_kind == ActiveKind::Init) {
    select_callback_mode(context);
    return P8W_STATUS_OK;
  }
  if (active_kind == ActiveKind::Update ||
      active_kind == ActiveKind::Update60) {
    if (start_global(context, "_draw", ActiveKind::Draw, P8W_PHASE_DRAW)) {
      return finish_callback_sequence(context);
    }
    context->yield_reason = P8W_YIELD_FRAME_END;
    return P8W_STATUS_OK;
  }
  if (active_kind == ActiveKind::Draw) {
    context->yield_reason = P8W_YIELD_FRAME_END;
    return P8W_STATUS_OK;
  }
  return P8W_STATUS_INTERNAL_ERROR;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE uint32_t p8w_abi_version(void) { return kAbiVersion; }

EMSCRIPTEN_KEEPALIVE uint32_t p8w_create(uint32_t lua_heap_limit) {
  const uint32_t resolved_limit =
      lua_heap_limit == 0 ? kDefaultLuaHeapLimit : lua_heap_limit;
  if (resolved_limit < kMinimumLuaHeapLimit) return 0;
  uint32_t slot_index = kMaxContexts;
  for (uint32_t index = 0; index < kMaxContexts; ++index) {
    if (g_slots[index].context == nullptr) {
      slot_index = index;
      break;
    }
  }
  if (slot_index == kMaxContexts) return 0;
  auto *context = new (std::nothrow) Context();
  if (context == nullptr) return 0;
  context->allocations.limit_bytes = resolved_limit;
  context->main = lua_newstate(tracked_lua_allocator, &context->allocations);
  if (context->main == nullptr) {
    delete context;
    return 0;
  }
  lua_pushlightuserdata(context->main, context);
  lua_setfield(context->main, LUA_REGISTRYINDEX, kContextRegistryKey);
  reset_ram(context);
  lua_setpico8memory(context->main, context->ram);
  open_guest_environment(context->main);
  lua_sethook(context->main, instruction_hook, LUA_MASKCOUNT, 1);
  const uint32_t handle = make_handle(slot_index);
  g_slots[slot_index].context = context;
  return handle;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w_destroy(uint32_t handle) {
  Context *context = context_from_handle(handle);
  if (context == nullptr) return P8W_STATUS_INVALID_HANDLE;
  const uint32_t slot_index = (handle & kHandleIndexMask) - 1u;
  lua_close(context->main);
  delete context;
  g_slots[slot_index].context = nullptr;
  return P8W_STATUS_OK;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w_bind_host(uint32_t handle,
                                            uint32_t binding_id) {
  Context *context = context_from_handle(handle);
  if (context == nullptr) return P8W_STATUS_INVALID_HANDLE;
  if (context->state != P8W_STATE_EMPTY || context->host_bound)
    return P8W_STATUS_INVALID_STATE;
  if (binding_id == 0) return P8W_STATUS_BAD_ARGUMENT;
  context->host_binding_id = binding_id;
  context->host_bound = true;
  return P8W_STATUS_OK;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w_compile(uint32_t handle,
                                         const uint8_t *source,
                                         uint32_t source_length) {
  Context *context = context_from_handle(handle);
  if (context == nullptr) return P8W_STATUS_INVALID_HANDLE;
  if (context->state != P8W_STATE_EMPTY || !context->host_bound)
    return P8W_STATUS_INVALID_STATE;
  if (source == nullptr && source_length != 0)
    return P8W_STATUS_BAD_ARGUMENT;
  clear_error(context);
  context->phase = P8W_PHASE_COMPILE;
  lua_State *thread = lua_newthread(context->main);
  context->active_ref = luaL_ref(context->main, LUA_REGISTRYINDEX);
  context->active = thread;
  context->active_kind = ActiveKind::TopLevel;
  const char *safe_source =
      source == nullptr ? "" : reinterpret_cast<const char *>(source);
  const int status =
      luaL_loadbufferx(thread, safe_source, source_length, kChunkName, "t");
  if (status != LUA_OK) {
    const P8wStatus mapped =
        status == LUA_ERRMEM || context->allocations.denied
            ? P8W_STATUS_OUT_OF_MEMORY
            : P8W_STATUS_LOAD_ERROR;
    copy_lua_error(context, thread, mapped);
    release_active(context);
    return mapped;
  }
  context->state = P8W_STATE_COMPILED;
  return P8W_STATUS_OK;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w_boot(uint32_t handle,
                                      uint32_t instruction_budget,
                                      uint32_t button_mask,
                                      int32_t time_raw) {
  Context *context = context_from_handle(handle);
  if (context == nullptr) return P8W_STATUS_INVALID_HANDLE;
  if (context->state != P8W_STATE_COMPILED)
    return P8W_STATUS_INVALID_STATE;
  if (!begin_budget(context, instruction_budget))
    return P8W_STATUS_BAD_ARGUMENT;
  context->button_mask = button_mask & 0x3fu;
  context->time_raw = time_raw;
  context->state = P8W_STATE_BOOTING;
  context->phase = P8W_PHASE_BOOT;
  P8wStatus status = resume_active(context);
  if (status != P8W_STATUS_OK) return status;
  if (start_global(context, "_init", ActiveKind::Init, P8W_PHASE_INIT)) {
    return finish_callback_sequence(context);
  }
  select_callback_mode(context);
  return P8W_STATUS_OK;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w_step(uint32_t handle,
                                      uint32_t instruction_budget,
                                      uint32_t button_mask,
                                      int32_t time_raw) {
  Context *context = context_from_handle(handle);
  if (context == nullptr) return P8W_STATUS_INVALID_HANDLE;
  if (context->state != P8W_STATE_CALLBACK_LOOP &&
      context->state != P8W_STATE_CUSTOM_LOOP)
    return P8W_STATUS_INVALID_STATE;
  if (!begin_budget(context, instruction_budget))
    return P8W_STATUS_BAD_ARGUMENT;
  context->button_mask = button_mask & 0x3fu;
  context->time_raw = time_raw;
  if (context->state == P8W_STATE_CALLBACK_LOOP)
    return run_callback_step(context);
  context->phase = P8W_PHASE_CUSTOM_LOOP;
  return resume_active(context);
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w_complete_host_request(
    uint32_t handle, uint32_t request_id, const uint8_t *bytes,
    uint32_t length, uint32_t is_error, uint32_t instruction_budget) {
  Context *context = context_from_handle(handle);
  if (context == nullptr) return P8W_STATUS_INVALID_HANDLE;
  if (context->state != P8W_STATE_WAITING_HOST || !context->pending_request ||
      context->request_id != request_id)
    return P8W_STATUS_INVALID_STATE;
  if ((bytes == nullptr && length != 0) || length > kMaxHostBytes ||
      !begin_budget(context, instruction_budget))
    return P8W_STATUS_BAD_ARGUMENT;
  context->response_length = length;
  if (length != 0) std::memcpy(context->response_bytes, bytes, length);
  context->response_is_error = is_error != 0;
  context->response_ready = true;
  context->pending_request = false;
  context->phase = P8W_PHASE_HOST_CALL;
  return continue_after_host_response(context);
}

#define P8W_GETTER(name, type, fallback, field)               \
  EMSCRIPTEN_KEEPALIVE type name(uint32_t handle) {           \
    Context *context = context_from_handle(handle);           \
    return context == nullptr ? fallback : context->field;    \
  }

P8W_GETTER(p8w_state, uint32_t, P8W_STATE_EMPTY, state)
P8W_GETTER(p8w_mode, uint32_t, P8W_MODE_NONE, mode)
P8W_GETTER(p8w_target_fps, uint32_t, 0, target_fps)
P8W_GETTER(p8w_yield_reason, uint32_t, P8W_YIELD_NONE, yield_reason)
P8W_GETTER(p8w_phase, uint32_t, P8W_PHASE_NONE, phase)
P8W_GETTER(p8w_pending_request_id, uint32_t, 0, request_id)
P8W_GETTER(p8w_pending_request_length, uint32_t, 0, request_length)
P8W_GETTER(p8w_error_status, uint32_t, P8W_STATUS_INVALID_HANDLE, error_status)
P8W_GETTER(p8w_error_line, int32_t, -1, error_line)
P8W_GETTER(p8w_error_message_length, uint32_t, 0, error_message_length)
P8W_GETTER(p8w_error_trace_length, uint32_t, 0, error_trace_length)

#undef P8W_GETTER

EMSCRIPTEN_KEEPALIVE uint32_t p8w_consumed_instructions(uint32_t handle) {
  Context *context = context_from_handle(handle);
  return context == nullptr || context->remaining_budget > context->budget_start
             ? 0
             : context->budget_start - context->remaining_budget;
}

EMSCRIPTEN_KEEPALIVE const uint8_t *p8w_pending_request_ptr(uint32_t handle) {
  Context *context = context_from_handle(handle);
  return context == nullptr || !context->pending_request
             ? nullptr
             : context->request_bytes;
}

EMSCRIPTEN_KEEPALIVE const char *p8w_error_message_ptr(uint32_t handle) {
  Context *context = context_from_handle(handle);
  return context == nullptr ? nullptr : context->error_message;
}

EMSCRIPTEN_KEEPALIVE const char *p8w_error_trace_ptr(uint32_t handle) {
  Context *context = context_from_handle(handle);
  return context == nullptr ? nullptr : context->error_trace;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w_ram_ptr(uint32_t handle) {
  Context *context = context_from_handle(handle);
  return context == nullptr
             ? 0
             : static_cast<uint32_t>(reinterpret_cast<uintptr_t>(context->ram));
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w_ram_size(uint32_t handle) {
  return context_from_handle(handle) == nullptr ? 0 : p8w::kPicoRamSize;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w_ram_reset(uint32_t handle) {
  Context *context = context_from_handle(handle);
  if (context == nullptr) return P8W_STATUS_INVALID_HANDLE;
  reset_ram(context);
  return P8W_STATUS_OK;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w_map_address(uint32_t handle,
                                             uint32_t logical_address) {
  Context *context = context_from_handle(handle);
  return context == nullptr ? 0xffffffffu
                            : p8w::map_address(context->ram, logical_address);
}

EMSCRIPTEN_KEEPALIVE void *p8w_alloc(uint32_t size) {
  return size == 0 ? nullptr : std::malloc(size);
}

EMSCRIPTEN_KEEPALIVE void p8w_free(void *pointer) { std::free(pointer); }

}  // extern "C"
