import { readFileSync } from "fs";
import { dirname, join } from "path";

/**
 * Cairo (SIL OFL) Arabic font embedded as base64 @font-face so Chromium renders
 * connected Arabic + RTL without depending on system fonts or any network fetch
 * at generation time. Arabic and Latin subsets are split by unicode-range so
 * Arabic glyphs shape correctly and Latin digits/letters stay crisp.
 */
function fontsDir(): string {
  const pkg = require.resolve("@fontsource/cairo/package.json");
  return join(dirname(pkg), "files");
}

function b64(file: string): string {
  return readFileSync(join(fontsDir(), file)).toString("base64");
}

let cached: string | null = null;

export function cairoFontFaceCss(): string {
  if (cached) return cached;
  const ar = "U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF";
  const lat = "U+0000-00FF, U+2000-206F, U+20A0-20BF";
  const face = (weight: number, file: string, range: string) =>
    `@font-face{font-family:'Cairo';font-style:normal;font-weight:${weight};font-display:swap;` +
    `src:url(data:font/woff2;base64,${b64(file)}) format('woff2');unicode-range:${range};}`;
  cached = [
    face(400, "cairo-arabic-400-normal.woff2", ar),
    face(700, "cairo-arabic-700-normal.woff2", ar),
    face(400, "cairo-latin-400-normal.woff2", lat),
    face(700, "cairo-latin-700-normal.woff2", lat),
  ].join("\n");
  return cached;
}
