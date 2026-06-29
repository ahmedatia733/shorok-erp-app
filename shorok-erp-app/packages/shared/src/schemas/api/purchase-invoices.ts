import { z } from "zod";
import { UuidSchema, IsoDateSchema } from "../primitives";

export const PurchaseInvoiceStatusEnum = z.enum(["DRAFT", "CONFIRMED", "CANCELLED"]);

export const PurchaseInvoiceLineInputSchema = z.object({
  productVariantId: UuidSchema,
  boardsQuantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
  unitPrice: z.string().regex(/^\d+(\.\d{1,2})?$/),
  taxRate: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
  isFree: z.boolean().default(false),
});
export type PurchaseInvoiceLineInput = z.infer<typeof PurchaseInvoiceLineInputSchema>;

export const CreatePurchaseInvoiceRequestSchema = z.object({
  invoiceDate: IsoDateSchema,
  supplierId: UuidSchema,
  branchId: UuidSchema,
  notes: z.string().max(1000).optional(),
  lines: z.array(PurchaseInvoiceLineInputSchema).min(1),
});
export type CreatePurchaseInvoiceRequest = z.infer<typeof CreatePurchaseInvoiceRequestSchema>;

export const PurchaseInvoiceQuerySchema = z.object({
  supplierId: UuidSchema.optional(),
  branchId: UuidSchema.optional(),
  status: PurchaseInvoiceStatusEnum.optional(),
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  cursor: z.string().uuid().optional().nullable(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PurchaseInvoiceQuery = z.infer<typeof PurchaseInvoiceQuerySchema>;
