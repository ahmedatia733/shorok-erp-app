import { z } from "zod";

export const JournalLineSchema = z.object({
  accountId: z.string().uuid(),
  debit: z.string().regex(/^\d+(\.\d{1,2})?$/),
  credit: z.string().regex(/^\d+(\.\d{1,2})?$/),
  note: z.string().max(300).optional(),
  // Party is required by the server on AR_CONTROL (CUSTOMER) / AP_CONTROL (SUPPLIER) lines.
  partyType: z.enum(["CUSTOMER", "SUPPLIER"]).optional(),
  partyId: z.string().uuid().optional(),
  // Optional branch dimension carried onto the line (used by branch-filtered
  // statements). The GL column already exists; this exposes it on manual entry.
  branchId: z.string().uuid().optional().nullable(),
  // Optional sales-representative dimension — authoritative, per line. Separate
  // from partyType/partyId; null/omitted means no representative on this line.
  salesRepresentativeId: z.string().uuid().optional().nullable(),
});
export type JournalLine = z.infer<typeof JournalLineSchema>;

export const JOURNAL_ENTRY_TYPES = ["JOURNAL", "RECEIPT", "PAYMENT", "ADJUSTMENT", "OPENING"] as const;
export type JournalEntryType = (typeof JOURNAL_ENTRY_TYPES)[number];

export const CreateJournalEntryRequestSchema = z.object({
  entryType: z.enum(JOURNAL_ENTRY_TYPES).optional().default("JOURNAL"),
  reference: z.string().max(100).optional(),
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().min(1).max(500),
  referenceType: z.string().max(60).optional(),
  referenceId: z.string().uuid().optional(),
  lines: z.array(JournalLineSchema).min(2),
  // Warn-only negative-treasury policy: set on the confirmed retry.
  acknowledgeNegativeBalance: z.boolean().optional(),
  negativeBalanceReason: z.string().max(500).optional(),
  // Optional client idempotency key so a retry/double-submit posts once.
  idempotencyKey: z.string().min(8).max(120).optional(),
});
export type CreateJournalEntryRequest = z.infer<typeof CreateJournalEntryRequestSchema>;

export const JournalQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  accountId: z.string().uuid().optional(),
  cursor: z.string().uuid().optional().nullable(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type JournalQuery = z.infer<typeof JournalQuerySchema>;

export const IncomeStatementQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type IncomeStatementQuery = z.infer<typeof IncomeStatementQuerySchema>;
