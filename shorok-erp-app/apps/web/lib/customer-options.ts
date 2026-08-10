/**
 * Builds and filters the searchable customer options used wherever a customer
 * is picked — sales invoices, legacy returns, and the customer account
 * statement. A customer is findable by code, Arabic name, and phone.
 *
 * One mapping, reused, so a customer looks and searches the same everywhere.
 * The filter mirrors SearchableSelect's internal matching (label + keywords,
 * case-insensitive, whitespace-tolerant) so it can be unit-tested directly.
 */
import type { CustomerRow } from "./customers-client";
import type { SearchableOption } from "../components/ui/searchable-select";

export function toCustomerOptions(
  customers: CustomerRow[],
  /**
   * Screens that list every customer — the account statement — mark the
   * inactive ones instead of hiding them, because an inactive customer can
   * still have a history worth reading. Screens that create new documents
   * leave this off.
   */
  opts: { markInactive?: boolean } = {},
): SearchableOption[] {
  return customers.map((c) => {
    const inactive = opts.markInactive && c.active === false ? " (غير نشط)" : "";
    return {
      value: c.id,
      label: `${c.code} — ${c.nameAr}${c.phone ? ` — ${c.phone}` : ""}${inactive}`,
      keywords: `${c.code} ${c.nameAr} ${c.phone ?? ""}`,
    };
  });
}

/** Same matching rule SearchableSelect uses: substring of `label + keywords`,
 *  lower-cased, with the query trimmed. Empty query returns the full list. */
export function filterCustomerOptions(
  options: SearchableOption[],
  query: string,
): SearchableOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => `${o.label} ${o.keywords ?? ""}`.toLowerCase().includes(q));
}
