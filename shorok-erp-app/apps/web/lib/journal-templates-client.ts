"use client";
import { apiCall } from "./api-client";

export interface JournalTemplateLine {
  id: string;
  accountId: string;
  accountCode: string;
  accountNameAr: string;
  accountNameEn: string;
  type: "debit" | "credit";
  amount: string | null;
  note: string | null;
  sortOrder: number;
}

export interface JournalTemplate {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lines: JournalTemplateLine[];
}

export const listTemplates = () =>
  apiCall<JournalTemplate[]>("/journal-templates");

export const getTemplate = (id: string) =>
  apiCall<JournalTemplate>(`/journal-templates/${id}`);

export const createTemplate = (body: {
  name: string;
  description?: string;
  lines: Array<{
    accountId: string;
    type: "debit" | "credit";
    amount?: string;
    note?: string;
    sortOrder?: number;
  }>;
}) => apiCall<JournalTemplate>("/journal-templates", { method: "POST", body });

export const updateTemplate = (
  id: string,
  body: {
    name?: string;
    description?: string;
    lines?: Array<{
      accountId: string;
      type: "debit" | "credit";
      amount?: string;
      note?: string;
      sortOrder?: number;
    }>;
  },
) => apiCall<JournalTemplate>(`/journal-templates/${id}`, { method: "PUT", body });

export const deleteTemplate = (id: string) =>
  apiCall<void>(`/journal-templates/${id}`, { method: "DELETE" });
