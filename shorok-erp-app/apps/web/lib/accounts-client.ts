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
