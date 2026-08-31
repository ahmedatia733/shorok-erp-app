/**
 * What document produced an inventory movement, and where it lives.
 *
 * Every movement stores `referenceType` + `referenceId` at the moment the
 * engine wrote it, so the source is knowable structurally. This maps that pair
 * to an Arabic label and, where the document has a page, a link to it.
 *
 * Deliberately keyed on the stored reference type and never on the Arabic note:
 * the note is free text meant for a human, and matching on it would break the
 * moment somebody rewords it — and would confuse «مردود بدون فاتورة» with an
 * invoice-linked «مردود مبيعات», which are different documents on different
 * pages.
 *
 * A reversal keeps its own label so a cancelled document reads as a reversal
 * rather than silently looking like a second original.
 */
export interface MovementDocument {
  labelAr: string;
  /** Route to the source document, or null when it has no page of its own. */
  href: string | null;
  /**
   * A second line under the label, when the label alone would lose something
   * worth keeping — the invoice number, once the customer's name takes the
   * headline.
   */
  subLabel?: string | null;
}

/** What the API resolved about the sale behind a movement, when there is one. */
export interface MovementSalesDocument {
  invoiceNumber: string;
  customerId: string;
  customerCode: string;
  customerName: string;
}

type Entry = { labelAr: string; route?: (id: string, locale: string) => string };

/**
 * The reference types that stand for a sale. Only these ever take a customer
 * name for a headline — a purchase or a transfer keeps its own label whatever
 * else is attached to the row.
 */
const SALES_INVOICE_REFS = new Set([
  "sales_invoice",
  "sales_invoice_cancel",
  "sales_invoice_revision",
  "sales_invoice_revision_reversal",
]);

const DOCUMENTS: Record<string, Entry> = {
  sales_invoice: { labelAr: "فاتورة مبيعات", route: (id, l) => `/${l}/sales/invoices/${id}` },
  sales_invoice_cancel: { labelAr: "إلغاء فاتورة مبيعات", route: (id, l) => `/${l}/sales/invoices/${id}` },
  sales_invoice_revision: { labelAr: "تعديل فاتورة مبيعات", route: (id, l) => `/${l}/sales/invoices/${id}` },
  sales_invoice_revision_reversal: { labelAr: "عكس تعديل فاتورة مبيعات", route: (id, l) => `/${l}/sales/invoices/${id}` },

  purchase_invoice: { labelAr: "فاتورة مشتريات", route: (id, l) => `/${l}/purchasing/invoices/${id}` },
  purchase_invoice_cancel: { labelAr: "إلغاء فاتورة مشتريات", route: (id, l) => `/${l}/purchasing/invoices/${id}` },
  purchase_invoice_revision: { labelAr: "تعديل فاتورة مشتريات", route: (id, l) => `/${l}/purchasing/invoices/${id}` },
  purchase_invoice_revision_reversal: { labelAr: "عكس تعديل فاتورة مشتريات", route: (id, l) => `/${l}/purchasing/invoices/${id}` },

  // An invoice-linked return and a return without an invoice are two different
  // documents with two different pages. Sending one to the other's route is
  // what produced "not found" on the customer statement.
  sales_return: { labelAr: "مردود فاتورة مبيعات", route: (id, l) => `/${l}/sales/returns/${id}` },
  legacy_sales_return: { labelAr: "مردود بدون فاتورة", route: (id, l) => `/${l}/sales/legacy-returns/${id}` },
  legacy_sales_return_cancel: { labelAr: "إلغاء مردود بدون فاتورة", route: (id, l) => `/${l}/sales/legacy-returns/${id}` },
  purchase_return: { labelAr: "مردود مشتريات", route: (id, l) => `/${l}/purchasing/returns/${id}` },

  inventory_transfer: { labelAr: "تحويل مخزون", route: (id, l) => `/${l}/inventory/transfers/${id}` },
  // The opening movements carry a reference, but it is not a document anybody
  // can open — there is no opening-balance page — so they are labelled only.
  BRANCH_OPENING_INVENTORY: { labelAr: "رصيد افتتاحي للمخزن" },
  CUTOVER_OPENING: { labelAr: "رصيد افتتاحي" },
};

/**
 * The document behind a movement, or null when it carries no reference.
 *
 * For a sale the headline is the customer, not the document kind: every sale row
 * said «فاتورة مبيعات», which is true of all of them and therefore tells the
 * reader nothing. The invoice number moves to a second line so the row stays
 * auditable, and the link is untouched — the same href to the same invoice.
 *
 * The customer is only ever the one the API resolved from the invoice itself.
 * When it could not resolve one, the generic label stands rather than a guess.
 */
export function movementDocument(
  row: {
    referenceType?: string | null;
    referenceId?: string | null;
    salesDocument?: MovementSalesDocument | null;
  },
  locale: string,
): MovementDocument | null {
  if (!row.referenceType) return null;
  const entry = DOCUMENTS[row.referenceType];
  // An unmapped type still names itself rather than disappearing — a movement
  // must never look sourceless just because a new document kind was added.
  if (!entry) return { labelAr: row.referenceType, href: null };
  const href = entry.route && row.referenceId ? entry.route(row.referenceId, locale) : null;

  const sale = SALES_INVOICE_REFS.has(row.referenceType) ? row.salesDocument : null;
  if (sale && sale.customerName.trim()) {
    const invoiceWord = locale === "ar" ? "فاتورة" : "Invoice";
    // A cancellation or a revision keeps saying so, otherwise the row would
    // read as an ordinary sale to that customer.
    const qualifier = row.referenceType === "sales_invoice" ? "" : ` — ${entry.labelAr}`;
    return {
      labelAr: sale.customerName,
      href,
      subLabel: `${invoiceWord} ${sale.invoiceNumber}${qualifier}`,
    };
  }

  return { labelAr: entry.labelAr, href };
}
