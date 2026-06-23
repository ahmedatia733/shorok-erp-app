import { z } from "zod";
import { DecimalStringSchema, IsoDateSchema, UuidSchema } from "../primitives";

export const CreateFactoryEntryRequestSchema = z.object({
  supplierId: UuidSchema,
  orderDate: IsoDateSchema,
  productVariantId: UuidSchema,
  boardsQuantity: DecimalStringSchema,
  purchasePricePerMeter: DecimalStringSchema,
  paidAmount: DecimalStringSchema.default("0"),
  notes: z.string().max(2000).optional(),
});
export type CreateFactoryEntryRequest = z.infer<typeof CreateFactoryEntryRequestSchema>;

export const CreateFactoryPaymentRequestSchema = z.object({
  supplierId: UuidSchema,
  orderDate: IsoDateSchema,
  paidAmount: DecimalStringSchema,
  notes: z.string().max(2000).optional(),
});
export type CreateFactoryPaymentRequest = z.infer<typeof CreateFactoryPaymentRequestSchema>;

export const UpdateFactoryEntryRequestSchema = z.object({
  orderDate: IsoDateSchema.optional(),
  productVariantId: UuidSchema.optional(),
  boardsQuantity: DecimalStringSchema.optional(),
  purchasePricePerMeter: DecimalStringSchema.optional(),
  paidAmount: DecimalStringSchema.optional(),
  notes: z.string().max(2000).nullish(),
});
export type UpdateFactoryEntryRequest = z.infer<typeof UpdateFactoryEntryRequestSchema>;

export const FactoryLedgerQuerySchema = z.object({
  supplierId: UuidSchema,
  cursor: z.string().nullish(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type FactoryLedgerQuery = z.infer<typeof FactoryLedgerQuerySchema>;
