"use client";
import { apiCall } from "./api-client";

export interface FixedAssetSummary {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  acquisitionDate: string;
  acquisitionCost: string;
  salvageValue: string;
  usefulLifeMonths: number;
  depreciationMethod: string;
  active: boolean;
  notes: string | null;
  assetAccount: { id: string; code: string; nameAr: string };
  accumulatedDepAccount: { id: string; code: string; nameAr: string };
  depreciationExpenseAccount: { id: string; code: string; nameAr: string };
  totalDepreciated: string;
  bookValue: string;
  monthlyDepreciation: string;
}

export interface DepreciationEntryRow {
  id: string;
  periodDate: string;
  amount: string;
  journalEntryId: string | null;
  notes: string | null;
  createdAt: string;
}

export interface FixedAssetDetail extends FixedAssetSummary {
  depreciationEntries: DepreciationEntryRow[];
}

export interface SchedulePeriod {
  periodDate: string;
  amount: string;
  posted: boolean;
  depreciationEntryId: string | null;
}

export interface DepreciationSchedule {
  assetId: string;
  totalPeriods: number;
  monthlyAmount: string;
  schedule: SchedulePeriod[];
}

export const listFixedAssets = () => apiCall<FixedAssetSummary[]>("/fixed-assets");
export const getFixedAsset = (id: string) => apiCall<FixedAssetDetail>(`/fixed-assets/${id}`);
export const getDepreciationSchedule = (id: string) =>
  apiCall<DepreciationSchedule>(`/fixed-assets/${id}/schedule`);
export const createFixedAsset = (body: {
  code: string;
  nameAr: string;
  nameEn?: string;
  acquisitionDate: string;
  acquisitionCost: string;
  salvageValue?: string;
  usefulLifeMonths: number;
  depreciationMethod?: string;
  assetAccountId: string;
  accumulatedDepAccountId: string;
  depreciationExpenseAccountId: string;
  notes?: string;
}) => apiCall<FixedAssetDetail>("/fixed-assets", { method: "POST", body });
export const updateFixedAsset = (
  id: string,
  body: { nameAr?: string; nameEn?: string; notes?: string; active?: boolean },
) => apiCall<FixedAssetDetail>(`/fixed-assets/${id}`, { method: "PUT", body });
export const deleteFixedAsset = (id: string) =>
  apiCall<void>(`/fixed-assets/${id}`, { method: "DELETE" });
export const runDepreciation = (
  id: string,
  body: { periodDate: string; postJournalEntry?: boolean; notes?: string },
) => apiCall<DepreciationEntryRow>(`/fixed-assets/${id}/depreciate`, { method: "POST", body });
