#ifndef P8W_BASELINE_H
#define P8W_BASELINE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum p8w_status {
  P8W_OK = 0,
  P8W_INVALID_HANDLE = 1,
  P8W_BAD_ARGUMENT = 2,
  P8W_LOAD_ERROR = 3,
  P8W_RUNTIME_ERROR = 4,
  P8W_BUDGET_EXCEEDED = 5,
};

uint32_t p8w0a_abi_version(void);
uint32_t p8w0a_create(void);
uint32_t p8w0a_destroy(uint32_t handle);
uint32_t p8w0a_run(uint32_t handle, const char *source,
                   uint32_t source_length, uint32_t instruction_budget);

uint32_t p8w0a_result_count(uint32_t handle);
int32_t p8w0a_result_type(uint32_t handle, uint32_t result_index);
int32_t p8w0a_result_number_bits(uint32_t handle, uint32_t result_index);
uint32_t p8w0a_result_boolean(uint32_t handle, uint32_t result_index);
const char *p8w0a_result_string_ptr(uint32_t handle, uint32_t result_index);
uint32_t p8w0a_result_string_length(uint32_t handle, uint32_t result_index);

const char *p8w0a_last_error_ptr(uint32_t handle);
uint32_t p8w0a_last_error_length(uint32_t handle);

uint32_t p8w0a_live_contexts(void);
uint32_t p8w0a_live_lua_bytes(void);

void *p8w0a_alloc(uint32_t size);
void p8w0a_free(void *pointer);

#ifdef __cplusplus
}
#endif

#endif
