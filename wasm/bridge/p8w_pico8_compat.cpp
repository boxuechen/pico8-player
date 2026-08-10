#include "p8w_pico8_compat.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>

#include "lauxlib.h"
#include "lua.h"
#include "lobject.h"

namespace p8w {
namespace {

constexpr uint32_t kPrngAddress = 0x5f44u;
constexpr uint32_t kDefaultSeed = 0xdeadbeefu;
constexpr uint32_t kSeedXor = 0xbead29bau;
constexpr char kMenuitemRegistryKey[] = "p8w.menuitems";
constexpr int kMenuitemMinimumSlot = 1;
constexpr int kMenuitemMaximumSlot = 5;
constexpr int kMaximumChrValues = 8192;

struct P8sciiGlobal {
  uint8_t name;
  uint32_t raw_value;
};

// PICO-8 exposes the first 26 extended charset glyphs as source-level
// numeric globals: six button names and twenty built-in fill patterns. Keep
// both names and values byte/raw-bit exact; neither side is Unicode text.
constexpr P8sciiGlobal kP8sciiGlobals[] = {
    {0x80u, 0x00000000u}, {0x81u, 0x5a5a8000u},
    {0x82u, 0x511f8000u}, {0x83u, 0x00030000u},
    {0x84u, 0x7d7d8000u}, {0x85u, 0xb81d8000u},
    {0x86u, 0xf99f8000u}, {0x87u, 0x51bf8000u},
    {0x88u, 0xb5bf8000u}, {0x89u, 0x999f8000u},
    {0x8au, 0xb11f8000u}, {0x8bu, 0x00000000u},
    {0x8cu, 0xa0e08000u}, {0x8du, 0x9b3f8000u},
    {0x8eu, 0x00040000u}, {0x8fu, 0xb1bf8000u},
    {0x90u, 0xf5ff8000u}, {0x91u, 0x00010000u},
    {0x92u, 0xb15f8000u}, {0x93u, 0x1b1f8000u},
    {0x94u, 0x00020000u}, {0x95u, 0xf5bf8000u},
    {0x96u, 0x7adf8000u}, {0x97u, 0x00050000u},
    {0x98u, 0x0f0f8000u}, {0x99u, 0x55558000u},
};

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

bool parse_pico8_hex_number(const char *value, size_t length,
                            lua_Number *result) {
  if (value == nullptr || length == 0 || result == nullptr) return false;
  size_t cursor = 0;
  bool negative = false;
  if (value[cursor] == '-' || value[cursor] == '+') {
    negative = value[cursor] == '-';
    if (++cursor == length) return false;
  }
  uint32_t integer = 0;
  uint32_t fraction = 0;
  int integer_digits = 0;
  int fraction_digits = 0;
  bool dot = false;
  for (; cursor < length; ++cursor) {
    const unsigned char byte = static_cast<unsigned char>(value[cursor]);
    if (byte == '.' && !dot) {
      dot = true;
      continue;
    }
    uint32_t digit;
    if (byte >= '0' && byte <= '9') digit = byte - '0';
    else if (byte >= 'a' && byte <= 'f') digit = byte - 'a' + 10u;
    else if (byte >= 'A' && byte <= 'F') digit = byte - 'A' + 10u;
    else return false;
    if (!dot) {
      if (++integer_digits > 4) return false;
      integer = (integer << 4u) | digit;
    } else {
      if (++fraction_digits > 4) return false;
      fraction = (fraction << 4u) | digit;
    }
  }
  if (integer_digits == 0 && fraction_digits == 0) return false;
  fraction <<= static_cast<uint32_t>((4 - fraction_digits) * 4);
  uint32_t bits = (integer << 16u) | fraction;
  if (negative) bits = 0u - bits;
  *result = lua_Number::frombits(static_cast<int32_t>(bits));
  return true;
}

void seed_prng(uint8_t *ram, uint32_t seed) {
  seed &= 0x7fffffffu;
  const uint32_t b = seed == 0 ? kDefaultSeed : seed;
  write_u32(ram, kPrngAddress, b ^ kSeedXor);
  write_u32(ram, kPrngAddress + 4u, b);
  for (int index = 0; index < 32; ++index) update_prng(ram);
}

int pico8_srand(lua_State *state) {
  const uint32_t seed = lua_isnoneornil(state, 1)
                            ? 0u
                            : static_cast<uint32_t>(luaL_checknumber(state, 1).bits());
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
  lua_Number parsed;
  uint32_t range = 0x00010000u;
  if (!lua_isnoneornil(state, 1)) {
    int is_number = 0;
    parsed = lua_tonumberx(state, 1, &is_number);
    if (!is_number && lua_type(state, 1) == LUA_TSTRING) {
      size_t length = 0;
      const char *value = lua_tolstring(state, 1, &length);
      is_number = parse_pico8_hex_number(value, length, &parsed) ? 1 : 0;
    }
    if (!is_number) return luaL_argerror(state, 1, "number or table expected");
    range = static_cast<uint32_t>(parsed.bits());
  }
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

int pico8_string_all_next(lua_State *state) {
  size_t length = 0;
  const char *value = lua_tolstring(state, lua_upvalueindex(1), &length);
  const int index = static_cast<int>(
      lua_tointeger(state, lua_upvalueindex(2)));
  if (value == nullptr || index < 1 || static_cast<size_t>(index) > length) {
    return 0;
  }
  lua_pushinteger(state, index + 1);
  lua_copy(state, -1, lua_upvalueindex(2));
  lua_pop(state, 1);
  lua_pushlstring(state, value + index - 1, 1);
  return 1;
}

int pico8_all(lua_State *state) {
  if (lua_isnoneornil(state, 1)) {
    lua_pushcfunction(state, pico8_empty_iterator);
    return 1;
  }
  if (lua_type(state, 1) == LUA_TSTRING) {
    lua_pushvalue(state, 1);
    lua_pushinteger(state, 1);
    lua_pushcclosure(state, pico8_string_all_next, 2);
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

int pico8_inext(lua_State *state) {
  luaL_checktype(state, 1, LUA_TTABLE);
  const int index = lua_isnoneornil(state, 2)
                        ? 1
                        : static_cast<int>(luaL_checknumber(state, 2)) + 1;
  lua_pushinteger(state, index);
  lua_rawgeti(state, 1, index);
  return lua_isnil(state, -1) ? 1 : 2;
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

uint8_t hex_digit_or_zero(unsigned char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10u;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10u;
  return 0;
}

int pico8_tonum(lua_State *state) {
  lua_Number result;
  switch (lua_type(state, 1)) {
    case LUA_TSTRING: {
      size_t length = 0;
      const char *value = lua_tolstring(state, 1, &length);
      const uint16_t flags = lua_isnumber(state, 2)
                                 ? static_cast<uint16_t>(lua_tointeger(state, 2))
                                 : 0u;
      if ((flags & 0x1u) != 0u) {
        uint32_t bits = 0;
        for (size_t index = 0; index < length; ++index) {
          bits = (bits << 4u) |
                 hex_digit_or_zero(static_cast<unsigned char>(value[index]));
        }
        result = (flags & 0x2u) != 0u
                     ? lua_Number::frombits(static_cast<int32_t>(bits))
                     : lua_Number(static_cast<int32_t>(bits));
      } else if ((flags & 0x2u) != 0u) {
        const int32_t integer = static_cast<int32_t>(std::strtoll(value, nullptr, 10));
        result = lua_Number(integer >> 16);
      } else if (!luaO_str2d(value, length, &result)) {
        if ((flags & 0x4u) == 0u) return 0;
        result = lua_Number(0);
      }
      break;
    }
    case LUA_TNUMBER:
      result = lua_tonumber(state, 1);
      break;
    case LUA_TBOOLEAN:
      result = lua_Number(lua_toboolean(state, 1) ? 1 : 0);
      break;
    default: {
      const uint16_t flags = lua_isnumber(state, 2)
                                 ? static_cast<uint16_t>(lua_tointeger(state, 2))
                                 : 0u;
      if ((flags & 0x4u) == 0u) return 0;
      result = lua_Number(0);
      break;
    }
  }
  lua_pushnumber(state, result);
  return 1;
}

int pico8_ord(lua_State *state) {
  if (lua_type(state, 1) != LUA_TSTRING) {
    lua_pushnil(state);
    return 1;
  }
  size_t length = 0;
  const char *value = lua_tolstring(state, 1, &length);
  if ((!lua_isnoneornil(state, 2) && !lua_isnumber(state, 2)) ||
      (!lua_isnoneornil(state, 3) && !lua_isnumber(state, 3))) {
    lua_pushnil(state);
    return 1;
  }
  const int index = lua_isnoneornil(state, 2)
                        ? 0
                        : static_cast<int>(lua_tonumber(state, 2)) - 1;
  int count = lua_isnoneornil(state, 3)
                  ? 1
                  : static_cast<int>(lua_tonumber(state, 3));
  if (index < 0 || static_cast<size_t>(index) >= length || count < 1) {
    lua_pushnil(state);
    return 1;
  }
  count = std::min(count, static_cast<int>(length) - index);
  if (!lua_checkstack(state, count)) {
    return luaL_error(state, "ord result count exceeds the Lua stack");
  }
  for (int offset = 0; offset < count; ++offset) {
    lua_pushnumber(
        state,
        lua_Number(static_cast<uint8_t>(value[index + offset])));
  }
  return count;
}

int pico8_extcmd(lua_State *state) {
  size_t length = 0;
  static_cast<void>(luaL_optlstring(state, 1, "", &length));
  if (length > 256) {
    return luaL_argerror(state, 1, "extcmd command exceeds 256 bytes");
  }
  // Browser players do not grant carts process, recording, filesystem or
  // window authority. PICO-8 command strings therefore terminate in this
  // bounded null sink instead of becoming an ambient host capability.
  return 0;
}

int pico8_chr(lua_State *state) {
  const int count = lua_gettop(state);
  if (count > kMaximumChrValues) {
    return luaL_error(state, "chr accepts at most 8192 values");
  }
  luaL_Buffer buffer;
  char *bytes = luaL_buffinitsize(state, &buffer, static_cast<size_t>(count));
  for (int index = 0; index < count; ++index) {
    bytes[index] = static_cast<char>(
        static_cast<uint8_t>(lua_tonumber(state, index + 1)));
  }
  luaL_pushresultsize(&buffer, static_cast<size_t>(count));
  return 1;
}

int pico8_set_fps(lua_State *) {
  // Callback discovery remains the only frame-rate authority. This private
  // compatibility entry is intentionally a deterministic no-op.
  return 0;
}

struct MenuitemIndex {
  int slot;
  uint16_t filter;
};

MenuitemIndex menuitem_index(lua_State *state) {
  const int32_t raw = luaL_checknumber(state, 1).bits();
  if ((raw & 0xffff) != 0) {
    luaL_argerror(state, 1, "menuitem index must be an integer");
  }
  // P8 numbers are signed Q16.16. Treat the integer half as the documented
  // 16-bit menuitem bitfield so filters such as 0xff00 remain representable.
  const uint16_t encoded = static_cast<uint16_t>(
      static_cast<uint32_t>(raw) >> 16u);
  const int slot = encoded & 0xff;
  if (slot < kMenuitemMinimumSlot || slot > kMenuitemMaximumSlot) {
    luaL_argerror(state, 1,
                  "menuitem index must select slot 1..5 with optional "
                  "0xff00 button filter bits");
  }
  return {slot, static_cast<uint16_t>(encoded & 0xff00u)};
}

int pico8_menuitem(lua_State *state) {
  const MenuitemIndex index = menuitem_index(state);
  const bool remove =
      lua_isnoneornil(state, 2) || lua_isnoneornil(state, 3);
  lua_getfield(state, LUA_REGISTRYINDEX, kMenuitemRegistryKey);

  // PICO-8 removes the slot when either optional registration value is absent.
  if (remove) {
    lua_pushnil(state);
    lua_rawseti(state, -2, index.slot);
    lua_pop(state, 1);
    return 0;
  }

  size_t label_length = 0;
  const char *label = luaL_checklstring(state, 2, &label_length);
  luaL_checktype(state, 3, LUA_TFUNCTION);
  const size_t display_label_length =
      std::min(label_length, static_cast<size_t>(kMenuitemLabelBytes));

  // The registry table is private to this lua_State. It owns the callback's
  // strong reference and is replaced/collected with the VM generation.
  lua_createtable(state, 3, 0);
  lua_pushlstring(state, label, display_label_length);
  lua_rawseti(state, -2, 1);
  lua_pushvalue(state, 3);
  lua_rawseti(state, -2, 2);
  lua_pushinteger(state, index.filter);
  lua_rawseti(state, -2, 3);
  lua_rawseti(state, -2, index.slot);
  lua_pop(state, 1);
  return 0;
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

void register_table_alias(lua_State *state, const char *name) {
  lua_getglobal(state, "table");
  lua_getfield(state, -1, name);
  lua_remove(state, -2);
  lua_setglobal(state, name);
}

void register_p8scii_globals(lua_State *state) {
  lua_pushglobaltable(state);
  for (const P8sciiGlobal &entry : kP8sciiGlobals) {
    const char name = static_cast<char>(entry.name);
    lua_pushlstring(state, &name, 1);
    lua_pushnumber(
        state,
        lua_Number::frombits(static_cast<int32_t>(entry.raw_value)));
    lua_rawset(state, -3);
  }
  lua_pop(state, 1);
}

}  // namespace

void open_pico8_compat(lua_State *state, uint8_t *pico_ram) {
  lua_createtable(state, kMenuitemMaximumSlot, 0);
  lua_setfield(state, LUA_REGISTRYINDEX, kMenuitemRegistryKey);
  register_function(state, "add", pico8_add);
  register_function(state, "del", pico8_del);
  register_function(state, "deli", pico8_deli);
  register_function(state, "count", pico8_count);
  register_function(state, "all", pico8_all);
  register_function(state, "foreach", pico8_foreach);
  register_function(state, "inext", pico8_inext);
  register_function(state, "sub", pico8_sub);
  register_function(state, "tonum", pico8_tonum);
  register_function(state, "ord", pico8_ord);
  register_function(state, "chr", pico8_chr);
  register_function(state, "extcmd", pico8_extcmd);
  register_function(state, "_set_fps", pico8_set_fps);
  register_function(state, "menuitem", pico8_menuitem);
  register_table_alias(state, "pack");
  register_table_alias(state, "unpack");
  register_p8scii_globals(state);
  register_prng_function(state, "rnd", pico8_rnd, pico_ram);
  register_prng_function(state, "srand", pico8_srand, pico_ram);
  reset_pico8_compat_ram(pico_ram);
}

void reset_pico8_compat_ram(uint8_t *pico_ram) {
  seed_prng(pico_ram, 0);
}

bool copy_menuitem_snapshot(lua_State *state, uint8_t *destination,
                            uint32_t capacity) {
  if (destination == nullptr || capacity != kMenuitemSnapshotBytes) {
    return false;
  }
  std::memset(destination, 0, capacity);
  destination[0] = 1;
  destination[1] = static_cast<uint8_t>(kMenuitemSlotCount);
  destination[2] = static_cast<uint8_t>(kMenuitemSnapshotRecordBytes);
  lua_getfield(state, LUA_REGISTRYINDEX, kMenuitemRegistryKey);
  for (uint32_t slot = 1; slot <= kMenuitemSlotCount; ++slot) {
    uint8_t *record = destination + 4 +
                      (slot - 1) * kMenuitemSnapshotRecordBytes;
    lua_rawgeti(state, -1, static_cast<int>(slot));
    if (lua_istable(state, -1)) {
      lua_rawgeti(state, -1, 1);
      size_t label_length = 0;
      const char *label = lua_tolstring(state, -1, &label_length);
      lua_pop(state, 1);
      lua_rawgeti(state, -1, 3);
      const uint16_t filter = static_cast<uint16_t>(lua_tointeger(state, -1));
      lua_pop(state, 1);
      if (label != nullptr && label_length <= kMenuitemLabelBytes) {
        record[0] = 1;
        record[1] = static_cast<uint8_t>(label_length);
        record[2] = static_cast<uint8_t>(filter & 0xffu);
        record[3] = static_cast<uint8_t>(filter >> 8u);
        if (label_length != 0) {
          std::memcpy(record + 4, label, label_length);
        }
      }
    }
    lua_pop(state, 1);
  }
  lua_pop(state, 1);
  return true;
}

MenuitemLookup push_menuitem_callback(lua_State *state, uint32_t slot,
                                      uint32_t button_mask) {
  if (slot < 1 || slot > kMenuitemSlotCount) return MenuitemLookup::Missing;
  lua_getfield(state, LUA_REGISTRYINDEX, kMenuitemRegistryKey);
  lua_rawgeti(state, -1, static_cast<int>(slot));
  if (!lua_istable(state, -1)) {
    lua_pop(state, 2);
    return MenuitemLookup::Missing;
  }
  lua_rawgeti(state, -1, 3);
  const uint16_t filter = static_cast<uint16_t>(lua_tointeger(state, -1));
  lua_pop(state, 1);
  if (((filter >> 8u) & button_mask) != 0) {
    lua_pop(state, 2);
    return MenuitemLookup::Filtered;
  }
  lua_rawgeti(state, -1, 2);
  if (!lua_isfunction(state, -1)) {
    lua_pop(state, 3);
    return MenuitemLookup::Missing;
  }
  lua_remove(state, -2);
  lua_remove(state, -2);
  return MenuitemLookup::Ready;
}

bool menuitem_slot_occupied(lua_State *state, uint32_t slot) {
  if (slot < 1 || slot > kMenuitemSlotCount) return false;
  lua_getfield(state, LUA_REGISTRYINDEX, kMenuitemRegistryKey);
  lua_rawgeti(state, -1, static_cast<int>(slot));
  const bool occupied = lua_istable(state, -1);
  lua_pop(state, 2);
  return occupied;
}

}  // namespace p8w
