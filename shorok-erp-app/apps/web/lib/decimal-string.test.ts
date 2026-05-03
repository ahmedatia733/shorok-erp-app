/**
 * Unit tests for the client-side decimal-string helpers used by the inventory
 * count UI's variance preview. These guard against the float-arithmetic
 * regression we found during the Phase 3 audit (Number-based variance
 * gave 0.30000000000000004 for 0.1 + 0.2).
 */
import {
  decimalSub,
  isNegativeDecimalString,
  isZeroDecimalString,
} from "./decimal-string";

describe("decimal-string", () => {
  describe("decimalSub", () => {
    it("returns 4-dp formatted result for whole numbers", () => {
      expect(decimalSub("12", "5")).toBe("7.0000");
    });

    it("subtracts negatives correctly", () => {
      expect(decimalSub("5", "12")).toBe("-7.0000");
    });

    it("handles fractional inputs precisely (no float drift)", () => {
      expect(decimalSub("0.3", "0.1")).toBe("0.2000");
      // The classic float gotcha: 0.1 + 0.2 = 0.30000000000000004
      // counted=0.3, expected=0.2 → 0.1 (NOT 0.09999... or 0.10000...4)
      expect(decimalSub("0.3", "0.2")).toBe("0.1000");
    });

    it("handles negative subtrahend (counted − (−x) = counted + x)", () => {
      expect(decimalSub("5", "-3")).toBe("8.0000");
    });

    it("handles negative minuend", () => {
      expect(decimalSub("-3", "2")).toBe("-5.0000");
    });

    it("returns null for malformed input", () => {
      expect(decimalSub("abc", "5")).toBeNull();
      expect(decimalSub("5", "")).toBeNull();
      expect(decimalSub("5.", "1")).toBeNull();
    });

    it("handles 4-dp boundary values from NUMERIC(14,4)", () => {
      expect(decimalSub("10.0001", "10.0000")).toBe("0.0001");
      expect(decimalSub("10.0000", "10.0001")).toBe("-0.0001");
    });
  });

  describe("isZeroDecimalString", () => {
    it("recognises zero in all forms", () => {
      expect(isZeroDecimalString("0")).toBe(true);
      expect(isZeroDecimalString("0.0")).toBe(true);
      expect(isZeroDecimalString("0.0000")).toBe(true);
      expect(isZeroDecimalString("-0")).toBe(true);
      expect(isZeroDecimalString("-0.0000")).toBe(true);
    });
    it("rejects non-zero", () => {
      expect(isZeroDecimalString("0.0001")).toBe(false);
      expect(isZeroDecimalString("-0.0001")).toBe(false);
      expect(isZeroDecimalString("1")).toBe(false);
    });
  });

  describe("isNegativeDecimalString", () => {
    it("returns true only for actual negatives", () => {
      expect(isNegativeDecimalString("-1")).toBe(true);
      expect(isNegativeDecimalString("-0.0001")).toBe(true);
    });
    it("returns false for zero variants and positives", () => {
      expect(isNegativeDecimalString("-0")).toBe(false);
      expect(isNegativeDecimalString("-0.0000")).toBe(false);
      expect(isNegativeDecimalString("0")).toBe(false);
      expect(isNegativeDecimalString("1")).toBe(false);
    });
  });
});
