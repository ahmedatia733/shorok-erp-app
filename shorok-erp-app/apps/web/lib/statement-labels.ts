/**
 * Presentation-only, locale-aware label for a GL statement row, derived from
 * sourceType (never from mutating the stored journal description). Returns get an
 * EXPLICIT document label with the real return number/code — e.g. a sales-return
 * row shows «مردود فاتورة مبيعات رقم 2», not the raw AR line note «رصيد دائن
 * للعميل». Reversals (which carry the original document's sourceType) are
 * prefixed. MANUAL/unknown fall back to the free-text description. Drilldown
 * still keys off sourceType + sourceId (see source-document.ts).
 *
 * `locale` defaults to "ar" so existing (Arabic-only) callers are unchanged.
 */
export interface StatementRowLike {
  sourceType?: string | null;
  reference?: string | null;
  description?: string | null;
  isReversal?: boolean | null;
}

type Locale = "ar" | "en";

// Documents shown as "{label} — {reference}".
const DOC_LABELS: Record<string, { ar: string; en: string }> = {
  SALES_INVOICE: { ar: "فاتورة مبيعات", en: "Sales Invoice" },
  PURCHASE_INVOICE: { ar: "فاتورة مشتريات", en: "Purchase Invoice" },
  RECEIPT_VOUCHER: { ar: "سند قبض", en: "Receipt Voucher" },
  PAYMENT_VOUCHER: { ar: "سند صرف", en: "Payment Voucher" },
  PAYMENT: { ar: "سند صرف", en: "Payment Voucher" },
  EXPENSE: { ar: "مصروف", en: "Expense" },
  TREASURY_TRANSFER: { ar: "تحويل خزينة", en: "Treasury Transfer" },
  TREASURY_OPENING: { ar: "رصيد افتتاحي للخزينة", en: "Treasury Opening" },
  OPENING: { ar: "رصيد افتتاحي", en: "Opening Balance" },
};

// Returns shown as "{label} رقم {number}" / "{label} No. {number}", where the
// number is the return's OWN reference (SR-2 / PR-3), never the journal number.
const RETURN_LABELS: Record<string, { ar: string; en: string; prefix: RegExp }> = {
  SALES_RETURN: { ar: "مردود فاتورة مبيعات", en: "Sales Invoice Return", prefix: /^SR-/i },
  PURCHASE_RETURN: { ar: "مردود فاتورة مشتريات", en: "Purchase Invoice Return", prefix: /^PR-/i },
};

/** The document number from a return reference: "SR-2" → "2", else the raw ref. */
function returnNumber(reference: string | null | undefined, prefix: RegExp): string | null {
  if (!reference) return null;
  const stripped = reference.replace(prefix, "").trim();
  const m = stripped.match(/^\d+/); // leading digits, ignoring any suffix (e.g. "-COGS")
  return m ? m[0] : stripped || null;
}

export function statementRowLabel(row: StatementRowLike, locale: Locale = "ar"): string {
  const en = locale === "en";
  const revPrefix = row.isReversal ? (en ? "Reversal " : "عكس ") : "";

  // Explicit return document with its real number/code.
  const ret = row.sourceType ? RETURN_LABELS[row.sourceType] : undefined;
  if (ret) {
    const base = en ? ret.en : ret.ar;
    const num = returnNumber(row.reference, ret.prefix);
    const numbered = num ? (en ? `${base} No. ${num}` : `${base} رقم ${num}`) : base;
    return `${revPrefix}${numbered}`;
  }

  // Other documents: "{label} — {reference}".
  const doc = row.sourceType ? DOC_LABELS[row.sourceType] : undefined;
  if (doc) {
    const label = en ? doc.en : doc.ar;
    const ref = row.reference ? ` — ${row.reference}` : "";
    return `${revPrefix}${label}${ref}`;
  }

  // MANUAL / JOURNAL / unknown → keep the free-text description.
  const base = row.description?.trim() || (en ? "Journal entry" : "قيد يومية");
  return row.isReversal ? (en ? `Reversal — ${base}` : `عكس — ${base}`) : base;
}
