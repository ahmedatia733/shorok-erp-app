/**
 * Decimal-safe invoice line arithmetic for the web client.
 *
 * Financial math must NEVER use JavaScript floating point (0.1 + 0.2 ≠ 0.3).
 * The web app deliberately avoids pulling decimal.js into the bundle (see
 * decimal-string.ts), so this module does fixed-point arithmetic with BigInt:
 * every input is parsed to an integer scaled by 10^WORK, multiplications stay
 * exact in BigInt, and results are rounded HALF-UP to the target precision —
 * matching the API's decimal.js `.toFixed()` (ROUND_HALF_UP) so the preview a
 * user sees equals what the server will post.
 *
 * Precisions mirror the database: meters/areas NUMERIC(x,4), money NUMERIC(x,2).
 */

const WORK = 6; // internal fractional digits kept per operand before multiply
export const METERS_DP = 4;
export const MONEY_DP = 2;

/** Parse a decimal string/number into a BigInt scaled by 10^scale (truncating
 *  any digits beyond `scale`). Invalid/empty input parses to 0. */
function toScaled(value: string | number, scale: number): bigint {
  const s = (typeof value === "number" ? String(value) : value ?? "").trim();
  if (s === "" || !/^-?\d+(\.\d+)?$/.test(s)) return 0n;
  const neg = s.startsWith("-");
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".");
  const fracScaled = (frac + "0".repeat(scale)).slice(0, scale);
  const digits = BigInt((whole || "0") + fracScaled);
  return neg ? -digits : digits;
}

/** Render a BigInt scaled by 10^fromScale as a decimal string with `dp`
 *  fractional digits, rounding HALF-UP. */
function render(scaled: bigint, fromScale: number, dp: number): string {
  const neg = scaled < 0n;
  let abs = neg ? -scaled : scaled;
  const diff = fromScale - dp;
  if (diff > 0) {
    const factor = 10n ** BigInt(diff);
    const remainder = abs % factor;
    abs = abs / factor;
    if (remainder * 2n >= factor) abs += 1n; // round half-up
  } else if (diff < 0) {
    abs = abs * 10n ** BigInt(-diff);
  }
  const digits = abs.toString().padStart(dp + 1, "0");
  const whole = digits.slice(0, digits.length - dp);
  const out = dp === 0 ? whole : `${whole}.${digits.slice(digits.length - dp)}`;
  return neg && abs !== 0n ? `-${out}` : out;
}

/** Exact product of two decimal strings, rounded to `dp` fractional digits. */
function mul(a: string | number, b: string | number, dp: number): string {
  const pa = toScaled(a, WORK);
  const pb = toScaled(b, WORK);
  return render(pa * pb, WORK * 2, dp);
}

/** Area of one board (م²) = width × length, to 4 dp. */
export function metersPerBoard(width: string | number, length: string | number): string {
  return mul(width, length, METERS_DP);
}

/** Total line meters = number of boards × meters/area per board, to 4 dp. */
export function totalMeters(boards: string | number, perBoard: string | number): string {
  return mul(boards, perBoard, METERS_DP);
}

/** Line total when the price is PER METER (purchase invoices): meters × price. */
export function lineTotalPerMeter(meters: string | number, pricePerMeter: string | number): string {
  return mul(meters, pricePerMeter, MONEY_DP);
}

/** Line total when the price is PER BOARD/unit (sales invoices): boards × price. */
export function lineTotalPerBoard(boards: string | number, pricePerBoard: string | number): string {
  return mul(boards, pricePerBoard, MONEY_DP);
}

/** Generic money product (qty × price) to 2 dp — used for tax bases, cost, etc. */
export function money(qty: string | number, price: string | number): string {
  return mul(qty, price, MONEY_DP);
}

/** Tax amount = base × (ratePercent / 100), to 2 dp. */
export function taxAmount(base: string | number, ratePercent: string | number): string {
  // base × rate, then ÷ 100 folded into the render scale.
  const scaled = toScaled(base, WORK) * toScaled(ratePercent, WORK);
  return render(scaled, WORK * 2 + 2, MONEY_DP);
}

/**
 * Area (م²) of a single board for an invoice line, Decimal-safe:
 * a custom طول×عرض overrides the standard كبير(5.25)/صغير(4) choice; otherwise
 * the variant's stored per-board size is used. Mirrors the previous float
 * helper's rules exactly, but without floating-point.
 */
export const BOARD_AREA_LARGE = "5.25"; // كبير — م²/لوح
export const BOARD_AREA_SMALL = "4";    // صغير — م²/لوح

export function boardArea(
  sizeChoice: "" | "K" | "S",
  customLength: string | number,
  customWidth: string | number,
  variantSize: string | number,
): string {
  const L = toScaled(customLength, METERS_DP);
  const W = toScaled(customWidth, METERS_DP);
  if (L > 0n && W > 0n) return metersPerBoard(customLength, customWidth);
  if (sizeChoice === "K") return BOARD_AREA_LARGE;
  if (sizeChoice === "S") return BOARD_AREA_SMALL;
  const v = toScaled(variantSize, METERS_DP);
  return v > 0n ? render(v, METERS_DP, METERS_DP) : "0";
}
