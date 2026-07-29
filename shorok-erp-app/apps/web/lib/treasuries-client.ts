"use client";
import { apiCall } from "./api-client";

export interface TreasuryRow {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  branchId: string;
  branchNameAr: string;
  branchNameEn: string | null;
  glAccountId: string;
  glAccountCode: string;
  glAccountNameAr: string;
  glAccountNameEn: string | null;
  currencyCode: string;
  allowNegativeBalance: boolean;
  isDefault: boolean;
  active: boolean;
  notes: string | null;
  balance: string;
  createdAt: string;
}

export interface TreasuryStatementRow {
  journalLineId: string;
  entryDate: string;
  entryNumber: string;
  documentType: string;
  reference: string | null;
  description: string;
  debit: string;
  credit: string;
  runningBalance: string;
  branchId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  userName: string;
}

export interface TreasuryStatement {
  treasury: TreasuryRow;
  openingBalance: string;
  closingBalance: string;
  currentBalance: string;
  limit: number;
  nextCursor: string | null;
  items: TreasuryStatementRow[];
}

export interface TransferRow {
  id: string;
  transferNumber: string;
  transferDate: string;
  sourceTreasuryId: string;
  sourceTreasuryCode: string;
  sourceTreasuryNameAr: string;
  destinationTreasuryId: string;
  destinationTreasuryCode: string;
  destinationTreasuryNameAr: string;
  amount: string;
  reference: string | null;
  notes: string | null;
  status: "DRAFT" | "CONFIRMED" | "CANCELLED";
  journalEntryId: string | null;
  reversalJournalEntryId: string | null;
  createdAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
}

export const listTreasuries = (includeInactive = false) =>
  apiCall<{ items: TreasuryRow[] }>(`/treasuries?includeInactive=${includeInactive ? "true" : "false"}`);
export const treasurySelector = (branchId?: string) =>
  apiCall<{ items: TreasuryRow[] }>(`/treasuries/selector${branchId ? `?branchId=${branchId}` : ""}`);
export const getTreasury = (id: string) => apiCall<TreasuryRow>(`/treasuries/${id}`);
export const createTreasury = (body: {
  nameAr: string; nameEn?: string; code?: string; branchId: string;
  currencyCode?: string; allowNegativeBalance?: boolean; isDefault?: boolean; notes?: string;
  glAccountId?: string; treasuryType?: "CASH" | "BANK";
}) => apiCall<TreasuryRow>("/treasuries", { method: "POST", body });
export const updateTreasury = (id: string, body: Record<string, unknown>) =>
  apiCall<TreasuryRow>(`/treasuries/${id}`, { method: "PATCH", body });
export const activateTreasury = (id: string) => apiCall<TreasuryRow>(`/treasuries/${id}/activate`, { method: "POST", body: {} });
export const deactivateTreasury = (id: string) => apiCall<TreasuryRow>(`/treasuries/${id}/deactivate`, { method: "POST", body: {} });
export const postOpeningBalance = (id: string, body: { entryDate: string; amount: string; counterpartAccountId?: string; branchId?: string; reference?: string; notes?: string }) =>
  apiCall<{ treasuryId: string; journalEntryId: string; balance: string; idempotent: boolean }>(`/treasuries/${id}/opening-balance`, { method: "POST", body });
export const getTreasuryStatement = (id: string, params: { from?: string; to?: string; cursor?: string; limit?: number } = {}) => {
  const p = new URLSearchParams();
  if (params.from) p.set("from", params.from);
  if (params.to) p.set("to", params.to);
  if (params.cursor) p.set("cursor", params.cursor);
  if (params.limit) p.set("limit", String(params.limit));
  return apiCall<TreasuryStatement>(`/treasuries/${id}/statement?${p.toString()}`);
};

export interface OpeningBalanceRow {
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  amount: string;
  counterpartAccountId: string | null;
  counterpartAccountCode: string | null;
  counterpartAccountNameAr: string | null;
  counterpartAccountNameEn: string | null;
  status: "POSTED" | "REVERSED";
  reversalJournalEntryId: string | null;
  reversalEntryNumber: string | null;
  reversedAt: string | null;
}
export const listOpeningBalances = (id: string) => apiCall<{ treasuryId: string; items: OpeningBalanceRow[] }>(`/treasuries/${id}/opening-balances`);
export const reverseOpeningBalance = (id: string, entryId: string, reason: string) =>
  apiCall<{ balance: string; idempotent: boolean }>(`/treasuries/${id}/opening-balances/${entryId}/reverse`, { method: "POST", body: { reason } });

export const listTransfers = () => apiCall<{ items: TransferRow[] }>("/treasuries/transfers");
export const createTransfer = (body: { transferDate: string; sourceTreasuryId: string; destinationTreasuryId: string; amount: string; reference?: string; notes?: string }) =>
  apiCall<TransferRow>("/treasuries/transfers", { method: "POST", body });
export const confirmTransfer = (id: string) => apiCall<TransferRow>(`/treasuries/transfers/${id}/confirm`, { method: "POST", body: {} });
export const cancelTransfer = (id: string, reason: string) => apiCall<TransferRow>(`/treasuries/transfers/${id}/cancel`, { method: "POST", body: { reason } });
