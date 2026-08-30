/**
 * What size a board is, and how to ask for one.
 *
 * The business talks about boards in three classes: كبير at 5.25 m, صغير at
 * 4.00 m, and everything else — a مقاس مخصص cut to whatever the job needed.
 * That vocabulary appears on screen, in search, and in the query that backs
 * both, so it lives here once. Two slightly different copies of "is this a
 * كبير?" would eventually disagree, and the disagreement would show up as
 * movements missing from a search rather than as an error anybody notices.
 *
 * The size itself is never stored as a class. It is read from the exact
 * ProductVariant the movement points at and classified on the way out, so a
 * movement recorded years ago describes itself correctly today without being
 * touched.
 *
 * Comparisons are exact. `size_meters_per_board` is `Decimal(10,4)`, so a size
 * is compared as an integer count of ten-thousandths rather than through
 * floating point, where 5.25 is representable but 4.8 is not and `0.1 + 0.2`
 * is famously not 0.3.
 */

export type BoardSizeKind = "BIG" | "SMALL" | "CUSTOM";

/** Ten-thousandths, matching the column's scale of 4. */
const SCALE = 4;
const BIG_UNITS = 52500; // 5.2500
const SMALL_UNITS = 40000; // 4.0000

/** The two sizes the business treats as standard, as decimal strings. */
export const BOARD_SIZE_BIG = "5.25";
export const BOARD_SIZE_SMALL = "4";

export interface BoardSize {
  kind: BoardSizeKind;
  /** Compact Arabic badge: ك / ص / م ق */
  shortAr: string;
  /** Full Arabic: كبير / صغير / مقاس مخصص */
  longAr: string;
  shortEn: string;
  longEn: string;
  /**
   * The size as text for display — always at least two decimals so 4 reads as
   * "4.00", and never fewer digits than the value actually has, so a 3.4375 m
   * board is not rounded away into something it isn't.
   */
  meters: string;
}

/**
 * A size as an exact integer number of ten-thousandths, or null when the text
 * is not a size at all.
 *
 * Anything with more precision than the column can hold is not a size — it
 * could never equal a stored value — so it is rejected rather than silently
 * rounded into matching something else.
 */
export function boardSizeUnits(size: string | number | null | undefined): number | null {
  if (size === null || size === undefined) return null;
  const raw = String(size).trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  const negative = raw.startsWith("-");
  const [whole, frac = ""] = raw.replace("-", "").split(".");
  if (frac.length > SCALE) return null;
  const units = Number(whole) * 10 ** SCALE + Number((frac + "0".repeat(SCALE)).slice(0, SCALE));
  if (!Number.isSafeInteger(units)) return null;
  return negative ? -units : units;
}

/** Display text for a size: at least 2 decimals, and never truncated. */
export function formatBoardMeters(size: string | number | null | undefined): string {
  const units = boardSizeUnits(size);
  if (units === null) return String(size ?? "");
  const whole = Math.trunc(units / 10 ** SCALE);
  const frac = String(Math.abs(units) % 10 ** SCALE).padStart(SCALE, "0");
  // Drop trailing zeros but keep two, so 5.2500 → "5.25", 4.0000 → "4.00" and
  // 3.4375 keeps all four digits it needs.
  const trimmed = frac.replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${trimmed}`;
}

const LABELS: Record<BoardSizeKind, Omit<BoardSize, "meters" | "kind">> = {
  BIG: { shortAr: "ك", longAr: "كبير", shortEn: "Big", longEn: "Big" },
  SMALL: { shortAr: "ص", longAr: "صغير", shortEn: "Small", longEn: "Small" },
  CUSTOM: { shortAr: "م ق", longAr: "مقاس مخصص", shortEn: "Custom", longEn: "Custom" },
};

/** Which class a board size belongs to, decided from the size alone. */
export function classifyBoardSize(size: string | number | null | undefined): BoardSize {
  const units = boardSizeUnits(size);
  const kind: BoardSizeKind = units === BIG_UNITS ? "BIG" : units === SMALL_UNITS ? "SMALL" : "CUSTOM";
  return { kind, ...LABELS[kind], meters: formatBoardMeters(size) };
}

// ── search ──────────────────────────────────────────────────────────────────

export interface MovementSearch {
  /** Whatever was not a size token, to match against code, name and note. */
  terms: string[];
  /** A requested size class, or null. */
  sizeKind: BoardSizeKind | null;
  /** A requested exact size in ten-thousandths, or null. */
  exactSizeUnits: number | null;
}

/** Arabic-Indic and Eastern Arabic-Indic digits, so a typed ٤ still means 4. */
function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

function normalize(query: string): string {
  return normalizeDigits(query)
    // Arabic comma and decimal separator, plus any unicode space
    .replace(/٫/g, ".")
    .replace(/[،،]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Multi-word size phrases, matched before the query is split into tokens. */
const PHRASES: Array<{ re: RegExp; kind: BoardSizeKind }> = [
  { re: /(^|\s)مقاس\s+مخصص(\s|$)/g, kind: "CUSTOM" },
  { re: /(^|\s)م\s*ق(\s|$)/g, kind: "CUSTOM" },
];

const WORDS: Record<string, BoardSizeKind> = {
  "ك": "BIG",
  "كبير": "BIG",
  "ص": "SMALL",
  "صغير": "SMALL",
  "مخصص": "CUSTOM",
  big: "BIG",
  small: "SMALL",
  custom: "CUSTOM",
};

/**
 * Split a search box into a size filter and ordinary text.
 *
 * Size words are recognised as whole tokens, never as substrings. That matters
 * more than it sounds: ك and ص are common Arabic letters, and a substring
 * search for them would quietly turn «كوبرا» or «سيلفر مط» into a size filter
 * and drop most of the results the user was looking at.
 *
 * A bare number is a size only when it says so. 5.25 and 4 are the two standard
 * sizes; any other number carrying a decimal point is an exact size to match;
 * a whole number like 1010 or 9005 is a product code and stays text.
 */
export function parseMovementSearch(query: string | null | undefined): MovementSearch {
  const result: MovementSearch = { terms: [], sizeKind: null, exactSizeUnits: null };
  if (!query) return result;

  let rest = normalize(query);
  for (const { re, kind } of PHRASES) {
    re.lastIndex = 0;
    if (re.test(rest)) {
      result.sizeKind = kind;
      rest = rest.replace(new RegExp(re.source, "g"), " ").replace(/\s+/g, " ").trim();
    }
  }

  for (const token of rest.split(" ").filter(Boolean)) {
    const word = WORDS[token] ?? WORDS[token.toLowerCase()];
    if (word) {
      result.sizeKind = word;
      continue;
    }
    const units = boardSizeUnits(token);
    if (units !== null && units > 0) {
      if (units === BIG_UNITS) {
        result.sizeKind = "BIG";
        continue;
      }
      if (units === SMALL_UNITS) {
        result.sizeKind = "SMALL";
        continue;
      }
      // A decimal point is what marks a measurement; 1010 is a code.
      if (token.includes(".")) {
        result.exactSizeUnits = units;
        continue;
      }
    }
    result.terms.push(token);
  }
  return result;
}

/** The exact sizes a class covers, for building a query. CUSTOM is "neither". */
export const BOARD_SIZE_STANDARD = { BIG: BOARD_SIZE_BIG, SMALL: BOARD_SIZE_SMALL } as const;

/** A size in ten-thousandths back to a decimal string, for query building. */
export function unitsToDecimalString(units: number): string {
  const whole = Math.trunc(units / 10 ** SCALE);
  const frac = String(Math.abs(units) % 10 ** SCALE).padStart(SCALE, "0");
  return `${whole}.${frac}`;
}
