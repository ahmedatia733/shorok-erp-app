/**
 * Tiny decimal-string helpers for the web app. Mirrors the API rule that
 * inventory math is NEVER done in float — keeps the displayed variance
 * consistent with what the engine will compute server-side.
 *
 * We don't pull in decimal.js on the client to keep bundle size lean: a
 * fixed-precision string subtraction with a 4-dp scale (matching
 * NUMERIC(14,4)) is enough for everything inventory needs in the UI.
 */

const SCALE = 4;

interface Parsed {
  negative: boolean;
  digits: string; // unsigned integer string with SCALE-digit fractional part baked in
}

function parse(input: string): Parsed | null {
  const trimmed = input.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ""] = unsigned.split(".");
  const padded = (frac + "0".repeat(SCALE)).slice(0, SCALE);
  const digits = (whole ?? "0") + padded;
  // Strip leading zeros but keep at least one digit
  const cleaned = digits.replace(/^0+/, "") || "0";
  return { negative, digits: cleaned };
}

function format(parsed: Parsed): string {
  // Pad so we always have at least SCALE+1 digits → split off fractional part.
  const padded = parsed.digits.padStart(SCALE + 1, "0");
  const whole = padded.slice(0, padded.length - SCALE).replace(/^0+/, "") || "0";
  const frac = padded.slice(padded.length - SCALE);
  const sign = parsed.negative && parsed.digits !== "0" ? "-" : "";
  return `${sign}${whole}.${frac}`;
}

function compareDigits(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function subDigits(a: string, b: string): string {
  // Assumes a >= b. Returns a - b as digit string.
  const aPad = a.padStart(b.length, "0");
  const bPad = b.padStart(a.length, "0");
  let borrow = 0;
  let result = "";
  for (let i = aPad.length - 1; i >= 0; i--) {
    let d = parseInt(aPad[i]!, 10) - parseInt(bPad[i]!, 10) - borrow;
    if (d < 0) {
      d += 10;
      borrow = 1;
    } else {
      borrow = 0;
    }
    result = d.toString() + result;
  }
  return result.replace(/^0+/, "") || "0";
}

function addDigits(a: string, b: string): string {
  const len = Math.max(a.length, b.length);
  const aPad = a.padStart(len, "0");
  const bPad = b.padStart(len, "0");
  let carry = 0;
  let result = "";
  for (let i = len - 1; i >= 0; i--) {
    const d = parseInt(aPad[i]!, 10) + parseInt(bPad[i]!, 10) + carry;
    carry = d >= 10 ? 1 : 0;
    result = (d % 10).toString() + result;
  }
  if (carry) result = "1" + result;
  return result;
}

/** counted − expected. Returns null if either input is malformed. */
export function decimalSub(counted: string, expected: string): string | null {
  const a = parse(counted);
  const b = parse(expected);
  if (!a || !b) return null;
  if (a.negative === b.negative) {
    const cmp = compareDigits(a.digits, b.digits);
    if (cmp >= 0) {
      return format({ negative: a.negative, digits: subDigits(a.digits, b.digits) });
    } else {
      return format({ negative: !a.negative, digits: subDigits(b.digits, a.digits) });
    }
  } else {
    // a − (−b) = a + b   or   (−a) − b = −(a + b)
    return format({ negative: a.negative, digits: addDigits(a.digits, b.digits) });
  }
}

/** True iff the string represents zero ("0", "0.0000", "-0.0000", etc.) */
export function isZeroDecimalString(s: string): boolean {
  const parsed = parse(s);
  return parsed !== null && parsed.digits === "0";
}

export function isNegativeDecimalString(s: string): boolean {
  const parsed = parse(s);
  return parsed !== null && parsed.negative && parsed.digits !== "0";
}
