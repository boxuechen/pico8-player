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
