import { z } from "zod";

/** Localized error response shape returned by every API error path. */
export const ApiErrorSchema = z.object({
  code: z.string(),
  message_ar: z.string(),
  message_en: z.string(),
  details: z.record(z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Cursor pagination wrapper used by list endpoints. */
export const PageQuerySchema = z.object({
  cursor: z.string().nullish(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export const PageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    nextCursor: z.string().nullable(),
  });
