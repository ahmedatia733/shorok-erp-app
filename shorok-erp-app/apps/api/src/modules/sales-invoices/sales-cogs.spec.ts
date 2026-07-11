import { lineCogs } from "./sales-cogs";

describe("sales COGS (from avg_cost)", () => {
  it("boards × avg_cost when 1 metre = 1 board", () => {
    // 4 metres / 1 = 4 boards × 560 = 2240
    expect(lineCogs("4", "1", "560").toString()).toBe("2240");
  });
  it("converts metres to boards via size", () => {
    // 21 metres / 5.25 = 4 boards × 560 = 2240
    expect(lineCogs("21", "5.25", "560").toString()).toBe("2240");
  });
  it("is 0 when avg_cost is 0 (no cost basis yet → caller skips COGS entry)", () => {
    expect(lineCogs("10", "1", "0").toString()).toBe("0");
  });
  it("guards non-positive board size", () => {
    expect(lineCogs("10", "0", "560").toString()).toBe("0");
  });
});
