import { z } from "zod";
import { DecimalStringSchema, IsoDateSchema, UuidSchema } from "../primitives";

// Phase 3C (backward-compatible): when posting accounts are resolvable the
// expense posts through the PostingEngine (Dr expense / [Dr VAT-in] / Cr
// treasury|AP). All new fields are optional; a legacy request with no accounts
// stays record-only (journalEntryId null). `glAccountId`/`paymentGlAccountId`
// remain the current-UI transitional fallback for the expense/treasury legs.
export const CreateExpenseRequestSchema = z.object({
  branchId: UuidSchema,
  expenseDate: IsoDateSchema,
  description: z.string().min(1).max(240),
  amount: DecimalStringSchema,
  paidFromAccount: z.string().min(1).max(120),
  glAccountId: UuidSchema.optional(),
  paymentGlAccountId: UuidSchema.optional(),
  expenseCategoryId: UuidSchema.optional(),
  supplierId: UuidSchema.optional(),
  taxable: z.boolean().optional(),
  taxRate: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  vatInputAccountId: UuidSchema.optional(),
  apAccountId: UuidSchema.optional(),
  acknowledgeNegativeBalance: z.boolean().optional(),
  negativeBalanceReason: z.string().max(500).optional(),
});
export type CreateExpenseRequest = z.infer<typeof CreateExpenseRequestSchema>;

export const UpdateExpenseRequestSchema = z.object({
  expenseDate: IsoDateSchema.optional(),
  description: z.string().min(1).max(240).optional(),
  amount: DecimalStringSchema.optional(),
  paidFromAccount: z.string().min(1).max(120).optional(),
  glAccountId: UuidSchema.optional().nullable(),
  paymentGlAccountId: UuidSchema.optional().nullable(),
});
export type UpdateExpenseRequest = z.infer<typeof UpdateExpenseRequestSchema>;

export const ExpensesQuerySchema = z.object({
  branchId: UuidSchema,
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  cursor: z.string().nullish(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ExpensesQuery = z.infer<typeof ExpensesQuerySchema>;
