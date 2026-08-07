#ifndef P8W_FRAME_RUNTIME_H
#define P8W_FRAME_RUNTIME_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum P8wStatus {
  P8W_STATUS_OK = 0,
  P8W_STATUS_YIELDED = 1,
  P8W_STATUS_INVALID_HANDLE = 2,
  P8W_STATUS_INVALID_STATE = 3,
  P8W_STATUS_BAD_ARGUMENT = 4,
  P8W_STATUS_LOAD_ERROR = 5,
  P8W_STATUS_RUNTIME_ERROR = 6,
  P8W_STATUS_INSTRUCTION_BUDGET = 7,
  P8W_STATUS_OUT_OF_MEMORY = 8,
  P8W_STATUS_FEATURE_UNSUPPORTED = 9,
  P8W_STATUS_HOST_ERROR = 10,
  P8W_STATUS_STOPPED = 11,
  P8W_STATUS_INTERNAL_ERROR = 12,
  P8W_STATUS_HOST_API_ERROR = 13,
  P8W_STATUS_RESTART = 14,
};

enum P8wVmState {
  P8W_STATE_EMPTY = 0,
  P8W_STATE_COMPILED = 1,
  P8W_STATE_BOOTING = 2,
  P8W_STATE_CALLBACK_LOOP = 3,
  P8W_STATE_CUSTOM_LOOP = 4,
  P8W_STATE_WAITING_HOST = 5,
  P8W_STATE_FAULTED = 6,
  P8W_STATE_STOPPED = 7,
};

enum P8wVmMode {
  P8W_MODE_NONE = 0,
  P8W_MODE_CALLBACK = 1,
  P8W_MODE_CUSTOM = 2,
};

enum P8wYieldReason {
  P8W_YIELD_NONE = 0,
  P8W_YIELD_FRAME_END = 1,
  P8W_YIELD_FLIP = 2,
  P8W_YIELD_HOST_REQUEST = 3,
  P8W_YIELD_STOP = 4,
  P8W_YIELD_RUN = 5,
};

enum P8wPhase {
  P8W_PHASE_NONE = 0,
  P8W_PHASE_COMPILE = 1,
  P8W_PHASE_BOOT = 2,
  P8W_PHASE_INIT = 3,
  P8W_PHASE_UPDATE = 4,
  P8W_PHASE_UPDATE60 = 5,
  P8W_PHASE_DRAW = 6,
  P8W_PHASE_CUSTOM_LOOP = 7,
  P8W_PHASE_HOST_CALL = 8,
  P8W_PHASE_MENUITEM = 9,
};

enum P8wMenuOutcome {
  P8W_MENU_OUTCOME_NONE = 0,
  P8W_MENU_OUTCOME_CLOSE = 1,
  P8W_MENU_OUTCOME_KEEP_OPEN = 2,
  P8W_MENU_OUTCOME_REMOVED = 3,
};

enum { P8W_MENU_SNAPSHOT_BYTES = 104 };

uint32_t p8w_abi_version(void);
uint32_t p8w_create(uint32_t lua_heap_limit);
uint32_t p8w_destroy(uint32_t handle);
uint32_t p8w_bind_host(uint32_t handle, uint32_t binding_id);
uint32_t p8w_set_run_parameter(uint32_t handle, const uint8_t *bytes,
                               uint32_t length);
uint32_t p8w_compile(uint32_t handle, const uint8_t *source,
                     uint32_t source_length);
uint32_t p8w_boot(uint32_t handle, uint32_t instruction_budget,
                  uint32_t button_mask, int32_t time_raw);
uint32_t p8w_step(uint32_t handle, uint32_t instruction_budget,
                  uint32_t button_mask, int32_t time_raw);
uint32_t p8w_complete_host_request(uint32_t handle, uint32_t request_id,
                                   const uint8_t *bytes, uint32_t length,
                                   uint32_t is_error,
                                   uint32_t instruction_budget);
uint32_t p8w_menu_snapshot(uint32_t handle, uint8_t *destination,
                           uint32_t capacity);
uint32_t p8w_menu_invoke(uint32_t handle, uint32_t slot,
                         uint32_t button_mask, uint32_t instruction_budget);
uint32_t p8w_menu_outcome(uint32_t handle);

uint32_t p8w_state(uint32_t handle);
uint32_t p8w_mode(uint32_t handle);
uint32_t p8w_target_fps(uint32_t handle);
uint32_t p8w_yield_reason(uint32_t handle);
uint32_t p8w_phase(uint32_t handle);
uint32_t p8w_consumed_instructions(uint32_t handle);
uint32_t p8w_lua_live_bytes(uint32_t handle);
uint32_t p8w_lua_heap_limit(uint32_t handle);
uint32_t p8w_live_contexts(void);

uint32_t p8w_pending_request_id(uint32_t handle);
const uint8_t *p8w_pending_request_ptr(uint32_t handle);
uint32_t p8w_pending_request_length(uint32_t handle);

const uint8_t *p8w_control_bytes_ptr(uint32_t handle);
uint32_t p8w_control_bytes_length(uint32_t handle);

uint32_t p8w_error_status(uint32_t handle);
int32_t p8w_error_line(uint32_t handle);
const char *p8w_error_message_ptr(uint32_t handle);
uint32_t p8w_error_message_length(uint32_t handle);
const char *p8w_error_trace_ptr(uint32_t handle);
uint32_t p8w_error_trace_length(uint32_t handle);

uint32_t p8w_ram_ptr(uint32_t handle);
uint32_t p8w_ram_size(uint32_t handle);
uint32_t p8w_ram_reset(uint32_t handle);
uint32_t p8w_map_address(uint32_t handle, uint32_t logical_address);

void *p8w_alloc(uint32_t size);
void p8w_free(void *pointer);

#ifdef __cplusplus
}
#endif

#endif
