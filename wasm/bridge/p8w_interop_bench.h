#ifndef P8W_INTEROP_BENCH_H
#define P8W_INTEROP_BENCH_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

uint32_t p8w0c_bench_abi_version(void);

uint32_t p8w0c_bench_export_noop(uint32_t value);
uint32_t p8w0c_bench_export_raw3(uint32_t a, uint32_t b, uint32_t c);
uint32_t p8w0c_bench_export_bytes(const uint8_t *bytes, uint32_t length);
uint32_t p8w0c_bench_export_pset(uint32_t handle, uint32_t x, uint32_t y,
                                uint32_t color);
uint32_t p8w0c_bench_export_peek_poke(uint32_t handle,
                                     uint32_t logical_address,
                                     uint32_t value);
uint32_t p8w0c_bench_export_spr(uint32_t handle, uint32_t sprite,
                               uint32_t x, uint32_t y);

uint32_t p8w0c_bench_import_noop(uint32_t count, uint32_t seed);
uint32_t p8w0c_bench_import_raw3(uint32_t count, uint32_t seed);
uint32_t p8w0c_bench_import_bytes(const uint8_t *bytes, uint32_t length,
                                  uint32_t count, uint32_t seed);
uint32_t p8w0c_bench_import_pset(uint32_t handle, uint32_t count,
                                uint32_t seed);
uint32_t p8w0c_bench_import_peek_poke(uint32_t handle, uint32_t count,
                                     uint32_t seed);
uint32_t p8w0c_bench_import_spr(uint32_t handle, uint32_t count,
                               uint32_t seed);

uint32_t p8w0c_bench_control_noop(uint32_t count, uint32_t seed);
uint32_t p8w0c_bench_control_raw3(uint32_t count, uint32_t seed);
uint32_t p8w0c_bench_control_bytes(const uint8_t *bytes, uint32_t length,
                                   uint32_t count, uint32_t seed);
uint32_t p8w0c_bench_control_pset(uint32_t handle, uint32_t count,
                                 uint32_t seed);
uint32_t p8w0c_bench_control_peek_poke(uint32_t handle, uint32_t count,
                                      uint32_t seed);
uint32_t p8w0c_bench_control_spr(uint32_t handle, uint32_t count,
                                uint32_t seed);

#ifdef __cplusplus
}
#endif

#endif
