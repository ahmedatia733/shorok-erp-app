export const ERROR_CODES = {
  // Auth
  INVALID_CREDENTIALS: "invalid_credentials",
  TOKEN_EXPIRED: "token_expired",
  USER_DISABLED: "user_disabled",
  REFRESH_INVALID: "refresh_invalid",
  // Authorization
  FORBIDDEN: "forbidden",
  BRANCH_FORBIDDEN: "branch_forbidden",
  // Validation
  VALIDATION_FAILED: "validation_failed",
  // Inventory
  INSUFFICIENT_STOCK: "insufficient_stock",
  INVALID_MOVEMENT: "invalid_movement",
  // Orders
  PRICE_APPROVAL_REQUIRED: "price_approval_required",
  INVALID_STATE_TRANSITION: "invalid_state_transition",
  COLLECTION_EXCEEDS_REQUIRED: "collection_exceeds_required",
  // Accounting
  TREASURY_NEGATIVE_BALANCE_WARNING: "treasury_negative_balance_warning",
  // Sales representatives
  REPRESENTATIVE_NOT_FOUND: "representative_not_found",
  REPRESENTATIVE_INACTIVE: "representative_inactive",
  DUPLICATE_REPRESENTATIVE_CODE: "duplicate_representative_code",
  // Generic conflict
  CONFLICT: "conflict",
  NOT_FOUND: "not_found",
  // Import
  INVALID_WORKBOOK: "invalid_workbook",
  MISSING_REFERENCES: "missing_references",
  // Internal
  INTERNAL_ERROR: "internal_error",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
