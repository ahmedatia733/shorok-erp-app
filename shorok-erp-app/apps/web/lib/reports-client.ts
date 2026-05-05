"use client";

import { apiCall } from "./api-client";

export interface DashboardData {
  branchId: string | null;
  totalSales: string;
  totalCollected: string;
  totalRemaining: string;
  totalExpenses: string;
  stockSummary: { boardsOnHand: string; metersOnHand: string };
  supplierBalances: Array<{
    supplierId: string;
    nameAr: string;
    nameEn: string;
    balance: string;
  }>;
  lowStock: Array<{
    branchId: string;
    productVariantId: string;
    boardsOnHand: string;
    metersOnHand: string;
    sku: { code: string; colorNameAr: string; colorNameEn: string };
    sizeMetersPerBoard: string;
  }>;
}

export const getDashboard = (branchId: string | null) => {
  const path = branchId ? `/reports/dashboard?branchId=${branchId}` : "/reports/dashboard";
  return apiCall<DashboardData>(path);
};
