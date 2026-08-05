const OFFICIAL_HEADER = "pico-8 cartridge // http://www.pico-8.com";

export function repeated(character, length) {
  return character.repeat(length);
}

export function replacePrefix(row, prefix) {
  return `${prefix}${row.slice(prefix.length)}`;
}

export function makeP8Text({
  version = 42,
  lineEnding = "\n",
  bom = false,
  preamble = [],
  sections = [{ name: "lua", lines: ["function _draw()", " cls(1)", "end"] }],
  finalLineEnding = true,
} = {}) {
  const lines = [
    OFFICIAL_HEADER,
    `version ${version}`,
    ...preamble,
  ];
  for (const section of sections) {
    lines.push(`__${section.name}__`, ...section.lines);
  }
  const text = `${lines.join(lineEnding)}${finalLineEnding ? lineEnding : ""}`;
  return `${bom ? "\ufeff" : ""}${text}`;
}

export function makeP8Bytes(options = {}) {
  return new TextEncoder().encode(makeP8Text(options));
}

export function allSectionsFixture({ lineEnding = "\n", bom = false } = {}) {
  const gfxRows = Array.from({ length: 65 }, () => repeated("0", 128));
  gfxRows[0] = replacePrefix(gfxRows[0], "12");
  gfxRows[64] = replacePrefix(gfxRows[64], "10");

  const mapRows = Array.from({ length: 33 }, () => repeated("0", 256));
  mapRows[0] = replacePrefix(mapRows[0], "7f");
  mapRows[32] = replacePrefix(mapRows[32], "02");

  const sfx = `011002033ff77${repeated("0", 31 * 5)}`;
  return makeP8Bytes({
    lineEnding,
    bom,
    sections: [
      { name: "lua", lines: ["a=1"] },
      { name: "gfx", lines: gfxRows },
      { name: "gff", lines: [replacePrefix(repeated("0", 256), "ab")] },
      { name: "map", lines: mapRows },
      { name: "sfx", lines: [sfx] },
      { name: "music", lines: ["0f 01020304"] },
      { name: "label", lines: [repeated("v", 128)] },
    ],
  });
}
