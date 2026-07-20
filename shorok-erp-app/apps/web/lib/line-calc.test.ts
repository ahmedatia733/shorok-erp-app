/**
 * Proves the invoice line arithmetic matches the spec examples exactly and is
 * Decimal-safe (no floating-point drift), so the on-screen preview equals what
 * the API will post.
 */
import {
  boardArea,
  lineTotalPerMeter,
  metersPerBoard,
  money,
  subtractMoney,
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

describe("line-calc — sales PER METER (confirmed rule) + spec examples", () => {
  // Sales: totalMeters = boards × size; lineTotal = totalMeters × salePricePerMeter.
  it("A) 10 boards × 4.00 × 498 → gross 19,920.00; cost 40 × 498 = 19,920.00", () => {
    const meters = totalMeters("10", "4.00");        // 40.0000
    expect(meters).toBe("40.0000");
    expect(lineTotalPerMeter(meters, "498")).toBe("19920.00");
    expect(lineTotalPerMeter(meters, "498")).toBe("19920.00"); // cost @ 498/m identical
  });
  it("B) 45 boards × 5.25 × 498 → 117,652.50", () => {
    const meters = totalMeters("45", "5.25");        // 236.2500
    expect(meters).toBe("236.2500");
    expect(lineTotalPerMeter(meters, "498")).toBe("117652.50");
  });
  it("C) 8 boards × 3.75 → 30.00 m; sale 750 → 22,500.00; cost 498 → 14,940.00; profit 7,560.00", () => {
    const meters = totalMeters("8", "3.75");          // 30.0000
    expect(meters).toBe("30.0000");
    const lineTotal = lineTotalPerMeter(meters, "750");
    const lineCost = lineTotalPerMeter(meters, "498");
    expect(lineTotal).toBe("22500.00");
    expect(lineCost).toBe("14940.00");
    expect(subtractMoney(lineTotal, lineCost)).toBe("7560.00");
  });
  it("15) discount is taken from the per-meter gross sale", () => {
    const meters = totalMeters("10", "4.00");         // 40.0000
    const gross = lineTotalPerMeter(meters, "498");   // 19,920.00
    const discount = taxAmount(gross, "10");          // 10% → 1,992.00
    expect(discount).toBe("1992.00");
    expect(subtractMoney(gross, discount)).toBe("17928.00");
  });
});

describe("line-calc — cost preview per meter (spec 3/7)", () => {
  // The visible cost preview is defaultPurchasePricePerMeter (per meter), and the
  // line cost = totalMeters × that. Board-total costs are NOT used any more.
  it("40 m × 498/m = 19,920.00", () => {
    expect(lineTotalPerMeter("40", "498")).toBe("19920.00");
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
