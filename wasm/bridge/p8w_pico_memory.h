#ifndef P8W_PICO_MEMORY_H
#define P8W_PICO_MEMORY_H

#include <stdint.h>

namespace p8w {

constexpr uint32_t kPicoRamSize = 0x10000u;
constexpr int kOriginalEnvironmentRegistryIndex = 3;
constexpr uint16_t kGfxMapRegister = 0x5f54u;
constexpr uint16_t kScreenMapRegister = 0x5f55u;
constexpr uint16_t kMapBaseRegister = 0x5f56u;
constexpr uint16_t kMapWidthRegister = 0x5f57u;

uint16_t normalize_address(int32_t address);
uint16_t map_address(const uint8_t *ram, uint32_t logical_address);

uint8_t read8(const uint8_t *ram, uint32_t logical_address);
uint16_t read16(const uint8_t *ram, uint32_t logical_address);
uint32_t read32(const uint8_t *ram, uint32_t logical_address);

void write8(uint8_t *ram, uint32_t logical_address, uint8_t value);
void write16(uint8_t *ram, uint32_t logical_address, uint16_t value);
void write32(uint8_t *ram, uint32_t logical_address, uint32_t value);

}  // namespace p8w

#endif
