"use client";

import type { MovementType } from "@shorok/shared";
import { apiCall } from "./api-client";

export interface BranchSummary {
  id: string;
  nameAr: string;
  nameEn: string;
  active: boolean;
}

export interface VariantOption {
  id: string;
  skuId: string;
  sizeMetersPerBoard: string;
  defaultSalePricePerMeter: string;
  defaultPurchasePricePerMeter: string;
  active: boolean;
  sku: {
    id: string;
    code: string;
    colorNameAr: string;
    colorNameEn: string;
  };
}

export interface BalanceRow {
  branchId: string;
  productVariantId: string;
  boardsOnHand: string;
  metersOnHand: string;
  lastCountedAt: string | null;
  sizeMetersPerBoard: string;
  sku: {
    id: string;
    code: string;
    colorNameAr: string;
    colorNameEn: string;
  };
  lowStock: boolean;
}

export interface MovementRow {
  id: string;
  branchId: string;
  productVariantId: string;
  movementType: MovementType;
  boardsQuantity: string;
  metersQuantity: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
  humanReadableNote: string | null;
  creator: { id: string; name: string };
  productVariant: {
    id: string;
    sizeMetersPerBoard: string;
    sku: { code: string; colorNameAr: string; colorNameEn: string };
  };
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface ApplyResult {
  movementId: string;
  boardsOnHand: string;
  metersOnHand: string;
  boardsDelta: string;
  metersDelta: string;
}

export const listBranches = () => apiCall<BranchSummary[]>("/branches");

export const listVariants = () => apiCall<VariantOption[]>("/products/variants");

export const listBalances = (branchId: string, cursor?: string | null) => {
  const params = new URLSearchParams({ branchId, limit: "200" });
  if (cursor) params.set("cursor", cursor);
  return apiCall<Page<BalanceRow>>(`/inventory/balances?${params.toString()}`);
};

export const listMovements = (filters: {
  branchId: string;
  movementType?: MovementType;
  productVariantId?: string;
  cursor?: string | null;
  limit?: number;
}) => {
  const params = new URLSearchParams({
    branchId: filters.branchId,
    limit: String(filters.limit ?? 50),
  });
  if (filters.movementType) params.set("movementType", filters.movementType);
  if (filters.productVariantId) params.set("productVariantId", filters.productVariantId);
  if (filters.cursor) params.set("cursor", filters.cursor);
  return apiCall<Page<MovementRow>>(`/inventory/movements?${params.toString()}`);
};

export const postReceipt = (body: {
  branchId: string;
  productVariantId: string;
  boardsQuantity: string;
  note?: string;
}) =>
  apiCall<ApplyResult>("/inventory/receipts", {
    method: "POST",
    body,
  });

export const postAdjustment = (body: {
  branchId: string;
  productVariantId: string;
  boardsDelta: string;
  note: string;
}) =>
  apiCall<ApplyResult>("/inventory/adjustments", {
    method: "POST",
    body,
  });

export const postCount = (body: {
  branchId: string;
  lines: Array<{ productVariantId: string; countedBoards: string }>;
}) =>
  apiCall<{ lines: Array<{ productVariantId: string; delta: string; boardsOnHand: string; metersOnHand: string; movementId: string | null }> }>(
    "/inventory/counts",
    { method: "POST", body },
  );
