"use client";
import { apiCall } from "./api-client";

export interface PurchaseInvoiceLineRow {
  id: string;
  productVariantId: string;
  skuCode: string;
  skuNameAr: string;
  skuNameEn: string;
  colorCode: string | null;
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
  /** Confirmed-invoice revision: 1 = the original confirmation, never revised. */
  revisionNumber: number;
  lastRevisedAt: string | null;
  subtotal: string;
  taxAmount: string;
  grandTotal: string;
  apAccountId: string | null;
  taxAccountId: string | null;
  inventoryAccountId: string | null;
  journalEntryId: string | null;
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
  q?: string;
  from?: string;
  to?: string;
  cursor?: string | null;
  limit?: number;
}) => {
  const p = new URLSearchParams();
  if (params.limit) p.set("limit", String(params.limit));
  if (params.q) p.set("q", params.q);
  if (params.supplierId) p.set("supplierId", params.supplierId);
  if (params.branchId) p.set("branchId", params.branchId);
  if (params.status) p.set("status", params.status);
  if (params.from) p.set("from", params.from);
  if (params.to) p.set("to", params.to);
  if (params.cursor) p.set("cursor", params.cursor);
  return apiCall<PurchaseInvoicePage>(`/purchase-invoices?${p.toString()}`);
};

/** The detail endpoint returns the same shape as a list row, lines included. */
export type PurchaseInvoiceDetail = PurchaseInvoiceRow;

export const getPurchaseInvoice = (id: string) =>
  apiCall<PurchaseInvoiceDetail>(`/purchase-invoices/${id}`);

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
    /** Either the exact variant… */
    productVariantId?: string;
    /** …or the base product plus the size actually purchased. */
    productSkuId?: string;
    sizeMetersPerBoard?: string;
    colorCode?: string;
    boardsQuantity: string;
    lengthM?: string;
    widthM?: string;
    heightM?: string;
    unitLabel?: string;
    unitPrice: string;
    taxRate: string;
    isFree: boolean;
  }>;
}) => apiCall<PurchaseInvoiceRow>("/purchase-invoices", { method: "POST", body });

export const confirmPurchaseInvoice = (
  id: string,
  // Accounts resolve server-side from the PostingProfile; the body is empty.
  body: { apAccountId?: string; taxAccountId?: string; inventoryAccountId?: string } = {},
) => apiCall<PurchaseInvoiceRow>(`/purchase-invoices/${id}/confirm`, { method: "POST", body });

export const cancelPurchaseInvoice = (id: string) =>
  apiCall<{ success: boolean }>(`/purchase-invoices/${id}/cancel`, { method: "POST" });

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

// ── the purchase catalogue ─────────────────────────────────────────────────

export interface PurchaseCatalogueVariant {
  productVariantId: string;
  sizeMetersPerBoard: string;
  defaultPurchasePricePerMeter: string;
}

export interface PurchaseCatalogueProduct {
  productSkuId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  initialPurchasePricePerMeter: string | null;
  variants: PurchaseCatalogueVariant[];
}

/**
 * Every active base product, each listed once.
 *
 * Purchases start from the product, not from a size: a product that has never
 * been bought has no sizes yet, and buying it is how its first size arrives.
 * That is why this is not `/products/variants`, which can only describe sizes
 * that already exist.
 */
export const listPurchaseCatalogue = async (): Promise<PurchaseCatalogueProduct[]> => {
  const res = await apiCall<{ products: PurchaseCatalogueProduct[] }>(
    "/products/purchase-catalogue",
  );
  return res.products;
};
