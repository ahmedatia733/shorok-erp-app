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

// ─── Supplier Statement ───────────────────────────────────────────────────────

export interface SupplierStatementRow {
  id: string;
  date: string;
  type: "purchase" | "payment" | "other";
  description: string;
  totalAmount: string;
  paidAmount: string;
  runningBalance: string;
  journalEntryId: string | null;
  notes: string | null;
}

export interface SupplierStatementData {
  supplier: { id: string; nameAr: string; nameEn: string | null };
  totalPurchases: string;
  totalPaid: string;
  closingBalance: string;
  rows: SupplierStatementRow[];
}

export const getSupplierStatement = (supplierId: string, from?: string, to?: string) => {
  const p = new URLSearchParams();
  if (from) p.set("from", from);
  if (to)   p.set("to",   to);
  const qs = p.toString() ? `?${p.toString()}` : "";
  return apiCall<SupplierStatementData>(`/reports/supplier-statement/${supplierId}${qs}`);
};

// ─── Supplier Aging ───────────────────────────────────────────────────────────

export interface SupplierAgingRow {
  supplierId: string;
  nameAr: string;
  nameEn: string | null;
  balance: string;
  oldestDays: number;
  agingBucket: string;
  bucketAmounts: { "0-30": string; "31-60": string; "61-90": string; "90+": string };
}

export interface SupplierAgingData {
  asOf: string;
  grandTotal: string;
  rows: SupplierAgingRow[];
}

export const getSupplierAging = (asOf?: string) => {
  const qs = asOf ? `?asOf=${asOf}` : "";
  return apiCall<SupplierAgingData>(`/reports/supplier-aging${qs}`);
};

// ─── Cash Flow ────────────────────────────────────────────────────────────────

export interface CashFlowLine {
  date: string;
  description: string;
  accountNameAr: string;
  accountCode: string;
  debit: string;
  credit: string;
  net: string;
  category: "operating" | "investing" | "other";
}

export interface CashFlowData {
  from: string;
  to: string;
  cashAccounts: Array<{ id: string; code: string; nameAr: string }>;
  operatingInflow:  string;
  operatingOutflow: string;
  netOperating:     string;
  investingInflow:  string;
  investingOutflow: string;
  netInvesting:     string;
  otherInflow:      string;
  otherOutflow:     string;
  netOther:         string;
  netCashFlow:      string;
  lines: CashFlowLine[];
}

export const getCashFlow = (from: string, to: string) =>
  apiCall<CashFlowData>(`/reports/cash-flow?from=${from}&to=${to}`);
