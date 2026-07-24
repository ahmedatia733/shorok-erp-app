import type { Role } from "@shorok/shared";

/**
 * Central Action → allowed-Roles map for the Phase 2 accounting-configuration
 * and period actions (Constitution VIII — accounting config is permission
 * gated; normal users cannot edit it).
 *
 * OWNER always bypasses role checks in RolesGuard, so it is implicitly allowed
 * everywhere and is listed explicitly only for OWNER-only actions. The new
 * controllers apply matching `@Roles(...)` decorators; this map is the
 * documented source of truth and backs GET /settings/permissions.
 *
 * Phase 2 scope: this map governs the NEW endpoints only. The existing
 * controllers keep their own `@Roles(...)` for now; migrating them onto this
 * map is deferred (not part of the accounting foundation).
 */
export type AccountingAction =
  | "period.create"
  | "period.close"
  | "period.reopen"
  | "company.update"
  | "postingProfile.create"
  | "taxProfile.create"
  | "expenseCategory.write"
  | "journal.post"
  | "journal.reverse";

// Roles that may perform each action IN ADDITION to OWNER (who always may).
export const ACCOUNTING_PERMISSIONS: Record<AccountingAction, Role[]> = {
  "period.create": ["ACCOUNTANT"],
  "period.close": ["ACCOUNTANT"],
  "period.reopen": [], // OWNER only
  "company.update": [], // OWNER only
  "postingProfile.create": [], // OWNER only
  "taxProfile.create": ["ACCOUNTANT"],
  "expenseCategory.write": ["ACCOUNTANT"],
  "journal.post": ["ACCOUNTANT"],
  "journal.reverse": ["ACCOUNTANT"],
};

/**
 * Returns (مردودات) capabilities — the documented source of truth for the
 * differentiated server-side access enforced by the return controllers'
 * `@Roles(...)`. VIEW is broad; CREATE/CONFIRM are accountant-level; CANCEL and
 * refunds are OWNER-only (destructive / money-out). Enforcement is server-side
 * in the RolesGuard + the per-request branch check — never UI-only.
 */
export type ReturnCapability =
  | "VIEW_SALES_RETURNS" | "CREATE_SALES_RETURNS" | "CONFIRM_SALES_RETURNS" | "CANCEL_SALES_RETURNS"
  | "VIEW_PURCHASE_RETURNS" | "CREATE_PURCHASE_RETURNS" | "CONFIRM_PURCHASE_RETURNS" | "CANCEL_PURCHASE_RETURNS"
  | "REFUND_CUSTOMER_CREDIT" | "RECEIVE_SUPPLIER_REFUND";

export const RETURN_PERMISSIONS: Record<ReturnCapability, Role[]> = {
  VIEW_SALES_RETURNS: ["ACCOUNTANT", "BRANCH_MANAGER"],
  CREATE_SALES_RETURNS: ["ACCOUNTANT"],
  CONFIRM_SALES_RETURNS: ["ACCOUNTANT"],
  CANCEL_SALES_RETURNS: [], // OWNER only
  VIEW_PURCHASE_RETURNS: ["ACCOUNTANT", "BRANCH_MANAGER"],
  CREATE_PURCHASE_RETURNS: ["ACCOUNTANT"],
  CONFIRM_PURCHASE_RETURNS: ["ACCOUNTANT"],
  CANCEL_PURCHASE_RETURNS: [], // OWNER only
  REFUND_CUSTOMER_CREDIT: [], // OWNER only (unsupported this phase)
  RECEIVE_SUPPLIER_REFUND: [], // OWNER only (unsupported this phase)
};

/** Human-readable matrix for GET /settings/permissions (OWNER shown as ✓ always). */
export function permissionMatrix(): Array<{ action: string; owner: true; roles: Role[] }> {
  const accounting = (Object.keys(ACCOUNTING_PERMISSIONS) as AccountingAction[]).map((action) => ({
    action, owner: true as const, roles: ACCOUNTING_PERMISSIONS[action],
  }));
  const returns = (Object.keys(RETURN_PERMISSIONS) as ReturnCapability[]).map((action) => ({
    action, owner: true as const, roles: RETURN_PERMISSIONS[action],
  }));
  return [...accounting, ...returns];
}
