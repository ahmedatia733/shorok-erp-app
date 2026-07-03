"use client";
import { apiCall } from "./api-client";

export interface PaymentAccount {
  id: string;
  name: string;
  type: "CASH" | "BANK";
  active: boolean;
}

export interface PaymentRow {
  id: string;
  entityType: "SUPPLIER" | "CUSTOMER";
  entityId: string;
  amount: string;
  paymentDate: string;
  referenceNumber: string | null;
  notes: string | null;
  paymentAccountId: string;
  paymentAccountName: string;
  paymentAccountType: "CASH" | "BANK";
  createdByName: string;
  createdAt: string;
}

export interface StatementEntry {
  id?: string;
  date: string;
  type: string;
  reference: string;
  description: string;
  debit: string;
  credit: string;
  balance: string;
  referenceType?: string;
  referenceId?: string;
  journalEntryId?: string;
}

export interface SupplierStatement {
  entity: { id: string; nameAr: string; nameEn: string };
  entries: StatementEntry[];
  totalDebit: string;
  totalCredit: string;
  closingBalance: string;
}

export interface AccountStatement {
  entity: { id: string; name: string; code?: string; type: "CASH" | "BANK" | "gl_account" };
  entries: StatementEntry[];
  totalIn: string;
  totalOut: string;
  closingBalance: string;
}

export interface InventoryItem {
  branchId: string;
  branchNameAr: string;
  branchNameEn: string;
  productVariantId: string;
  skuCode: string;
  skuNameAr: string;
  skuNameEn: string;
  sizeMetersPerBoard: string;
  boardsOnHand: string;
  metersOnHand: string;
}

export const listPaymentAccounts = () =>
  apiCall<PaymentAccount[]>("/payment-accounts");

export const createPayment = (body: {
  entityType: "SUPPLIER" | "CUSTOMER";
  entityId: string;
  paymentAccountId: string;
  amount: string;
  paymentDate: string;
  referenceNumber?: string;
  notes?: string;
}) => apiCall<PaymentRow>("/payments", { method: "POST", body });

export const deletePayment = (id: string) =>
  apiCall<void>(`/payments/${id}`, { method: "DELETE" });

export const getSupplierStatement = (supplierId: string, from?: string, to?: string) => {
  const p = new URLSearchParams();
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  return apiCall<SupplierStatement>(`/statements/supplier/${supplierId}?${p}`);
};

export const getAccountStatement = (accountId: string, from?: string, to?: string) => {
  const p = new URLSearchParams();
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  return apiCall<AccountStatement>(`/statements/account/${accountId}?${p}`);
};

export const getInventoryBalance = (branchId?: string) => {
  const p = new URLSearchParams();
  if (branchId) p.set("branchId", branchId);
  return apiCall<InventoryItem[]>(`/inventory/balance?${p}`);
};
