import { ArgumentMetadata, Injectable, PipeTransform } from "@nestjs/common";
import { ZodError, ZodSchema } from "zod";

/**
 * Validates request payloads against a Zod schema. Throw a `ZodError` on
 * failure — the global ApiErrorFilter maps it to a `validation_failed`
 * 400 with localized messages.
 *
 * Usage:
 *   @Post() create(@Body(new ZodValidationPipe(CreateOrderRequestSchema)) body: CreateOrderRequest) {}
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw parsed.error as ZodError;
    }
    return parsed.data;
  }
}
