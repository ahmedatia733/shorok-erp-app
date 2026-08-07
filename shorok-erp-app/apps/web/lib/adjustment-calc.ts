/**
 * The arithmetic behind «تعديل مخزون» — what a settlement will do to a balance,
 * worked out before anything is written.
 *
 * It lives outside the React component because it is the part that has to be
 * *right*: the screen promises a resulting balance, and the server then produces
 * one. If those two ever disagreed the storekeeper would stop trusting the
 * preview, so this mirrors the engine's rule exactly — metres move by
 * boards × the variant's board size, added to whatever the branch actually
 * holds today.
 *
 * No floating point anywhere: boards are whole, and the metre arithmetic goes
 * through the same fixed-point helpers the invoice lines use.
 */
import { decimalAdd, isNegativeDecimalString } from "./decimal-string";
import { totalMeters } from "./line-calc";

export type AdjustmentDirection = "INCREASE" | "DECREASE";

export interface AdjustmentProjection {
  /** Signed metres this settlement moves, to 4 dp. */
  metersDelta: string;
  resultingBoards: string;
  resultingMeters: string;
  /**
   * True when the settlement would drive the balance below zero on either
   * measure. The engine refuses this outright; surfacing it here turns a
   * rejected submission into a question answered before it is asked.
   */
  negative: boolean;
}

/**
 * The signed, whole-board delta exactly as the API will receive it.
 *
 * Returns null for anything that is not a non-zero count of whole boards —
 * including an empty box, a stray decimal point and a plain zero, which is not
 * a settlement but a no-op the engine rejects.
 */
export function signedBoardDelta(
  direction: AdjustmentDirection | null,
  boards: string,
): string | null {
  if (!direction) return null;
  const trimmed = boards.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  // "0", "00" and "000" are all zero; strip the padding before judging it.
  const normalised = trimmed.replace(/^0+(?=\d)/, "");
  if (normalised === "0") return null;
  return direction === "DECREASE" ? `-${normalised}` : normalised;
}

/**
 * What the balance becomes.
 *
 * `metersOnHand` is read from the branch rather than recomputed from boards on
 * purpose: once a board has been partly cut the two stop being proportional,
 * and a preview that assumed boards × size would quietly contradict the real
 * balance.
 */
export function projectAdjustment(
  onHand: { boardsOnHand: string; metersOnHand: string; boardSizeMeters: string },
  signedDelta: string,
): AdjustmentProjection | null {
  const metersDelta = totalMeters(signedDelta, onHand.boardSizeMeters);
  const resultingBoards = decimalAdd(onHand.boardsOnHand, signedDelta);
  const resultingMeters = decimalAdd(onHand.metersOnHand, metersDelta);
  if (resultingBoards === null || resultingMeters === null) return null;

  return {
    metersDelta,
    resultingBoards,
    resultingMeters,
    negative: isNegativeDecimalString(resultingBoards) || isNegativeDecimalString(resultingMeters),
  };
}
