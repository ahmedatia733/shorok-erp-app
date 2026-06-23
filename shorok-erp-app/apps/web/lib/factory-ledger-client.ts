"use client";

import { apiCall } from "./api-client";

export interface FactoryEntryRow {
  id: string;
  supplierId: string;
  orderDate: string;
  productVariantId: string | null;
  boardsQuantity: string | null;
  metersQuantity: string | null;
  purchasePricePerMeter: string | null;
  totalAmount: string;
  paidAmount: string;
  runningBalance: string;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  productVariant: {
    id: string;
    sizeMetersPerBoard: string;
    sku: { code: string; colorNameAr: string; colorNameEn: string };
  } | null;
  creator: { id: string; name: string };
}

export interface FactoryLedgerPage {
  data: FactoryEntryRow[];
  nextCursor: string | null;
}

export const listFactoryLedger = (filters: {
  supplierId: string;
  cursor?: string | null;
  limit?: number;
}) => {
  const params = new URLSearchParams({
    supplierId: filters.supplierId,
    limit: String(filters.limit ?? 50),
  });
  if (filters.cursor) params.set("cursor", filters.cursor);
  return apiCall<FactoryLedgerPage>(`/factory-ledger?${params.toString()}`);
};

export const createFactoryEntry = (body: {
  supplierId: string;
  orderDate: string;
  productVariantId: string;
  boardsQuantity: string;
  purchasePricePerMeter: string;
  paidAmount: string;
  notes?: string;
}) => apiCall<FactoryEntryRow>("/factory-ledger/entries", { method: "POST", body });

export const createFactoryPayment = (body: {
  supplierId: string;
  orderDate: string;
  paidAmount: string;
  notes?: string;
}) => apiCall<FactoryEntryRow>("/factory-ledger/payments", { method: "POST", body });

export const updateFactoryEntry = (
  id: string,
  body: Partial<{
    orderDate: string;
    productVariantId: string;
    boardsQuantity: string;
    purchasePricePerMeter: string;
    paidAmount: string;
    notes: string | null;
  }>,
) => apiCall<FactoryEntryRow>(`/factory-ledger/entries/${id}`, { method: "PATCH", body });

export const deleteFactoryEntry = (id: string) =>
  apiCall<void>(`/factory-ledger/entries/${id}`, { method: "DELETE" });
