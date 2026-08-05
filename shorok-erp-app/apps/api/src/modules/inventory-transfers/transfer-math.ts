import { Decimal } from "decimal.js";

/**
 * The arithmetic of an inventory transfer, with no database and no I/O.
 *
 * One rule does all the work:
 *
 *     metres = boards × the variant's own board size
 *
 * The user types the board count and nothing else. Metres are never entered,
 * never accepted from a client, and never rounded into existence — they are
 * derived here and the database re-checks the same equality with a CHECK
 * constraint, so a value that did not come from this function cannot be stored.
 *
 * Everything is Decimal. A transfer of 3 boards at 5.25 m must be exactly
 * 15.75 m; in binary floating point 3 * 5.25 happens to be exact, but
 * 7 * 0.1 is not, and inventory is not a place to find out which is which.
 */

/** Quantities are stored at 4 dp (`Decimal(14,4)`), money at 2 dp. */
export const QTY_DP = 4;
export const MONEY_DP = 2;

export class TransferMathError extends Error {
  constructor(
    readonly code: string,
    readonly context: Record<string, string> = {},
  ) {
    super(code);
    this.name = "TransferMathError";
  }
}

/**
 * Whole boards only. Accepts a string or a number and rejects anything that is
 * not a positive integer — including "3.0", which is a decimal the user did not
 * mean to type, and 1e3, which is not how anyone counts boards.
 */
export function parseBoardQuantity(raw: string | number): Decimal {
  const text = typeof raw === "number" ? String(raw) : raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new TransferMathError("board_quantity_must_be_whole", { value: text });
  }
  const boards = new Decimal(text);
  if (!boards.isFinite() || boards.lte(0)) {
    throw new TransferMathError("board_quantity_must_be_positive", { value: text });
  }
  if (!boards.isInteger()) {
    throw new TransferMathError("board_quantity_must_be_whole", { value: text });
  }
  return boards;
}

/**
 * `new Decimal("abc")` throws a DecimalError of its own, which would escape as
 * an unclassified 500 instead of a validation failure. Every untrusted value is
 * therefore parsed through this, so the only thing that ever leaves this module
 * is a TransferMathError with a code the caller can translate.
 */
function toDecimal(raw: Decimal | string | number, errorCode: string): Decimal {
  try {
    const value = new Decimal(raw as Decimal.Value);
    if (!value.isFinite()) throw new TransferMathError(errorCode, { value: String(raw) });
    return value;
  } catch (e) {
    if (e instanceof TransferMathError) throw e;
    throw new TransferMathError(errorCode, { value: String(raw) });
  }
}

/**
 * A board count read back from the database, where `Decimal(14,4)` renders 6 as
 * "6.0000".
 *
 * `parseBoardQuantity` is deliberately strict about what a *person* may type —
 * "6.0000" is not how anyone counts boards — but that same strictness would
 * reject the value this system itself stored. So stored values come back
 * through here instead: still integral, still positive, but tolerant of the
 * trailing zeros the column adds. It re-asserts integrality rather than
 * trusting it, because silently truncating half a board would be far worse
 * than failing.
 */
export function storedBoardQuantity(raw: Decimal | string | number): Decimal {
  const boards = toDecimal(raw, "board_quantity_must_be_whole");
  if (!boards.isInteger()) {
    throw new TransferMathError("board_quantity_must_be_whole", { value: String(raw) });
  }
  if (boards.lte(0)) {
    throw new TransferMathError("board_quantity_must_be_positive", { value: String(raw) });
  }
  return boards;
}

export function parseBoardSize(raw: Decimal | string | number): Decimal {
  const size = toDecimal(raw, "board_size_invalid");
  if (size.lte(0)) {
    throw new TransferMathError("board_size_invalid", { value: String(raw) });
  }
  return size;
}

/**
 * The transfer's defining calculation.
 *
 * `toDecimalPlaces(4)` matches the storage precision exactly rather than
 * approximating it, so what is asserted here is what the column holds and what
 * the database CHECK re-derives.
 */
export function metresForBoards(boards: Decimal, boardSize: Decimal): Decimal {
  return boards.times(boardSize).toDecimalPlaces(QTY_DP, Decimal.ROUND_HALF_UP);
}

/**
 * Value carried by the transfer at the CURRENT shared cost. This never changes
 * the cost — it records what the moved stock was already worth, so the two
 * movements can be equal and opposite in value as well as in quantity.
 */
export function transferValue(metres: Decimal, costPerMetre: Decimal): Decimal {
  return metres.times(costPerMetre).toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP);
}

export interface TransferLineMath {
  boards: Decimal;
  boardSize: Decimal;
  metres: Decimal;
  costPerMetre: Decimal;
  value: Decimal;
}

export function computeLine(input: {
  boardQuantity: Decimal | string | number;
  boardSize: Decimal | string | number;
  costPerMetre: Decimal | string | number;
  /**
   * "typed" — a person entered this, so hold it to the strict form.
   * "stored" — this system wrote it, so accept the column's trailing zeros.
   */
  source?: "typed" | "stored";
}): TransferLineMath {
  const boards =
    input.source === "stored"
      ? storedBoardQuantity(input.boardQuantity)
      : parseBoardQuantity(input.boardQuantity as string | number);
  const boardSize = parseBoardSize(input.boardSize);
  const costPerMetre = toDecimal(input.costPerMetre, "cost_per_metre_invalid");
  if (costPerMetre.isNegative()) {
    throw new TransferMathError("cost_per_metre_invalid", { value: String(input.costPerMetre) });
  }
  const metres = metresForBoards(boards, boardSize);
  return { boards, boardSize, metres, costPerMetre, value: transferValue(metres, costPerMetre) };
}

/**
 * A transfer is a redistribution, so the two legs must cancel exactly. This is
 * asserted before anything is written rather than hoped for afterwards.
 */
export function assertPairConserves(pair: {
  sourceBoardsDelta: Decimal;
  destinationBoardsDelta: Decimal;
  sourceMetresDelta: Decimal;
  destinationMetresDelta: Decimal;
  sourceValueDelta: Decimal;
  destinationValueDelta: Decimal;
}): void {
  const checks: Array<[string, Decimal]> = [
    ["boards", pair.sourceBoardsDelta.plus(pair.destinationBoardsDelta)],
    ["metres", pair.sourceMetresDelta.plus(pair.destinationMetresDelta)],
    ["value", pair.sourceValueDelta.plus(pair.destinationValueDelta)],
  ];
  for (const [what, sum] of checks) {
    if (!sum.isZero()) {
      throw new TransferMathError("transfer_pair_not_conserved", { what, sum: sum.toString() });
    }
  }
}

export const qty = (v: Decimal): string => v.toFixed(QTY_DP);
export const money = (v: Decimal): string => v.toFixed(MONEY_DP);
export const rate = (v: Decimal): string => v.toFixed(QTY_DP);

/** «TRF-000001» — the same shape the sales invoice uses for SI-{number}. */
export function formatTransferNumber(n: bigint | number | string): string {
  return `TRF-${String(n).padStart(6, "0")}`;
}
