"use client";
import { apiCall } from "./api-client";

export interface JournalLineRow {
  id: string;
  accountId: string;
  accountCode: string;
  accountNameAr: string;
  accountNameEn: string;
  debit: string;
  credit: string;
  note: string | null;
}

export interface JournalEntryRow {
  id: string;
  entryNumber: number;
  entryType: string;
  reference: string | null;
  entryDate: string;
  description: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
  totalDebit: string;
  lines: JournalLineRow[];
}

export interface JournalPage {
  data: JournalEntryRow[];
  nextCursor: string | null;
}

export const listJournal = (params: {
  from?: string;
  to?: string;
  accountId?: string;
  cursor?: string | null;
  limit?: number;
}) => {
  const p = new URLSearchParams();
  if (params.limit) p.set("limit", String(params.limit));
  if (params.from) p.set("from", params.from);
  if (params.to) p.set("to", params.to);
  if (params.accountId) p.set("accountId", params.accountId);
  if (params.cursor) p.set("cursor", params.cursor);
  return apiCall<JournalPage>(`/journal?${p.toString()}`);
};

export const createJournalEntry = (body: {
  entryType?: string;
  reference?: string;
  entryDate: string;
  description: string;
  referenceType?: string;
  lines: Array<{ accountId: string; debit: string; credit: string; note?: string; partyType?: "CUSTOMER" | "SUPPLIER"; partyId?: string; branchId?: string | null; salesRepresentativeId?: string | null }>;
  acknowledgeNegativeBalance?: boolean;
  negativeBalanceReason?: string;
  idempotencyKey?: string;
}) => apiCall<JournalEntryRow>("/journal", { method: "POST", body });

export const deleteJournalEntry = (id: string) =>
  apiCall<void>(`/journal/${id}`, { method: "DELETE" });

export const getJournalEntry = (id: string) =>
  apiCall<JournalEntryRow>(`/journal/${id}`);

export interface ISAccountLine {
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  amount: string;
}

export interface IncomeStatementData {
  revenue: string;
  revenueLines: ISAccountLine[];
  costOfSales: string;
  cogsLines: ISAccountLine[];
  grossProfit: string;
  grossMarginPct: string;
  expenses: ISAccountLine[];
  totalExpenses: string;
  netProfit: string;
  from: string;
  to: string;
}

export const getIncomeStatement = (from: string, to: string) =>
  apiCall<IncomeStatementData>(`/reports/income-statement?from=${from}&to=${to}`);
