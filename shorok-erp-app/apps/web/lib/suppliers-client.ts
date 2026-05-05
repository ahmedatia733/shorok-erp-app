"use client";

import { apiCall } from "./api-client";

export interface SupplierRow {
  id: string;
  nameAr: string;
  nameEn: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export const listSuppliers = () => apiCall<SupplierRow[]>("/suppliers");

export const getSupplier = (id: string) => apiCall<SupplierRow>(`/suppliers/${id}`);

export const createSupplier = (body: {
  nameAr: string;
  nameEn: string;
  active?: boolean;
}) => apiCall<SupplierRow>("/suppliers", { method: "POST", body });

export const updateSupplier = (
  id: string,
  body: { nameAr?: string; nameEn?: string; active?: boolean },
) => apiCall<SupplierRow>(`/suppliers/${id}`, { method: "PATCH", body });
