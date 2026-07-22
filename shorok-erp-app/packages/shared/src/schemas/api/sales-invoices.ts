import { z } from "zod";

const MoneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/);
const PctStr   = z.string().regex(/^\d+(\.\d{1,2})?$/);
const QtyStr   = z.string().regex(/^\d+(\.\d{1,4})?$/);
const DateStr  = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const SalesInvoiceLineInputSchema = z.object({
  productVariantId: z.string().uuid(),
  quantity:    QtyStr, // number of BOARDS
  // Effective board size chosen on the line (like purchase invoices):
  //   custom طول×عرض → lengthM + widthM;  كبير/صغير → lengthM only (5.25 / 4).
  //   Omitted → the variant's stored sizeMetersPerBoard is used. The server
  //   recomputes the effective area from these (never trusts a client total).
  lengthM:     QtyStr.optional(),
  widthM:      QtyStr.optional(),
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
  // Optional reporting dimension; null clears it. Never affects posting.
  salesRepresentativeId: z.string().uuid().optional().nullable(),
  lines:       z.array(SalesInvoiceLineInputSchema).min(1),
});
export type CreateSalesInvoice = z.infer<typeof CreateSalesInvoiceSchema>;

export const UpdateSalesInvoiceSchema = z.object({
  invoiceDate: DateStr.optional(),
  dueDate:     DateStr.optional(),
  notes:       z.string().max(1000).optional(),
  taxRate:     PctStr.optional(),
  salesRepresentativeId: z.string().uuid().optional().nullable(),
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

// Phase 3B: accounts resolve from the PostingProfile in force on the invoice
// date; all account fields are optional and act only as a transitional
// fallback for the current UI (removed when the UI is rebuilt in Phase 6).
// `postJournalEntry`/`postCogs` are DEPRECATED and ignored — posting and the
// stock SALE are now mandatory; they remain in the schema so the current UI
// keeps validating.
export const ConfirmSalesInvoiceSchema = z.object({
  arAccountId:        z.string().uuid().optional(),
  revenueAccountId:   z.string().uuid().optional(),
  taxAccountId:       z.string().uuid().optional(),
  postJournalEntry:   z.boolean().optional(), // deprecated, ignored
  postCogs:           z.boolean().optional(), // deprecated, ignored
  cogsAccountId:      z.string().uuid().optional(),
  inventoryAccountId: z.string().uuid().optional(),
});
export type ConfirmSalesInvoice = z.infer<typeof ConfirmSalesInvoiceSchema>;
