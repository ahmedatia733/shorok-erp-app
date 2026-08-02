"use client";

import { apiCall } from "./api-client";
import type { HistoricalSalesReturnDetail, HistoricalSalesReturnListResponse } from "@shorok/shared";

/**
 * Historical sales-return archive (أرشيف مردودات المبيعات) — READ ONLY.
 *
 * The six July 2026 paper returns are evidence, not documents: their customer
 * effect is already inside the approved 2026-08-01 opening AR balances and their
 * stock effect is already inside the 2026-08-01 physical count. The API exposes
 * two GETs and nothing else, and this client deliberately mirrors that — there
 * is no create/update/confirm/cancel/delete call to reach for, because replaying
 * these rows would double-count them.
 */

export type {
  HistoricalSalesReturnCustomerRef,
  HistoricalSalesReturnDetail,
  HistoricalSalesReturnLineResponse,
  HistoricalSalesReturnListResponse,
  HistoricalSalesReturnSummary,
  HistoricalSalesReturnTotals,
  HistoricalSalesReturnVariantRef,
} from "@shorok/shared";

/** Mirrors HistoricalSalesReturnQuerySchema — every filter is optional. */
export interface HistoricalSalesReturnFilters {
  /** Inclusive lower bound on the document date (YYYY-MM-DD). */
  from?: string;
  /** Inclusive upper bound on the document date (YYYY-MM-DD). */
  to?: string;
  customerId?: string;
  productVariantId?: string;
  /** Free text over the source snapshots: customer name, product code, reference. */
  q?: string;
  cursor?: string;
  limit?: number;
}

export const listHistoricalSalesReturns = (filters: HistoricalSalesReturnFilters = {}) => {
  const p = new URLSearchParams({ limit: String(filters.limit ?? 50) });
  if (filters.from) p.set("from", filters.from);
  if (filters.to) p.set("to", filters.to);
  if (filters.customerId) p.set("customerId", filters.customerId);
  if (filters.productVariantId) p.set("productVariantId", filters.productVariantId);
  if (filters.q) p.set("q", filters.q);
  if (filters.cursor) p.set("cursor", filters.cursor);
  return apiCall<HistoricalSalesReturnListResponse>(`/historical-sales-returns?${p.toString()}`);
};

export const getHistoricalSalesReturn = (id: string) =>
  apiCall<HistoricalSalesReturnDetail>(`/historical-sales-returns/${id}`);
