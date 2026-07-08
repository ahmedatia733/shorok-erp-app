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

/** Human-readable matrix for GET /settings/permissions (OWNER shown as ✓ always). */
export function permissionMatrix(): Array<{ action: AccountingAction; owner: true; roles: Role[] }> {
  return (Object.keys(ACCOUNTING_PERMISSIONS) as AccountingAction[]).map((action) => ({
    action,
    owner: true,
    roles: ACCOUNTING_PERMISSIONS[action],
  }));
}
