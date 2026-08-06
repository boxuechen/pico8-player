#include "p8w_pico8_compat.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>

#include "lauxlib.h"
#include "lua.h"

namespace p8w {
namespace {

constexpr uint32_t kPrngAddress = 0x5f44u;
constexpr uint32_t kDefaultSeed = 0xdeadbeefu;
constexpr uint32_t kSeedXor = 0xbead29bau;

uint32_t read_u32(const uint8_t *ram, uint32_t address) {
  return static_cast<uint32_t>(ram[address]) |
         (static_cast<uint32_t>(ram[address + 1u]) << 8u) |
         (static_cast<uint32_t>(ram[address + 2u]) << 16u) |
         (static_cast<uint32_t>(ram[address + 3u]) << 24u);
}

void write_u32(uint8_t *ram, uint32_t address, uint32_t value) {
  ram[address] = static_cast<uint8_t>(value);
  ram[address + 1u] = static_cast<uint8_t>(value >> 8u);
  ram[address + 2u] = static_cast<uint8_t>(value >> 16u);
  ram[address + 3u] = static_cast<uint8_t>(value >> 24u);
}

uint8_t *prng_ram(lua_State *state) {
  return static_cast<uint8_t *>(lua_touserdata(state, lua_upvalueindex(1)));
}

uint32_t update_prng(uint8_t *ram) {
  uint32_t a = read_u32(ram, kPrngAddress);
  uint32_t b = read_u32(ram, kPrngAddress + 4u);
  a = ((a >> 16u) | (a << 16u)) + b;
  b += a;
  write_u32(ram, kPrngAddress, a);
  write_u32(ram, kPrngAddress + 4u, b);
  return a;
}

void seed_prng(uint8_t *ram, uint32_t seed) {
  seed &= 0x7fffffffu;
  const uint32_t b = seed == 0 ? kDefaultSeed : seed;
  write_u32(ram, kPrngAddress, b ^ kSeedXor);
  write_u32(ram, kPrngAddress + 4u, b);
  for (int index = 0; index < 32; ++index) update_prng(ram);
}

int pico8_srand(lua_State *state) {
  const uint32_t seed = static_cast<uint32_t>(luaL_checknumber(state, 1).bits());
  seed_prng(prng_ram(state), seed);
  return 0;
}

int pico8_rnd(lua_State *state) {
  uint8_t *ram = prng_ram(state);
  if (lua_istable(state, 1)) {
    const size_t length = lua_rawlen(state, 1);
    if (length == 0) {
      lua_pushnil(state);
      return 1;
    }
    const uint32_t range = static_cast<uint32_t>(length) << 16u;
    const uint32_t raw = update_prng(ram) % range;
    lua_rawgeti(state, 1, static_cast<int>((raw >> 16u) + 1u));
    return 1;
  }
  const uint32_t range = lua_isnoneornil(state, 1)
                             ? 0x00010000u
                             : static_cast<uint32_t>(
                                   luaL_checknumber(state, 1).bits());
  const uint32_t raw = range == 0 ? 0 : update_prng(ram) % range;
  lua_pushnumber(state, lua_Number::frombits(static_cast<int32_t>(raw)));
  return 1;
}

int normalized_index(lua_State *state, int argument, int minimum,
                     int maximum, int fallback) {
  if (lua_isnoneornil(state, argument)) return fallback;
  const int value = static_cast<int>(luaL_checknumber(state, argument));
  return std::max(minimum, std::min(value, maximum));
}

int pico8_add(lua_State *state) {
  if (lua_isnil(state, 1)) return 0;
  luaL_checktype(state, 1, LUA_TTABLE);
  const size_t length = lua_rawlen(state, 1);
  const int end = static_cast<int>(length) + 1;
  const int index = normalized_index(state, 3, 1, end, end);
  for (int cursor = static_cast<int>(length); cursor >= index; --cursor) {
    lua_rawgeti(state, 1, cursor);
    lua_rawseti(state, 1, cursor + 1);
  }
  lua_pushvalue(state, 2);
  lua_rawseti(state, 1, index);
  lua_pushvalue(state, 2);
  return 1;
}

int pico8_del(lua_State *state) {
  if (lua_isnil(state, 1)) return 0;
  luaL_checktype(state, 1, LUA_TTABLE);
  const int length = static_cast<int>(lua_rawlen(state, 1));
  for (int index = 1; index <= length; ++index) {
    lua_rawgeti(state, 1, index);
    if (!lua_rawequal(state, -1, 2)) {
      lua_pop(state, 1);
      continue;
    }
    for (int cursor = index; cursor < length; ++cursor) {
      lua_rawgeti(state, 1, cursor + 1);
      lua_rawseti(state, 1, cursor);
    }
    lua_pushnil(state);
    lua_rawseti(state, 1, length);
    return 1;
  }
  return 0;
}

int pico8_deli(lua_State *state) {
  if (lua_isnil(state, 1)) return 0;
  luaL_checktype(state, 1, LUA_TTABLE);
  const int length = static_cast<int>(lua_rawlen(state, 1));
  if (length == 0) {
    lua_pushnil(state);
    return 1;
  }
  const int index = normalized_index(state, 2, 1, length, length);
  lua_rawgeti(state, 1, index);
  for (int cursor = index; cursor < length; ++cursor) {
    lua_rawgeti(state, 1, cursor + 1);
    lua_rawseti(state, 1, cursor);
  }
  lua_pushnil(state);
  lua_rawseti(state, 1, length);
  return 1;
}

int pico8_count(lua_State *state) {
  luaL_checktype(state, 1, LUA_TTABLE);
  const int length = static_cast<int>(lua_rawlen(state, 1));
  int count = 0;
  const bool count_value = !lua_isnoneornil(state, 2);
  for (int index = 1; index <= length; ++index) {
    lua_rawgeti(state, 1, index);
    if (count_value ? lua_rawequal(state, -1, 2) : !lua_isnil(state, -1)) {
      ++count;
    }
    lua_pop(state, 1);
  }
  lua_pushinteger(state, count);
  return 1;
}

int pico8_all_next(lua_State *state) {
  int index = static_cast<int>(lua_tointeger(state, lua_upvalueindex(2)));
  lua_rawgeti(state, lua_upvalueindex(1), index);
  if (lua_rawequal(state, -1, lua_upvalueindex(3))) {
    lua_pop(state, 1);
    ++index;
  } else {
    lua_pop(state, 1);
  }
  const int length = static_cast<int>(lua_rawlen(state, lua_upvalueindex(1)));
  while (index <= length) {
    lua_rawgeti(state, lua_upvalueindex(1), index);
    if (!lua_isnil(state, -1)) {
      lua_pushinteger(state, index);
      lua_copy(state, -1, lua_upvalueindex(2));
      lua_pop(state, 1);
      lua_pushvalue(state, -1);
      lua_copy(state, -1, lua_upvalueindex(3));
      lua_pop(state, 1);
      return 1;
    }
    lua_pop(state, 1);
    ++index;
  }
  return 0;
}

int pico8_empty_iterator(lua_State *) { return 0; }

int pico8_all(lua_State *state) {
  if (lua_isnil(state, 1)) {
    lua_pushcfunction(state, pico8_empty_iterator);
    return 1;
  }
  luaL_checktype(state, 1, LUA_TTABLE);
  lua_pushvalue(state, 1);
  lua_pushinteger(state, 1);
  lua_pushnil(state);
  lua_pushcclosure(state, pico8_all_next, 3);
  return 1;
}

int pico8_foreach(lua_State *state) {
  if (lua_isnil(state, 1)) return 0;
  luaL_checktype(state, 1, LUA_TTABLE);
  luaL_checktype(state, 2, LUA_TFUNCTION);
  lua_settop(state, 2);  // PICO-8 ignores extra arguments.
  int index = 1;
  lua_pushnil(state);  // Previous yielded value.
  for (;;) {
    lua_rawgeti(state, 1, index);
    if (lua_rawequal(state, -1, 3)) {
      lua_pop(state, 1);
      ++index;
    } else {
      lua_pop(state, 1);
    }
    const int length = static_cast<int>(lua_rawlen(state, 1));
    while (index <= length) {
      lua_rawgeti(state, 1, index);
      if (!lua_isnil(state, -1)) break;
      lua_pop(state, 1);
      ++index;
    }
    if (index > length) return 0;
    lua_pushvalue(state, 2);
    lua_pushvalue(state, -2);
    lua_call(state, 1, 0);
    lua_replace(state, 3);
  }
}

int relative_position(int position, size_t length) {
  if (position >= 0) return position;
  const auto relative = static_cast<int64_t>(length) + position + 1;
  return relative < 0 ? 0 : static_cast<int>(relative);
}

int pico8_sub(lua_State *state) {
  size_t length = 0;
  const char *string = luaL_checklstring(state, 1, &length);
  int first = relative_position(static_cast<int>(luaL_checknumber(state, 2)), length);
  int last;
  if (lua_isnoneornil(state, 3)) {
    last = static_cast<int>(length);
  } else if (lua_isnumber(state, 3)) {
    last = relative_position(static_cast<int>(lua_tonumber(state, 3)), length);
  } else {
    last = first;
  }
  first = std::max(first, 1);
  last = std::min(last, static_cast<int>(length));
  if (first <= last) {
    lua_pushlstring(state, string + first - 1,
                    static_cast<size_t>(last - first + 1));
  } else {
    lua_pushliteral(state, "");
  }
  return 1;
}

void register_function(lua_State *state, const char *name,
                       lua_CFunction function) {
  lua_pushcfunction(state, function);
  lua_setglobal(state, name);
}

void register_prng_function(lua_State *state, const char *name,
                            lua_CFunction function, uint8_t *ram) {
  lua_pushlightuserdata(state, ram);
  lua_pushcclosure(state, function, 1);
  lua_setglobal(state, name);
}

}  // namespace

void open_pico8_compat(lua_State *state, uint8_t *pico_ram) {
  register_function(state, "add", pico8_add);
  register_function(state, "del", pico8_del);
  register_function(state, "deli", pico8_deli);
  register_function(state, "count", pico8_count);
  register_function(state, "all", pico8_all);
  register_function(state, "foreach", pico8_foreach);
  register_function(state, "sub", pico8_sub);
  register_prng_function(state, "rnd", pico8_rnd, pico_ram);
  register_prng_function(state, "srand", pico8_srand, pico_ram);
  seed_prng(pico_ram, 0);
}

}  // namespace p8w
