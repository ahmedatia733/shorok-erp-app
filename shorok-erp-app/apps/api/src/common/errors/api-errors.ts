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
