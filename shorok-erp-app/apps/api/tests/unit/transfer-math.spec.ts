/**
 * The transfer's arithmetic, pinned.
 *
 * Every rule the brief states about quantities lives in transfer-math.ts, so
 * this suite is where those rules are proven rather than assumed: whole boards
 * only, metres derived from the variant's own board size, and two legs that
 * cancel exactly.
 */
import { Decimal } from "decimal.js";
import {
  assertPairConserves,
  computeLine,
  formatTransferNumber,
  metresForBoards,
  parseBoardQuantity,
  parseBoardSize,
  transferValue,
  TransferMathError,
} from "../../src/modules/inventory-transfers/transfer-math";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof TransferMathError ? e.code : `unexpected:${(e as Error).name}`;
  }
  return "no_error";
};

describe("board quantity parsing", () => {
  it("accepts a plain positive integer", () => {
    expect(parseBoardQuantity("7").toString()).toBe("7");
    expect(parseBoardQuantity(12).toString()).toBe("12");
  });

  it.each(["0", "-1", "-0", "0.0"])("rejects %s", (input) => {
    expect(code(() => parseBoardQuantity(input))).not.toBe("no_error");
  });

  it.each(["3.5", "0.25", "2,5"])("rejects the fractional board %s", (input) => {
    expect(code(() => parseBoardQuantity(input))).toBe("board_quantity_must_be_whole");
  });

  it("rejects '3.0' — a decimal nobody means to type for a board count", () => {
    expect(code(() => parseBoardQuantity("3.0"))).toBe("board_quantity_must_be_whole");
  });

  it("rejects exponent notation, which is not how boards are counted", () => {
    expect(code(() => parseBoardQuantity("1e3"))).toBe("board_quantity_must_be_whole");
  });

  it.each(["", "   ", "abc", "٣", "NaN", "Infinity"])("rejects the non-number %p", (input) => {
    expect(code(() => parseBoardQuantity(input))).toBe("board_quantity_must_be_whole");
  });

  it("tolerates surrounding whitespace on an otherwise valid count", () => {
    expect(parseBoardQuantity("  5  ").toString()).toBe("5");
  });
});

describe("board size", () => {
  it.each(["0", "-4"])("rejects the unusable size %p", (input) => {
    expect(code(() => parseBoardSize(input))).toBe("board_size_invalid");
  });

  // A raw DecimalError escaping here would become a 500 instead of a
  // validation failure, so unparseable input must come back typed.
  it.each(["abc", "", "NaN", "Infinity"])("reports the unparseable size %p as a typed error", (input) => {
    expect(code(() => parseBoardSize(input))).toBe("board_size_invalid");
  });

  it("reports an unparseable cost as a typed error too", () => {
    expect(code(() => computeLine({ boardQuantity: "1", boardSize: "4", costPerMetre: "abc" })))
      .toBe("cost_per_metre_invalid");
  });
});

describe("metres are derived, never entered", () => {
  it("multiplies boards by the variant's own board size", () => {
    expect(metresForBoards(new Decimal(3), new Decimal("5.25")).toString()).toBe("15.75");
    expect(metresForBoards(new Decimal(4), new Decimal("4.00")).toString()).toBe("16");
  });

  it("is exact for sizes that binary floating point gets wrong", () => {
    // 7 * 0.1 is 0.7000000000000001 in IEEE-754 doubles.
    expect(metresForBoards(new Decimal(7), new Decimal("0.1")).toString()).toBe("0.7");
    expect(metresForBoards(new Decimal(3), new Decimal("0.1")).toString()).toBe("0.3");
  });

  it("stores at exactly the column's 4 decimal places", () => {
    expect(metresForBoards(new Decimal(3), new Decimal("1.23456")).toFixed(4)).toBe("3.7037");
  });

  it("scales linearly — one board of size s, n times, is n boards of size s", () => {
    const size = new Decimal("5.25");
    const single = metresForBoards(new Decimal(1), size);
    expect(metresForBoards(new Decimal(9), size).toString()).toBe(single.times(9).toString());
  });
});

describe("value carried by the transfer", () => {
  it("is metres × the shared cost, at 2dp", () => {
    expect(transferValue(new Decimal("15.75"), new Decimal("12.3456")).toString()).toBe("194.44");
  });

  it("is zero when the cost is zero, without throwing", () => {
    expect(transferValue(new Decimal("15.75"), new Decimal(0)).toString()).toBe("0");
  });
});

describe("computeLine", () => {
  it("produces boards, derived metres and value together", () => {
    const line = computeLine({ boardQuantity: "3", boardSize: "5.25", costPerMetre: "100" });
    expect(line.boards.toString()).toBe("3");
    expect(line.metres.toString()).toBe("15.75");
    expect(line.value.toString()).toBe("1575");
  });

  it("refuses a negative cost rather than moving stock at a nonsense value", () => {
    expect(code(() => computeLine({ boardQuantity: "3", boardSize: "5.25", costPerMetre: "-1" })))
      .toBe("cost_per_metre_invalid");
  });
});

describe("the two legs must cancel", () => {
  const legs = (over: Partial<Record<string, Decimal>> = {}) => ({
    sourceBoardsDelta: new Decimal(-3),
    destinationBoardsDelta: new Decimal(3),
    sourceMetresDelta: new Decimal("-15.75"),
    destinationMetresDelta: new Decimal("15.75"),
    sourceValueDelta: new Decimal("-1575"),
    destinationValueDelta: new Decimal("1575"),
    ...over,
  });

  it("passes for an equal and opposite pair", () => {
    expect(() => assertPairConserves(legs())).not.toThrow();
  });

  it.each([
    ["boards", { destinationBoardsDelta: new Decimal(4) }],
    ["metres", { destinationMetresDelta: new Decimal("15.7501") }],
    ["value", { destinationValueDelta: new Decimal("1575.01") }],
  ])("catches a %s mismatch of any size", (_what, over) => {
    expect(code(() => assertPairConserves(legs(over)))).toBe("transfer_pair_not_conserved");
  });
});

describe("document numbering", () => {
  it("pads to the six-digit TRF form", () => {
    expect(formatTransferNumber(1n)).toBe("TRF-000001");
    expect(formatTransferNumber(1234567)).toBe("TRF-1234567");
  });
});
