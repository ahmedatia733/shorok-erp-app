/**
 * Proves the tax page classifies VAT by origin and nets cancellations:
 * a cancelled purchase's original + reversal both sit on the INPUT side and
 * cancel to zero, they never leak onto the output side, and an unrelated
 * output-VAT credit survives untouched.
 */
import { directionTotal, splitByDirection, taxSummary } from "./tax-summary";
import type { TaxEntry, TaxLedgerResult } from "./tax-client";

function entry(over: Partial<TaxEntry>): TaxEntry {
  return {
    id: Math.random().toString(36).slice(2),
    entryId: "je", entryNumber: "1", date: "2026-07-10",
    reference: "", referenceType: "purchase_invoice", referenceLabel: "فاتورة مشتريات",
    referenceId: null, description: "", note: "",
    accountId: "vat", accountCode: "2300", accountNameAr: "ضريبة",
    debit: "", credit: "", runningBalance: "0.00",
    invoiceDetail: null,
    vatDirection: "input", vatAmount: "0.00", isReversal: false, reversed: false,
    ...over,
  };
}

const original  = entry({ referenceType: "purchase_invoice", debit: "140.00", vatDirection: "input", vatAmount: "140.00", reversed: true });
const reversal  = entry({ referenceType: "purchase_invoice", credit: "140.00", vatDirection: "input", vatAmount: "-140.00", isReversal: true });
const saleOut   = entry({ referenceType: "sales_invoice", credit: "90.00", vatDirection: "output", vatAmount: "90.00", referenceLabel: "فاتورة مبيعات" });

describe("tax-summary — reversal-aware VAT split", () => {
  it("a cancelled purchase's original + reversal net to zero on the INPUT side", () => {
    expect(directionTotal([original, reversal], "input")).toBeCloseTo(0);
  });

  it("the purchase reversal never appears on the output side", () => {
    expect(directionTotal([original, reversal], "output")).toBeCloseTo(0);
    expect(splitByDirection([original, reversal], "output")).toHaveLength(0);
  });

  it("both the original and its reversal are shown on the input side, flagged", () => {
    const rows = splitByDirection([original, reversal], "input");
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.isReversal)?.amount).toBe(-140);
    expect(rows.find((r) => r.reversed && !r.isReversal)).toBeTruthy();
  });

  it("an unrelated output-VAT credit survives a purchase cancellation", () => {
    const entries = [original, reversal, saleOut];
    expect(directionTotal(entries, "input")).toBeCloseTo(0);
    expect(directionTotal(entries, "output")).toBeCloseTo(90);
  });

  it("taxSummary reads the netted backend totals, not raw debit/credit", () => {
    const result = {
      periodTotals: { debit: "140.00", credit: "230.00", net: "-140.00", inputVat: "0.00", outputVat: "90.00" },
      closing: { debit: "140.00", credit: "230.00", net: "90.00", inputVat: "0.00", outputVat: "90.00", status: "liability" },
    } as unknown as TaxLedgerResult;
    const s = taxSummary(result);
    expect(s.inputVat).toBe(0);   // NOT 140 (raw debit)
    expect(s.outputVat).toBe(90);
    expect(s.net).toBe(90);
    expect(s.status).toBe("liability");
  });
});
