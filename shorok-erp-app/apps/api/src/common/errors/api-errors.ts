import { ERROR_CODES, type ErrorCode } from "@shorok/shared";

/**
 * Base class for typed domain errors. The global filter maps these to the
 * `{ code, message_ar, message_en, details? }` response envelope.
 */
export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    public readonly i18nKey: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`${code}: ${i18nKey}`);
    this.name = this.constructor.name;
  }
}

export class InsufficientStockError extends ApiError {
  constructor(details?: Record<string, unknown>) {
    super(ERROR_CODES.INSUFFICIENT_STOCK, 409, "errors.insufficient_stock", details);
  }
}

export class PriceApprovalRequiredError extends ApiError {
  constructor(details?: Record<string, unknown>) {
    super(
      ERROR_CODES.PRICE_APPROVAL_REQUIRED,
      409,
      "errors.price_approval_required",
      details,
    );
  }
}

export class InvalidStateTransitionError extends ApiError {
  constructor(details: { from: string; to: string }) {
    super(
      ERROR_CODES.INVALID_STATE_TRANSITION,
      409,
      "errors.invalid_state_transition",
      details,
    );
  }
}

export class InvalidMovementError extends ApiError {
  constructor(details?: Record<string, unknown>) {
    super(ERROR_CODES.INVALID_MOVEMENT, 409, "errors.invalid_movement", details);
  }
}

export class CollectionExceedsRequiredError extends ApiError {
  constructor(details?: Record<string, unknown>) {
    super(
      ERROR_CODES.COLLECTION_EXCEEDS_REQUIRED,
      409,
      "errors.collection_exceeds_required",
      details,
    );
  }
}

export class InvalidCredentialsError extends ApiError {
  constructor() {
    super(ERROR_CODES.INVALID_CREDENTIALS, 401, "errors.invalid_credentials");
  }
}

export class TokenExpiredError extends ApiError {
  constructor() {
    super(ERROR_CODES.TOKEN_EXPIRED, 401, "errors.token_expired");
  }
}

export class UserDisabledError extends ApiError {
  constructor() {
    super(ERROR_CODES.USER_DISABLED, 403, "errors.user_disabled");
  }
}

export class RefreshInvalidError extends ApiError {
  constructor() {
    super(ERROR_CODES.REFRESH_INVALID, 401, "errors.refresh_invalid");
  }
}

export class ForbiddenError extends ApiError {
  constructor(details?: Record<string, unknown>) {
    super(ERROR_CODES.FORBIDDEN, 403, "errors.forbidden", details);
  }
}

export class BranchForbiddenError extends ApiError {
  constructor(details?: Record<string, unknown>) {
    super(ERROR_CODES.BRANCH_FORBIDDEN, 403, "errors.branch_forbidden", details);
  }
}

export class NotFoundError extends ApiError {
  constructor(details?: Record<string, unknown>) {
    super(ERROR_CODES.NOT_FOUND, 404, "errors.not_found", details);
  }
}

export class ConflictError extends ApiError {
  constructor(i18nKey = "errors.conflict", details?: Record<string, unknown>) {
    super(ERROR_CODES.CONFLICT, 409, i18nKey, details);
  }
}

/**
 * Business-rule validation failure (HTTP 409). Distinct from ConflictError
 * because the response code is `validation_failed` — clients can detect it
 * generically and surface field-level guidance via `details`.
 */
export class ValidationError extends ApiError {
  constructor(details?: Record<string, unknown>) {
    super(ERROR_CODES.VALIDATION_FAILED, 409, "errors.validation_failed", details);
  }
}

/**
 * Warning (HTTP 409) that a posting would drive a treasury/bank account below
 * zero. Policy is warn-only: the client re-sends with acknowledgeNegativeBalance
 * to proceed. Distinct code so the web can open the confirmation modal rather
 * than treat it as a hard failure. `details` carries the balance breakdown.
 */
export class TreasuryNegativeBalanceWarning extends ApiError {
  constructor(details: Record<string, unknown>) {
    super(ERROR_CODES.TREASURY_NEGATIVE_BALANCE_WARNING, 409, "errors.treasury_negative_balance_warning", details);
  }
}

export class RepresentativeNotFoundError extends ApiError {
  constructor(details?: Record<string, unknown>) {
    super(ERROR_CODES.REPRESENTATIVE_NOT_FOUND, 404, "errors.representative_not_found", details);
  }
}

/** Assigning an inactive representative to a NEW invoice/journal line (409). */
export class RepresentativeInactiveError extends ApiError {
  constructor(details?: Record<string, unknown>) {
    super(ERROR_CODES.REPRESENTATIVE_INACTIVE, 409, "errors.representative_inactive", details);
  }
}

export class DuplicateRepresentativeCodeError extends ApiError {
  constructor(details?: Record<string, unknown>) {
    super(ERROR_CODES.DUPLICATE_REPRESENTATIVE_CODE, 409, "errors.duplicate_representative_code", details);
  }
}
