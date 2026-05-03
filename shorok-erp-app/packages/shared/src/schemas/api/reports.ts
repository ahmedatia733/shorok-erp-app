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
