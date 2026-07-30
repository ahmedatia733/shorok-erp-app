import { sourceDocumentHref, journalEntryHref, hasSourceDocument, sourceLabel } from "./source-document";

const L = "ar";

describe("source-document resolver", () => {
  it("11/12) a sales-invoice row links to the invoice detail via sourceId", () => {
    const href = sourceDocumentHref({ sourceType: "SALES_INVOICE", sourceId: "si-1", journalEntryId: "je-1" }, L);
    expect(href).toBe("/ar/sales/invoices/si-1");
    expect(hasSourceDocument({ sourceType: "SALES_INVOICE", sourceId: "si-1" })).toBe(true);
  });

  it("purchase-invoice row links to the purchase detail", () => {
    expect(sourceDocumentHref({ sourceType: "PURCHASE_INVOICE", sourceId: "pi-9", journalEntryId: "je-2" }, L)).toBe("/ar/purchasing/invoices/pi-9");
  });

  it("13) a reversal row (carries the original's source) links to the original document; the JE href points at the reversal entry", () => {
    const reversalRow = { sourceType: "RECEIPT_VOUCHER", sourceId: "rv-1", journalEntryId: "je-reversal", isReversal: true, reversalOfId: "je-orig" };
    // RECEIPT_VOUCHER has no dedicated page → falls back to the (reversal) journal entry, never broken
    expect(sourceDocumentHref(reversalRow, L)).toBe("/ar/accounting/journal/je-reversal");
    // and a SALES_INVOICE reversal drills into the original invoice
    const siReversal = { sourceType: "SALES_INVOICE", sourceId: "si-5", journalEntryId: "je-rev", isReversal: true };
    expect(sourceDocumentHref(siReversal, L)).toBe("/ar/sales/invoices/si-5");
    expect(journalEntryHref("je-rev", L)).toBe("/ar/accounting/journal/je-rev");
  });

  it("14) an unsupported source type falls back to the journal-entry detail", () => {
    expect(sourceDocumentHref({ sourceType: "EXPENSE", sourceId: "e-1", journalEntryId: "je-7" }, L)).toBe("/ar/accounting/journal/je-7");
    expect(sourceDocumentHref({ sourceType: "MANUAL", sourceId: null, journalEntryId: "je-8" }, L)).toBe("/ar/accounting/journal/je-8");
    expect(hasSourceDocument({ sourceType: "EXPENSE", sourceId: "e-1" })).toBe(false);
  });

  it("15) a row with no source and no journal entry yields no link (plain text)", () => {
    expect(sourceDocumentHref({ sourceType: null, sourceId: null, journalEntryId: null }, L)).toBeNull();
    expect(sourceDocumentHref({}, L)).toBeNull();
  });

  it("exposes Arabic source labels", () => {
    expect(sourceLabel("SALES_INVOICE")).toBe("فاتورة مبيعات");
    expect(sourceLabel("RECEIPT_VOUCHER")).toBe("سند قبض");
    expect(sourceLabel("SALES_RETURN")).toBe("مردود فاتورة مبيعات");
    expect(sourceLabel("PURCHASE_RETURN")).toBe("مردود فاتورة مشتريات");
    expect(sourceLabel(null)).toBeNull();
    expect(sourceLabel("WHATEVER")).toBeNull();
  });

  it("respects the locale segment", () => {
    expect(sourceDocumentHref({ sourceType: "SALES_INVOICE", sourceId: "si-1" }, "en")).toBe("/en/sales/invoices/si-1");
  });

  it("a SALES_RETURN row links to the sales-return document (its own sourceId), not the invoice", () => {
    const row = { sourceType: "SALES_RETURN", sourceId: "sr-2", journalEntryId: "je-9" };
    expect(sourceDocumentHref(row, "ar")).toBe("/ar/sales/returns/sr-2");
    expect(sourceDocumentHref(row, "en")).toBe("/en/sales/returns/sr-2");
    expect(hasSourceDocument(row)).toBe(true);
  });

  it("a PURCHASE_RETURN row links to the purchase-return document", () => {
    expect(sourceDocumentHref({ sourceType: "PURCHASE_RETURN", sourceId: "pr-3", journalEntryId: "je-x" }, "ar"))
      .toBe("/ar/purchasing/returns/pr-3");
  });

  it("a SALES_RETURN row missing its sourceId falls back to the journal entry (no broken link)", () => {
    expect(sourceDocumentHref({ sourceType: "SALES_RETURN", sourceId: null, journalEntryId: "je-9" }, "ar"))
      .toBe("/ar/accounting/journal/je-9");
  });
});
