import { z } from "zod";

const QtyStr  = z.string().regex(/^\d+(\.\d{1,4})?$/); // metres, up to 4dp, ≥ 0 (legacy field)
// Whole-board return quantity: a positive integer, optionally sent with a
// trailing ".0000" (persisted Decimal form). Fractions like 0.5 / 1.25 / 2.1 are
// rejected here at the edge; the service re-validates authoritatively (§ whole
// boards). Boards are the ONE quantity authority — metres are derived server-side.
const BoardsStr = z.string().regex(/^[1-9]\d*(\.0+)?$/);
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

// The client only ever chooses WHICH original line and HOW MANY WHOLE BOARDS to
// return. It can NEVER send historical prices, discounts, taxes, costs — nor the
// returned metres: the server derives metres = returnedBoards × metresPerBoard
// (from the original line) and all money from the original invoice line
// snapshots. `returnedMeters` is accepted for backward compatibility but IGNORED.
export const SalesReturnLineInputSchema = z.object({
  originalSalesInvoiceLineId: z.string().uuid(),
  returnedBoards: BoardsStr,          // CANONICAL returned quantity — whole boards only
  returnedMeters: QtyStr.optional(),  // DEPRECATED/IGNORED — server recomputes from boards
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
  returnedBoards: BoardsStr,          // CANONICAL — whole boards only; metres derived server-side
  returnedMeters: QtyStr.optional(),  // DEPRECATED/IGNORED — server recomputes from boards
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
