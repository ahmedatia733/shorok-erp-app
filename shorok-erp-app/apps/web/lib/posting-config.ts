import { ApiClientError, apiCall } from "./api-client";

/**
 * Reasons the server returns when an invoice cannot post because the effective
 * PostingProfile is missing a required account. The UI maps any of these to a
 * "configuration incomplete" message with a link to accounting configuration —
 * it must never fall back to a hard-coded account.
 */
const POSTING_CONFIG_REASONS = new Set([
  "accounts_receivable_account_required",
  "accounts_payable_account_required",
  "revenue_account_required",
  "tax_account_required_when_tax_exists",
  "cogs_account_required",
  "inventory_account_required",
]);

export function isPostingConfigError(e: unknown): boolean {
  if (e instanceof ApiClientError) {
    const reason = (e.payload.details as { reason?: string } | undefined)?.reason;
    return typeof reason === "string" && POSTING_CONFIG_REASONS.has(reason);
  }
  return false;
}

interface PostingProfileLite {
  effectiveFrom: string;
  createdAt: string;
  salesReturnsAccountId: string | null;
}

/**
 * Whether the posting profile effective on `returnDateISO` (YYYY-MM-DD) has a
 * Sales Returns account — so the UI can warn and disable confirm BEFORE the user
 * hits the server-side `sales_returns_account_required` guard. Mirrors the
 * server resolver (greatest effectiveFrom ≤ date, newest createdAt on a tie).
 * Requires an ACCOUNTANT/OWNER token; callers must gate the call by role.
 */
export async function salesReturnsAccountConfigured(returnDateISO: string): Promise<boolean> {
  const day = returnDateISO.slice(0, 10);
  const profiles = await apiCall<PostingProfileLite[]>("/settings/posting-profiles");
  const eff = profiles
    .filter((p) => p.effectiveFrom.slice(0, 10) <= day)
    .sort((a, b) =>
      a.effectiveFrom === b.effectiveFrom ? b.createdAt.localeCompare(a.createdAt) : b.effectiveFrom.localeCompare(a.effectiveFrom),
    )[0];
  return !!eff?.salesReturnsAccountId;
}
