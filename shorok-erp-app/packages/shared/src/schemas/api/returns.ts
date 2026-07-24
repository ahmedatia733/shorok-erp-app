import { z } from "zod";

const QtyStr  = z.string().regex(/^\d+(\.\d{1,4})?$/); // metres / boards, up to 4dp, ≥ 0
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ── settlement + disposition vocab ─────────────────────────────────────────
// Full vocab (persisted). Cash/bank refunds are NOT accepted for confirmation in
// this phase — there is no customer-refund / supplier-refund voucher module, and
// direct-posting to treasury would bypass the financial engines (returns spec §9).
export const SalesReturnSettlementEnum = z.enum([
  "KEEP_AS_CUSTOMER_CREDIT",
  "OFFSET_OUTSTANDING_BALANCE",
  "CASH_REFUND",
  "BANK_REFUND",
]);
export type SalesReturnSettlement = z.infer<typeof SalesReturnSettlementEnum>;

export const PurchaseReturnSettlementEnum = z.enum([
  "KEEP_AS_SUPPLIER_CREDIT",
  "OFFSET_OUTSTANDING_BALANCE",
  "CASH_REFUND",
  "BANK_REFUND",
]);
export type PurchaseReturnSettlement = z.infer<typeof PurchaseReturnSettlementEnum>;

// Only credit settlements are currently SUPPORTED for create/confirm.
export const SalesReturnSettlementSupported = z.enum(["KEEP_AS_CUSTOMER_CREDIT", "OFFSET_OUTSTANDING_BALANCE"]);
export const PurchaseReturnSettlementSupported = z.enum(["KEEP_AS_SUPPLIER_CREDIT", "OFFSET_OUTSTANDING_BALANCE"]);

// Only stock-back-to-available is implemented in this phase (see returns spec §9).
export const InventoryDispositionEnum = z.enum(["RETURN_TO_AVAILABLE_STOCK"]);
export type InventoryDisposition = z.infer<typeof InventoryDispositionEnum>;

export const ReturnStatusEnum = z.enum(["DRAFT", "CONFIRMED", "CANCELLED"]);
export type ReturnStatus = z.infer<typeof ReturnStatusEnum>;

// The client only ever chooses WHICH original line and HOW MANY metres to
// return (plus operational board count). It can NEVER send historical prices,
// discounts, taxes or costs — the server derives all money from the original
// invoice line snapshots.
export const SalesReturnLineInputSchema = z.object({
  originalSalesInvoiceLineId: z.string().uuid(),
  returnedMeters: QtyStr,             // CANONICAL returned quantity (square metres)
  returnedBoards: QtyStr.optional(),  // operational piece/board count (defaults proportional)
  inventoryDisposition: InventoryDispositionEnum.optional().default("RETURN_TO_AVAILABLE_STOCK"),
  reason: z.string().max(300).optional(),
  note: z.string().max(300).optional(),
});
export type SalesReturnLineInput = z.infer<typeof SalesReturnLineInputSchema>;

// Reject the SAME original invoice line appearing twice — otherwise two items
// could each validate independently against the same remaining quantity (§4).
const uniqueSalesLines = (lines: { originalSalesInvoiceLineId: string }[], ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    if (seen.has(l.originalSalesInvoiceLineId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate_original_line", path: ["lines", i, "originalSalesInvoiceLineId"] });
    }
    seen.add(l.originalSalesInvoiceLineId);
  });
};

export const CreateSalesReturnSchema = z.object({
  originalSalesInvoiceId: z.string().uuid(),
  returnDate: DateStr,
  reason: z.string().max(300).optional(),
  notes: z.string().max(1000).optional(),
  settlementMode: SalesReturnSettlementSupported.optional().default("KEEP_AS_CUSTOMER_CREDIT"),
  lines: z.array(SalesReturnLineInputSchema).min(1),
}).superRefine((v, ctx) => uniqueSalesLines(v.lines, ctx));
export type CreateSalesReturn = z.infer<typeof CreateSalesReturnSchema>;

export const UpdateSalesReturnSchema = z.object({
  returnDate: DateStr.optional(),
  reason: z.string().max(300).optional(),
  notes: z.string().max(1000).optional(),
  settlementMode: SalesReturnSettlementSupported.optional(),
  lines: z.array(SalesReturnLineInputSchema).min(1).optional(),
}).superRefine((v, ctx) => { if (v.lines) uniqueSalesLines(v.lines, ctx); });
export type UpdateSalesReturn = z.infer<typeof UpdateSalesReturnSchema>;

export const PurchaseReturnLineInputSchema = z.object({
  originalPurchaseInvoiceLineId: z.string().uuid(),
  returnedMeters: QtyStr,
  returnedBoards: QtyStr.optional(),
  reason: z.string().max(300).optional(),
  note: z.string().max(300).optional(),
});
export type PurchaseReturnLineInput = z.infer<typeof PurchaseReturnLineInputSchema>;

const uniquePurchaseLines = (lines: { originalPurchaseInvoiceLineId: string }[], ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    if (seen.has(l.originalPurchaseInvoiceLineId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate_original_line", path: ["lines", i, "originalPurchaseInvoiceLineId"] });
    }
    seen.add(l.originalPurchaseInvoiceLineId);
  });
};

export const CreatePurchaseReturnSchema = z.object({
  originalPurchaseInvoiceId: z.string().uuid(),
  returnDate: DateStr,
  reason: z.string().max(300).optional(),
  notes: z.string().max(1000).optional(),
  settlementMode: PurchaseReturnSettlementSupported.optional().default("KEEP_AS_SUPPLIER_CREDIT"),
  lines: z.array(PurchaseReturnLineInputSchema).min(1),
}).superRefine((v, ctx) => uniquePurchaseLines(v.lines, ctx));
export type CreatePurchaseReturn = z.infer<typeof CreatePurchaseReturnSchema>;

export const UpdatePurchaseReturnSchema = z.object({
  returnDate: DateStr.optional(),
  reason: z.string().max(300).optional(),
  notes: z.string().max(1000).optional(),
  settlementMode: PurchaseReturnSettlementSupported.optional(),
  lines: z.array(PurchaseReturnLineInputSchema).min(1).optional(),
}).superRefine((v, ctx) => { if (v.lines) uniquePurchaseLines(v.lines, ctx); });
export type UpdatePurchaseReturn = z.infer<typeof UpdatePurchaseReturnSchema>;

export const ReturnCancelSchema = z.object({
  reason: z.string().max(300).optional(),
});
export type ReturnCancel = z.infer<typeof ReturnCancelSchema>;

export const ReturnQuerySchema = z.object({
  status: ReturnStatusEnum.optional(),
  branchId: z.string().uuid().optional(),
  originalInvoiceId: z.string().uuid().optional(), // related-documents filter
  from: DateStr.optional(),
  to: DateStr.optional(),
  cursor: z.string().uuid().optional().nullable(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ReturnQuery = z.infer<typeof ReturnQuerySchema>;
