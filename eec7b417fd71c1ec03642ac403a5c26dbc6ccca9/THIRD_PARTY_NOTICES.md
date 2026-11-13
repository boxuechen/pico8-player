# Third-party notices: PICO-8 Web Player 0.2.0-alpha.2

This generated notice combines the two tracked provenance owners used by the release artifact.

# RuntimeCore third-party notices

## P8SCII built-in font data

`src/graphics/p8scii-font.ts` adapts the 2048-byte `defaultFontBinaryData`
table from:

- fake-08: <https://github.com/jtothebell/fake-08>
- fixed revision: `814991a2571ad3970e386cef48f3b148aa1c27b9`
- upstream path: `source/fontdata.cpp`
- upstream note: the file attributes its font source to
  [tac08](https://github.com/0xcafed00d/tac08)

The data representation was changed from a C++ byte array to a hexadecimal
TypeScript constant. Glyph rows and byte values are otherwise unchanged.

fake-08 identifies this component as MIT licensed. tac08 is Copyright (c)
2018 Lee Witek and is also MIT licensed:

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## SFX synthesis and filter formulae

`src/audio/sfx-synth.ts` is a TypeScript rewrite informed by the SFX state,
waveform, effect, reverb, distortion and biquad filter implementations in:

- fake-08: <https://github.com/jtothebell/fake-08>
- fixed revision: `814991a2571ad3970e386cef48f3b148aa1c27b9`
- upstream paths: `source/Audio.cpp`, `source/synth.cpp`, `source/filter.cpp`
- original implementation: [zepto8](https://github.com/samhocevar/zepto8)

The production implementation uses project-owned deterministic noise and a
browser-neutral TypeScript state model. The waveform constants and filter
formulae remain derived from the cited zepto8 work, whose files carry the Do
What The Fuck You Want To Public License, Version 2:

```text
            DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE
                    Version 2, December 2004

 Copyright (C) 2004 Sam Hocevar <sam@hocevar.net>

 Everyone is permitted to copy and distribute verbatim or modified
 copies of this license document, and changing it is allowed as long
 as the name is changed.

            DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE
   TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION

  0. You just DO WHAT THE FUCK YOU WANT TO.
```

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
