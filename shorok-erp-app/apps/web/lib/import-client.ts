import { getAccessToken } from "./api-client";

const API_BASE = "/api/v1";

export type ImportKind = "orders" | "inventory" | "expenses" | "factory_ledger";

export interface ImportValidationError {
  row: number;
  code: string;
  message_ar: string;
  message_en: string;
}

export interface ImportDryRunResult {
  sessionId: string;
  rowsParsed: number;
  rowsValid: number;
  validationErrors: ImportValidationError[];
  missingReferences: {
    skuCodes: string[];
    variantSizes: string[];
  };
}

export async function importDryRun(
  file: File,
  kind: ImportKind,
  branchId?: string | null,
  supplierId?: string | null,
): Promise<ImportDryRunResult> {
  const params = new URLSearchParams({ kind });
  if (branchId) params.set("branchId", branchId);
  if (supplierId) params.set("supplierId", supplierId);

  const form = new FormData();
  form.append("file", file);

  const headers: Record<string, string> = {};
  const token = getAccessToken();
  if (token) headers["authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}/import/dry-run?${params.toString()}`, {
    method: "POST",
    credentials: "include",
    headers,
    body: form,
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    const msg =
      payload?.message_ar || payload?.message_en || `Error ${res.status}`;
    throw new Error(msg);
  }

  return res.json();
}

export async function importCommit(sessionId: string): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const token = getAccessToken();
  if (token) headers["authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}/import/commit`, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({ importSessionId: sessionId }),
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    const msg =
      payload?.message_ar || payload?.message_en || `Error ${res.status}`;
    throw new Error(msg);
  }
}
