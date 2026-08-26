import { describe, expect, it } from "@jest/globals";
import { deductionDisplay } from "./pnl-format";

/**
 * The income statement's calculation is debit-normal and lives in the API:
 * expense = debit − credit, netProfit = grossProfit − totalExpenses. These tests
 * are about the SIGN THE READER SEES, and specifically that presentation never
 * contradicts the arithmetic.
 */
describe("deductionDisplay", () => {
  it("puts money actually spent in deduction parentheses", () => {
    const d = deductionDisplay("900.00");
    expect(d.kind).toBe("DEDUCTION");
    expect(d.parenthesise).toBe(true);
    expect(Number(d.magnitude)).toBe(900);
  });

  it("never wraps a credit balance in deduction parentheses", () => {
    // An expense account with a credit balance INCREASED profit. Showing it as
    // «(900)» would tell the reader 900 was spent while net profit rose by 900.
    const d = deductionDisplay("-900.00");
    expect(d.kind).toBe("CREDIT");
    expect(d.parenthesise).toBe(false);
    expect(Number(d.magnitude)).toBe(900);
  });

  it("reports a magnitude, never a smuggled negative", () => {
    for (const v of ["-900.00", "-0.01", "-123456.78"]) {
      expect(Number(deductionDisplay(v).magnitude)).toBeGreaterThan(0);
    }
  });

  it("treats zero as an ordinary deduction row", () => {
    const d = deductionDisplay("0.00");
    expect(d.kind).toBe("ZERO");
    expect(d.parenthesise).toBe(true);
  });

  it("accepts numbers as well as the API's strings", () => {
    expect(deductionDisplay(900).kind).toBe("DEDUCTION");
    expect(deductionDisplay(-900).kind).toBe("CREDIT");
  });

  it("does not fall over on a non-numeric value", () => {
    expect(deductionDisplay("—").kind).toBe("ZERO");
  });

  it("changes only presentation — it never returns a value to compute with", () => {
    // The helper deliberately exposes no signed amount: net profit comes from
    // the API and must never be re-derived on the client.
    expect(Object.keys(deductionDisplay("-900.00")).sort()).toEqual(["kind", "magnitude", "parenthesise"]);
  });
});
