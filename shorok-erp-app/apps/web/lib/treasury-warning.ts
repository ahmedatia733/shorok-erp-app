import { ApiClientError } from "./api-client";

/** Details carried by a `treasury_negative_balance_warning` (409) response. */
export interface TreasuryWarning {
  treasuryAccountId: string;
  accountCode: string;
  accountName: string;
  treasuryType: string;
  currentBalance: string;
  operationDebit: string;
  operationCredit: string;
  projectedBalance: string;
}

/**
 * If the error is the warn-only negative-treasury response, return its details
 * so the caller can open the confirmation modal and retry with acknowledgement.
 * Any other error returns null (treated as a real failure).
 */
export function parseTreasuryWarning(e: unknown): TreasuryWarning | null {
  if (e instanceof ApiClientError && e.payload.code === "treasury_negative_balance_warning") {
    const d = e.payload.details as Record<string, unknown> | undefined;
    if (d && typeof d.treasuryAccountId === "string") return d as unknown as TreasuryWarning;
  }
  return null;
}
