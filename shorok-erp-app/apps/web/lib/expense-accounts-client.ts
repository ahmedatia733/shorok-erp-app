"use client";

import type {
  ExpenseAccountDetail,
  ExpenseDashboard,
  ExpenseItem,
  ExpenseItemStatus,
  ExpenseItemsResponse,
  ExpenseMovement,
  ExpenseMovementsResponse,
} from "@shorok/shared";
import { apiCall, apiDownload } from "./api-client";
import type { AppLocale } from "../i18n";

export type {
  ExpenseAccountDetail,
  ExpenseDashboard,
  ExpenseItem,
  ExpenseItemStatus,
  ExpenseItemsResponse,
  ExpenseMovement,
  ExpenseMovementsResponse,
};

/**
 * إدارة المصروفات — the client for the expenses area.
 *
 * Every filter the screen holds is passed to the server, and the same query
 * string is what the PDF endpoints receive. That is deliberate: the export is
 * built from the server's answer to the user's filters rather than from the rows
 * the browser happens to be holding, so "حفظ PDF" cannot quietly print one page
 * of a longer report.
 */

export interface ExpenseItemsFilters {
  from?: string;
  to?: string;
  search?: string;
  status?: ExpenseItemStatus;
}

export interface ExpenseMovementsFilters {
  from?: string;
  to?: string;
  accountId?: string;
  search?: string;
  minAmount?: string;
  maxAmount?: string;
  limit?: number;
  offset?: number;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "" || v === null) continue;
    search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
};

export const itemsQuery = (f: ExpenseItemsFilters): string =>
  qs({ from: f.from, to: f.to, search: f.search?.trim() || undefined, status: f.status });

export const movementsQuery = (f: ExpenseMovementsFilters): string =>
  qs({
    from: f.from,
    to: f.to,
    accountId: f.accountId,
    search: f.search?.trim() || undefined,
    minAmount: f.minAmount?.trim() || undefined,
    maxAmount: f.maxAmount?.trim() || undefined,
    limit: f.limit,
    offset: f.offset,
  });

export const listExpenseItems = (f: ExpenseItemsFilters) =>
  apiCall<ExpenseItemsResponse>(`/expense-accounts${itemsQuery(f)}`);

export const getExpenseDashboard = (from?: string, to?: string) =>
  apiCall<ExpenseDashboard>(`/expense-accounts/dashboard${qs({ from, to })}`);

export const listExpenseMovements = (f: ExpenseMovementsFilters) =>
  apiCall<ExpenseMovementsResponse>(`/expense-accounts/movements${movementsQuery(f)}`);

export const getExpenseAccount = (id: string, from?: string, to?: string) =>
  apiCall<ExpenseAccountDetail>(`/expense-accounts/${id}${qs({ from, to })}`);

export const createExpenseAccount = (body: { nameAr: string; nameEn?: string; code: string }) =>
  apiCall<{ id: string; code: string; nameAr: string }>("/expense-accounts", {
    method: "POST",
    body,
  });

export const updateExpenseAccount = (
  id: string,
  body: { nameAr?: string; nameEn?: string; active?: boolean },
) => apiCall<{ id: string; active: boolean }>(`/expense-accounts/${id}`, { method: "PATCH", body });

// ── PDF ────────────────────────────────────────────────────────────────────

/** Saves a blob under the filename the server chose. */
async function download(path: string, fallback: string, locale: AppLocale): Promise<void> {
  const { blob, filename } = await apiDownload(path, { locale });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename ?? fallback;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoked on the next tick so the download has a chance to start.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}

const today = () => new Date().toISOString().slice(0, 10);

export const downloadDashboardPdf = (from: string | undefined, to: string | undefined, locale: AppLocale) =>
  download(`/expense-accounts/pdf/dashboard${qs({ from, to })}`, `expenses-dashboard-${today()}.pdf`, locale);

export const downloadItemsPdf = (f: ExpenseItemsFilters, locale: AppLocale) =>
  download(`/expense-accounts/pdf/items${itemsQuery(f)}`, `expenses-items-${today()}.pdf`, locale);

export const downloadMovementsPdf = (f: ExpenseMovementsFilters, locale: AppLocale) =>
  // Paging belongs to the screen, not to the export: the server returns every
  // matching row for the PDF regardless of which page is on display.
  download(
    `/expense-accounts/pdf/movements${movementsQuery({ ...f, limit: undefined, offset: undefined })}`,
    `expenses-movements-${today()}.pdf`,
    locale,
  );

export const downloadExpenseDetailPdf = (
  id: string,
  code: string,
  from: string | undefined,
  to: string | undefined,
  locale: AppLocale,
) =>
  download(
    `/expense-accounts/pdf/${id}${qs({ from, to })}`,
    `expense-${code.replace(/[^A-Za-z0-9._-]/g, "_")}-${today()}.pdf`,
    locale,
  );
