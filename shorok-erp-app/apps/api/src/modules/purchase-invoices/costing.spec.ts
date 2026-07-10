import { Decimal } from "decimal.js";
import { weightedAverageCost, unitCostPerBoard } from "./costing";

describe("purchase costing (WAC)", () => {
  it("first receipt sets avg to the incoming unit cost (starts from 0/empty)", () => {
    expect(weightedAverageCost(0, 0, 10, "550").toString()).toBe("550");
  });

  it("blends existing on-hand with the new receipt", () => {
    // 10 @ 500 on hand, receive 10 @ 600 → (5000 + 6000)/20 = 550
    expect(weightedAverageCost(10, "500", 10, "600").toString()).toBe("550");
  });

  it("weights by quantity", () => {
    // 30 @ 500, receive 10 @ 700 → (15000 + 7000)/40 = 550
    expect(weightedAverageCost(30, "500", 10, "700").toString()).toBe("550");
  });

  it("returns the incoming cost when nothing is (or would be) on hand", () => {
    expect(weightedAverageCost(0, "999", 0, "560").toString()).toBe("560");
  });

  it("unitCostPerBoard = ex-tax total / boards", () => {
    // 4 boards, ex-tax line total 2240 → 560 per board
    expect(unitCostPerBoard("2240", 4).toString()).toBe("560");
  });

  it("unitCostPerBoard guards divide-by-zero", () => {
    expect(unitCostPerBoard("100", 0).toString()).toBe("0");
  });
});
