import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import { I18nService } from "nestjs-i18n";
import { ZodError } from "zod";
import { ERROR_CODES } from "@shorok/shared";
import { ApiError } from "../errors/api-errors";

interface LocalizedError {
  code: string;
  status: number;
  message_ar: string;
  message_en: string;
  details?: Record<string, unknown>;
}

/**
 * Global error filter. Maps every error to the API contract's response shape:
 * `{ code, message_ar, message_en, details? }` with a stable `code`.
 */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiErrorFilter.name);

  constructor(private readonly i18n: I18nService) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    const localized = await this.toLocalizedError(exception, request);

    if (localized.status >= 500) {
      this.logger.error(
        { code: localized.code, exception },
        `${request.method} ${request.url} -> ${localized.status} ${localized.code}`,
      );
    }

    response.status(localized.status).json({
      code: localized.code,
      message_ar: localized.message_ar,
      message_en: localized.message_en,
      ...(localized.details ? { details: localized.details } : {}),
    });
  }

  private async toLocalizedError(
    exception: unknown,
    _request: unknown,
  ): Promise<LocalizedError> {
    // Typed domain errors → exact mapping.
    if (exception instanceof ApiError) {
      return {
        code: exception.code,
        status: exception.status,
        message_ar: await this.translate(exception.i18nKey, "ar", exception.details),
        message_en: await this.translate(exception.i18nKey, "en", exception.details),
        details: exception.details,
      };
    }

    // Zod validation failure (e.g. from ZodValidationPipe).
    if (exception instanceof ZodError) {
      const issues = exception.issues.map((i) => ({
        path: i.path.join("."),
        code: i.code,
        message: i.message,
      }));
      return {
        code: ERROR_CODES.VALIDATION_FAILED,
        status: 400,
        message_ar: await this.translate("errors.validation_failed", "ar"),
        message_en: await this.translate("errors.validation_failed", "en"),
        details: { issues },
      };
    }

    // NestJS HttpException — preserve the status, fall back to a localized
    // message keyed on the status code.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const i18nKey = `errors.http_${status}`;
      return {
        code: this.codeForHttpStatus(status),
        status,
        message_ar: await this.translateOrFallback(i18nKey, "ar", exception.message),
        message_en: await this.translateOrFallback(i18nKey, "en", exception.message),
      };
    }

    // Anything else is a 500.
    return {
      code: ERROR_CODES.INTERNAL_ERROR,
      status: 500,
      message_ar: await this.translate("errors.internal_error", "ar"),
      message_en: await this.translate("errors.internal_error", "en"),
    };
  }

  private async translate(
    key: string,
    lang: "ar" | "en",
    args?: Record<string, unknown>,
  ): Promise<string> {
    return (await this.i18n.translate(key, { lang, args: args ?? {} })) as string;
  }

  private async translateOrFallback(
    key: string,
    lang: "ar" | "en",
    fallback: string,
  ): Promise<string> {
    const value = (await this.i18n.translate(key, { lang })) as string;
    return value === key ? fallback : value;
  }

  private codeForHttpStatus(status: number): string {
    if (status === 401) return ERROR_CODES.INVALID_CREDENTIALS;
    if (status === 403) return ERROR_CODES.FORBIDDEN;
    if (status === 404) return ERROR_CODES.NOT_FOUND;
    if (status === 409) return ERROR_CODES.CONFLICT;
    if (status === 400) return ERROR_CODES.VALIDATION_FAILED;
    return ERROR_CODES.INTERNAL_ERROR;
  }
}
