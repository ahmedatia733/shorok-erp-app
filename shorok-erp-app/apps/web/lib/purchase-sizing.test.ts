import { boardArea, totalArea, BOARD_AREA_LARGE, BOARD_AREA_SMALL } from "./purchase-sizing";

describe("purchase-sizing", () => {
  describe("boardArea", () => {
    it("returns 5.25 for كبير (K)", () => {
      expect(boardArea("K", 0, 0, 3)).toBe(BOARD_AREA_LARGE);
    });
    it("returns 4 for صغير (S)", () => {
      expect(boardArea("S", 0, 0, 3)).toBe(BOARD_AREA_SMALL);
    });
    it("returns طول×عرض for custom dimensions", () => {
      expect(boardArea("", 3, 4, 0)).toBe(12);
    });
    it("custom dimensions override the standard choice", () => {
      expect(boardArea("K", 3, 4, 0)).toBe(12);
    });
    it("falls back to the variant size when nothing chosen", () => {
      expect(boardArea("", 0, 0, 3.5)).toBe(3.5);
    });
    it("returns 0 when nothing is available", () => {
      expect(boardArea("", 0, 0, 0)).toBe(0);
    });
  });

  describe("totalArea = boards × areaPerBoard", () => {
    // The exact examples from the bug report.
    it("كبير + 1 board → 5.25", () => {
      expect(totalArea(1, boardArea("K", 0, 0, 3))).toBe(5.25);
    });
    it("كبير + 4 boards → 21", () => {
      expect(totalArea(4, boardArea("K", 0, 0, 3))).toBe(21);
    });
    it("صغير + 1 board → 4", () => {
      expect(totalArea(1, boardArea("S", 0, 0, 3))).toBe(4);
    });
    it("صغير + 4 boards → 16", () => {
      expect(totalArea(4, boardArea("S", 0, 0, 3))).toBe(16);
    });
    it("custom 3×4 + 1 board → 12", () => {
      expect(totalArea(1, boardArea("", 3, 4, 0))).toBe(12);
    });
    it("returns 0 for non-positive inputs", () => {
      expect(totalArea(0, 5.25)).toBe(0);
      expect(totalArea(4, 0)).toBe(0);
    });
  });
});
