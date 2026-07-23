import { Decimal } from "decimal.js";
import { allocateReturn, zeroAlready, type OriginalLineEconomics } from "./return-allocation";

const D = (v: string) => new Decimal(v);

/** A line that does NOT divide evenly, to exercise rounding + residual. */
const awkward: OriginalLineEconomics = {
  meters: D("3"),        // return in three 1-metre slices
  boards: D("3"),
  gross: D("100"),       // 100 / 3 = 33.3333…
  discount: D("10"),     // 10 / 3  = 3.3333…
  net: D("90"),
  lineTax: D("12.60"),   // 14% of 90 = 12.60 → 4.20 per slice
  lineCogs: D("40"),     // 40 / 3 = 13.3333…
};

describe("allocateReturn (returns §7/§8/§12)", () => {
  it("uses the metre ratio and rounds each partial to 2dp", () => {
    const a = allocateReturn(awkward, zeroAlready(), D("1"), null);
    expect(a.isFinal).toBe(false);
    expect(a.gross.toFixed(2)).toBe("33.33");
    expect(a.discount.toFixed(2)).toBe("3.33");
    expect(a.net.toFixed(2)).toBe("30.00");   // 33.33 − 3.33
    expect(a.tax.toFixed(2)).toBe("4.20");
    expect(a.total.toFixed(2)).toBe("34.20");
    expect(a.cogs.toFixed(2)).toBe("13.33");
    expect(a.boards.toFixed(4)).toBe("1.0000");
  });

  it("three 1-metre partials reconcile EXACTLY to the original line (residual on the last)", () => {
    let already = zeroAlready();
    const sum = { gross: new Decimal(0), discount: new Decimal(0), net: new Decimal(0), tax: new Decimal(0), total: new Decimal(0), cogs: new Decimal(0), boards: new Decimal(0) };
    for (let i = 0; i < 3; i++) {
      const a = allocateReturn(awkward, already, D("1"), null);
      if (i === 2) expect(a.isFinal).toBe(true);
      // The final slice takes the residual so rounding never drifts.
      if (i === 2) {
        expect(a.gross.toFixed(2)).toBe("33.34"); // 100 − 33.33 − 33.33
        expect(a.cogs.toFixed(2)).toBe("13.34");  // 40 − 13.33 − 13.33
      }
      (Object.keys(sum) as (keyof typeof sum)[]).forEach((k) => { sum[k] = sum[k].plus((a as any)[k]); });
      already = {
        meters: already.meters.plus(a.meters), boards: already.boards.plus(a.boards),
        gross: already.gross.plus(a.gross), discount: already.discount.plus(a.discount),
        net: already.net.plus(a.net), tax: already.tax.plus(a.tax), cogs: already.cogs.plus(a.cogs),
      };
    }
    expect(sum.gross.toFixed(2)).toBe("100.00");
    expect(sum.discount.toFixed(2)).toBe("10.00");
    expect(sum.net.toFixed(2)).toBe("90.00");
    expect(sum.tax.toFixed(2)).toBe("12.60");
    expect(sum.total.toFixed(2)).toBe("102.60");
    expect(sum.cogs.toFixed(2)).toBe("40.00");
    expect(sum.boards.toFixed(4)).toBe("3.0000");
  });

  it("a single full return equals the whole original line", () => {
    const a = allocateReturn(awkward, zeroAlready(), D("3"), null);
    expect(a.isFinal).toBe(true);
    expect(a.net.toFixed(2)).toBe("90.00");
    expect(a.cogs.toFixed(2)).toBe("40.00");
    expect(a.total.toFixed(2)).toBe("102.60");
  });
});
