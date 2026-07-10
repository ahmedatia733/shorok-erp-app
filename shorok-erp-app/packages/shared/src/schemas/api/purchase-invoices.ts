import { z } from "zod";
import { UuidSchema, IsoDateSchema } from "../primitives";

export const PurchaseInvoiceStatusEnum = z.enum(["DRAFT", "CONFIRMED", "CANCELLED"]);

const decimalStr = z.string().regex(/^\d+(\.\d{1,4})?$/);

export const PurchaseInvoiceLineInputSchema = z.object({
  productVariantId: UuidSchema,
  colorCode: z.string().max(20).optional(),
  boardsQuantity: decimalStr,
  lengthM: decimalStr.optional(),
  widthM: decimalStr.optional(),
  heightM: decimalStr.optional(),
  unitLabel: z.string().max(30).optional(),
  unitPrice: z.string().regex(/^\d+(\.\d{1,2})?$/),
  taxRate: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
  isFree: z.boolean().default(false),
});
export type PurchaseInvoiceLineInput = z.infer<typeof PurchaseInvoiceLineInputSchema>;

export const CreatePurchaseInvoiceRequestSchema = z.object({
  invoiceDate: IsoDateSchema,
  dueDate: IsoDateSchema.optional(),
  supplierId: UuidSchema,
  branchId: UuidSchema,
  factoryLedgerEntryId: UuidSchema.optional(),
  basedOn: z.string().max(300).optional(),
  docDirection: z.string().max(100).optional(),
  customsNumber: z.string().max(100).optional(),
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

// Phase 3A: all account fields are optional. Accounts resolve from the
// PostingProfile in force on the invoice date; these body fields are only a
// transitional fallback for the current UI and are removed when the UI is
// rebuilt in Phase 6.
export const ConfirmPurchaseInvoiceSchema = z.object({
  apAccountId:        z.string().uuid().optional(),
  taxAccountId:       z.string().uuid().optional(),
  inventoryAccountId: z.string().uuid().optional(),
});
export type ConfirmPurchaseInvoice = z.infer<typeof ConfirmPurchaseInvoiceSchema>;
