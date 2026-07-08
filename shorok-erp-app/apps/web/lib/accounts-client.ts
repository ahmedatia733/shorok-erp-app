"use client";
import { apiCall } from "./api-client";

export interface AccountRow {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  category: string;
  accountType: string;
  parentId: string | null;
  isLeaf: boolean;
  active: boolean;
  children?: AccountRow[];
}

export const listAccounts = () => apiCall<AccountRow[]>("/accounts");

/**
 * Flatten the account tree returned by `listAccounts` to its active leaf
 * accounts. `GET /accounts` returns a NESTED tree, so a top-level
 * `.filter(a => a.isLeaf)` misses any leaf nested under a parent (e.g. the
 * VAT account 2300 under 2000) — the Phase 1 purchase-confirm bug. Always
 * flatten through this helper before matching/listing postable accounts.
 */
export function getLeafAccounts(accounts: AccountRow[]): AccountRow[] {
  const out: AccountRow[] = [];
  const walk = (nodes: AccountRow[]) => {
    for (const a of nodes) {
      if (a.isLeaf && a.active) out.push(a);
      if (a.children && a.children.length) walk(a.children);
    }
  };
  walk(accounts);
  return out;
}

export const createAccount = (body: {
  code: string;
  nameAr: string;
  nameEn: string;
  category: string;
  accountType: string;
  parentId?: string;
}) => apiCall<AccountRow>("/accounts", { method: "POST", body });

export const updateAccount = (
  id: string,
  body: { nameAr?: string; nameEn?: string; active?: boolean },
) => apiCall<AccountRow>(`/accounts/${id}`, { method: "PATCH", body });

export const getAccountBalance = (id: string, from?: string, to?: string) => {
  const p = new URLSearchParams();
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  return apiCall<{ accountId: string; debit: string; credit: string; balance: string }>(
    `/accounts/${id}/balance?${p.toString()}`,
  );
};
