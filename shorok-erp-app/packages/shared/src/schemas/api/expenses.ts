import { z } from "zod";
import { DecimalStringSchema, IsoDateSchema, UuidSchema } from "../primitives";

export const CreateExpenseRequestSchema = z.object({
  branchId: UuidSchema,
  expenseDate: IsoDateSchema,
  description: z.string().min(1).max(240),
  amount: DecimalStringSchema,
  paidFromAccount: z.string().min(1).max(120),
});
export type CreateExpenseRequest = z.infer<typeof CreateExpenseRequestSchema>;

export const UpdateExpenseRequestSchema = z.object({
  expenseDate: IsoDateSchema.optional(),
  description: z.string().min(1).max(240).optional(),
  amount: DecimalStringSchema.optional(),
  paidFromAccount: z.string().min(1).max(120).optional(),
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
