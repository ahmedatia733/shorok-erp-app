import { z } from "zod";

const MoneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/);
const PctStr   = z.string().regex(/^\d+(\.\d{1,2})?$/);
const QtyStr   = z.string().regex(/^\d+(\.\d{1,4})?$/);
const DateStr  = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const SalesInvoiceLineInputSchema = z.object({
  productVariantId: z.string().uuid(),
  quantity:    QtyStr,
  unitLabel:   z.string().max(30).optional().default("وحدة"),
  unitPrice:   MoneyStr,
  costPrice:   MoneyStr.optional().default("0"),
  discountPct: PctStr.optional().default("0"),
  note:        z.string().max(300).optional(),
});

export const CreateSalesInvoiceSchema = z.object({
  invoiceDate: DateStr,
  dueDate:     DateStr.optional(),
  customerId:  z.string().uuid(),
  branchId:    z.string().uuid(),
  taxRate:     PctStr.optional().default("0"),
  notes:       z.string().max(1000).optional(),
  orderId:     z.string().uuid().optional(),
  lines:       z.array(SalesInvoiceLineInputSchema).min(1),
});
export type CreateSalesInvoice = z.infer<typeof CreateSalesInvoiceSchema>;

export const UpdateSalesInvoiceSchema = z.object({
  invoiceDate: DateStr.optional(),
  dueDate:     DateStr.optional(),
  notes:       z.string().max(1000).optional(),
  taxRate:     PctStr.optional(),
  lines:       z.array(SalesInvoiceLineInputSchema).min(1).optional(),
});
export type UpdateSalesInvoice = z.infer<typeof UpdateSalesInvoiceSchema>;

export const SalesInvoiceQuerySchema = z.object({
  customerId: z.string().uuid().optional(),
  status:     z.enum(["DRAFT","CONFIRMED","CANCELLED","PAID"]).optional(),
  from:       DateStr.optional(),
  to:         DateStr.optional(),
  cursor:     z.string().uuid().optional().nullable(),
  limit:      z.coerce.number().int().min(1).max(100).default(20),
});
export type SalesInvoiceQuery = z.infer<typeof SalesInvoiceQuerySchema>;

export const ConfirmSalesInvoiceSchema = z.object({
  arAccountId:        z.string().uuid(),
  revenueAccountId:   z.string().uuid(),
  taxAccountId:       z.string().uuid().optional(),
  postJournalEntry:   z.boolean().default(true),
  postCogs:           z.boolean().default(false),
  cogsAccountId:      z.string().uuid().optional(),
  inventoryAccountId: z.string().uuid().optional(),
});
export type ConfirmSalesInvoice = z.infer<typeof ConfirmSalesInvoiceSchema>;
