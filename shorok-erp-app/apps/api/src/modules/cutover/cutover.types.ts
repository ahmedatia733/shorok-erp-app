/**
 * Opening-data cutover importer — shared types and the stable refusal codes.
 *
 * Every refusal has a stable code so an operator can act on it without reading
 * a stack trace, and so tests assert on the code rather than on message text.
 */

export const IMPORTER_VERSION = "1.0.0";

export type CutoverMode = "audit" | "dry-run" | "execute";

/**
 * Which class of database a run may touch. DEFAULT-DENY: `local` is the only
 * implicit value, and `production` must be requested explicitly and then satisfy
 * every check in `assertProductionTargetIsAuthorized`.
 */
export type TargetMode = "local" | "production";

/** The one token that unlocks production. Rotating it invalidates old scripts. */
export const PRODUCTION_CUTOVER_TOKEN = "APPROVE_SHOROK_PRODUCTION_CUTOVER_20260802";

/** What a run is allowed to write. Chosen by the manifest, not by a flag. */
export type ImportScope = "FULL_OPENING_IMPORT" | "MASTER_AND_STOCK_ONLY" | "AUDIT_ONLY";

export const CUTOVER_ERROR = {
  // ── invocation ──────────────────────────────────────────────────────────
  MODE_MISSING: "MODE_MISSING",
  MODE_AMBIGUOUS: "MODE_AMBIGUOUS",
  MANIFEST_MISSING: "MANIFEST_MISSING",
  MANIFEST_UNREADABLE: "MANIFEST_UNREADABLE",
  MANIFEST_INVALID: "MANIFEST_INVALID",
  MANIFEST_VERSION_UNSUPPORTED: "MANIFEST_VERSION_UNSUPPORTED",
  DATABASE_URL_MISSING: "DATABASE_URL_MISSING",
  APPROVAL_FILE_MISSING: "APPROVAL_FILE_MISSING",

  // ── integrity ───────────────────────────────────────────────────────────
  SOURCE_HASH_MISMATCH: "SOURCE_HASH_MISMATCH",
  MANIFEST_HASH_MISMATCH: "MANIFEST_HASH_MISMATCH",
  APPROVAL_HASH_MISMATCH: "APPROVAL_HASH_MISMATCH",
  UNRESOLVED_DECISIONS: "UNRESOLVED_DECISIONS",
  APPROVER_MISSING: "APPROVER_MISSING",
  APPROVAL_DATE_MISSING: "APPROVAL_DATE_MISSING",
  CUTOVER_DATE_MISMATCH: "CUTOVER_DATE_MISMATCH",

  // ── scope ───────────────────────────────────────────────────────────────
  JULY_TRANSACTION_IN_MANIFEST: "JULY_TRANSACTION_IN_MANIFEST",
  OPERATIONAL_TRANSACTION_IN_MANIFEST: "OPERATIONAL_TRANSACTION_IN_MANIFEST",
  OPERATIONAL_RETURN_IN_MANIFEST: "OPERATIONAL_RETURN_IN_MANIFEST",

  // ── uniqueness ──────────────────────────────────────────────────────────
  DUPLICATE_SOURCE_KEY: "DUPLICATE_SOURCE_KEY",
  DUPLICATE_CUSTOMER_KEY: "DUPLICATE_CUSTOMER_KEY",
  DUPLICATE_VARIANT_KEY: "DUPLICATE_VARIANT_KEY",
  DUPLICATE_BATCH: "DUPLICATE_BATCH",

  // ── domain ──────────────────────────────────────────────────────────────
  BRANCH_MISSING: "BRANCH_MISSING",
  BRANCH_MISMATCH: "BRANCH_MISMATCH",
  NEGATIVE_BOARDS: "NEGATIVE_BOARDS",
  INVALID_SIZE: "INVALID_SIZE",
  METERS_INCONSISTENT: "METERS_INCONSISTENT",
  INVENTORY_TOTALS_MISMATCH: "INVENTORY_TOTALS_MISMATCH",
  CUSTOMER_TOTALS_MISMATCH: "CUSTOMER_TOTALS_MISMATCH",
  JOURNAL_UNBALANCED: "JOURNAL_UNBALANCED",
  ACCOUNT_MISSING: "ACCOUNT_MISSING",
  AR_PARTY_DIMENSION_MISSING: "AR_PARTY_DIMENSION_MISSING",
  PERIOD_MISSING: "PERIOD_MISSING",
  PERIOD_CLOSED: "PERIOD_CLOSED",
  ROW_NOT_APPROVED: "ROW_NOT_APPROVED",
  BLOCKED_ROW_MARKED_IMPORTABLE: "BLOCKED_ROW_MARKED_IMPORTABLE",
  COLOR_POLICY_VIOLATION: "COLOR_POLICY_VIOLATION",
  CUSTOMER_CODE_TOO_LONG: "CUSTOMER_CODE_TOO_LONG",
  MASTER_ONLY_CUSTOMER_HAS_BALANCE: "MASTER_ONLY_CUSTOMER_HAS_BALANCE",

  // ── database safety ─────────────────────────────────────────────────────
  DB_URL_MALFORMED: "DB_URL_MALFORMED",
  DB_HOST_NOT_LOOPBACK: "DB_HOST_NOT_LOOPBACK",
  DB_HOST_PUBLIC: "DB_HOST_PUBLIC",
  DB_NAME_NOT_ALLOWLISTED: "DB_NAME_NOT_ALLOWLISTED",
  DB_IDENTITY_MISMATCH: "DB_IDENTITY_MISMATCH",
  DB_TARGET_FORBIDDEN: "DB_TARGET_FORBIDDEN",

  // ── privacy ─────────────────────────────────────────────────────────────
  PRIVATE_DUMP_REQUESTED: "PRIVATE_DUMP_REQUESTED",

  // ── late ────────────────────────────────────────────────────────────────
  RECONCILIATION_FAILED: "RECONCILIATION_FAILED",

  // ── binding (Section 2) ─────────────────────────────────────────────────
  ACTOR_MISSING: "ACTOR_MISSING",
  ACTOR_NOT_ACTIVE: "ACTOR_NOT_ACTIVE",
  ACTOR_NOT_OWNER: "ACTOR_NOT_OWNER",
  ACTOR_NOT_AUTHORIZED_FOR_BRANCH: "ACTOR_NOT_AUTHORIZED_FOR_BRANCH",
  ACTOR_IDENTITY_MISMATCH: "ACTOR_IDENTITY_MISMATCH",

  // ── source verification (Section 3) ─────────────────────────────────────
  SOURCE_DIR_REQUIRED: "SOURCE_DIR_REQUIRED",
  SOURCE_FILE_NOT_FOUND: "SOURCE_FILE_NOT_FOUND",

  // ── opening journal (Section 5) ─────────────────────────────────────────
  BALANCING_POLICY_NOT_PERMITTED: "BALANCING_POLICY_NOT_PERMITTED",
  TEMPORARY_EQUITY_NOT_DECLARED: "TEMPORARY_EQUITY_NOT_DECLARED",
  TEMPORARY_EQUITY_AMOUNT_MISMATCH: "TEMPORARY_EQUITY_AMOUNT_MISMATCH",
  POSTING_ACCOUNTS_NOT_DECLARED: "POSTING_ACCOUNTS_NOT_DECLARED",

  // ── fresh-database preparation (Section 1) ──────────────────────────────
  DB_NOT_FRESH: "DB_NOT_FRESH",
  DEMO_ROW_HAS_OPERATIONAL_REFERENCES: "DEMO_ROW_HAS_OPERATIONAL_REFERENCES",

  // ── production target authorization (default-deny) ──────────────────────
  TARGET_MODE_MISSING: "TARGET_MODE_MISSING",
  TARGET_MODE_INVALID: "TARGET_MODE_INVALID",
  PRODUCTION_TOKEN_MISSING: "PRODUCTION_TOKEN_MISSING",
  PRODUCTION_TOKEN_INVALID: "PRODUCTION_TOKEN_INVALID",
  EXPECTED_HOST_MISSING: "EXPECTED_HOST_MISSING",
  EXPECTED_HOST_MISMATCH: "EXPECTED_HOST_MISMATCH",
  EXPECTED_DATABASE_MISSING: "EXPECTED_DATABASE_MISSING",
  EXPECTED_DATABASE_MISMATCH: "EXPECTED_DATABASE_MISMATCH",
  PRODUCTION_APPROVAL_FILE_MISSING: "PRODUCTION_APPROVAL_FILE_MISSING",
  RUNTIME_PROJECT_MISMATCH: "RUNTIME_PROJECT_MISMATCH",
  RUNTIME_ENVIRONMENT_MISMATCH: "RUNTIME_ENVIRONMENT_MISMATCH",
  RUNTIME_SERVICE_NAME_MISMATCH: "RUNTIME_SERVICE_NAME_MISMATCH",
  RUNTIME_IDENTITY_UNAVAILABLE: "RUNTIME_IDENTITY_UNAVAILABLE",

  // ── valuation rounding ──────────────────────────────────────────────────
  VALUATION_ADJUSTMENT_NOT_APPROVED: "VALUATION_ADJUSTMENT_NOT_APPROVED",
  VALUATION_ADJUSTMENT_MISMATCH: "VALUATION_ADJUSTMENT_MISMATCH",
  VALUATION_ADJUSTMENT_TARGET_MISSING: "VALUATION_ADJUSTMENT_TARGET_MISSING",
} as const;

export type CutoverErrorCode = (typeof CUTOVER_ERROR)[keyof typeof CUTOVER_ERROR];

/** Non-fatal, must still surface in every report. */
export const CUTOVER_WARNING = {
  SOURCE_DATE_ANOMALY_ACCEPTED_AS_OPENING_SNAPSHOT:
    "SOURCE_DATE_ANOMALY_ACCEPTED_AS_OPENING_SNAPSHOT",
  ZERO_QUANTITY_VARIANT_IMPORTED: "ZERO_QUANTITY_VARIANT_IMPORTED",
  PROVISIONAL_LOCAL_VALIDATION_NOT_PRODUCTION_APPROVAL:
    "PROVISIONAL_LOCAL_VALIDATION_NOT_PRODUCTION_APPROVAL",
  SEQUENCES_ADVANCED_DESPITE_ROLLBACK: "SEQUENCES_ADVANCED_DESPITE_ROLLBACK",
  /** Audit ran without checking the source files against their hashes. */
  SOURCE_FILES_NOT_VERIFIED: "SOURCE_FILES_NOT_VERIFIED",
  /** NO_JOURNAL finished: master data and stock only, accounting incomplete. */
  NOT_ACCOUNTING_COMPLETE: "NOT_ACCOUNTING_COMPLETE",
  TEMPORARY_OPENING_EQUITY_USED: "TEMPORARY_OPENING_EQUITY_USED",
  VALUATION_ROUNDING_APPLIED: "VALUATION_ROUNDING_APPLIED",
} as const;

export type CutoverWarningCode = (typeof CUTOVER_WARNING)[keyof typeof CUTOVER_WARNING];

/**
 * A refusal. Carries a stable code and only redaction-safe details — never a
 * customer name, a per-row balance or a connection string.
 */
export class CutoverRefusal extends Error {
  constructor(
    readonly code: CutoverErrorCode,
    readonly details: Record<string, string | number | boolean> = {},
  ) {
    super(code);
    this.name = "CutoverRefusal";
  }
}

/** Thrown at the end of a dry-run to force the transaction to roll back. */
export class DryRunRollback extends Error {
  constructor(readonly plan: unknown) {
    super("DRY_RUN_ROLLBACK");
    this.name = "DryRunRollback";
  }
}
