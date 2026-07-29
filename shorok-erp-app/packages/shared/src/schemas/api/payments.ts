import { z } from "zod";
import { UuidSchema, IsoDateSchema } from "../primitives";

export const CreatePaymentSchema = z.object({
  entityType: z.enum(["SUPPLIER", "CUSTOMER"]),
  entityId: UuidSchema,
  paymentAccountId: UuidSchema,
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  paymentDate: IsoDateSchema,
  referenceNumber: z.string().max(100).optional(),
  notes: z.string().max(500).optional(),
});
export type CreatePayment = z.infer<typeof CreatePaymentSchema>;

export const CreateSupplierPaymentSchema = z.object({
  supplierId: UuidSchema,
  apAccountId: UuidSchema,
  bankAccountId: UuidSchema,
  // Additive treasury dimension: when treasuryId is given, the backend resolves
  // the GL account + branch from it; bankAccountId stays for legacy clients.
  treasuryId: UuidSchema.optional(),
  branchId: UuidSchema.optional(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  paymentDate: IsoDateSchema,
  reference: z.string().max(100).optional(),
  notes: z.string().max(500).optional(),
  acknowledgeNegativeBalance: z.boolean().optional(),
  negativeBalanceReason: z.string().max(500).optional(),
});
export type CreateSupplierPayment = z.infer<typeof CreateSupplierPaymentSchema>;

export const StatementQuerySchema = z.object({
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
});
export type StatementQuery = z.infer<typeof StatementQuerySchema>;
