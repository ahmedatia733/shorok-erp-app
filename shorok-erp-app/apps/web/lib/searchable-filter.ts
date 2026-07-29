export interface SearchableOption {
  value: string;
  label: string;
  /** Extra text matched while searching (code, English name, phone, …). */
  keywords?: string;
  /** Renders as a pinned, visually distinct entry (used for the "الكل" option). */
  pinned?: boolean;
}

/**
 * Pure option filter for the searchable combobox: matches the query
 * (case-insensitive, trimmed) against each option's `label` + `keywords`, so an
 * option is findable by its visible label, code, English name or phone. An empty
 * query returns ALL options (so the list shows immediately on open).
 */
export function filterOptions(options: SearchableOption[], query: string): SearchableOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => `${o.label} ${o.keywords ?? ""}`.toLowerCase().includes(q));
}
