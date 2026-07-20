/**
 * Builds and filters the searchable customer options for the Sales Invoice
 * customer selector. A customer is findable by code, Arabic name, and phone.
 * The filter mirrors SearchableSelect's internal matching (label + keywords,
 * case-insensitive, whitespace-tolerant) so it can be unit-tested directly.
 */
import type { CustomerRow } from "./customers-client";
import type { SearchableOption } from "../components/ui/searchable-select";

export function toCustomerOptions(customers: CustomerRow[]): SearchableOption[] {
  return customers.map((c) => ({
    value: c.id,
    label: `${c.code} — ${c.nameAr}${c.phone ? ` — ${c.phone}` : ""}`,
    keywords: `${c.code} ${c.nameAr} ${c.phone ?? ""}`,
  }));
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
