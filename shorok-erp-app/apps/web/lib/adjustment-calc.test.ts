/**
 * Proves the «تعديل مخزون» preview says exactly what the engine will do:
 * whole boards only, metres derived from the variant's own board size, and a
 * balance that is never allowed to be promised into the negative.
 */
import { projectAdjustment, signedBoardDelta } from "./adjustment-calc";

describe("signedBoardDelta — what actually reaches the API", () => {
  it("sends a bare count for an increase and a negated one for a decrease", () => {
    expect(signedBoardDelta("INCREASE", "3")).toBe("3");
    expect(signedBoardDelta("DECREASE", "3")).toBe("-3");
  });

  it("refuses a fractional board however it is written", () => {
    for (const input of ["1.5", "0.25", "2.", ".5", "3,5"]) {
      expect(signedBoardDelta("INCREASE", input)).toBeNull();
    }
  });

  it("refuses zero, which is a no-op the engine rejects rather than a settlement", () => {
    expect(signedBoardDelta("INCREASE", "0")).toBeNull();
    expect(signedBoardDelta("DECREASE", "000")).toBeNull();
  });

  it("refuses an empty box, whitespace and non-numeric text", () => {
    for (const input of ["", "   ", "abc", "٣"]) {
      expect(signedBoardDelta("INCREASE", input)).toBeNull();
    }
  });

  it("never lets the sign be typed — a decrease is a choice, not a character", () => {
    // "-3" typed into the box is not a valid board count; the direction control
    // is the only thing that may make a delta negative.
    expect(signedBoardDelta("INCREASE", "-3")).toBeNull();
    expect(signedBoardDelta("DECREASE", "-3")).toBeNull();
  });

  it("strips leading zeros rather than sending 007", () => {
    expect(signedBoardDelta("INCREASE", "007")).toBe("7");
    expect(signedBoardDelta("DECREASE", "010")).toBe("-10");
  });

  it("yields nothing until a direction has been chosen", () => {
    expect(signedBoardDelta(null, "5")).toBeNull();
  });
});

describe("projectAdjustment — the balance the screen promises", () => {
  const large = { boardsOnHand: "10.0000", metersOnHand: "52.5000", boardSizeMeters: "5.2500" };

  it("moves metres by boards × the variant's own board size", () => {
    const p = projectAdjustment(large, "3")!;
    expect(p.metersDelta).toBe("15.7500");
    expect(p.resultingBoards).toBe("13.0000");
    expect(p.resultingMeters).toBe("68.2500");
    expect(p.negative).toBe(false);
  });

  it("subtracts on a decrease", () => {
    const p = projectAdjustment(large, "-4")!;
    expect(p.metersDelta).toBe("-21.0000");
    expect(p.resultingBoards).toBe("6.0000");
    expect(p.resultingMeters).toBe("31.5000");
    expect(p.negative).toBe(false);
  });

  it("uses the 4.00 board for a ص variant, not the 5.25 one", () => {
    const small = { boardsOnHand: "8.0000", metersOnHand: "32.0000", boardSizeMeters: "4.0000" };
    const p = projectAdjustment(small, "2")!;
    expect(p.metersDelta).toBe("8.0000");
    expect(p.resultingMeters).toBe("40.0000");
  });

  it("handles a custom board size exactly, with no float drift", () => {
    const custom = { boardsOnHand: "3.0000", metersOnHand: "9.9900", boardSizeMeters: "3.3300" };
    const p = projectAdjustment(custom, "7")!;
    expect(p.metersDelta).toBe("23.3100");
    expect(p.resultingMeters).toBe("33.3000");
  });

  it("reaches exactly zero without reporting a negative balance", () => {
    const p = projectAdjustment(large, "-10")!;
    expect(p.resultingBoards).toBe("0.0000");
    expect(p.resultingMeters).toBe("0.0000");
    expect(p.negative).toBe(false);
  });

  it("flags a decrease that would drive the balance below zero", () => {
    const p = projectAdjustment(large, "-11")!;
    expect(p.resultingBoards).toBe("-1.0000");
    expect(p.negative).toBe(true);
  });

  it("adds to a size holding nothing, which is what a found-stock settlement is", () => {
    const empty = { boardsOnHand: "0.0000", metersOnHand: "0.0000", boardSizeMeters: "5.2500" };
    const p = projectAdjustment(empty, "2")!;
    expect(p.resultingBoards).toBe("2.0000");
    expect(p.resultingMeters).toBe("10.5000");
    expect(p.negative).toBe(false);
  });

  it("keeps the metres the branch really holds when a board has been part-cut", () => {
    // 10 boards but only 50 metres: 2.5 m has already been cut off one of them.
    // Removing one board must take 5.25 m off the *real* figure, not off a
    // recomputed 52.50 that the branch never had.
    const partCut = { boardsOnHand: "10.0000", metersOnHand: "50.0000", boardSizeMeters: "5.2500" };
    const p = projectAdjustment(partCut, "-1")!;
    expect(p.resultingBoards).toBe("9.0000");
    expect(p.resultingMeters).toBe("44.7500");
  });

  it("catches a metre balance that would go negative even when boards do not", () => {
    // A balance already inconsistent enough that boards survive the decrease
    // but metres do not. The engine blocks on either measure; so does this.
    const thin = { boardsOnHand: "10.0000", metersOnHand: "3.0000", boardSizeMeters: "5.2500" };
    const p = projectAdjustment(thin, "-1")!;
    expect(p.resultingBoards).toBe("9.0000");
    expect(p.resultingMeters).toBe("-2.2500");
    expect(p.negative).toBe(true);
  });
});
