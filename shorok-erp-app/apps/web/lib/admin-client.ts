"use client";

import type { Role } from "@shorok/shared";
import { apiCall } from "./api-client";

/* ------------------------------ Branches ------------------------------ */

export interface BranchRow {
  id: string;
  nameAr: string;
  nameEn: string;
  location: string | null;
  active: boolean;
  createdAt: string;
}

export const listAllBranches = () => apiCall<BranchRow[]>("/branches");

export const createBranch = (body: {
  nameAr: string;
  nameEn: string;
  location?: string;
}) => apiCall<BranchRow>("/branches", { method: "POST", body });

export const updateBranch = (
  id: string,
  body: { nameAr?: string; nameEn?: string; location?: string },
) => apiCall<BranchRow>(`/branches/${id}`, { method: "PATCH", body });

export const deactivateBranch = (id: string) =>
  apiCall<BranchRow>(`/branches/${id}/deactivate`, { method: "POST" });

/* ------------------------------- Users -------------------------------- */

export interface UserRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: Role;
  status: "ACTIVE" | "DISABLED";
  allowedBranches: string[];
  createdAt: string;
}

export const listUsers = () => apiCall<UserRow[]>("/users");

export const createUser = (body: {
  name: string;
  phone: string;
  email?: string;
  password: string;
  role: Role;
  allowedBranches?: string[];
}) => apiCall<UserRow>("/users", { method: "POST", body });

export const updateUser = (
  id: string,
  body: {
    name?: string;
    phone?: string;
    email?: string;
    role?: Role;
    allowedBranches?: string[];
  },
) => apiCall<UserRow>(`/users/${id}`, { method: "PATCH", body });

export const disableUser = (id: string) =>
  apiCall<UserRow>(`/users/${id}/disable`, { method: "POST" });

export const enableUser = (id: string) =>
  apiCall<UserRow>(`/users/${id}/enable`, { method: "POST" });

export const resetUserPassword = (id: string, password: string) =>
  apiCall<{ ok: true }>(`/users/${id}/password-reset`, {
    method: "POST",
    body: { password },
  });

/* ------------------------------ Products ------------------------------ */

export interface SkuRow {
  id: string;
  code: string;
  colorNameAr: string;
  colorNameEn: string;
  category: "NORMAL" | "SPECIAL";
  active: boolean;
}

export const listSkus = () => apiCall<SkuRow[]>("/products/skus");

export const createSku = (body: {
  code: string;
  colorNameAr: string;
  colorNameEn: string;
  category?: "NORMAL" | "SPECIAL";
}) => apiCall<SkuRow>("/products/skus", { method: "POST", body });

export const updateSku = (
  id: string,
  body: {
    code?: string;
    colorNameAr?: string;
    colorNameEn?: string;
    category?: "NORMAL" | "SPECIAL";
    active?: boolean;
  },
) => apiCall<SkuRow>(`/products/skus/${id}`, { method: "PATCH", body });

export interface VariantRow {
  id: string;
  skuId: string;
  sizeMetersPerBoard: string;
  defaultSalePricePerMeter: string;
  defaultPurchasePricePerMeter: string;
  priceOverrideTolerancePercent: string | null;
  active: boolean;
}

export const listAllVariants = () => apiCall<VariantRow[]>("/products/variants");

export const createVariant = (body: {
  skuId: string;
  sizeMetersPerBoard: string;
  defaultSalePricePerMeter: string;
  defaultPurchasePricePerMeter: string;
  priceOverrideTolerancePercent?: string | null;
}) => apiCall<VariantRow>("/products/variants", { method: "POST", body });

export const updateVariant = (
  id: string,
  body: {
    sizeMetersPerBoard?: string;
    defaultSalePricePerMeter?: string;
    defaultPurchasePricePerMeter?: string;
    priceOverrideTolerancePercent?: string | null;
    active?: boolean;
  },
) => apiCall<VariantRow>(`/products/variants/${id}`, { method: "PATCH", body });

/* ---------------------------- System Settings ------------------------- */

export interface SystemSettings {
  id: number;
  defaultPriceOverrideTolerancePercent: string;
  lowStockThresholdBoards: string;
}

export const getSystemSettings = () => apiCall<SystemSettings>("/system-settings");

export const updateSystemSettings = (body: {
  defaultPriceOverrideTolerancePercent?: string;
  lowStockThresholdBoards?: string;
}) => apiCall<SystemSettings>("/system-settings", { method: "PATCH", body });
