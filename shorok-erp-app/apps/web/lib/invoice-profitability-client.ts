import { apiCall, apiDownload } from "./api-client";
import type { AppLocale } from "../i18n";

/**
 * Client for تقرير ربحية الفواتير.
 *
 * Every call is a GET. The report writes nothing, so there is no create/update
 * counterpart here by design.
 *
 * Money and percentages arrive as STRINGS, and `null` means "not available" —
 * a cost the ERP never recorded — which is deliberately different from "0.00".
 * Rendering must keep that distinction; a missing cost shown as zero reads as a
 * 100% margin.
 */

export type CostCoverage = "COMPLETE" | "PARTIAL" | "MISSING";

export interface ProfitabilitySummary {
  invoiceCount: number;
  netSalesExVat: string;
  tax: string;
  grandTotal: string;
  costedInvoiceCount: number;
  costedNetSalesExVat: string;
  historicalCogs: string;
  grossProfit: string;
  grossMarginPct: string | null;
  linkedReturnsNetExVat: string;
  linkedReturnsCogs: string;
  finalNetSalesExVat: string;
  finalCogs: string;
  finalGrossProfit: string;
  finalGrossMarginPct: string | null;
  incompleteCostInvoiceCount: number;
  incompleteCostNetSales: string;
}

export interface ProfitabilityInvoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  status: string;
  revisionNumber: number;
  customerCode: string | null;
  customerName: string | null;
  branchName: string | null;
  salesRepresentativeName: string | null;
  boards: string;
  meters: string;
  salesBeforeDiscount: string;
  discount: string;
  netSalesExVat: string;
  tax: string;
  grandTotal: string;
  cogs: string | null;
  grossProfit: string | null;
  marginPct: string | null;
  returnNetExVat: string;
  returnCogs: string | null;
  returnedMeters: string;
  finalNetSalesExVat: string;
  finalCogs: string | null;
  finalProfit: string | null;
  finalMarginPct: string | null;
  costCoverage: CostCoverage;
  lineCount: number;
  linesMissingCost: number;
}

export interface ProfitabilityReport {
  from: string;
  to: string;
  summary: ProfitabilitySummary;
  invoices: ProfitabilityInvoice[];
  page: number;
  pageSize: number;
  totalInvoices: number;
}

export interface ProfitabilityGroup {
  key: string;
  label: string;
  invoiceCount: number;
  boards: string;
  meters: string;
  salesBeforeDiscount: string;
  discount: string;
  netSalesExVat: string;
  costedNetSalesExVat: string;
  cogs: string;
  grossProfit: string;
  marginPct: string | null;
  returnNetExVat: string;
  returnCogs: string;
  returnedMeters: string;
  finalNetSalesExVat: string;
  finalCogs: string;
  finalProfit: string;
  finalMarginPct: string | null;
  incompleteCostInvoiceCount: number;
  linesMissingCost: number;
}

export type ProfitabilityAggregates = Record<"product" | "customer" | "branch" | "representative", ProfitabilityGroup[]>;

export interface ProfitabilityLine {
  id: string;
  productCode: string;
  productName: string;
  productVariantId: string;
  variantSize: string;
  sizeMode: "DEFAULT" | "LARGE" | "SMALL" | "CUSTOM";
  lengthM: string | null;
  widthM: string | null;
  boards: string;
  meters: string;
  salePricePerMeter: string;
  discountPct: string;
  discount: string;
  netSalesExVat: string;
  taxRate: string | null;
  costPerMeterAtPosting: string | null;
  costPerBoardAtPosting: string | null;
  cogs: string | null;
  grossProfit: string | null;
  marginPct: string | null;
  returnedBoards: string;
  returnedMeters: string;
  returnNetExVat: string;
  returnCogs: string | null;
  finalNetSalesExVat: string;
  finalCogs: string | null;
  finalProfit: string | null;
  costBasis: "METER_SNAPSHOT" | "LEGACY_BOARD" | "MISSING";
}

export interface ProfitabilityDetail {
  invoice: ProfitabilityInvoice;
  lines: ProfitabilityLine[];
  returns: Array<{
    id: string;
    returnNumber: string;
    returnDate: string;
    netExVat: string;
    cogs: string;
    meters: string;
    boards: string;
  }>;
}

export interface ProfitabilityFilters {
  from: string;
  to: string;
  branchId?: string;
  customerId?: string;
  salesRepresentativeId?: string;
  productCode?: string;
  invoiceNumber?: string;
  costCoverage?: "ALL" | "COMPLETE" | "INCOMPLETE";
  page?: number;
  pageSize?: number;
}

const BASE = "/reports/sales/invoice-profitability";

/** The filters as a query string. `preset=custom` keeps the explicit dates. */
export function profitabilityQuery(f: ProfitabilityFilters): string {
  const p = new URLSearchParams({ preset: "custom", from: f.from, to: f.to });
  if (f.branchId) p.set("branchId", f.branchId);
  if (f.customerId) p.set("customerId", f.customerId);
  if (f.salesRepresentativeId) p.set("salesRepresentativeId", f.salesRepresentativeId);
  if (f.productCode) p.set("productCode", f.productCode);
  if (f.invoiceNumber) p.set("invoiceNumber", f.invoiceNumber);
  if (f.costCoverage && f.costCoverage !== "ALL") p.set("costCoverage", f.costCoverage);
  if (f.page) p.set("page", String(f.page));
  if (f.pageSize) p.set("pageSize", String(f.pageSize));
  return p.toString();
}

export const getProfitabilityReport = (f: ProfitabilityFilters, signal?: AbortSignal) =>
  apiCall<ProfitabilityReport>(`${BASE}?${profitabilityQuery(f)}`, { signal });

export const getProfitabilityAggregates = (f: ProfitabilityFilters, signal?: AbortSignal) =>
  apiCall<ProfitabilityAggregates>(`${BASE}/aggregates?${profitabilityQuery(f)}`, { signal });

export const getProfitabilityDetail = (invoiceId: string, f: ProfitabilityFilters, signal?: AbortSignal) =>
  apiCall<ProfitabilityDetail>(`${BASE}/${invoiceId}?${profitabilityQuery(f)}`, { signal });

/** Hands the browser a file; nothing is persisted server-side. */
async function save(path: string, fallbackName: string, locale: AppLocale) {
  const { blob, filename } = await apiDownload(path, { locale });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const downloadProfitabilityPdf = (f: ProfitabilityFilters, locale: AppLocale) =>
  save(`${BASE}/pdf?${profitabilityQuery(f)}`, `invoice-profitability-${f.from}_${f.to}.pdf`, locale);

export const downloadProfitabilityExcel = (f: ProfitabilityFilters, locale: AppLocale) =>
  save(`${BASE}/export?${profitabilityQuery(f)}`, `invoice-profitability-${f.from}_${f.to}.xlsx`, locale);

export const downloadInvoiceProfitPdf = (invoiceId: string, invoiceNumber: string, f: ProfitabilityFilters, locale: AppLocale) =>
  save(`${BASE}/${invoiceId}/pdf?${profitabilityQuery(f)}`, `invoice-profit-${invoiceNumber}.pdf`, locale);
