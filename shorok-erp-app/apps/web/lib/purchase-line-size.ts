/**
 * The board size a purchase line is actually buying.
 *
 * A purchase names the base product; the size is chosen on the line with the
 * same ك / ص / custom controls the invoice has always had. That size is what
 * resolves — or creates — the exact ProductVariant, so it must be a real
 * measurement the user supplied and never a fallback the screen invented.
 *
 * Returning null means "no size chosen yet", which is a normal state while the
 * line is being filled in and a reason not to submit it, not an error.
 */
import { metersPerBoard } from "./line-calc";

/** كبير and صغير, the two sizes the business treats as standard. */
export const SIZE_LARGE = "5.25";
export const SIZE_SMALL = "4";

export interface PurchaseLineSizeInput {
  sizeChoice: "" | "K" | "S";
  customL: string;
  customW: string;
}

/**
 * Metres (م²) per board, as a decimal string, or null when nothing was chosen.
 *
 * A custom length with no width is a one-dimensional board — the same shape ك
 * and ص have — so the width defaults to 1 rather than making the line invalid.
 */
export function purchaseLineSize(line: PurchaseLineSizeInput): string | null {
  if (line.sizeChoice === "K") return SIZE_LARGE;
  if (line.sizeChoice === "S") return SIZE_SMALL;

  const length = line.customL.trim();
  if (length === "" || Number(length) <= 0) return null;
  const width = line.customW.trim();
  if (width === "") return metersPerBoard(1, length);
  if (Number(width) <= 0) return null;
  return metersPerBoard(width, length);
}
