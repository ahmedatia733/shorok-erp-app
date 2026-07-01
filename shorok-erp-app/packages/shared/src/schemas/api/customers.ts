import { z } from "zod";

export const CreateCustomerRequestSchema = z.object({
  nameAr: z.string().min(1).max(200),
  phone: z.string().max(30).optional(),
});
export type CreateCustomerRequest = z.infer<typeof CreateCustomerRequestSchema>;

export const UpdateCustomerRequestSchema = z.object({
  nameAr: z.string().min(1).max(200).optional(),
  phone: z.string().max(30).optional().nullable(),
  active: z.boolean().optional(),
});
export type UpdateCustomerRequest = z.infer<typeof UpdateCustomerRequestSchema>;

export const CUSTOMER_TX_TYPES = ["INVOICE", "RECEIPT", "RETURN", "ADJUSTMENT", "OPENING"] as const;
export type CustomerTxType = (typeof CUSTOMER_TX_TYPES)[number];

export const CreateCustomerTransactionSchema = z.object({
  customerId: z.string().uuid(),
  type: z.enum(CUSTOMER_TX_TYPES),
  direction: z.enum(["DR", "CR"]),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reference: z.string().max(100).optional(),
  description: z.string().max(300).optional(),
  paymentAccountId: z.string().uuid().optional(),
});
export type CreateCustomerTransaction = z.infer<typeof CreateCustomerTransactionSchema>;

export const CustomerStatementQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});
export type CustomerStatementQuery = z.infer<typeof CustomerStatementQuerySchema>;
