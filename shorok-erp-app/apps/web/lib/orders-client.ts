"use client";

import type { OrderStatus, PriceOverrideStatus } from "@shorok/shared";
import { apiCall } from "./api-client";

export interface OrderListRow {
  id: string;
  branchId: string;
  orderDate: string;
  customerName: string;
  productVariantId: string;
  boardsQuantity: string;
  metersQuantity: string;
  salePricePerMeter: string;
  priceOverrideStatus: PriceOverrideStatus;
  priceApprovedByUserId: string | null;
  priceApprovedAt: string | null;
  requiredAmount: string;
  collectedAmount: string;
  remainingAmount: string;
  receiverName: string | null;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
  productVariant: {
    id: string;
    sizeMetersPerBoard: string;
    sku: { code: string; colorNameAr: string; colorNameEn: string };
  };
  creator: { id: string; name: string };
}

export interface OrderDetail extends OrderListRow {
  branch: { id: string; nameAr: string; nameEn: string };
  collections: Array<{
    id: string;
    orderId: string;
    collectedAt: string;
    amount: string;
    paidToAccount: string | null;
    createdBy: string;
    createdAt: string;
  }>;
  productVariant: OrderListRow["productVariant"] & {
    defaultSalePricePerMeter: string;
    defaultPurchasePricePerMeter: string;
    priceOverrideTolerancePercent: string | null;
  };
  priceApprover: { id: string; name: string } | null;
}

export interface OrdersPage {
  data: OrderListRow[];
  nextCursor: string | null;
}

export const listOrders = (filters: {
  branchId: string;
  status?: OrderStatus;
  cursor?: string | null;
  limit?: number;
}) => {
  const params = new URLSearchParams({
    branchId: filters.branchId,
    limit: String(filters.limit ?? 50),
  });
  if (filters.status) params.set("status", filters.status);
  if (filters.cursor) params.set("cursor", filters.cursor);
  return apiCall<OrdersPage>(`/orders?${params.toString()}`);
};

export const getOrder = (id: string) => apiCall<OrderDetail>(`/orders/${id}`);

export const createOrder = (body: {
  branchId: string;
  customerName: string;
  productVariantId: string;
  boardsQuantity: string;
  salePricePerMeter: string;
  receiverName?: string;
  initialCollectionAmount?: string;
  orderDate?: string;
}) => apiCall<OrderDetail>("/orders", { method: "POST", body });

export const updateOrder = (
  id: string,
  body: {
    customerName?: string;
    productVariantId?: string;
    boardsQuantity?: string;
    salePricePerMeter?: string;
    receiverName?: string;
    orderDate?: string;
  },
) => apiCall<OrderDetail>(`/orders/${id}`, { method: "PATCH", body });

export const confirmOrder = (id: string) =>
  apiCall<OrderDetail>(`/orders/${id}/confirm`, { method: "POST" });

export const approveOrderPrice = (id: string) =>
  apiCall<OrderDetail>(`/orders/${id}/price-approval`, { method: "POST" });

export const cancelOrder = (id: string, reason?: string) =>
  apiCall<OrderDetail>(`/orders/${id}/cancel`, {
    method: "POST",
    body: { reason },
  });

export const recordCollection = (
  id: string,
  body: { amount: string; paidToAccount?: string },
) => apiCall<OrderDetail>(`/orders/${id}/collections`, { method: "POST", body });

export const deleteOrder = (id: string) =>
  apiCall<void>(`/orders/${id}`, { method: "DELETE" });
