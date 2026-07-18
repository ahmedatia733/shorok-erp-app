/**
 * Opening dataset (2026-07-18) — pure validation of the authoritative data:
 * counts, AP-prefix normalization, the AP 199 / AP 183 / AP 1010 rules, exact
 * stock + customer totals. No database — guards the embedded data itself.
 */
import { Decimal } from "decimal.js";
import {
  CUSTOMERS, EXPECT, PRODUCTS, VARIANTS, computeTotals, normalizeCode, sizeOf, validateDataset,
} from "../../scripts/opening-dataset";

describe("opening dataset (authoritative 2026-07-18)", () => {
  it("has exactly 27 products and 41 variants", () => {
    expect(PRODUCTS).toHaveLength(27);
    expect(VARIANTS).toHaveLength(41);
    expect(new Set(PRODUCTS.map(([c]) => c)).size).toBe(27);
  });

  it("every code begins with 'AP ' and is normalized", () => {
    for (const [code] of PRODUCTS) {
      expect(code.startsWith("AP ")).toBe(true);
      expect(normalizeCode(code)).toBe(code);
    }
    for (const v of VARIANTS) expect(normalizeCode(v.code)).toBe(v.code);
  });

  it("normalizes d1/D1 and d4/D4 to AP D1 / AP D4", () => {
    expect(normalizeCode(" d1 ")).toBe("AP D1");
    expect(normalizeCode("ap d4")).toBe("AP D4");
    expect(normalizeCode("AP  d1")).toBe("AP D1");
  });

  it("AP 199 is شامبين جولد and AP 183 is not present", () => {
    const byCode = new Map(PRODUCTS);
    expect(byCode.get("AP 199")).toBe("شامبين جولد");
    expect(byCode.has("AP 183")).toBe(false);
    expect(VARIANTS.some((v) => v.code === "AP 183")).toBe(false);
  });

  it("AP 1010 is خشبي دابل فيس with exactly two variants and no separate خشبي master", () => {
    const byCode = new Map(PRODUCTS);
    expect(byCode.get("AP 1010")).toBe("خشبي دابل فيس");
    expect([...byCode.values()]).not.toContain("خشبي");
    const ap1010 = VARIANTS.filter((v) => v.code === "AP 1010");
    expect(ap1010).toHaveLength(2);
    for (const v of ap1010) expect(v.item).toBe("خشبي دابل فيس");
    // The two sizes: 1.25×3.20 and 1.25×3.00.
    expect(ap1010.map((v) => `${v.width}x${v.length}`).sort()).toEqual(["1.25x3.00", "1.25x3.20"]);
  });

  it("every row's meters equals boards × width × length", () => {
    for (const v of VARIANTS) {
      const mpb = sizeOf(v);
      expect(new Decimal(v.waraqBoards).mul(mpb).eq(v.waraqMeters)).toBe(true);
      expect(new Decimal(v.sohagBoards).mul(mpb).eq(v.sohagMeters)).toBe(true);
    }
  });

  it("inventory totals match the authoritative source exactly", () => {
    const t = computeTotals();
    expect(t.wb.eq(EXPECT.waraq.boards)).toBe(true);
    expect(t.wm.toFixed(2)).toBe(EXPECT.waraq.meters);
    expect(t.wval.toFixed(2)).toBe(EXPECT.waraq.value);
    expect(t.sb.eq(EXPECT.sohag.boards)).toBe(true);
    expect(t.sm.toFixed(2)).toBe(EXPECT.sohag.meters);
    expect(t.sval.toFixed(2)).toBe(EXPECT.sohag.value);
    expect(t.wb.add(t.sb).eq(EXPECT.combined.boards)).toBe(true);
    expect(t.wm.add(t.sm).toFixed(2)).toBe(EXPECT.combined.meters);
    expect(t.wval.add(t.sval).toFixed(2)).toBe(EXPECT.combined.value);
  });

  it("has 19 customers: 15 debit (1,592,830) and 4 credit (287,580), net 1,305,250 debit", () => {
    expect(CUSTOMERS).toHaveLength(19);
    const debit = CUSTOMERS.filter((c) => c.side === "DEBIT");
    const credit = CUSTOMERS.filter((c) => c.side === "CREDIT");
    expect(debit).toHaveLength(15);
    expect(credit).toHaveLength(4);
    const dt = debit.reduce((a, c) => a.add(c.amount), new Decimal(0));
    const ct = credit.reduce((a, c) => a.add(c.amount), new Decimal(0));
    expect(dt.toFixed(2)).toBe("1592830.00");
    expect(ct.toFixed(2)).toBe("287580.00");
    expect(dt.sub(ct).toFixed(2)).toBe("1305250.00");
    expect(new Set(CUSTOMERS.map((c) => c.name.trim())).size).toBe(19);
  });

  it("validateDataset() passes on the authoritative data", () => {
    expect(() => validateDataset()).not.toThrow();
  });
});
