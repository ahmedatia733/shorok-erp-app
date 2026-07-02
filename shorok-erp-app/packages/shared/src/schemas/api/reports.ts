import { z } from "zod";
import { DecimalStringSchema, UuidSchema } from "../primitives";

export const DashboardQuerySchema = z.object({
  branchId: UuidSchema.optional(),
});
export type DashboardQuery = z.infer<typeof DashboardQuerySchema>;

export const SupplierBalanceSchema = z.object({
  supplierId: UuidSchema,
  supplierNameAr: z.string(),
  supplierNameEn: z.string(),
  runningBalance: DecimalStringSchema,
});

export const LowStockEntrySchema = z.object({
  branchId: UuidSchema,
  productVariantId: UuidSchema,
  skuCode: z.string(),
  colorNameAr: z.string(),
  colorNameEn: z.string(),
  sizeMetersPerBoard: DecimalStringSchema,
  boardsOnHand: DecimalStringSchema,
});

export const DashboardResponseSchema = z.object({
  totalSales: DecimalStringSchema,
  collected: DecimalStringSchema,
  remaining: DecimalStringSchema,
  expensesTotal: DecimalStringSchema,
  stockBoardsTotal: DecimalStringSchema,
  stockMetersTotal: DecimalStringSchema,
  supplierBalances: z.array(SupplierBalanceSchema),
  lowStock: z.array(LowStockEntrySchema),
});
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;

export const TrialBalanceQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type TrialBalanceQuery = z.infer<typeof TrialBalanceQuerySchema>;

export const BalanceSheetQuerySchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type BalanceSheetQuery = z.infer<typeof BalanceSheetQuerySchema>;

export const AgingQuerySchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  type: z.enum(["AR", "AP"]).default("AR"),
});
export type AgingQuery = z.infer<typeof AgingQuerySchema>;

// Supplier Statement
export const SupplierStatementQuerySchema = z.object({
  supplierId: UuidSchema,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type SupplierStatementQuery = z.infer<typeof SupplierStatementQuerySchema>;

// Supplier Aging
export const SupplierAgingQuerySchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type SupplierAgingQuery = z.infer<typeof SupplierAgingQuerySchema>;

// Cash Flow
export const CashFlowQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type CashFlowQuery = z.infer<typeof CashFlowQuerySchema>;
