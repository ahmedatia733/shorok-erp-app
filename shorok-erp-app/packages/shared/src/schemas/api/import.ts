import { z } from "zod";
import { UuidSchema } from "../primitives";

export const ImportKindEnum = z.enum([
  "orders",
  "inventory",
  "expenses",
  "factory_ledger",
]);
export type ImportKind = z.infer<typeof ImportKindEnum>;

export const ImportDryRunQuerySchema = z.object({
  kind: ImportKindEnum,
  branchId: UuidSchema.optional(),
  supplierId: UuidSchema.optional(),
});
export type ImportDryRunQuery = z.infer<typeof ImportDryRunQuerySchema>;

export const ImportCommitRequestSchema = z.object({
  importSessionId: UuidSchema,
});
export type ImportCommitRequest = z.infer<typeof ImportCommitRequestSchema>;

export const ImportValidationErrorSchema = z.object({
  row: z.number().int(),
  code: z.string(),
  message_ar: z.string(),
  message_en: z.string(),
});

export const ImportDryRunResponseSchema = z.object({
  sessionId: UuidSchema,
  rowsParsed: z.number().int().nonnegative(),
  rowsValid: z.number().int().nonnegative(),
  validationErrors: z.array(ImportValidationErrorSchema),
  missingReferences: z.object({
    skuCodes: z.array(z.string()),
    variantSizes: z.array(z.string()),
  }),
});
export type ImportDryRunResponse = z.infer<typeof ImportDryRunResponseSchema>;
