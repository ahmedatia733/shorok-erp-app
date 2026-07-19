/**
 * Proves the invoice line arithmetic matches the spec examples exactly and is
 * Decimal-safe (no floating-point drift), so the on-screen preview equals what
 * the API will post.
 */
import {
  boardArea,
  lineTotalPerBoard,
  lineTotalPerMeter,
  metersPerBoard,
  money,
  taxAmount,
  totalMeters,
} from "./line-calc";

describe("line-calc — spec examples", () => {
  it("1) a 1.25 × 3.20 variant is 4.00 m² per board", () => {
    expect(metersPerBoard("1.25", "3.20")).toBe("4.0000");
  });

  it("2) quantity 10 produces 40.00 total meters", () => {
    expect(totalMeters("10", metersPerBoard("1.25", "3.20"))).toBe("40.0000");
  });

  it("3) price 498 (per meter) produces a line total of 19,920.00", () => {
    const meters = totalMeters("10", metersPerBoard("1.25", "3.20"));
    expect(lineTotalPerMeter(meters, "498")).toBe("19920.00");
  });

  it("4) a 1.50 × 3.50 variant is 5.25 m² per board", () => {
    expect(metersPerBoard("1.50", "3.50")).toBe("5.2500");
  });

  it("5) quantity 45 produces 236.25 total meters", () => {
    expect(totalMeters("45", metersPerBoard("1.50", "3.50"))).toBe("236.2500");
  });

  it("6) price 498 (per meter) produces 117,652.50", () => {
    const meters = totalMeters("45", metersPerBoard("1.50", "3.50"));
    expect(lineTotalPerMeter(meters, "498")).toBe("117652.50");
  });
});

describe("line-calc — Decimal safety & rounding", () => {
  it("does not drift on values that break IEEE floats", () => {
    // 0.1 * 0.2 === 0.020000000000000004 in float; fixed-point stays exact.
    expect(metersPerBoard("0.1", "0.2")).toBe("0.0200");
    // 1.1 + 2.2 style traps show up in accumulation; the product path is exact.
    expect(money("0.07", "100")).toBe("7.00");
  });

  it("rounds money HALF-UP to 2 dp, matching decimal.js toFixed", () => {
    expect(money("0.005", "1")).toBe("0.01");
    expect(money("0.004", "1")).toBe("0.00");
    expect(taxAmount("22410.00", "14")).toBe("3137.40");
  });
});

describe("line-calc — sales board cost & line total (spec 7)", () => {
  // Estimated board cost = purchase price per meter × board size (NOT avg_cost).
  it("size 4.00 @ 498/m → board cost 1,992.00", () => {
    expect(money("498", "4.00")).toBe("1992.00");
  });
  it("size 5.25 @ 498/m → board cost 2,614.50", () => {
    expect(money("498", "5.25")).toBe("2614.50");
  });
  it("size 3.75 @ 750/m → board cost 2,812.50", () => {
    expect(money("750", "3.75")).toBe("2812.50");
  });
  it("8 boards × manual sale price 3000 → line total 24,000.00", () => {
    expect(lineTotalPerBoard("8", "3000")).toBe("24000.00");
  });
});

describe("line-calc — sales (per board) vs purchase (per meter)", () => {
  it("14) frontend line totals agree with the backend formulas", () => {
    // Purchase backend: lineTotal = metersQuantity × unitPrice (per meter).
    const meters = totalMeters("45", metersPerBoard("1.50", "3.50")); // 236.2500
    expect(lineTotalPerMeter(meters, "498")).toBe("117652.50");
    // Sales backend: lineTotal = quantity(boards) × unitPrice (per board).
    expect(lineTotalPerBoard("45", "498")).toBe("22410.00");
  });
});

describe("line-calc — boardArea rules", () => {
  it("custom طول×عرض overrides the size choice", () => {
    expect(boardArea("K", "1.25", "3.20", "9")).toBe("4.0000");
  });
  it("كبير = 5.25 and صغير = 4 when no custom size", () => {
    expect(boardArea("K", "", "", "9")).toBe("5.25");
    expect(boardArea("S", "", "", "9")).toBe("4");
  });
  it("falls back to the variant's stored size", () => {
    expect(boardArea("", "", "", "5.25")).toBe("5.2500");
    expect(boardArea("", "", "", "")).toBe("0");
  });
});

describe("line-calc — locale independence (test 15)", () => {
  it("returns canonical ASCII decimals regardless of UI locale", () => {
    const meters = totalMeters("45", metersPerBoard("1.50", "3.50"));
    const total = lineTotalPerMeter(meters, "498");
    // No Arabic-Indic digits, no thousands separators — a stable numeric string
    // that renders identically in ar and en after locale formatting.
    expect(/^[0-9.]+$/.test(total)).toBe(true);
    expect(Number(total)).toBe(117652.5);
  });
});
