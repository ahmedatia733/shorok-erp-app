"use client";

import { apiCall } from "./api-client";

export interface CustomerRow {
  id: string;
  code: string;
  nameAr: string;
  phone: string | null;
  active: boolean;
  createdAt: string;
}

export interface CustomerStatementEntry {
  id: string;
  rowNum: number;
  date: string;
  reference: string | null;
  description: string | null;
  type: string;
  direction: "DR" | "CR";
  debit: string;
  credit: string;
  balance: string;
}

export interface CustomerStatement {
  customer: { id: string; code: string; nameAr: string };
  openingBalance: string;
  totalDR: string;
  totalCR: string;
  closingBalance: string;
  entries: CustomerStatementEntry[];
}

export const listCustomers = () => apiCall<CustomerRow[]>("/customers");

export const getCustomer = (id: string) => apiCall<CustomerRow>(`/customers/${id}`);

export const createCustomer = (body: { nameAr: string; phone?: string }) =>
  apiCall<CustomerRow>("/customers", { method: "POST", body });

export const updateCustomer = (id: string, body: { nameAr?: string; phone?: string | null; active?: boolean }) =>
  apiCall<CustomerRow>(`/customers/${id}`, { method: "PATCH", body });

export const getCustomerStatement = (id: string, from?: string, to?: string) => {
  const p = new URLSearchParams();
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  return apiCall<CustomerStatement>(`/customers/statement/${id}?${p}`);
};

export const createCustomerTransaction = (body: {
  customerId: string;
  type: "INVOICE" | "RECEIPT" | "RETURN" | "ADJUSTMENT" | "OPENING";
  direction: "DR" | "CR";
  amount: string;
  date: string;
  reference?: string;
  description?: string;
  paymentAccountId?: string;
}) => apiCall<CustomerStatementEntry>("/customers/transactions", { method: "POST", body });

export const deleteCustomerTransaction = (id: string) =>
  apiCall<void>(`/customers/transactions/${id}`, { method: "DELETE" });
