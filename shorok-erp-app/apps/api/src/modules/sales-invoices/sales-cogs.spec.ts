import { lineCogs } from "./sales-cogs";

describe("sales COGS (from avg_cost)", () => {
  it("boards × avg_cost per board", () => {
    // 4 boards × 560 = 2240
    expect(lineCogs("4", "560").toString()).toBe("2240");
  });
  it("30 boards × 498 = 14940 (spec example C cost basis shape)", () => {
    expect(lineCogs("30", "498").toString()).toBe("14940");
  });
  it("is 0 when avg_cost is 0 (no cost basis yet → caller skips COGS entry)", () => {
    expect(lineCogs("10", "0").toString()).toBe("0");
  });
  it("guards non-positive board quantity", () => {
    expect(lineCogs("0", "560").toString()).toBe("0");
    expect(lineCogs("-2", "560").toString()).toBe("0");
  });
});
