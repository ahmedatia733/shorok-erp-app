import { z } from "zod";
import { UuidSchema, IsoDateSchema } from "../primitives";

// Money as a positive 2dp string (no sign). Amounts must be > 0.
const MoneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/, { message: "must be a money string like '12.34'" });
const PositiveMoney = MoneyStr.refine((v) => Number(v) > 0, { message: "must be greater than 0" });

export const VoucherStatusSchema = z.enum(["DRAFT", "POSTED", "REVERSED"]);
export type VoucherStatus = z.infer<typeof VoucherStatusSchema>;

// ── Allocation input ─────────────────────────────────────────────────
export const ReceiptVoucherAllocationInputSchema = z.object({
  salesInvoiceId: UuidSchema,
  amount: PositiveMoney,
});
export type ReceiptVoucherAllocationInput = z.infer<typeof ReceiptVoucherAllocationInputSchema>;

const AllocationsArray = z
  .array(ReceiptVoucherAllocationInputSchema)
  .refine((arr) => new Set(arr.map((a) => a.salesInvoiceId)).size === arr.length, {
    message: "duplicate salesInvoiceId in allocations",
  });

// total(allocations) must not exceed the voucher amount (checked only when both are present).
const allocationsWithinAmount = (v: { amount?: string; allocations?: { amount: string }[] }) => {
  if (!v.allocations || v.allocations.length === 0 || v.amount === undefined) return true;
  const total = v.allocations.reduce((s, a) => s + Number(a.amount), 0);
  return total <= Number(v.amount) + 1e-9;
};

// ── Create (draft) ───────────────────────────────────────────────────
export const CreateReceiptVoucherSchema = z
  .object({
    voucherDate: IsoDateSchema,
    branchId: UuidSchema,
    customerId: UuidSchema,
    treasuryAccountId: UuidSchema,
    amount: PositiveMoney,
    reference: z.string().max(100).optional(),
    memo: z.string().max(300).optional(),
    allocations: AllocationsArray.optional(),
  })
  .strict()
  .refine(allocationsWithinAmount, { message: "allocations total exceeds voucher amount", path: ["allocations"] });
export type CreateReceiptVoucher = z.infer<typeof CreateReceiptVoucherSchema>;

// ── Update (draft only) — no status / journal / posting metadata ─────
export const UpdateReceiptVoucherSchema = z
  .object({
    voucherDate: IsoDateSchema.optional(),
    branchId: UuidSchema.optional(),
    customerId: UuidSchema.optional(),
    treasuryAccountId: UuidSchema.optional(),
    amount: PositiveMoney.optional(),
    reference: z.string().max(100).nullable().optional(),
    memo: z.string().max(300).nullable().optional(),
    allocations: AllocationsArray.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" })
  .refine(allocationsWithinAmount, { message: "allocations total exceeds voucher amount", path: ["allocations"] });
export type UpdateReceiptVoucher = z.infer<typeof UpdateReceiptVoucherSchema>;

// ── Post — server-side idempotency (RECEIPT_VOUCHER:<id>), no client fields ──
export const ReceiptVoucherPostSchema = z.object({}).strict();
export type ReceiptVoucherPost = z.infer<typeof ReceiptVoucherPostSchema>;

// ── Reverse — mirrors the journal reverse convention (reason + optional date) ─
export const ReceiptVoucherReverseSchema = z.object({
  reason: z.string().min(3).max(500),
  reversalDate: IsoDateSchema.optional(),
  acknowledgeNegativeBalance: z.boolean().optional(),
  negativeBalanceReason: z.string().max(500).optional(),
});
export type ReceiptVoucherReverse = z.infer<typeof ReceiptVoucherReverseSchema>;

// ── Query / list ─────────────────────────────────────────────────────
export const ReceiptVoucherQuerySchema = z
  .object({
    branchId: UuidSchema.optional(),
    customerId: UuidSchema.optional(),
    treasuryAccountId: UuidSchema.optional(),
    status: VoucherStatusSchema.optional(),
    dateFrom: IsoDateSchema.optional(),
    dateTo: IsoDateSchema.optional(),
    search: z.string().max(120).optional(),
    cursor: z.string().uuid().optional().nullable(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((v) => !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo, {
    message: "dateFrom must be <= dateTo",
    path: ["dateFrom"],
  });
export type ReceiptVoucherQuery = z.infer<typeof ReceiptVoucherQuerySchema>;

// ── Response shapes (serialized — Decimals + voucherNumber as strings) ─
export interface ReceiptVoucherAllocationResponse {
  id: string;
  salesInvoiceId: string;
  invoiceNumber: string | null;
  amount: string;
}

export interface ReceiptVoucherSummary {
  id: string;
  voucherNumber: string;
  voucherDate: string;
  status: VoucherStatus;
  branchId: string;
  branchNameAr: string;
  customerId: string;
  customerNameAr: string;
  treasuryAccountId: string;
  treasuryAccountCode: string;
  amount: string;
  reference: string | null;
  allocationCount: number;
  journalEntryId: string | null;
  createdAt: string;
}

export interface ReceiptVoucherDetail extends ReceiptVoucherSummary {
  memo: string | null;
  treasuryAccountNameAr: string;
  periodId: string | null;
  reversalJournalEntryId: string | null;
  postedBy: string | null;
  reversedBy: string | null;
  postedAt: string | null;
  reversedAt: string | null;
  updatedAt: string;
  allocations: ReceiptVoucherAllocationResponse[];
}
