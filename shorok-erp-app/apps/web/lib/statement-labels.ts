/**
 * Presentation-only label for a GL statement row, derived from sourceType (never
 * from mutating the stored journal description). Reversals (which carry the
 * original document's sourceType) are prefixed with "عكس". MANUAL/unknown fall
 * back to the free-text description. Drilldown still keys off sourceType+sourceId.
 */
export interface StatementRowLike {
  sourceType?: string | null;
  reference?: string | null;
  description?: string | null;
  isReversal?: boolean | null;
}

const DOC_LABELS: Record<string, string> = {
  SALES_INVOICE: "فاتورة مبيعات",
  PURCHASE_INVOICE: "فاتورة مشتريات",
  RECEIPT_VOUCHER: "سند قبض",
  PAYMENT_VOUCHER: "سند صرف",
  PAYMENT: "سند صرف",
  EXPENSE: "مصروف",
};

export function statementRowLabel(row: StatementRowLike): string {
  const doc = row.sourceType ? DOC_LABELS[row.sourceType] : undefined;
  if (doc) {
    const ref = row.reference ? ` — ${row.reference}` : "";
    return `${row.isReversal ? "عكس " : ""}${doc}${ref}`;
  }
  // MANUAL / JOURNAL / unknown → keep the free-text description.
  const base = row.description?.trim() || "قيد يومية";
  return row.isReversal ? `عكس — ${base}` : base;
}
