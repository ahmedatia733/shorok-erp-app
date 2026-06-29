"use client";
import { apiCall } from "./api-client";

export interface PurchaseInvoiceLineRow {
  id: string;
  productVariantId: string;
  skuCode: string;
  skuNameAr: string;
  skuNameEn: string;
  sizeMetersPerBoard: string;
  boardsQuantity: string;
  metersQuantity: string;
  unitPrice: string;
  lineTotal: string;
  taxRate: string;
  taxAmount: string;
  isFree: boolean;
}

export interface PurchaseInvoiceRow {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  supplierId: string;
  supplierNameAr: string;
  supplierNameEn: string;
  branchId: string;
  branchNameAr: string;
  branchNameEn: string;
  notes: string | null;
  status: "DRAFT" | "CONFIRMED" | "CANCELLED";
  subtotal: string;
  taxAmount: string;
  grandTotal: string;
  createdAt: string;
  lines: PurchaseInvoiceLineRow[];
}

export interface PurchaseInvoicePage {
  data: PurchaseInvoiceRow[];
  nextCursor: string | null;
}

export const listPurchaseInvoices = (params: {
  supplierId?: string;
  branchId?: string;
  status?: string;
  from?: string;
  to?: string;
  cursor?: string | null;
  limit?: number;
}) => {
  const p = new URLSearchParams();
  if (params.limit) p.set("limit", String(params.limit));
  if (params.supplierId) p.set("supplierId", params.supplierId);
  if (params.branchId) p.set("branchId", params.branchId);
  if (params.status) p.set("status", params.status);
  if (params.from) p.set("from", params.from);
  if (params.to) p.set("to", params.to);
  if (params.cursor) p.set("cursor", params.cursor);
  return apiCall<PurchaseInvoicePage>(`/purchase-invoices?${p.toString()}`);
};

export const getPurchaseInvoice = (id: string) =>
  apiCall<PurchaseInvoiceRow>(`/purchase-invoices/${id}`);

export const createPurchaseInvoice = (body: {
  invoiceDate: string;
  supplierId: string;
  branchId: string;
  notes?: string;
  lines: Array<{
    productVariantId: string;
    boardsQuantity: string;
    unitPrice: string;
    taxRate: string;
    isFree: boolean;
  }>;
}) => apiCall<PurchaseInvoiceRow>("/purchase-invoices", { method: "POST", body });

export const confirmPurchaseInvoice = (id: string) =>
  apiCall<PurchaseInvoiceRow>(`/purchase-invoices/${id}/confirm`, { method: "PATCH" });

export const deletePurchaseInvoice = (id: string) =>
  apiCall<void>(`/purchase-invoices/${id}`, { method: "DELETE" });
