#ifndef P8W_PICO8_COMPAT_H
#define P8W_PICO8_COMPAT_H

#include <cstdint>

struct lua_State;

namespace p8w {

constexpr uint32_t kMenuitemSlotCount = 5;
constexpr uint32_t kMenuitemLabelBytes = 16;
constexpr uint32_t kMenuitemSnapshotRecordBytes = 20;
constexpr uint32_t kMenuitemSnapshotBytes =
    4 + kMenuitemSlotCount * kMenuitemSnapshotRecordBytes;

enum class MenuitemLookup : uint8_t { Missing, Filtered, Ready };

// Installs project-owned P8 Lua helpers. Table/function values, including the
// bounded menuitem registry, remain inside the VM; the RAM pointer is used
// only for the documented PRNG state.
void open_pico8_compat(lua_State *state, uint8_t *pico_ram);

// Restore deterministic PRNG state after Base RAM is cleared.
void reset_pico8_compat_ram(uint8_t *pico_ram);

// Copy the VM-local five-slot registry into the fixed ADR-023 codec.
bool copy_menuitem_snapshot(lua_State *state, uint8_t *destination,
                            uint32_t capacity);

// On Ready, leaves exactly one callback function on top of state's stack.
MenuitemLookup push_menuitem_callback(lua_State *state, uint32_t slot,
                                      uint32_t button_mask);

bool menuitem_slot_occupied(lua_State *state, uint32_t slot);

}  // namespace p8w

#endif
