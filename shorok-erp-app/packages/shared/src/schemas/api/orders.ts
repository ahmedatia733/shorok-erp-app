import { z } from "zod";
import { OrderStatusEnum } from "../../enums";
import { DecimalStringSchema, IsoDateSchema, UuidSchema } from "../primitives";

export const CreateOrderRequestSchema = z.object({
  branchId: UuidSchema,
  orderDate: IsoDateSchema.optional(),
  customerName: z.string().min(1).max(160),
  productVariantId: UuidSchema,
  boardsQuantity: DecimalStringSchema,
  salePricePerMeter: DecimalStringSchema,
  receiverName: z.string().max(160).optional(),
  initialCollectionAmount: DecimalStringSchema.optional(),
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

export const UpdateOrderRequestSchema = CreateOrderRequestSchema.partial().omit({
  branchId: true,
});
export type UpdateOrderRequest = z.infer<typeof UpdateOrderRequestSchema>;

export const OrdersQuerySchema = z.object({
  branchId: UuidSchema,
  status: OrderStatusEnum.optional(),
  cursor: z.string().nullish(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type OrdersQuery = z.infer<typeof OrdersQuerySchema>;

export const RecordCollectionRequestSchema = z.object({
  amount: DecimalStringSchema,
  paidToAccount: z.string().max(120).optional(),
  cashAccountId: UuidSchema.optional(),
  arAccountId: UuidSchema.optional(),
});
export type RecordCollectionRequest = z.infer<typeof RecordCollectionRequestSchema>;

export const CancelOrderRequestSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});
export type CancelOrderRequest = z.infer<typeof CancelOrderRequestSchema>;
