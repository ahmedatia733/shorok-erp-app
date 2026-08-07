"use client";

import type {
  InventoryTransferPreview,
  InventoryTransferStatus,
} from "@shorok/shared";
import { apiCall } from "./api-client";

export type { InventoryTransferPreview, InventoryTransferStatus };

export interface TransferListRow {
  id: string;
  transferNumber: string;
  transferDate: string;
  status: InventoryTransferStatus;
  sourceBranch: { id: string; nameAr: string };
  destinationBranch: { id: string; nameAr: string };
  lineCount: number;
  totalBoards: string;
  totalMeters: string;
  createdByName: string | null;
  confirmedByName: string | null;
  createdAt: string;
}

export interface TransferLine {
  id: string;
  productVariantId: string;
  skuCode: string;
  productNameAr: string;
  productNameEn: string | null;
  boardSizeMeters: string;
  boardQuantity: string;
  meterQuantity: string;
  costPerMeter: string;
  totalValue: string;
  lineIndex: number;
  sourceMovementId: string | null;
  destinationMovementId: string | null;
  cancelSourceMovementId: string | null;
  cancelDestinationMovementId: string | null;
}

export interface TransferDetail {
  id: string;
  transferNumber: string;
  status: InventoryTransferStatus;
  transferDate: string;
  sourceBranch: { id: string; nameAr: string };
  destinationBranch: { id: string; nameAr: string };
  purpose: string | null;
  notes: string | null;
  version: number;
  createdByName: string | null;
  createdAt: string;
  updatedByName: string | null;
  updatedAt: string;
  confirmedByName: string | null;
  confirmedAt: string | null;
  cancelledByName: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  totals: { lineCount: number; boards: string; meters: string; value: string };
  lines: TransferLine[];
  idempotentReplay?: boolean;
}

export interface TransferLineInput {
  productVariantId: string;
  /** Whole boards, as typed. Metres are never sent — the server derives them. */
  boardQuantity: string;
}

export interface TransferPayload {
  transferDate: string;
  sourceBranchId: string;
  destinationBranchId: string;
  purpose?: string | null;
  notes?: string | null;
  lines: TransferLineInput[];
}

export const listTransfers = (filters: {
  status?: InventoryTransferStatus;
  sourceBranchId?: string;
  destinationBranchId?: string;
  productVariantId?: string;
  q?: string;
  from?: string;
  to?: string;
  cursor?: string | null;
  limit?: number;
}) => {
  const params = new URLSearchParams({ limit: String(filters.limit ?? 20) });
  for (const key of ["status", "sourceBranchId", "destinationBranchId", "productVariantId", "q", "from", "to"] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  if (filters.cursor) params.set("cursor", filters.cursor);
  return apiCall<{ data: TransferListRow[]; nextCursor: string | null }>(
    `/inventory-transfers?${params.toString()}`,
  );
};

export const getTransfer = (id: string) => apiCall<TransferDetail>(`/inventory-transfers/${id}`);

export const createTransfer = (body: TransferPayload) =>
  apiCall<TransferDetail>("/inventory-transfers", { method: "POST", body });

export const updateTransfer = (id: string, body: TransferPayload & { expectedVersion: number }) =>
  apiCall<TransferDetail>(`/inventory-transfers/${id}`, { method: "PATCH", body });

export const deleteTransfer = (id: string) =>
  apiCall<void>(`/inventory-transfers/${id}`, { method: "DELETE" });

/** Calculates against an unsaved payload and writes nothing. */
export const previewTransferPayload = (body: TransferPayload) =>
  apiCall<InventoryTransferPreview>("/inventory-transfers/preview", { method: "POST", body });

export const previewConfirm = (id: string) =>
  apiCall<InventoryTransferPreview>(`/inventory-transfers/${id}/confirm-preview`, { method: "POST" });

export const previewCancel = (id: string) =>
  apiCall<InventoryTransferPreview>(`/inventory-transfers/${id}/cancel-preview`, { method: "POST" });

export const confirmTransfer = (
  id: string,
  body: { expectedVersion: number; previewFingerprint: string; idempotencyKey: string },
) => apiCall<TransferDetail>(`/inventory-transfers/${id}/confirm`, { method: "POST", body });

export const cancelTransfer = (
  id: string,
  body: { expectedVersion: number; previewFingerprint: string; idempotencyKey: string; reason: string },
) => apiCall<TransferDetail>(`/inventory-transfers/${id}/cancel`, { method: "POST", body });

/**
 * A stable key for one confirm/cancel attempt.
 *
 * Derived from the document, its version and the exact preview the user is
 * looking at — so a double-click, a lost response or a refresh-and-retry all
 * send the SAME key and the server replays the first result instead of moving
 * the stock twice. A genuinely new attempt necessarily has a new version or a
 * new preview, and therefore a new key.
 */
export function transferIdempotencyKey(
  operation: "confirm" | "cancel",
  transferId: string,
  version: number,
  previewFingerprint: string,
): string {
  return `transfer:${operation}:${transferId}:v${version}:${previewFingerprint.slice(0, 32)}`;
}

// ── Source-stock-driven size options (P10) ────────────────────────────────

export interface SourceSizeOption {
  productVariantId: string;
  sizeBadge: "LARGE" | "SMALL" | "CUSTOM";
  sizeBadgeAr: string;
  sizeBadgeEn: string;
  dimensionsLabelAr: string;
  dimensionsLabelEn: string;
  boardSizeMeters: string;
  widthMeters: string | null;
  boardsAvailable: string;
  metersAvailable: string;
  enabled: boolean;
  disabledReason: string | null;
  disabledReasonAr: string | null;
  variantCode: string;
  variantDisplayNameAr: string;
  variantDisplayNameEn: string | null;
}

export interface SourceSizeOptionsResponse {
  sourceBranchId: string;
  sourceBranchNameAr: string;
  productSkuId: string;
  productCode: string;
  productNameAr: string;
  productNameEn: string | null;
  options: SourceSizeOption[];
  committedChanges: 0;
}

/**
 * Read-only. Keyed by (source branch, product) so a response can never be
 * shown against a different branch than the one it was asked about — the
 * caller re-checks those two ids before rendering.
 */
export const getSourceSizeOptions = (sourceBranchId: string, productSkuId: string) =>
  apiCall<SourceSizeOptionsResponse>(
    `/inventory-transfers/source-size-options?${new URLSearchParams({ sourceBranchId, productSkuId }).toString()}`,
  );

// ── Source-warehouse product picker (P11) ─────────────────────────────────

export interface SourceProduct {
  productSkuId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  enabledSizeCount: number;
}

export interface SourceProductsResponse {
  sourceBranchId: string;
  sourceBranchNameAr: string;
  products: SourceProduct[];
  committedChanges: 0;
}

/**
 * Read-only. One request per source branch — the server does the filtering, so
 * the browser never asks about products one at a time.
 */
export const getSourceProducts = (sourceBranchId: string) =>
  apiCall<SourceProductsResponse>(
    `/inventory-transfers/source-products?${new URLSearchParams({ sourceBranchId }).toString()}`,
  );
