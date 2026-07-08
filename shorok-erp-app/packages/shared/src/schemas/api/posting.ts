import { z } from "zod";
import { UuidSchema, IsoDateSchema, DecimalStringSchema } from "../primitives";

// ── Enums shared with Prisma (kept in sync with schema.prisma) ──────────────

export const JournalSourceTypeEnum = z.enum([
  "SALES_INVOICE",
  "PURCHASE_INVOICE",
  "SALES_RETURN",
  "PURCHASE_RETURN",
  "RECEIPT_VOUCHER",
  "PAYMENT_VOUCHER",
  "EXPENSE",
  "ADJUSTMENT",
  "DEPRECIATION",
  "OPENING",
  "MANUAL",
]);
export type JournalSourceType = z.infer<typeof JournalSourceTypeEnum>;

export const JournalPartyTypeEnum = z.enum(["CUSTOMER", "SUPPLIER"]);
export type JournalPartyType = z.infer<typeof JournalPartyTypeEnum>;

// ── PostingEngine request contract ──────────────────────────────────────────

/**
 * A single posting line. Exactly one of debit/credit must be > 0 (the engine
 * and a DB CHECK both enforce debit-XOR-credit). Party ref is required by the
 * engine only when the target account carries an AR/AP control system role.
 */
export const PostingLineSchema = z.object({
  accountId: UuidSchema,
  debit: DecimalStringSchema.default("0"),
  credit: DecimalStringSchema.default("0"),
  partyType: JournalPartyTypeEnum.optional(),
  partyId: UuidSchema.optional(),
  branchId: UuidSchema.optional(),
  note: z.string().max(300).optional(),
});
export type PostingLine = z.infer<typeof PostingLineSchema>;

export const PostingRequestSchema = z.object({
  sourceType: JournalSourceTypeEnum,
  sourceId: UuidSchema.optional(),
  entryDate: IsoDateSchema,
  entryType: z.string().max(30).default("JOURNAL"),
  reference: z.string().max(100).optional(),
  description: z.string().min(1).max(500),
  idempotencyKey: z.string().min(8).max(120),
  lines: z.array(PostingLineSchema).min(2),
});
export type PostingRequest = z.infer<typeof PostingRequestSchema>;

export const PostingResultSchema = z.object({
  journalEntryId: UuidSchema,
  entryNumber: z.number().int(),
  idempotent: z.boolean().default(false),
});
export type PostingResult = z.infer<typeof PostingResultSchema>;

// ── Reversal contract ───────────────────────────────────────────────────────

export const ReverseEntrySchema = z.object({
  reason: z.string().min(3).max(500),
  reversalDate: IsoDateSchema.optional(), // defaults to today in an OPEN period
});
export type ReverseEntry = z.infer<typeof ReverseEntrySchema>;
