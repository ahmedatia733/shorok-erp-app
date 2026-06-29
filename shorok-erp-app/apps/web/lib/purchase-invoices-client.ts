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
  lengthM: string | null;
  widthM: string | null;
  metersQuantity: string;
  unitLabel: string | null;
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
  dueDate: string | null;
  supplierId: string;
  supplierNameAr: string;
  supplierNameEn: string;
  branchId: string;
  branchNameAr: string;
  branchNameEn: string;
  basedOn: string | null;
  docDirection: string | null;
  customsNumber: string | null;
  notes: string | null;
  status: "DRAFT" | "CONFIRMED" | "CANCELLED";
  subtotal: string;
  taxAmount: string;
  grandTotal: string;
  createdAt: string;
  createdByName: string;
  lines: PurchaseInvoiceLineRow[];
}

export interface PurchaseInvoicePage {
  data: PurchaseInvoiceRow[];
  nextCursor: string | null;
}

export interface VariantOption {
  id: string;
  skuCode: string;
  skuNameAr: string;
  skuNameEn: string;
  sizeMetersPerBoard: string;
  defaultPurchasePricePerMeter: string;
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
  dueDate?: string;
  supplierId: string;
  branchId: string;
  basedOn?: string;
  docDirection?: string;
  customsNumber?: string;
  notes?: string;
  lines: Array<{
    productVariantId: string;
    boardsQuantity: string;
    lengthM?: string;
    widthM?: string;
    unitLabel?: string;
    unitPrice: string;
    taxRate: string;
    isFree: boolean;
  }>;
}) => apiCall<PurchaseInvoiceRow>("/purchase-invoices", { method: "POST", body });

export const confirmPurchaseInvoice = (id: string) =>
  apiCall<PurchaseInvoiceRow>(`/purchase-invoices/${id}/confirm`, { method: "PATCH" });

export const deletePurchaseInvoice = (id: string) =>
  apiCall<void>(`/purchase-invoices/${id}`, { method: "DELETE" });

export const listVariantsForInvoice = async (): Promise<VariantOption[]> => {
  const rows = await apiCall<
    Array<{
      id: string;
      sizeMetersPerBoard: string;
      defaultPurchasePricePerMeter: string;
      sku: { code: string; colorNameAr: string; colorNameEn: string };
    }>
  >("/products/variants");
  return rows.map((v) => ({
    id: v.id,
    skuCode: v.sku.code,
    skuNameAr: v.sku.colorNameAr,
    skuNameEn: v.sku.colorNameEn,
    sizeMetersPerBoard: v.sizeMetersPerBoard,
    defaultPurchasePricePerMeter: v.defaultPurchasePricePerMeter,
  }));
};
