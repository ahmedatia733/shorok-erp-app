/**
 * Free-text search over the accounts listed in a consolidated account
 * statement.
 *
 * Display only. It decides which rows are drawn and never what they contain:
 * the opening balance, debit, credit and closing totals under the table are the
 * API's authoritative category totals, and filtering must not appear to change
 * them. Keeping the filter as a pure function is what makes that testable.
 *
 * Matching mirrors the searchable combobox — a case-insensitive substring of
 * "code + name" — so typing «احمد» or «C-0014» narrows the same way in both
 * controls.
 */
export interface StatementAccountRow {
  code?: string | null;
  name?: string | null;
}

export function filterStatementAccounts<T extends StatementAccountRow>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => `${r.code ?? ""} ${r.name ?? ""}`.toLowerCase().includes(q));
}
