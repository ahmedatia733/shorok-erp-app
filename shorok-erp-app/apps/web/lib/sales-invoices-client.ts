"use client";

import { apiCall } from "./api-client";

export interface SalesInvoiceLineSummary {
  id: string;
  productVariant: {
    id: string;
    sku: { code: string; colorNameAr: string } | null;
    sizeLabel: string | null;
  } | null;
  quantity: string;
  unitLabel: string;
  unitPrice: string;
  costPrice: string;
  discountPct: string;
  lineTotal: string;
  lineCost: string;
  note: string | null;
}

export interface SalesInvoiceRow {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  customer: { id: string; code: string; nameAr: string } | null;
  branch: { id: string; nameAr: string } | null;
  status: "DRAFT" | "CONFIRMED" | "CANCELLED" | "PAID";
  notes: string | null;
  subtotal: string;
  discountAmount: string;
  taxRate: string;
  taxAmount: string;
  grandTotal: string;
  totalCost: string;
  arAccountId: string | null;
  revenueAccountId: string | null;
  taxAccountId: string | null;
  cogsAccountId: string | null;
  inventoryAccountId: string | null;
  journalEntryId: string | null;
  cogsJournalEntryId: string | null;
  customerTxId: string | null;
  lineCount: number;
  createdAt: string;
}

export interface SalesInvoiceDetail extends SalesInvoiceRow {
  lines: SalesInvoiceLineSummary[];
}

export interface SalesInvoicePage {
  data: SalesInvoiceRow[];
  nextCursor: string | null;
}

export const listSalesInvoices = (params: {
  customerId?: string;
  status?: string;
  from?: string;
  to?: string;
  cursor?: string | null;
  limit?: number;
}) => {
  const p = new URLSearchParams();
  if (params.limit) p.set("limit", String(params.limit));
  if (params.customerId) p.set("customerId", params.customerId);
  if (params.status) p.set("status", params.status);
  if (params.from) p.set("from", params.from);
  if (params.to) p.set("to", params.to);
  if (params.cursor) p.set("cursor", params.cursor);
  return apiCall<SalesInvoicePage>(`/sales-invoices?${p.toString()}`);
};

export const getSalesInvoice = (id: string) =>
  apiCall<SalesInvoiceDetail>(`/sales-invoices/${id}`);

export const createSalesInvoice = (body: {
  invoiceDate: string;
  dueDate?: string;
  customerId: string;
  branchId: string;
  taxRate?: string;
  notes?: string;
  lines: Array<{
    productVariantId: string;
    quantity: string;
    unitLabel?: string;
    unitPrice: string;
    costPrice?: string;
    discountPct?: string;
    note?: string;
  }>;
}) => apiCall<SalesInvoiceDetail>("/sales-invoices", { method: "POST", body });

export const updateSalesInvoice = (
  id: string,
  body: {
    invoiceDate?: string;
    dueDate?: string;
    notes?: string;
    taxRate?: string;
    lines?: Array<{
      productVariantId: string;
      quantity: string;
      unitLabel?: string;
      unitPrice: string;
      costPrice?: string;
      discountPct?: string;
      note?: string;
    }>;
  },
) => apiCall<SalesInvoiceDetail>(`/sales-invoices/${id}`, { method: "PUT", body });

export const confirmSalesInvoice = (
  id: string,
  // Accounts resolve server-side from the PostingProfile; the body is empty.
  body: {
    arAccountId?: string;
    revenueAccountId?: string;
    taxAccountId?: string;
    postJournalEntry?: boolean;
    postCogs?: boolean;
    cogsAccountId?: string;
    inventoryAccountId?: string;
  } = {},
) => apiCall<SalesInvoiceDetail>(`/sales-invoices/${id}/confirm`, { method: "POST", body });

export const cancelSalesInvoice = (id: string) =>
  apiCall<{ success: boolean }>(`/sales-invoices/${id}/cancel`, { method: "POST" });

export const deleteSalesInvoice = (id: string) =>
  apiCall<void>(`/sales-invoices/${id}`, { method: "DELETE" });
