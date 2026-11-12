# Third-party notices: z8lua runtime

This artifact embeds selected sources from
[z8lua](https://github.com/samhocevar/z8lua) at commit
`8575dfbc524003c869c0aa05e109819302c576f9` (`pico8` branch).

The Lua 5.2-derived core and auxiliary/library sources carry the Lua license.
See `licenses/Lua-5.2.txt` and the notice embedded in `z8lua/lua.h`.

The PICO-8 fixed-point and pure-library additions in `z8lua/fix32.h`,
`z8lua/lpico8lib.c`, and `z8lua/trigtables.h` are copyright © 2016–2024 Sam
Hocevar and are offered under the Do What The Fuck You Want To Public License,
Version 2. See `licenses/WTFPL-2.txt` and the notices embedded in those files.

The JavaScript/WASM glue and runtime portions are generated with Emscripten
6.0.5. See `licenses/Emscripten.txt` for the toolchain's dual MIT and
University of Illinois/NCSA notice and its bundled-code notices.

The project-owned bridge and build scripts are not covered by this third-party
notice. This inventory records provenance and redistribution notices; it is
not legal advice.
