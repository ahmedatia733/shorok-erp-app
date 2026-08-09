import { z } from "zod";
import { UuidSchema, IsoDateSchema } from "../primitives";

/**
 * مردودات بدون فواتير — a return of goods sold before this ERP existed.
 *
 * The operator has the paper invoice in front of him, so every figure the
 * system cannot know is asked for rather than guessed: the paper's number and
 * date, and the price actually written on it. What the system DOES know — the
 * cost the goods carry back into stock — is taken at confirmation and never
 * typed by anyone.
 *
 * There is no `originalSalesInvoiceId` here, and there never will be. The paper
 * is a reference, not a relation.
 */

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, { message: "expected a money amount" });
const qty = z.string().regex(/^\d+(\.\d{1,4})?$/, { message: "expected a quantity" });
const pct = z.string().regex(/^\d+(\.\d{1,2})?$/).refine((v) => Number(v) <= 100, {
  message: "percentage cannot exceed 100",
});

export const LegacyReturnStatusEnum = z.enum(["DRAFT", "CONFIRMED", "CANCELLED"]);
export type LegacyReturnStatus = z.infer<typeof LegacyReturnStatusEnum>;

/**
 * One returned item.
 *
 * A line names the base product and the size actually returned, exactly as a
 * purchase line does, so goods can come back at a size this product has never
 * been recorded at before. Naming an existing variant outright is also allowed.
 */
export const LegacyReturnLineInputSchema = z
  .object({
    productVariantId: UuidSchema.optional(),
    productSkuId: UuidSchema.optional(),
    /** Metres per board — ك 5.25, ص 4.00, or a genuine custom board. */
    sizeMetersPerBoard: qty.optional(),
    /** Kept for display when the operator measured a custom board. */
    lengthM: qty.optional(),
    widthM: qty.optional(),
    /** Whole boards, as the returns architecture counts them. */
    returnedBoards: z
      .string()
      .regex(/^[1-9]\d{0,5}$/, { message: "whole boards only" }),
    /** Read off the paper invoice. Never inferred. */
    unitPricePerMeter: money,
    discountPct: pct.optional().default("0"),
    taxRate: pct.optional().default("0"),
    note: z.string().trim().max(300).optional(),
  })
  .refine((l) => Boolean(l.productVariantId) || Boolean(l.productSkuId && l.sizeMetersPerBoard), {
    message: "a line needs either productVariantId, or productSkuId with sizeMetersPerBoard",
  });
export type LegacyReturnLineInput = z.infer<typeof LegacyReturnLineInputSchema>;

export const CreateLegacyReturnSchema = z.object({
  customerId: UuidSchema,
  branchId: UuidSchema,
  paperInvoiceNumber: z.string().trim().min(1).max(120),
  paperInvoiceDate: IsoDateSchema,
  returnDate: IsoDateSchema,
  notes: z.string().trim().max(1000).optional(),
  lines: z.array(LegacyReturnLineInputSchema).min(1),
});
export type CreateLegacyReturn = z.infer<typeof CreateLegacyReturnSchema>;

/** A draft may be reshaped freely; a confirmed document may not be touched. */
export const UpdateLegacyReturnSchema = CreateLegacyReturnSchema.partial().extend({
  lines: z.array(LegacyReturnLineInputSchema).min(1).optional(),
});
export type UpdateLegacyReturn = z.infer<typeof UpdateLegacyReturnSchema>;

export const CancelLegacyReturnSchema = z.object({
  reason: z.string().trim().min(1).max(300),
});
export type CancelLegacyReturn = z.infer<typeof CancelLegacyReturnSchema>;

export const LegacyReturnQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  paperInvoiceNumber: z.string().trim().max(120).optional(),
  customerId: UuidSchema.optional(),
  branchId: UuidSchema.optional(),
  status: LegacyReturnStatusEnum.optional(),
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});
export type LegacyReturnQuery = z.infer<typeof LegacyReturnQuerySchema>;

// ── responses ──────────────────────────────────────────────────────────────

export interface LegacyReturnLineRow {
  id: string;
  productVariantId: string;
  productSkuId: string;
  productCode: string;
  productNameAr: string;
  sizeMetersPerBoard: string;
  sizeBadgeAr: string;
  lengthM: string | null;
  widthM: string | null;
  returnedBoards: string;
  returnedMeters: string;
  unitPricePerMeter: string;
  discountPct: string;
  taxRate: string;
  lineSubtotal: string;
  lineDiscount: string;
  lineNetExTax: string;
  lineTax: string;
  lineTotal: string;
  /** Null until confirmation — the cost is only known when the goods return. */
  costPerMeterSnapshot: string | null;
  lineCogs: string;
  note: string | null;
}

export interface LegacyReturnRow {
  id: string;
  returnNumber: string;
  status: LegacyReturnStatus;
  customerId: string;
  customerCode: string | null;
  customerNameAr: string;
  branchId: string;
  branchNameAr: string;
  paperInvoiceNumber: string;
  paperInvoiceDate: string;
  returnDate: string;
  lineCount: number;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  cogsTotal: string;
  createdByName: string;
  createdAt: string;
}

export interface LegacyReturnListResponse {
  rows: LegacyReturnRow[];
  totalCount: number;
  totalAmount: string;
  limit: number;
  offset: number;
}

export interface LegacyReturnDetail extends LegacyReturnRow {
  settlementMode: "KEEP_AS_CUSTOMER_CREDIT";
  notes: string | null;
  lines: LegacyReturnLineRow[];
  journalEntryId: string | null;
  journalEntryNumber: string | null;
  cogsJournalEntryId: string | null;
  cogsJournalEntryNumber: string | null;
  customerTransactionId: string | null;
  confirmedAt: string | null;
  confirmedByName: string | null;
  cancelledAt: string | null;
  cancelledByName: string | null;
  cancellationReason: string | null;
}
