#include "p8w_interop_bench.h"

#include <emscripten/em_js.h>
#include <emscripten/emscripten.h>

#include "p8w_baseline.h"
#include "p8w_pico_memory.h"

namespace {

constexpr uint32_t kBenchAbiVersion = 0x00030000u;
constexpr uint32_t kFnvOffset = 2166136261u;
constexpr uint32_t kFnvPrime = 16777619u;
constexpr uint32_t kScreenLogicalBase = 0x6000u;
constexpr uint32_t kPackedRowBytes = 64u;
constexpr uint32_t kSpriteColumns = 16u;
constexpr uint32_t kSpritePixels = 8u;
constexpr uint32_t kMaxSpritePosition = 120u;
constexpr uint32_t kInvalidResult = 0xffffffffu;

volatile uint32_t g_bench_sink = 0;

uint32_t next_random(uint32_t &state) {
  state = state * 1664525u + 1013904223u;
  return state;
}

uint32_t combine(uint32_t accumulator, uint32_t value, uint32_t index) {
  return (accumulator ^ value ^ index) * kFnvPrime;
}

uint32_t raw3_value(uint32_t a, uint32_t b, uint32_t c) {
  return (a + ((b << 7u) | (b >> 25u))) ^ c;
}

uint32_t bytes_checksum(const uint8_t *bytes, uint32_t length) {
  uint32_t hash = kFnvOffset;
  for (uint32_t index = 0; index < length; ++index) {
    hash = (hash ^ bytes[index]) * kFnvPrime;
  }
  return hash;
}

uint8_t *ram_for_handle(uint32_t handle) {
  const uint32_t pointer = p8w0b_ram_ptr(handle);
  return pointer == 0 ? nullptr
                      : reinterpret_cast<uint8_t *>(
                            static_cast<uintptr_t>(pointer));
}

uint8_t write_packed_pixel(uint8_t *ram, uint32_t physical_address,
                           uint32_t x, uint32_t color) {
  const uint32_t shift = (x & 1u) << 2u;
  const uint8_t mask = static_cast<uint8_t>(0x0fu << shift);
  const uint8_t current = ram[physical_address];
  const uint8_t updated = static_cast<uint8_t>(
      (current & static_cast<uint8_t>(~mask)) | ((color & 0x0fu) << shift));
  ram[physical_address] = updated;
  return updated;
}

uint32_t control_pset(uint8_t *ram, uint32_t x, uint32_t y,
                      uint32_t color) {
  x &= 0x7fu;
  y &= 0x7fu;
  const uint32_t logical =
      kScreenLogicalBase + y * kPackedRowBytes + (x >> 1u);
  return write_packed_pixel(ram, p8w::map_address(ram, logical), x, color);
}

uint32_t control_peek_poke(uint8_t *ram, uint32_t logical_address,
                           uint32_t value) {
  const uint32_t physical = p8w::map_address(ram, logical_address);
  const uint8_t previous = ram[physical];
  const uint8_t updated = static_cast<uint8_t>(value);
  ram[physical] = updated;
  return previous | (static_cast<uint32_t>(updated) << 8u);
}

uint8_t read_packed_pixel(const uint8_t *ram, uint32_t base,
                          uint32_t x, uint32_t y) {
  const uint8_t packed = ram[base + y * kPackedRowBytes + (x >> 1u)];
  return static_cast<uint8_t>((packed >> ((x & 1u) << 2u)) & 0x0fu);
}

uint32_t control_spr(uint8_t *ram, uint32_t sprite, uint32_t destination_x,
                     uint32_t destination_y) {
  const uint32_t gfx_base = p8w::map_address(ram, 0x0000u);
  const uint32_t screen_base = p8w::map_address(ram, kScreenLogicalBase);
  const uint32_t source_x = (sprite % kSpriteColumns) * kSpritePixels;
  const uint32_t source_y = (sprite / kSpriteColumns) * kSpritePixels;
  uint32_t hash = kFnvOffset;
  for (uint32_t row = 0; row < kSpritePixels; ++row) {
    for (uint32_t column = 0; column < kSpritePixels; ++column) {
      const uint8_t color =
          read_packed_pixel(ram, gfx_base, source_x + column, source_y + row);
      const uint32_t x = destination_x + column;
      const uint32_t y = destination_y + row;
      const uint32_t physical =
          screen_base + y * kPackedRowBytes + (x >> 1u);
      const uint8_t updated = write_packed_pixel(ram, physical, x, color);
      hash = (hash ^ updated) * kFnvPrime;
    }
  }
  return hash;
}

EM_JS(uint32_t, p8w0c_js_noop, (uint32_t value), { return value >>> 0; });

EM_JS(uint32_t, p8w0c_js_raw3,
      (uint32_t a, uint32_t b, uint32_t c), {
        return ((a + ((b << 7) | (b >>> 25))) ^ c) >>> 0;
      });

EM_JS(uint32_t, p8w0c_js_bytes,
      (const uint8_t *bytes, uint32_t length), {
        let hash = 2166136261;
        for (let index = 0; index < length; ++index) {
          hash = Math.imul(hash ^ HEAPU8[bytes + index], 16777619);
        }
        return hash >>> 0;
      });

EM_JS(uint32_t, p8w0c_js_pset,
      (uint32_t ram_pointer, uint32_t physical_address, uint32_t x,
       uint32_t color), {
        const pointer = ram_pointer + physical_address;
        const shift = (x & 1) << 2;
        const mask = 15 << shift;
        const updated = (HEAPU8[pointer] & ~mask) | ((color & 15) << shift);
        HEAPU8[pointer] = updated;
        return updated >>> 0;
      });

EM_JS(uint32_t, p8w0c_js_peek_poke,
      (uint32_t ram_pointer, uint32_t physical_address, uint32_t value), {
        const pointer = ram_pointer + physical_address;
        const previous = HEAPU8[pointer];
        const updated = value & 255;
        HEAPU8[pointer] = updated;
        return (previous | (updated << 8)) >>> 0;
      });

EM_JS(uint32_t, p8w0c_js_spr,
      (uint32_t ram_pointer, uint32_t gfx_base, uint32_t screen_base,
       uint32_t sprite, uint32_t destination_x, uint32_t destination_y), {
        const fnvPrime = 16777619;
        const sourceX = (sprite & 15) << 3;
        const sourceY = (sprite >>> 4) << 3;
        let hash = 2166136261;
        for (let row = 0; row < 8; ++row) {
          for (let column = 0; column < 8; ++column) {
            const sx = sourceX + column;
            const sourcePacked = HEAPU8[
              ram_pointer + gfx_base + (sourceY + row) * 64 + (sx >>> 1)
            ];
            const color = (sourcePacked >>> ((sx & 1) << 2)) & 15;
            const x = destination_x + column;
            const y = destination_y + row;
            const pointer =
              ram_pointer + screen_base + y * 64 + (x >>> 1);
            const shift = (x & 1) << 2;
            const mask = 15 << shift;
            const updated =
              (HEAPU8[pointer] & ~mask) | ((color & 15) << shift);
            HEAPU8[pointer] = updated;
            hash = Math.imul(hash ^ updated, fnvPrime);
          }
        }
        return hash >>> 0;
      });

uint32_t pset_loop(uint8_t *ram, uint32_t count, uint32_t seed,
                   bool imported) {
  uint32_t state = seed;
  uint32_t accumulator = kFnvOffset;
  const uint32_t ram_pointer =
      static_cast<uint32_t>(reinterpret_cast<uintptr_t>(ram));
  for (uint32_t index = 0; index < count; ++index) {
    const uint32_t x = next_random(state) & 0x7fu;
    const uint32_t y = next_random(state) & 0x7fu;
    const uint32_t color = next_random(state) & 0x0fu;
    uint32_t result;
    if (imported) {
      const uint32_t logical =
          kScreenLogicalBase + y * kPackedRowBytes + (x >> 1u);
      result = p8w0c_js_pset(ram_pointer,
                             p8w::map_address(ram, logical), x, color);
    } else {
      result = control_pset(ram, x, y, color);
    }
    accumulator = combine(accumulator, result, index);
  }
  g_bench_sink = accumulator;
  return accumulator;
}

uint32_t peek_poke_loop(uint8_t *ram, uint32_t count, uint32_t seed,
                        bool imported) {
  uint32_t state = seed;
  uint32_t accumulator = kFnvOffset;
  const uint32_t ram_pointer =
      static_cast<uint32_t>(reinterpret_cast<uintptr_t>(ram));
  for (uint32_t index = 0; index < count; ++index) {
    const uint32_t selector = next_random(state);
    const uint32_t logical = (selector & 1u) == 0
                                 ? selector & 0x1fffu
                                 : kScreenLogicalBase + (selector & 0x1fffu);
    const uint32_t value = next_random(state);
    const uint32_t physical = p8w::map_address(ram, logical);
    const uint32_t result = imported
                                ? p8w0c_js_peek_poke(ram_pointer, physical, value)
                                : control_peek_poke(ram, logical, value);
    accumulator = combine(accumulator, result, index);
  }
  g_bench_sink = accumulator;
  return accumulator;
}

uint32_t spr_loop(uint8_t *ram, uint32_t count, uint32_t seed,
                  bool imported) {
  uint32_t state = seed;
  uint32_t accumulator = kFnvOffset;
  const uint32_t ram_pointer =
      static_cast<uint32_t>(reinterpret_cast<uintptr_t>(ram));
  for (uint32_t index = 0; index < count; ++index) {
    const uint32_t sprite = next_random(state) & 0x7fu;
    const uint32_t x = next_random(state) % (kMaxSpritePosition + 1u);
    const uint32_t y = next_random(state) % (kMaxSpritePosition + 1u);
    const uint32_t result =
        imported
            ? p8w0c_js_spr(ram_pointer, p8w::map_address(ram, 0x0000u),
                           p8w::map_address(ram, kScreenLogicalBase), sprite, x,
                           y)
            : control_spr(ram, sprite, x, y);
    accumulator = combine(accumulator, result, index);
  }
  g_bench_sink = accumulator;
  return accumulator;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_abi_version(void) {
  return kBenchAbiVersion;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_export_noop(uint32_t value) {
  g_bench_sink = value;
  return value;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_export_raw3(uint32_t a, uint32_t b,
                                                     uint32_t c) {
  const uint32_t result = raw3_value(a, b, c);
  g_bench_sink = result;
  return result;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_export_bytes(const uint8_t *bytes,
                                                      uint32_t length) {
  const uint32_t result = bytes_checksum(bytes, length);
  g_bench_sink = result;
  return result;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_export_pset(
    uint32_t handle, uint32_t x, uint32_t y, uint32_t color) {
  uint8_t *ram = ram_for_handle(handle);
  return ram == nullptr ? kInvalidResult : control_pset(ram, x, y, color);
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_export_peek_poke(
    uint32_t handle, uint32_t logical_address, uint32_t value) {
  uint8_t *ram = ram_for_handle(handle);
  return ram == nullptr ? kInvalidResult
                        : control_peek_poke(ram, logical_address, value);
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_export_spr(
    uint32_t handle, uint32_t sprite, uint32_t x, uint32_t y) {
  uint8_t *ram = ram_for_handle(handle);
  return ram == nullptr ? kInvalidResult : control_spr(ram, sprite, x, y);
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_import_noop(uint32_t count,
                                                     uint32_t seed) {
  uint32_t state = seed;
  uint32_t accumulator = kFnvOffset;
  for (uint32_t index = 0; index < count; ++index) {
    accumulator =
        combine(accumulator, p8w0c_js_noop(next_random(state)), index);
  }
  g_bench_sink = accumulator;
  return accumulator;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_import_raw3(uint32_t count,
                                                     uint32_t seed) {
  uint32_t state = seed;
  uint32_t accumulator = kFnvOffset;
  for (uint32_t index = 0; index < count; ++index) {
    const uint32_t result = p8w0c_js_raw3(
        next_random(state), next_random(state), next_random(state));
    accumulator = combine(accumulator, result, index);
  }
  g_bench_sink = accumulator;
  return accumulator;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_import_bytes(
    const uint8_t *bytes, uint32_t length, uint32_t count, uint32_t seed) {
  uint32_t state = seed;
  uint32_t accumulator = kFnvOffset;
  for (uint32_t index = 0; index < count; ++index) {
    accumulator = combine(accumulator,
                          p8w0c_js_bytes(bytes, length) ^ next_random(state),
                          index);
  }
  g_bench_sink = accumulator;
  return accumulator;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_import_pset(
    uint32_t handle, uint32_t count, uint32_t seed) {
  uint8_t *ram = ram_for_handle(handle);
  return ram == nullptr ? kInvalidResult : pset_loop(ram, count, seed, true);
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_import_peek_poke(
    uint32_t handle, uint32_t count, uint32_t seed) {
  uint8_t *ram = ram_for_handle(handle);
  return ram == nullptr ? kInvalidResult
                        : peek_poke_loop(ram, count, seed, true);
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_import_spr(
    uint32_t handle, uint32_t count, uint32_t seed) {
  uint8_t *ram = ram_for_handle(handle);
  return ram == nullptr ? kInvalidResult : spr_loop(ram, count, seed, true);
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_control_noop(uint32_t count,
                                                      uint32_t seed) {
  uint32_t state = seed;
  uint32_t accumulator = kFnvOffset;
  for (uint32_t index = 0; index < count; ++index) {
    const uint32_t value = next_random(state);
    g_bench_sink = value;
    accumulator = combine(accumulator, value, index);
  }
  g_bench_sink = accumulator;
  return accumulator;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_control_raw3(uint32_t count,
                                                      uint32_t seed) {
  uint32_t state = seed;
  uint32_t accumulator = kFnvOffset;
  for (uint32_t index = 0; index < count; ++index) {
    const uint32_t result = raw3_value(
        next_random(state), next_random(state), next_random(state));
    g_bench_sink = result;
    accumulator = combine(accumulator, result, index);
  }
  g_bench_sink = accumulator;
  return accumulator;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_control_bytes(
    const uint8_t *bytes, uint32_t length, uint32_t count, uint32_t seed) {
  uint32_t state = seed;
  uint32_t accumulator = kFnvOffset;
  for (uint32_t index = 0; index < count; ++index) {
    accumulator = combine(accumulator,
                          bytes_checksum(bytes, length) ^ next_random(state),
                          index);
  }
  g_bench_sink = accumulator;
  return accumulator;
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_control_pset(
    uint32_t handle, uint32_t count, uint32_t seed) {
  uint8_t *ram = ram_for_handle(handle);
  return ram == nullptr ? kInvalidResult : pset_loop(ram, count, seed, false);
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_control_peek_poke(
    uint32_t handle, uint32_t count, uint32_t seed) {
  uint8_t *ram = ram_for_handle(handle);
  return ram == nullptr ? kInvalidResult
                        : peek_poke_loop(ram, count, seed, false);
}

EMSCRIPTEN_KEEPALIVE uint32_t p8w0c_bench_control_spr(
    uint32_t handle, uint32_t count, uint32_t seed) {
  uint8_t *ram = ram_for_handle(handle);
  return ram == nullptr ? kInvalidResult : spr_loop(ram, count, seed, false);
}

}  // extern "C"
