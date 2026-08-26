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

/**
 * «مردود بدون فاتورة» has its own document and its own page, but its journal is
 * posted with sourceType SALES_RETURN because JournalSourceType has no value of
 * its own for it. The statement API re-labels such a row from the persisted id;
 * these tests pin what the link layer must then do with it.
 */
describe("legacy sales return links", () => {
  const L = "ar";

  it("opens the legacy-return page, not the ordinary sales-return page", () => {
    const href = sourceDocumentHref({ sourceType: "LEGACY_SALES_RETURN", sourceId: "abc-123" }, L);
    expect(href).toBe("/ar/sales/legacy-returns/abc-123");
    expect(href).not.toContain("/sales/returns/");
  });

  it("counts as a real source document, so the row links to the document not the journal", () => {
    expect(hasSourceDocument({ sourceType: "LEGACY_SALES_RETURN", sourceId: "abc-123", journalEntryId: "je-1" })).toBe(true);
    expect(sourceDocumentHref({ sourceType: "LEGACY_SALES_RETURN", sourceId: "abc-123", journalEntryId: "je-1" }, L))
      .toBe("/ar/sales/legacy-returns/abc-123");
  });

  it("is labelled distinctly from an invoice-linked return", () => {
    expect(sourceLabel("LEGACY_SALES_RETURN")).toBe("مردود بدون فاتورة");
    expect(sourceLabel("SALES_RETURN")).toBe("مردود فاتورة مبيعات");
  });

  it("leaves every other document type exactly where it was", () => {
    expect(sourceDocumentHref({ sourceType: "SALES_INVOICE", sourceId: "i1" }, L)).toBe("/ar/sales/invoices/i1");
    expect(sourceDocumentHref({ sourceType: "PURCHASE_INVOICE", sourceId: "p1" }, L)).toBe("/ar/purchasing/invoices/p1");
    expect(sourceDocumentHref({ sourceType: "SALES_RETURN", sourceId: "r1" }, L)).toBe("/ar/sales/returns/r1");
    expect(sourceDocumentHref({ sourceType: "PURCHASE_RETURN", sourceId: "pr1" }, L)).toBe("/ar/purchasing/returns/pr1");
  });

  it("an unknown source falls back to the journal entry rather than a broken link", () => {
    expect(sourceDocumentHref({ sourceType: "RECEIPT_VOUCHER", sourceId: "v1", journalEntryId: "je-9" }, L))
      .toBe("/ar/accounting/journal/je-9");
    expect(sourceDocumentHref({ sourceType: "WHAT_IS_THIS", sourceId: "x" }, L)).toBeNull();
  });
});
