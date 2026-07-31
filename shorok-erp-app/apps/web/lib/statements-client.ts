"use client";

import { apiCall } from "./api-client";
import type { AccountRow } from "./accounts-client";

export interface StatementCategory {
  id: string;
  label: string;
  allLabel: string;
  kind: "ACCOUNTS" | "CUSTOMERS" | "SUPPLIERS";
}

export interface StatementCustomer {
  id: string;
  code: string;
  nameAr: string;
}
export interface StatementSupplier {
  id: string;
  nameAr: string;
  nameEn: string | null;
}

export interface StatementOptions {
  categories: StatementCategory[];
  /** Active leaf accounts only — already filtered server-side. */
  accounts: AccountRow[];
  customers: StatementCustomer[];
  suppliers: StatementSupplier[];
}

export interface StatementBreakdownRow {
  entityId: string;
  code: string;
  name: string;
  openingBalance: string;
  debit: string;
  credit: string;
  endingBalance: string;
}

export interface ConsolidatedStatementRow {
  journalEntryId: string;
  journalLineId: string;
  entryNumber: string;
  entryDate: string;
  reference: string | null;
  description: string | null;
  debit: string;
  credit: string;
  runningBalance: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  sourceType: string | null;
  sourceId: string | null;
  partyType: string | null;
  partyId: string | null;
  branchId: string | null;
  isReversal: boolean;
  reversalOfId: string | null;
}

export interface ConsolidatedStatement {
  selectionType: "consolidated" | "specific";
  category: string;
  entityId: string | null;
  entityLabel: string;
  openingBalance: string;
  periodDebit: string;
  periodCredit: string;
  endingBalance: string;
  breakdown: StatementBreakdownRow[];
  rows: ConsolidatedStatementRow[];
}

export const getStatementOptions = () => apiCall<StatementOptions>("/statements/options");

export type BalanceSide = "ALL" | "DEBIT" | "CREDIT";

/** `entityId` omitted or "all" → consolidated statement for the whole category. */
export function getConsolidatedStatement(params: {
  category: string;
  entityId?: string;
  from?: string;
  to?: string;
  includeZero?: boolean;
  balanceSide?: BalanceSide;
}): Promise<ConsolidatedStatement> {
  const q = new URLSearchParams({ category: params.category });
  if (params.entityId && params.entityId !== "all") q.set("entityId", params.entityId);
  if (params.from) q.set("from", params.from);
  if (params.to) q.set("to", params.to);
  if (params.includeZero) q.set("includeZero", "true");
  // Default ALL is left off the query so existing URLs/consumers are unchanged.
  if (params.balanceSide && params.balanceSide !== "ALL") q.set("balanceSide", params.balanceSide);
  return apiCall<ConsolidatedStatement>(`/statements/consolidated?${q.toString()}`);
}
