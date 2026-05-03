import { z } from "zod";
import { MovementTypeEnum } from "../../enums";
import { DecimalStringSchema, IsoDateTimeSchema, UuidSchema } from "../primitives";

export const ReceiptRequestSchema = z.object({
  branchId: UuidSchema,
  productVariantId: UuidSchema,
  boardsQuantity: DecimalStringSchema,
  note: z.string().max(500).optional(),
});
export type ReceiptRequest = z.infer<typeof ReceiptRequestSchema>;

export const AdjustmentRequestSchema = z.object({
  branchId: UuidSchema,
  productVariantId: UuidSchema,
  boardsDelta: DecimalStringSchema,
  note: z.string().min(1).max(500),
});
export type AdjustmentRequest = z.infer<typeof AdjustmentRequestSchema>;

export const CountLineSchema = z.object({
  productVariantId: UuidSchema,
  countedBoards: DecimalStringSchema,
});
export type CountLine = z.infer<typeof CountLineSchema>;

export const CountRequestSchema = z.object({
  branchId: UuidSchema,
  lines: z.array(CountLineSchema).min(1),
});
export type CountRequest = z.infer<typeof CountRequestSchema>;

export const InventoryMovementsQuerySchema = z.object({
  branchId: UuidSchema,
  productVariantId: UuidSchema.optional(),
  movementType: MovementTypeEnum.optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
  cursor: z.string().nullish(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type InventoryMovementsQuery = z.infer<typeof InventoryMovementsQuerySchema>;
