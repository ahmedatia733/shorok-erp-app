"use client";

import { apiCall } from "./api-client";

// ── shared shapes ────────────────────────────────────────────────────────────
export type ReturnStatus = "DRAFT" | "CONFIRMED" | "CANCELLED";

export interface ReturnableLine {
  originalLineId: string;
  productVariantId: string;
  productCode: string | null;
  colorName: string | null;            // color, not a product name
  currentVariantSize: string | null;   // CURRENT master data (hint only)
  historicalBoardSize: string | null;  // HISTORICAL effective board area
  unitLabel: string;
  lengthM: string | null;              // HISTORICAL original dimensions
  widthM: string | null;
  originalMeters: string;
  originalBoards: string;
  returnedMeters: string;
  returnedBoards: string;
  remainingMeters: string;
  remainingBoards: string;
  originalNetExTax: string;
  originalUnitPrice: string;
  originalTaxRate: string;
  originalLineCogs: string;
  originalCostPerMeter: string | null;
  legacyAmbiguous: boolean;
}

export interface SalesReturnable {
  invoice: { id: string; status: string; branchId: string; customerId: string; salesRepresentativeId: string | null; taxRate: string; returnStatus: "NONE" | "PARTIAL" | "FULL" };
  lines: ReturnableLine[];
}
export interface PurchaseReturnableLine {
  originalLineId: string; productVariantId: string;
  productCode: string | null; colorName: string | null;
  currentVariantSize: string | null; historicalBoardSize: string | null; unitLabel: string;
  lengthM: string | null; widthM: string | null;
  originalMeters: string; originalBoards: string; returnedMeters: string; returnedBoards: string;
  remainingMeters: string; remainingBoards: string;
  originalUnitPrice: string; originalTaxRate: string; originalNetExTax: string;
}
export interface PurchaseReturnable {
  invoice: { id: string; status: string; branchId: string; supplierId: string; returnStatus: "NONE" | "PARTIAL" | "FULL" };
  lines: PurchaseReturnableLine[];
}

export interface SalesReturnLineDetail {
  id: string;
  originalSalesInvoiceLineId: string;
  returnedBoards: string;
  returnedMetersQuantity: string;
  originalSalePricePerMeter: string;
  returnNetExTax: string;
  returnTax: string;
  returnTotal: string;
  returnCogs: string;
}
export interface PurchaseReturnLineDetail {
  id: string;
  originalPurchaseInvoiceLineId: string;
  returnedBoards: string;
  returnedMetersQuantity: string;
  originalPurchasePricePerMeter: string;
  returnNetExTax: string;
  returnTax: string;
  returnTotal: string;
}
export interface SalesReturnRow {
  id: string;
  returnNumber: string;
  originalSalesInvoiceId: string;
  returnDate: string;
  status: ReturnStatus;
  settlementMode: string;
  reason?: string | null;
  subtotal: string;
  taxTotal: string;
  grandTotal: string;
  cogsReversalTotal: string;
  totalMeters?: string;
  totalBoards?: string;
  customer?: { id: string; code: string; nameAr: string } | null;
  originalInvoice?: { id: string; invoiceNumber: string } | null;
  lines?: SalesReturnLineDetail[];
}
export interface PurchaseReturnRow {
  id: string;
  returnNumber: string;
  originalPurchaseInvoiceId: string;
  returnDate: string;
  status: ReturnStatus;
  settlementMode: string;
  reason?: string | null;
  subtotal: string;
  taxTotal: string;
  grandTotal: string;
  inventoryValueOut: string;
  totalMeters?: string;
  totalBoards?: string;
  supplier?: { id: string; nameAr: string } | null;
  originalInvoice?: { id: string; invoiceNumber: string } | null;
  lines?: PurchaseReturnLineDetail[];
}

export interface SalesReturnLineInput { originalSalesInvoiceLineId: string; returnedMeters: string; returnedBoards?: string; reason?: string; note?: string }
export interface PurchaseReturnLineInput { originalPurchaseInvoiceLineId: string; returnedMeters: string; returnedBoards?: string; reason?: string; note?: string }

// ── sales returns ────────────────────────────────────────────────────────────
export const listSalesReturns = (q: { status?: string; limit?: number; originalInvoiceId?: string } = {}) =>
  apiCall<{ items: SalesReturnRow[]; nextCursor: string | null }>(
    `/sales-returns?limit=${q.limit ?? 50}${q.status ? `&status=${q.status}` : ""}${q.originalInvoiceId ? `&originalInvoiceId=${q.originalInvoiceId}` : ""}`);
export const getSalesReturn = (id: string) => apiCall<SalesReturnRow>(`/sales-returns/${id}`);
export const getSalesReturnable = (invoiceId: string) => apiCall<SalesReturnable>(`/sales-returns/returnable/${invoiceId}`);
export const createSalesReturn = (body: { originalSalesInvoiceId: string; returnDate: string; reason?: string; notes?: string; settlementMode?: string; lines: SalesReturnLineInput[] }) =>
  apiCall<SalesReturnRow>(`/sales-returns`, { method: "POST", body });
export const updateSalesReturn = (id: string, body: { returnDate?: string; reason?: string; notes?: string; settlementMode?: string; lines?: SalesReturnLineInput[] }) =>
  apiCall<SalesReturnRow>(`/sales-returns/${id}`, { method: "PUT", body });
export const confirmSalesReturn = (id: string) => apiCall<SalesReturnRow>(`/sales-returns/${id}/confirm`, { method: "POST", body: {} });
export const cancelSalesReturn = (id: string, reason?: string) => apiCall<SalesReturnRow>(`/sales-returns/${id}/cancel`, { method: "POST", body: { reason } });

// ── purchase returns ─────────────────────────────────────────────────────────
export const listPurchaseReturns = (q: { status?: string; limit?: number; originalInvoiceId?: string } = {}) =>
  apiCall<{ items: PurchaseReturnRow[]; nextCursor: string | null }>(
    `/purchase-returns?limit=${q.limit ?? 50}${q.status ? `&status=${q.status}` : ""}${q.originalInvoiceId ? `&originalInvoiceId=${q.originalInvoiceId}` : ""}`);
export const getPurchaseReturn = (id: string) => apiCall<PurchaseReturnRow>(`/purchase-returns/${id}`);
export const getPurchaseReturnable = (invoiceId: string) => apiCall<PurchaseReturnable>(`/purchase-returns/returnable/${invoiceId}`);
export const createPurchaseReturn = (body: { originalPurchaseInvoiceId: string; returnDate: string; reason?: string; notes?: string; settlementMode?: string; lines: PurchaseReturnLineInput[] }) =>
  apiCall<PurchaseReturnRow>(`/purchase-returns`, { method: "POST", body });
export const updatePurchaseReturn = (id: string, body: { returnDate?: string; reason?: string; notes?: string; settlementMode?: string; lines?: PurchaseReturnLineInput[] }) =>
  apiCall<PurchaseReturnRow>(`/purchase-returns/${id}`, { method: "PUT", body });
export const confirmPurchaseReturn = (id: string) => apiCall<PurchaseReturnRow>(`/purchase-returns/${id}/confirm`, { method: "POST", body: {} });
export const cancelPurchaseReturn = (id: string, reason?: string) => apiCall<PurchaseReturnRow>(`/purchase-returns/${id}/cancel`, { method: "POST", body: { reason } });
