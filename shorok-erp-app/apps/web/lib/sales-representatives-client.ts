import { apiCall } from "./api-client";

export interface SalesRepresentative {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SalesRepresentativeDetail extends SalesRepresentative {
  summary: {
    draftInvoiceCount: number;
    confirmedInvoiceCount: number;
    confirmedSalesTotal: string;
    periodDebit: string;
    periodCredit: string;
    netBalance: string;
  };
}

export interface RepStatementRow {
  kind: "SALES_INVOICE" | "JOURNAL";
  date: string;
  reference: string | null;
  description: string | null;
  counterparty: string | null;
  branchId: string | null;
  branchName: string | null;
  invoiceValue: string | null;
  debit: string | null;
  credit: string | null;
  runningBalance: string;
  status: string | null;
  salesInvoiceId: string | null;
  journalEntryId: string | null;
  journalLineId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  isReversal: boolean;
}

export interface RepStatement {
  representative: { id: string; code: string; nameAr: string; nameEn: string | null; phone: string | null; active: boolean };
  openingBalance: string;
  periodDebit: string;
  periodCredit: string;
  closingBalance: string;
  salesInvoiceCount: number;
  confirmedSalesTotal: string;
  page: number;
  limit: number;
  totalRows: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
  pageOpeningBalance: string;
  rows: RepStatementRow[];
}

export interface CreateRepInput {
  code?: string;
  nameAr: string;
  nameEn?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  active?: boolean;
}

export type UpdateRepInput = Partial<CreateRepInput>;

export interface RepStatementFilters {
  from?: string;
  to?: string;
  branchId?: string;
  type?: "all" | "invoice" | "journal";
  invoiceStatus?: "DRAFT" | "CONFIRMED" | "CANCELLED" | "PAID";
  page?: number;
  limit?: number;
}

export function listRepresentatives(params: { search?: string; status?: "active" | "inactive" | "all" } = {}): Promise<SalesRepresentative[]> {
  const q = new URLSearchParams();
  if (params.search) q.set("search", params.search);
  if (params.status) q.set("status", params.status);
  const qs = q.toString();
  return apiCall(`/sales-representatives${qs ? `?${qs}` : ""}`);
}

export function getRepresentative(id: string): Promise<SalesRepresentativeDetail> {
  return apiCall(`/sales-representatives/${id}`);
}

export function createRepresentative(input: CreateRepInput): Promise<SalesRepresentative> {
  return apiCall("/sales-representatives", { method: "POST", body: input });
}

export function updateRepresentative(id: string, input: UpdateRepInput): Promise<SalesRepresentative> {
  return apiCall(`/sales-representatives/${id}`, { method: "PATCH", body: input });
}

export function getRepresentativeStatement(id: string, filters: RepStatementFilters = {}): Promise<RepStatement> {
  const q = new URLSearchParams();
  if (filters.from) q.set("from", filters.from);
  if (filters.to) q.set("to", filters.to);
  if (filters.branchId) q.set("branchId", filters.branchId);
  if (filters.type && filters.type !== "all") q.set("type", filters.type);
  if (filters.invoiceStatus) q.set("invoiceStatus", filters.invoiceStatus);
  if (filters.page) q.set("page", String(filters.page));
  if (filters.limit) q.set("limit", String(filters.limit));
  const qs = q.toString();
  return apiCall(`/sales-representatives/${id}/statement${qs ? `?${qs}` : ""}`);
}
