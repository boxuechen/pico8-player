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
#include "p8w_pico8_compat.h"
#include "p8w_pico_memory.h"

namespace {

constexpr uint32_t kAbiVersion = 0x00010004u;
constexpr uint32_t kMaxContexts = 32;
constexpr uint32_t kHandleIndexBits = 8;
constexpr uint32_t kHandleIndexMask = (1u << kHandleIndexBits) - 1u;
constexpr uint32_t kDefaultLuaHeapLimit = 1024u * 1024u;
constexpr uint32_t kMinimumLuaHeapLimit = 32u * 1024u;
constexpr uint32_t kMaxMessageLength = 1023;
constexpr uint32_t kMaxTraceLength = 2047;
constexpr uint32_t kMaxHostBytes = 4096;
constexpr uint32_t kPicoVmInstructionsPerSecond = 4000000;
constexpr uint32_t kImplicitFrameInstructions =
    kPicoVmInstructionsPerSecond / 30;
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

enum class ActiveKind : uint8_t {
  None,
  TopLevel,
  Init,
  Update,
  Update60,
  Draw,
  MenuItem,
};

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
  P8wMenuOutcome menu_outcome = P8W_MENU_OUTCOME_NONE;
  ActiveKind active_kind = ActiveKind::None;
  uint32_t target_fps = 0;
  uint32_t accounting_fps = 0;
  uint32_t button_mask = 0;
  int32_t time_raw = 0;
  uint32_t host_binding_id = 0;
  bool host_bound = false;

  uint32_t budget_start = 0;
  uint32_t remaining_budget = 0;
  uint32_t remaining_implicit_frame_budget = 0;
  uint32_t transaction_consumed = 0;
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
  uint32_t run_parameter_length = 0;
  uint32_t control_bytes_length = 0;
  uint8_t run_parameter[kMaxHostBytes] = {};
  uint8_t control_bytes[kMaxHostBytes] = {};

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
    } else if (selector == 20 || selector == 32 || selector == 33 || selector == 36 ||
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

bool copy_control_bytes(lua_State *state, int argument, Context *context) {
  size_t length = 0;
  const char *bytes = luaL_optlstring(state, argument, "", &length);
  if (length > kMaxHostBytes) {
    luaL_error(state, "runtime control payload exceeds 4096 bytes");
    return false;
  }
  context->control_bytes_length = static_cast<uint32_t>(length);
  if (length != 0) std::memcpy(context->control_bytes, bytes, length);
  return true;
}

int p8_run(lua_State *state) {
  Context *context = context_from_lua(state);
  if (state != context->active) {
    context->nested_suspend_attempt = true;
    return lua_yieldk(state, 0, 0, control_continuation);
  }
  if (!copy_control_bytes(state, 1, context)) return 0;
  context->yield_reason = P8W_YIELD_RUN;
  return lua_yieldk(state, 0, 0, control_continuation);
}

int p8_stop(lua_State *state) {
  Context *context = context_from_lua(state);
  if (state != context->active) {
    context->nested_suspend_attempt = true;
    return lua_yieldk(state, 0, 0, control_continuation);
  }
  if (!copy_control_bytes(state, 1, context)) return 0;
  context->yield_reason = P8W_YIELD_STOP;
  return lua_yieldk(state, 0, 0, control_continuation);
}

int p8_stat(lua_State *state) {
  const int32_t selector = luaL_checknumber(state, 1).bits() >> 16;
  Context *context = context_from_lua(state);
  if (selector == 1) {
    const uint64_t current_segment =
        context->remaining_budget > context->budget_start
            ? 0
            : context->budget_start - context->remaining_budget;
    const uint64_t consumed = context->transaction_consumed + current_segment;
    const uint64_t raw = consumed * context->accounting_fps * 65536u /
                         kPicoVmInstructionsPerSecond;
    lua_pushnumber(state, lua_Number::frombits(static_cast<int32_t>(
                              raw > INT32_MAX ? INT32_MAX : raw)));
    return 1;
  }
  if (selector == 6) {
    lua_pushlstring(
        state, reinterpret_cast<const char *>(context->run_parameter),
        context->run_parameter_length);
    return 1;
  }
  if (selector == 7) {
    lua_pushnumber(state, lua_Number::frombits(
                              static_cast<int32_t>(context->target_fps << 16)));
    return 1;
  }
  return p8_host_call(state);
}

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

int load_continuation(lua_State *state) {
  return luaL_error(state, "replaced load execution resumed");
}

int cart_data_continuation(lua_State *state) {
  Context *context = context_from_lua(state);
  if (!context->response_ready) {
    return luaL_error(state, "cart-data response invariant failed");
  }
  context->response_ready = false;
  if (context->response_is_error) {
    context->host_response_failed = true;
    return luaL_error(state, "external cart-data request failed");
  }
  return 0;
}

int p8_load(lua_State *state) {
  constexpr uint8_t kMagic[4] = {'P', '8', 'W', 'L'};
  constexpr size_t kHeaderBytes = 16;
  constexpr size_t kMaxRefBytes = 256;
  Context *context = context_from_lua(state);
  size_t ref_length = 0;
  size_t breadcrumb_length = 0;
  size_t parameter_length = 0;
  const char *ref = luaL_checklstring(state, 1, &ref_length);
  const bool has_breadcrumb = !lua_isnoneornil(state, 2);
  const bool has_parameter = !lua_isnoneornil(state, 3);
  const char *breadcrumb = has_breadcrumb
                               ? luaL_checklstring(state, 2, &breadcrumb_length)
                               : nullptr;
  const char *parameter = has_parameter
                              ? luaL_checklstring(state, 3, &parameter_length)
                              : nullptr;
  if (ref_length == 0 || ref_length > kMaxRefBytes ||
      kHeaderBytes + ref_length + breadcrumb_length + parameter_length >
          kMaxHostBytes ||
      breadcrumb_length > UINT16_MAX || parameter_length > UINT16_MAX) {
    return luaL_error(state, "load request exceeds local multicart limits");
  }
  if (state != context->active) {
    context->nested_suspend_attempt = true;
    return lua_yieldk(state, 0, 0, load_continuation);
  }
  if (context->pending_request) {
    return luaL_error(state, "host request already pending");
  }
  context->next_request_id += 1u;
  if (context->next_request_id == 0) context->next_request_id = 1;
  context->request_id = context->next_request_id;
  uint8_t *output = context->request_bytes;
  std::memcpy(output, kMagic, sizeof(kMagic));
  output[4] = 1;
  output[5] = 1;
  output[6] = static_cast<uint8_t>((has_breadcrumb ? 1u : 0u) |
                                   (has_parameter ? 2u : 0u));
  output[7] = 0;
  const auto write_u16 = [output](size_t offset, size_t value) {
    output[offset] = static_cast<uint8_t>(value & 0xffu);
    output[offset + 1] = static_cast<uint8_t>((value >> 8u) & 0xffu);
  };
  write_u16(8, ref_length);
  write_u16(10, breadcrumb_length);
  write_u16(12, parameter_length);
  write_u16(14, 0);
  size_t cursor = kHeaderBytes;
  std::memcpy(output + cursor, ref, ref_length);
  cursor += ref_length;
  if (breadcrumb_length != 0) {
    std::memcpy(output + cursor, breadcrumb, breadcrumb_length);
    cursor += breadcrumb_length;
  }
  if (parameter_length != 0) {
    std::memcpy(output + cursor, parameter, parameter_length);
    cursor += parameter_length;
  }
  context->request_length = static_cast<uint32_t>(cursor);
  context->pending_request = true;
  context->yield_reason = P8W_YIELD_HOST_REQUEST;
  return lua_yieldk(state, 0, static_cast<int>(context->request_id),
                    load_continuation);
}

int p8_external_cart_data(lua_State *state) {
  // The existing no-ref call remains a synchronous PicoApiHost operation.
  if (lua_isnoneornil(state, 4)) return p8_host_call(state);

  constexpr uint8_t kMagic[4] = {'P', '8', 'W', 'D'};
  constexpr size_t kHeaderBytes = 24;
  constexpr size_t kMaxRefBytes = 256;
  auto *descriptor = static_cast<const P8wHostBindingDescriptor *>(
      lua_touserdata(state, lua_upvalueindex(1)));
  Context *context = context_from_lua(state);
  if (descriptor == nullptr || context == nullptr) {
    return luaL_error(state, "external cart-data binding invariant failed");
  }
  const bool is_reload = std::strcmp(descriptor->guest_name, "reload") == 0;
  const bool is_cstore = std::strcmp(descriptor->guest_name, "cstore") == 0;
  if (!is_reload && !is_cstore) {
    return luaL_error(state, "external cart-data operation invariant failed");
  }

  uint8_t flags = 1u << 3u;
  int32_t scalars[3] = {};
  for (int index = 0; index < 3; ++index) {
    const int argument = index + 1;
    if (!lua_isnoneornil(state, argument)) {
      flags |= static_cast<uint8_t>(1u << index);
      scalars[index] = luaL_checknumber(state, argument).bits();
    }
  }
  size_t ref_length = 0;
  const char *ref = luaL_checklstring(state, 4, &ref_length);
  if (ref_length == 0 || ref_length > kMaxRefBytes ||
      kHeaderBytes + ref_length > kMaxHostBytes ||
      std::memchr(ref, '\0', ref_length) != nullptr) {
    return luaL_error(state, "external cart-data ref exceeds local multicart limits");
  }
  if (state != context->active) {
    context->nested_suspend_attempt = true;
    return lua_yieldk(state, 0, 0, cart_data_continuation);
  }
  if (context->pending_request) {
    return luaL_error(state, "host request already pending");
  }

  context->next_request_id += 1u;
  if (context->next_request_id == 0) context->next_request_id = 1;
  context->request_id = context->next_request_id;
  uint8_t *output = context->request_bytes;
  std::memcpy(output, kMagic, sizeof(kMagic));
  output[4] = 1;
  output[5] = is_reload ? 1 : 2;
  output[6] = flags;
  output[7] = 0;
  const auto write_u16 = [output](size_t offset, size_t value) {
    output[offset] = static_cast<uint8_t>(value & 0xffu);
    output[offset + 1] = static_cast<uint8_t>((value >> 8u) & 0xffu);
  };
  const auto write_i32 = [output](size_t offset, int32_t value) {
    const uint32_t bits = static_cast<uint32_t>(value);
    output[offset] = static_cast<uint8_t>(bits & 0xffu);
    output[offset + 1] = static_cast<uint8_t>((bits >> 8u) & 0xffu);
    output[offset + 2] = static_cast<uint8_t>((bits >> 16u) & 0xffu);
    output[offset + 3] = static_cast<uint8_t>((bits >> 24u) & 0xffu);
  };
  write_i32(8, scalars[0]);
  write_i32(12, scalars[1]);
  write_i32(16, scalars[2]);
  write_u16(20, ref_length);
  write_u16(22, 0);
  std::memcpy(output + kHeaderBytes, ref, ref_length);
  context->request_length = static_cast<uint32_t>(kHeaderBytes + ref_length);
  context->pending_request = true;
  context->yield_reason = P8W_YIELD_HOST_REQUEST;
  return lua_yieldk(state, 0, static_cast<int>(context->request_id),
                    cart_data_continuation);
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
    lua_CFunction function = p8_host_call;
    if (std::strcmp(binding.guest_name, "pal") == 0) function = p8_pal;
    if (std::strcmp(binding.guest_name, "stat") == 0) function = p8_stat;
    if (std::strcmp(binding.guest_name, "reload") == 0 ||
        std::strcmp(binding.guest_name, "cstore") == 0) {
      function = p8_external_cart_data;
    }
    lua_pushcclosure(state, function, 1);
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
  register_function(state, "run", p8_run);
  register_function(state, "stop", p8_stop);
  register_function(state, "load", p8_load);
  register_function(state, "flip", p8_flip);
  p8w::open_pico8_compat(state, context_from_lua(state)->ram);
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
  if (context->active_kind == ActiveKind::TopLevel) {
    if (context->remaining_implicit_frame_budget <= 1) {
      context->remaining_implicit_frame_budget = 0;
      // A hook yield belongs to the directly resumed Lua thread. Defer a
      // boundary reached inside a guest coroutine until control returns to
      // the Runtime-owned root thread, where it cannot be swallowed by
      // coresume(). The hard budget still bounds a coroutine that never
      // returns to this safe point.
      if (state == context->active) {
        context->yield_reason = P8W_YIELD_FRAME_END;
        lua_yield(state, 0);
      }
      return;
    }
    --context->remaining_implicit_frame_budget;
  }
}

bool begin_budget(Context *context, uint32_t budget, bool continuation) {
  if (budget == 0) return false;
  if (continuation) {
    if (context->remaining_budget > context->budget_start) return false;
    const uint32_t consumed = context->budget_start - context->remaining_budget;
    context->transaction_consumed =
        consumed > UINT32_MAX - context->transaction_consumed
            ? UINT32_MAX
            : context->transaction_consumed + consumed;
  } else {
    context->transaction_consumed = 0;
    context->remaining_implicit_frame_budget = kImplicitFrameInstructions;
  }
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

bool at_menu_boundary(const Context *context) {
  if (context->pending_request || context->state == P8W_STATE_WAITING_HOST) {
    return false;
  }
  if (context->state == P8W_STATE_CALLBACK_LOOP) {
    return context->active == nullptr && context->active_kind == ActiveKind::None;
  }
  // A custom-loop cart retains its suspended Runtime-owned root coroutine at
  // FLIP/frame-end. It is safe to run a separate callback thread between root
  // resumes, but never while another callback/frame operation is active.
  return context->state == P8W_STATE_CUSTOM_LOOP &&
         context->active != nullptr &&
         context->active_kind == ActiveKind::TopLevel &&
         context->yield_reason != P8W_YIELD_HOST_REQUEST;
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

void detect_callback_target_fps(Context *context) {
  context->target_fps = global_is_function(context, "_update60") ? 60 : 30;
}

void select_callback_mode(Context *context) {
  detect_callback_target_fps(context);
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
    if (context->yield_reason == P8W_YIELD_FRAME_END &&
        completed_kind == ActiveKind::TopLevel) {
      context->mode = P8W_MODE_CUSTOM;
      context->target_fps = 30;
      context->phase = P8W_PHASE_CUSTOM_LOOP;
      context->state = P8W_STATE_CUSTOM_LOOP;
      return P8W_STATUS_YIELDED;
    }
    if (context->yield_reason == P8W_YIELD_STOP ||
        context->yield_reason == P8W_YIELD_RUN) {
      const bool restart = context->yield_reason == P8W_YIELD_RUN;
      release_active(context);
      context->state = P8W_STATE_STOPPED;
      return restart ? P8W_STATUS_RESTART : P8W_STATUS_STOPPED;
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

P8wStatus finish_top_level(Context *context, bool completes_frame) {
  detect_callback_target_fps(context);
  P8wStatus status = P8W_STATUS_OK;
  if (start_global(context, "_init", ActiveKind::Init, P8W_PHASE_INIT)) {
    status = finish_callback_sequence(context);
  } else {
    select_callback_mode(context);
  }
  if (status == P8W_STATUS_OK && completes_frame) {
    context->yield_reason = P8W_YIELD_FRAME_END;
  }
  return status;
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
  const bool completes_frame =
      context->waiting_return_state == P8W_STATE_CUSTOM_LOOP;
  context->state = context->waiting_return_state;
  const ActiveKind active_kind = context->active_kind;
  const P8wStatus status = resume_active(context);
  if (status != P8W_STATUS_OK) return status;
  if (active_kind == ActiveKind::TopLevel) {
    return finish_top_level(context, completes_frame);
  }
  if (active_kind == ActiveKind::Init) {
    select_callback_mode(context);
    if (completes_frame) context->yield_reason = P8W_YIELD_FRAME_END;
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

EMSCRIPTEN_KEEPALIVE uint32_t p8w_live_contexts(void) {
  uint32_t count = 0;
  for (const auto &slot : g_slots) {
    if (slot.context != nullptr) count += 1;
  }
  return count;
}

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

EMSCRIPTEN_KEEPALIVE uint32_t p8w_lua_live_bytes(uint32_t handle) {
  Context *context = context_from_handle(handle);
  return context == nullptr ? 0 : context->allocations.live_bytes;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w_lua_heap_limit(uint32_t handle) {
  Context *context = context_from_handle(handle);
  return context == nullptr ? 0 : context->allocations.limit_bytes;
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

EMSCRIPTEN_KEEPALIVE uint32_t p8w_set_run_parameter(
    uint32_t handle, const uint8_t *bytes, uint32_t length) {
  Context *context = context_from_handle(handle);
  if (context == nullptr) return P8W_STATUS_INVALID_HANDLE;
  if (context->state != P8W_STATE_EMPTY) return P8W_STATUS_INVALID_STATE;
  if ((bytes == nullptr && length != 0) || length > kMaxHostBytes)
    return P8W_STATUS_BAD_ARGUMENT;
  context->run_parameter_length = length;
  if (length != 0) std::memcpy(context->run_parameter, bytes, length);
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
  if (!begin_budget(context, instruction_budget, false))
    return P8W_STATUS_BAD_ARGUMENT;
  context->button_mask = button_mask & 0x3fu;
  context->time_raw = time_raw;
  // PICO-8 starts in the 30 Hz profile; callback mode may select 60 Hz after
  // top-level code has installed _update60.
  context->target_fps = 30;
  // Startup always commits a 1/30-second epoch, including 60 Hz carts whose
  // completed-slice clock advances by two slices after boot.
  context->accounting_fps = 30;
  context->state = P8W_STATE_BOOTING;
  context->phase = P8W_PHASE_BOOT;
  P8wStatus status = resume_active(context);
  if (status != P8W_STATUS_OK) return status;
  return finish_top_level(context, false);
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
  if (!begin_budget(context, instruction_budget, false))
    return P8W_STATUS_BAD_ARGUMENT;
  context->accounting_fps = context->target_fps;
  context->button_mask = button_mask & 0x3fu;
  context->time_raw = time_raw;
  if (context->state == P8W_STATE_CALLBACK_LOOP)
    return run_callback_step(context);
  context->phase = P8W_PHASE_CUSTOM_LOOP;
  const ActiveKind active_kind = context->active_kind;
  const P8wStatus status = resume_active(context);
  if (status != P8W_STATUS_OK) return status;
  return active_kind == ActiveKind::TopLevel
             ? finish_top_level(context, true)
             : P8W_STATUS_OK;
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
      !begin_budget(context, instruction_budget, true))
    return P8W_STATUS_BAD_ARGUMENT;
  context->response_length = length;
  if (length != 0) std::memcpy(context->response_bytes, bytes, length);
  context->response_is_error = is_error != 0;
  context->response_ready = true;
  context->pending_request = false;
  context->phase = P8W_PHASE_HOST_CALL;
  return continue_after_host_response(context);
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w_menu_snapshot(uint32_t handle,
                                                uint8_t *destination,
                                                uint32_t capacity) {
  Context *context = context_from_handle(handle);
  if (context == nullptr) return P8W_STATUS_INVALID_HANDLE;
  if (!at_menu_boundary(context)) return P8W_STATUS_INVALID_STATE;
  if (destination == nullptr || capacity != P8W_MENU_SNAPSHOT_BYTES ||
      p8w::kMenuitemSnapshotBytes != P8W_MENU_SNAPSHOT_BYTES) {
    return P8W_STATUS_BAD_ARGUMENT;
  }
  context->menu_outcome = P8W_MENU_OUTCOME_NONE;
  return p8w::copy_menuitem_snapshot(context->main, destination, capacity)
             ? P8W_STATUS_OK
             : P8W_STATUS_INTERNAL_ERROR;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w_menu_invoke(
    uint32_t handle, uint32_t slot, uint32_t button_mask,
    uint32_t instruction_budget) {
  Context *context = context_from_handle(handle);
  if (context == nullptr) return P8W_STATUS_INVALID_HANDLE;
  if (!at_menu_boundary(context)) return P8W_STATUS_INVALID_STATE;
  if (slot < 1 || slot > p8w::kMenuitemSlotCount ||
      (button_mask != 1 && button_mask != 2 && button_mask != 4) ||
      instruction_budget == 0) {
    return P8W_STATUS_BAD_ARGUMENT;
  }

  context->menu_outcome = P8W_MENU_OUTCOME_NONE;
  const p8w::MenuitemLookup lookup =
      p8w::push_menuitem_callback(context->main, slot, button_mask);
  if (lookup != p8w::MenuitemLookup::Ready) {
    return P8W_STATUS_INVALID_STATE;
  }
  if (!begin_budget(context, instruction_budget, false)) {
    lua_pop(context->main, 1);
    return P8W_STATUS_BAD_ARGUMENT;
  }

  lua_State *saved_active = context->active;
  const int saved_active_ref = context->active_ref;
  const ActiveKind saved_active_kind = context->active_kind;
  lua_State *thread = lua_newthread(context->main);
  const int callback_ref = luaL_ref(context->main, LUA_REGISTRYINDEX);
  lua_xmove(context->main, thread, 1);
  context->active = thread;
  context->active_ref = callback_ref;
  context->active_kind = ActiveKind::MenuItem;
  context->phase = P8W_PHASE_MENUITEM;
  lua_pushnumber(thread, lua_Number(static_cast<int32_t>(button_mask)));
  const int lua_status = lua_resume(thread, context->main, 1);

  P8wStatus status = P8W_STATUS_OK;
  if (context->budget_poisoned || context->nested_suspend_attempt ||
      (lua_status != LUA_OK && lua_status != LUA_YIELD)) {
    status = classify_resume_error(context, thread, lua_status);
  } else if (lua_status == LUA_YIELD) {
    context->pending_request = false;
    context->response_ready = false;
    fault(context, P8W_STATUS_FEATURE_UNSUPPORTED,
          "menuitem callback cannot suspend");
    status = P8W_STATUS_FEATURE_UNSUPPORTED;
  }

  const bool keep_open = status == P8W_STATUS_OK && lua_gettop(thread) > 0 &&
                         lua_isboolean(thread, 1) &&
                         lua_toboolean(thread, 1) != 0;
  luaL_unref(context->main, LUA_REGISTRYINDEX, callback_ref);
  context->active = saved_active;
  context->active_ref = saved_active_ref;
  context->active_kind = saved_active_kind;
  if (status != P8W_STATUS_OK) return status;

  if (!p8w::menuitem_slot_occupied(context->main, slot)) {
    context->menu_outcome = P8W_MENU_OUTCOME_REMOVED;
  } else {
    context->menu_outcome = keep_open ? P8W_MENU_OUTCOME_KEEP_OPEN
                                      : P8W_MENU_OUTCOME_CLOSE;
  }
  context->phase = P8W_PHASE_NONE;
  context->yield_reason = P8W_YIELD_NONE;
  return P8W_STATUS_OK;
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
P8W_GETTER(p8w_control_bytes_length, uint32_t, 0, control_bytes_length)
P8W_GETTER(p8w_menu_outcome, uint32_t, P8W_MENU_OUTCOME_NONE, menu_outcome)
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

EMSCRIPTEN_KEEPALIVE const uint8_t *p8w_control_bytes_ptr(uint32_t handle) {
  Context *context = context_from_handle(handle);
  return context == nullptr || context->control_bytes_length == 0
             ? nullptr
             : context->control_bytes;
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
