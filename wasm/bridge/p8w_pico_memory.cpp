#include "p8w_pico_memory.h"

namespace p8w {
namespace {

constexpr uint16_t kVideoBlockSize = 0x2000u;
constexpr uint16_t kScreenWindow = 0x6000u;

bool is_valid_video_base(uint8_t base) {
  switch (base) {
    case 0x00:
    case 0x60:
    case 0x80:
    case 0xa0:
    case 0xc0:
    case 0xe0:
      return true;
    default:
      return false;
  }
}

bool conflicts_with_upper_map(const uint8_t *ram, uint8_t video_base) {
  const uint8_t map_base = ram[kMapBaseRegister];
  if (map_base < 0x80u || video_base < 0x80u) return false;
  const uint32_t map_start = static_cast<uint32_t>(map_base) << 8u;
  const uint32_t video_start = static_cast<uint32_t>(video_base) << 8u;
  return video_start < kPicoRamSize &&
         video_start + kVideoBlockSize > map_start;
}

uint16_t mapped_video_address(const uint8_t *ram, uint8_t configured_base,
                              uint8_t fallback_base, uint16_t offset) {
  const uint8_t base = is_valid_video_base(configured_base) &&
                               !conflicts_with_upper_map(ram, configured_base)
                           ? configured_base
                           : fallback_base;
  return static_cast<uint16_t>((static_cast<uint16_t>(base) << 8u) + offset);
}

}  // namespace

uint16_t normalize_address(int32_t address) {
  return static_cast<uint16_t>(static_cast<uint32_t>(address) & 0xffffu);
}

uint16_t map_address(const uint8_t *ram, uint32_t logical_address) {
  const uint16_t address = static_cast<uint16_t>(logical_address & 0xffffu);
  if (ram == nullptr) {
    return address;
  }
  if (address < kVideoBlockSize) {
    return mapped_video_address(ram, ram[kGfxMapRegister], 0x00u, address);
  }
  if (address >= kScreenWindow &&
      address < static_cast<uint16_t>(kScreenWindow + kVideoBlockSize)) {
    return mapped_video_address(ram, ram[kScreenMapRegister], 0x60u,
                                static_cast<uint16_t>(address - kScreenWindow));
  }
  return address;
}

uint8_t read8(const uint8_t *ram, uint32_t logical_address) {
  return ram == nullptr ? 0u : ram[map_address(ram, logical_address)];
}

uint16_t read16(const uint8_t *ram, uint32_t logical_address) {
  return static_cast<uint16_t>(read8(ram, logical_address)) |
         static_cast<uint16_t>(read8(ram, logical_address + 1u) << 8u);
}

uint32_t read32(const uint8_t *ram, uint32_t logical_address) {
  return static_cast<uint32_t>(read8(ram, logical_address)) |
         (static_cast<uint32_t>(read8(ram, logical_address + 1u)) << 8u) |
         (static_cast<uint32_t>(read8(ram, logical_address + 2u)) << 16u) |
         (static_cast<uint32_t>(read8(ram, logical_address + 3u)) << 24u);
}

void write8(uint8_t *ram, uint32_t logical_address, uint8_t value) {
  if (ram != nullptr) {
    ram[map_address(ram, logical_address)] = value;
  }
}

void write16(uint8_t *ram, uint32_t logical_address, uint16_t value) {
  write8(ram, logical_address, static_cast<uint8_t>(value));
  write8(ram, logical_address + 1u, static_cast<uint8_t>(value >> 8u));
}

void write32(uint8_t *ram, uint32_t logical_address, uint32_t value) {
  write8(ram, logical_address, static_cast<uint8_t>(value));
  write8(ram, logical_address + 1u, static_cast<uint8_t>(value >> 8u));
  write8(ram, logical_address + 2u, static_cast<uint8_t>(value >> 16u));
  write8(ram, logical_address + 3u, static_cast<uint8_t>(value >> 24u));
}

}  // namespace p8w
