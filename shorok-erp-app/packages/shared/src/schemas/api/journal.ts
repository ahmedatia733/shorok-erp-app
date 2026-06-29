import { z } from "zod";

export const JournalLineSchema = z.object({
  accountId: z.string().uuid(),
  debit: z.string().regex(/^\d+(\.\d{1,2})?$/),
  credit: z.string().regex(/^\d+(\.\d{1,2})?$/),
  note: z.string().max(300).optional(),
});
export type JournalLine = z.infer<typeof JournalLineSchema>;

export const CreateJournalEntryRequestSchema = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().min(1).max(500),
  referenceType: z.string().max(60).optional(),
  referenceId: z.string().uuid().optional(),
  lines: z.array(JournalLineSchema).min(2),
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
