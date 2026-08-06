#ifndef P8W_PICO8_COMPAT_H
#define P8W_PICO8_COMPAT_H

#include <cstdint>

struct lua_State;

namespace p8w {

// Installs project-owned P8 Lua helpers. Table/function values, including the
// bounded menuitem registry, remain inside the VM; the RAM pointer is used
// only for the documented PRNG state.
void open_pico8_compat(lua_State *state, uint8_t *pico_ram);

}  // namespace p8w

#endif
