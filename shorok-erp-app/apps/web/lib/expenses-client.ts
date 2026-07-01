"use client";

import { apiCall } from "./api-client";

export interface ExpenseRow {
  id: string;
  branchId: string;
  expenseDate: string;
  description: string;
  amount: string;
  paidFromAccount: string;
  glAccountId:        string | null;
  paymentGlAccountId: string | null;
  journalEntryId:     string | null;
  createdAt: string;
  creator: { id: string; name: string };
}

export interface ExpensesPage {
  data: ExpenseRow[];
  nextCursor: string | null;
}

export const listExpenses = (filters: {
  branchId: string;
  from?: string;
  to?: string;
  cursor?: string | null;
  limit?: number;
}) => {
  const params = new URLSearchParams({
    branchId: filters.branchId,
    limit: String(filters.limit ?? 50),
  });
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.cursor) params.set("cursor", filters.cursor);
  return apiCall<ExpensesPage>(`/expenses?${params.toString()}`);
};

export const createExpense = (body: {
  branchId: string;
  expenseDate: string;
  description: string;
  amount: string;
  paidFromAccount: string;
  glAccountId?: string;
  paymentGlAccountId?: string;
}) => apiCall<ExpenseRow>("/expenses", { method: "POST", body });

export const updateExpense = (
  id: string,
  body: Partial<{
    expenseDate: string;
    description: string;
    amount: string;
    paidFromAccount: string;
    glAccountId: string | null;
    paymentGlAccountId: string | null;
  }>,
) => apiCall<ExpenseRow>(`/expenses/${id}`, { method: "PATCH", body });

export const deleteExpense = (id: string) =>
  apiCall<void>(`/expenses/${id}`, { method: "DELETE" });
