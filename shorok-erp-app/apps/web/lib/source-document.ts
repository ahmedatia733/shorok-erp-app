/**
 * Central resolver: maps a GL statement/journal row to the web route of its
 * source document, using sourceType + sourceId (never by parsing Arabic text).
 *
 * A reversal row carries the ORIGINAL document's sourceType/sourceId (the
 * PostingEngine copies them onto the mirror entry), so it links to the original
 * document; its journalEntryId points at the reversal entry itself.
 *
 * Fallback order guarantees a link is never broken:
 *   1. a supported source-document detail route (sourceType + sourceId)
 *   2. the journal-entry detail page (journalEntryId)
 *   3. null → the caller renders plain text (no link)
 */
export interface SourceRef {
  sourceType?: string | null;
  sourceId?: string | null;
  journalEntryId?: string | null;
  isReversal?: boolean | null;
  reversalOfId?: string | null;
}

/** sourceType (JournalSourceType) → detail route builder. Types without a
 *  dedicated page fall through to the journal-entry detail. */
const SOURCE_ROUTES: Record<string, (id: string, locale: string) => string> = {
  SALES_INVOICE: (id, l) => `/${l}/sales/invoices/${id}`,
  PURCHASE_INVOICE: (id, l) => `/${l}/purchasing/invoices/${id}`,
};

export const SOURCE_LABELS: Record<string, string> = {
  SALES_INVOICE: "فاتورة مبيعات",
  PURCHASE_INVOICE: "فاتورة مشتريات",
  RECEIPT_VOUCHER: "سند قبض",
  PAYMENT_VOUCHER: "سند صرف",
  EXPENSE: "مصروف",
  MANUAL: "قيد يدوي",
  JOURNAL: "قيد يومية",
};

export function journalEntryHref(journalEntryId: string, locale: string): string {
  return `/${locale}/accounting/journal/${journalEntryId}`;
}

/** Best drilldown href for a row, or null when it has no source and no entry. */
export function sourceDocumentHref(row: SourceRef, locale: string): string | null {
  if (row.sourceType && row.sourceId) {
    const build = SOURCE_ROUTES[row.sourceType];
    if (build) return build(row.sourceId, locale);
  }
  if (row.journalEntryId) return journalEntryHref(row.journalEntryId, locale);
  return null;
}

/** True when the row resolves to a real source-document page (not the journal fallback). */
export function hasSourceDocument(row: SourceRef): boolean {
  return Boolean(row.sourceType && row.sourceId && SOURCE_ROUTES[row.sourceType]);
}

export function sourceLabel(sourceType?: string | null): string | null {
  if (!sourceType) return null;
  return SOURCE_LABELS[sourceType] ?? null;
}
