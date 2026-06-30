"use client";

import { apiCall } from "./api-client";

export interface DashboardData {
  branchId: string | null;
  totalSales: string;
  totalCollected: string;
  totalRemaining: string;
  totalExpenses: string;
  stockSummary: { boardsOnHand: string; metersOnHand: string };
  supplierBalances: Array<{
    supplierId: string;
    nameAr: string;
    nameEn: string;
    balance: string;
  }>;
  lowStock: Array<{
    branchId: string;
    productVariantId: string;
    boardsOnHand: string;
    metersOnHand: string;
    sku: { code: string; colorNameAr: string; colorNameEn: string };
    sizeMetersPerBoard: string;
  }>;
}

export const getDashboard = (branchId: string | null) => {
  const path = branchId ? `/reports/dashboard?branchId=${branchId}` : "/reports/dashboard";
  return apiCall<DashboardData>(path);
};

// ─── Trial Balance ────────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  category: string;
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
}

export interface TrialBalanceTotals {
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
}

export interface TrialBalanceData {
  from: string;
  to: string;
  rows: TrialBalanceRow[];
  totals: TrialBalanceTotals;
}

export const getTrialBalance = (from: string, to: string) =>
  apiCall<TrialBalanceData>(`/reports/trial-balance?from=${from}&to=${to}`);

// ─── Balance Sheet ────────────────────────────────────────────────────────────

export interface BalanceSheetAccountRow {
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  accountType: string;
  balance: string;
}

export interface BalanceSheetData {
  asOf: string;
  assets: BalanceSheetAccountRow[];
  totalAssets: string;
  liabilities: BalanceSheetAccountRow[];
  totalLiabilities: string;
  equity: BalanceSheetAccountRow[];
  totalEquity: string;
  difference: string;
}

export const getBalanceSheet = (asOf?: string) => {
  const path = asOf ? `/reports/balance-sheet?asOf=${asOf}` : "/reports/balance-sheet";
  return apiCall<BalanceSheetData>(path);
};

// ─── Aging ────────────────────────────────────────────────────────────────────

export interface AgingRow {
  entityId: string;
  code: string;
  nameAr: string;
  totalInvoiced: string;
  totalReceived: string;
  outstanding: string;
  current: string;
  days30: string;
  days60: string;
  days90: string;
  days90plus: string;
}

export interface AgingTotals {
  outstanding: string;
  current: string;
  days30: string;
  days60: string;
  days90: string;
  days90plus: string;
}

export interface AgingData {
  asOf: string;
  type: "AR" | "AP";
  rows: AgingRow[];
  totals: AgingTotals;
}

export const getAging = (type: "AR" | "AP", asOf?: string) => {
  const params = new URLSearchParams({ type });
  if (asOf) params.set("asOf", asOf);
  return apiCall<AgingData>(`/reports/aging?${params.toString()}`);
};
