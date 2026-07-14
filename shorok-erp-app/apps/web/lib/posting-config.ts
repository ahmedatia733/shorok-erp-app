import { ApiClientError } from "./api-client";

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
