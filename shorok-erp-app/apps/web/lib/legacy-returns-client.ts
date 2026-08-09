"use client";

import type {
  LegacyReturnDetail,
  LegacyReturnListResponse,
  LegacyReturnRow,
  LegacyReturnStatus,
} from "@shorok/shared";
import { apiCall, apiDownload } from "./api-client";
import type { AppLocale } from "../i18n";

export type { LegacyReturnDetail, LegacyReturnListResponse, LegacyReturnRow, LegacyReturnStatus };

/**
 * مردودات بدون فواتير — the client.
 *
 * The list and its PDF are built from the same filters, so «حفظ PDF» exports
 * the report the user is actually looking at rather than whatever page happens
 * to be loaded.
 */

export interface LegacyReturnFilters {
  q?: string;
  paperInvoiceNumber?: string;
  customerId?: string;
  branchId?: string;
  status?: LegacyReturnStatus | "";
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "" || v === null) continue;
    s.set(k, String(v));
  }
  const out = s.toString();
  return out ? `?${out}` : "";
};

export const legacyReturnsQuery = (f: LegacyReturnFilters): string =>
  qs({
    q: f.q?.trim() || undefined,
    paperInvoiceNumber: f.paperInvoiceNumber?.trim() || undefined,
    customerId: f.customerId || undefined,
    branchId: f.branchId || undefined,
    status: f.status || undefined,
    from: f.from || undefined,
    to: f.to || undefined,
    limit: f.limit,
    offset: f.offset,
  });

export const listLegacyReturns = (f: LegacyReturnFilters) =>
  apiCall<LegacyReturnListResponse>(`/legacy-returns${legacyReturnsQuery(f)}`);

export const getLegacyReturn = (id: string) => apiCall<LegacyReturnDetail>(`/legacy-returns/${id}`);

export interface LegacyReturnLinePayload {
  productVariantId?: string;
  productSkuId?: string;
  sizeMetersPerBoard?: string;
  lengthM?: string;
  widthM?: string;
  returnedBoards: string;
  unitPricePerMeter: string;
  discountPct?: string;
  taxRate?: string;
  note?: string;
}

export const createLegacyReturn = (body: {
  customerId: string;
  branchId: string;
  paperInvoiceNumber: string;
  paperInvoiceDate: string;
  returnDate: string;
  notes?: string;
  lines: LegacyReturnLinePayload[];
}) => apiCall<LegacyReturnDetail>("/legacy-returns", { method: "POST", body });

export const confirmLegacyReturn = (id: string) =>
  apiCall<LegacyReturnDetail>(`/legacy-returns/${id}/confirm`, { method: "POST", body: {} });

export const cancelLegacyReturn = (id: string, reason: string) =>
  apiCall<LegacyReturnDetail>(`/legacy-returns/${id}/cancel`, { method: "POST", body: { reason } });

// ── PDF ────────────────────────────────────────────────────────────────────

async function download(path: string, fallback: string, locale: AppLocale): Promise<void> {
  const { blob, filename } = await apiDownload(path, { locale });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename ?? fallback;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

const today = () => new Date().toISOString().slice(0, 10);

/** The whole filtered set — paging belongs to the screen, not the export. */
export const downloadLegacyReturnsListPdf = (f: LegacyReturnFilters, locale: AppLocale) =>
  download(
    `/legacy-returns/pdf${legacyReturnsQuery({ ...f, limit: undefined, offset: undefined })}`,
    `legacy-returns-${today()}.pdf`,
    locale,
  );

export const downloadLegacyReturnPdf = (id: string, returnNumber: string, locale: AppLocale) =>
  download(`/legacy-returns/${id}/pdf`, `legacy-return-LRN-${returnNumber}.pdf`, locale);
