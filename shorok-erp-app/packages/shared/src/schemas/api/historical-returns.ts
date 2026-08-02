import { z } from "zod";
import { DecimalStringSchema, IsoDateSchema, IsoDateTimeSchema, UuidSchema } from "../primitives";

/**
 * Historical sales-return archive (أرشيف مردودات المبيعات) — the six July 2026
 * paper returns, imported once as EVIDENCE, never as documents.
 *
 * Their customer effect is already inside the approved 2026-08-01 opening AR
 * balances and their stock effect is already inside the 2026-08-01 physical
 * count, so they must never post. There is deliberately no create/update/cancel
 * schema here: the archive is read-only forever.
 */

// ── list query ────────────────────────────────────────────────────────
// `from`/`to` bound the document date; `q` is free text over the source
// snapshots (customer name as written, product code as written, and the source
// reference), so a row can still be found when nothing resolved to a master row.
export const HistoricalSalesReturnQuerySchema = z.object({
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  customerId: UuidSchema.optional(),
  productVariantId: UuidSchema.optional(),
  q: z.string().trim().max(120).optional(),
  cursor: UuidSchema.optional().nullable(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type HistoricalSalesReturnQuery = z.infer<typeof HistoricalSalesReturnQuerySchema>;

// ── response shapes (serialized — Decimals + archiveNumber as strings) ─
// Money is 2dp, quantities are 4dp, exactly as the returns module serializes.

/** Present only when the source name resolved to exactly one customer. */
export const HistoricalSalesReturnCustomerRefSchema = z.object({
  id: UuidSchema,
  code: z.string(),
  nameAr: z.string(),
});
export type HistoricalSalesReturnCustomerRef = z.infer<typeof HistoricalSalesReturnCustomerRefSchema>;

/** Present only on an exact code + exact board-size match. */
export const HistoricalSalesReturnVariantRefSchema = z.object({
  id: UuidSchema,
  code: z.string(),
  colorNameAr: z.string(),
  sizeMetersPerBoard: DecimalStringSchema,
});
export type HistoricalSalesReturnVariantRef = z.infer<typeof HistoricalSalesReturnVariantRefSchema>;

export const HistoricalSalesReturnLineResponseSchema = z.object({
  id: UuidSchema,
  lineNumber: z.number().int(),
  productVariantId: UuidSchema.nullable(),
  productVariant: HistoricalSalesReturnVariantRefSchema.nullable(),
  /** What the paper said — always populated, even when the variant resolved. */
  productSourceCode: z.string(),
  boards: DecimalStringSchema,
  canonicalMeters: DecimalStringSchema,
  unitPrice: DecimalStringSchema.nullable(),
  lineValue: DecimalStringSchema,
  sourceReference: z.string(),
});
export type HistoricalSalesReturnLineResponse = z.infer<typeof HistoricalSalesReturnLineResponseSchema>;

export const HistoricalSalesReturnSummarySchema = z.object({
  id: UuidSchema,
  archiveNumber: z.string(),
  documentDate: IsoDateSchema,
  sourceReference: z.string(),
  customerId: UuidSchema.nullable(),
  customer: HistoricalSalesReturnCustomerRefSchema.nullable(),
  /** The customer name as written on the paper — the fallback when unresolved. */
  customerSourceReference: z.string(),
  originalInvoiceReference: z.string().nullable(),
  grossValue: DecimalStringSchema,
  totalBoards: DecimalStringSchema,
  totalCanonicalMeters: DecimalStringSchema,
  lineCount: z.number().int(),
  notes: z.string().nullable(),
  /** Always true — the row can never be edited, confirmed, cancelled or posted. */
  immutable: z.boolean(),
  importedAt: IsoDateTimeSchema,
});
export type HistoricalSalesReturnSummary = z.infer<typeof HistoricalSalesReturnSummarySchema>;

export const HistoricalSalesReturnDetailSchema = HistoricalSalesReturnSummarySchema.extend({
  sourceSystem: z.string(),
  sourceFileHash: z.string(),
  sourceSheet: z.string(),
  sourceRow: z.number().int(),
  importBatchId: UuidSchema,
  importedBy: UuidSchema,
  createdAt: IsoDateTimeSchema,
  lines: z.array(HistoricalSalesReturnLineResponseSchema),
});
export type HistoricalSalesReturnDetail = z.infer<typeof HistoricalSalesReturnDetailSchema>;

/** Totals span the whole filtered archive, not the current page. */
export const HistoricalSalesReturnTotalsSchema = z.object({
  count: z.number().int(),
  grossValue: DecimalStringSchema,
  boards: DecimalStringSchema,
  canonicalMeters: DecimalStringSchema,
});
export type HistoricalSalesReturnTotals = z.infer<typeof HistoricalSalesReturnTotalsSchema>;

export const HistoricalSalesReturnListResponseSchema = z.object({
  items: z.array(HistoricalSalesReturnSummarySchema),
  nextCursor: UuidSchema.nullable(),
  totals: HistoricalSalesReturnTotalsSchema,
});
export type HistoricalSalesReturnListResponse = z.infer<typeof HistoricalSalesReturnListResponseSchema>;
