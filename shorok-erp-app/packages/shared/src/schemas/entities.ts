import { z } from "zod";
import {
  AuditActionEnum,
  MovementTypeEnum,
  OrderStatusEnum,
  PriceOverrideStatusEnum,
  ProductCategoryEnum,
  RoleEnum,
  UserStatusEnum,
} from "../enums";
import {
  DecimalStringSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  PhoneE164Schema,
  UuidSchema,
} from "./primitives";

/* ----------------------------- Branch ----------------------------- */

export const BranchSchema = z.object({
  id: UuidSchema,
  nameAr: z.string().min(1).max(120),
  nameEn: z.string().min(1).max(120),
  location: z.string().max(240).nullable(),
  active: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Branch = z.infer<typeof BranchSchema>;

/* ------------------------------ User ------------------------------ */

export const UserSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1).max(120),
  phone: PhoneE164Schema,
  email: z.string().email().max(160).nullable(),
  role: RoleEnum,
  status: UserStatusEnum,
  allowedBranches: z.array(UuidSchema),
  lastLoginAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type User = z.infer<typeof UserSchema>;

/* -------------------------- RefreshToken -------------------------- */

export const RefreshTokenSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  expiresAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  userAgent: z.string().max(240).nullable(),
});
export type RefreshToken = z.infer<typeof RefreshTokenSchema>;

/* --------------------------- ProductSku --------------------------- */

export const ProductSkuSchema = z.object({
  id: UuidSchema,
  code: z.string().min(1).max(60),
  colorNameAr: z.string().min(1).max(120),
  colorNameEn: z.string().min(1).max(120),
  category: ProductCategoryEnum,
  active: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ProductSku = z.infer<typeof ProductSkuSchema>;

/* ------------------------- ProductVariant ------------------------- */

export const ProductVariantSchema = z.object({
  id: UuidSchema,
  skuId: UuidSchema,
  sizeMetersPerBoard: DecimalStringSchema,
  defaultSalePricePerMeter: DecimalStringSchema,
  defaultPurchasePricePerMeter: DecimalStringSchema,
  priceOverrideTolerancePercent: DecimalStringSchema.nullable(),
  active: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ProductVariant = z.infer<typeof ProductVariantSchema>;

/* --------------------------- Supplier ----------------------------- */

export const SupplierSchema = z.object({
  id: UuidSchema,
  nameAr: z.string().min(1).max(160),
  nameEn: z.string().min(1).max(160),
  active: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Supplier = z.infer<typeof SupplierSchema>;

/* ------------------- BranchInventoryBalance ----------------------- */

export const BranchInventoryBalanceSchema = z.object({
  branchId: UuidSchema,
  productVariantId: UuidSchema,
  boardsOnHand: DecimalStringSchema,
  metersOnHand: DecimalStringSchema,
  lastCountedAt: IsoDateTimeSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
});
export type BranchInventoryBalance = z.infer<typeof BranchInventoryBalanceSchema>;

/* --------------------- InventoryMovement -------------------------- */

export const InventoryMovementSchema = z.object({
  id: UuidSchema,
  branchId: UuidSchema,
  productVariantId: UuidSchema,
  movementType: MovementTypeEnum,
  boardsQuantity: DecimalStringSchema,
  metersQuantity: DecimalStringSchema,
  referenceType: z.string().max(40).nullable(),
  referenceId: UuidSchema.nullable(),
  createdBy: UuidSchema,
  createdAt: IsoDateTimeSchema,
  humanReadableNote: z.string().nullable(),
});
export type InventoryMovement = z.infer<typeof InventoryMovementSchema>;

/* ------------------------ CustomerOrder --------------------------- */

export const CustomerOrderSchema = z.object({
  id: UuidSchema,
  branchId: UuidSchema,
  orderDate: IsoDateSchema,
  customerName: z.string().min(1).max(160),
  productVariantId: UuidSchema,
  boardsQuantity: DecimalStringSchema,
  metersQuantity: DecimalStringSchema,
  salePricePerMeter: DecimalStringSchema,
  priceOverrideStatus: PriceOverrideStatusEnum,
  priceApprovedByUserId: UuidSchema.nullable(),
  priceApprovedAt: IsoDateTimeSchema.nullable(),
  requiredAmount: DecimalStringSchema,
  collectedAmount: DecimalStringSchema,
  remainingAmount: DecimalStringSchema,
  receiverName: z.string().max(160).nullable(),
  status: OrderStatusEnum,
  createdBy: UuidSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type CustomerOrder = z.infer<typeof CustomerOrderSchema>;

/* ------------------------ OrderCollection ------------------------- */

export const OrderCollectionSchema = z.object({
  id: UuidSchema,
  orderId: UuidSchema,
  collectedAt: IsoDateTimeSchema,
  amount: DecimalStringSchema,
  paidToAccount: z.string().max(120).nullable(),
  createdBy: UuidSchema,
  createdAt: IsoDateTimeSchema,
});
export type OrderCollection = z.infer<typeof OrderCollectionSchema>;

/* ----------------------------- Expense ---------------------------- */

export const ExpenseSchema = z.object({
  id: UuidSchema,
  branchId: UuidSchema,
  expenseDate: IsoDateSchema,
  description: z.string().min(1).max(240),
  amount: DecimalStringSchema,
  paidFromAccount: z.string().min(1).max(120),
  createdBy: UuidSchema,
  createdAt: IsoDateTimeSchema,
});
export type Expense = z.infer<typeof ExpenseSchema>;

/* ----------------------- FactoryLedgerEntry ----------------------- */

export const FactoryLedgerEntrySchema = z.object({
  id: UuidSchema,
  supplierId: UuidSchema,
  orderDate: IsoDateSchema,
  productVariantId: UuidSchema.nullable(),
  boardsQuantity: DecimalStringSchema.nullable(),
  metersQuantity: DecimalStringSchema.nullable(),
  purchasePricePerMeter: DecimalStringSchema.nullable(),
  totalAmount: DecimalStringSchema,
  paidAmount: DecimalStringSchema,
  runningBalance: DecimalStringSchema,
  notes: z.string().nullable(),
  createdBy: UuidSchema,
  createdAt: IsoDateTimeSchema,
});
export type FactoryLedgerEntry = z.infer<typeof FactoryLedgerEntrySchema>;

/* ----------------------------- AuditLog --------------------------- */

export const AuditLogSchema = z.object({
  id: UuidSchema,
  actorId: UuidSchema.nullable(),
  action: AuditActionEnum,
  entityType: z.string().max(60),
  entityId: UuidSchema.nullable(),
  beforeSnapshot: z.record(z.unknown()).nullable(),
  afterSnapshot: z.record(z.unknown()).nullable(),
  humanReadableSummaryAr: z.string(),
  humanReadableSummaryEn: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type AuditLog = z.infer<typeof AuditLogSchema>;

/* -------------------------- SystemSettings ------------------------ */

export const SystemSettingsSchema = z.object({
  id: z.literal(1),
  defaultPriceOverrideTolerancePercent: DecimalStringSchema,
  lowStockThresholdBoards: DecimalStringSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type SystemSettings = z.infer<typeof SystemSettingsSchema>;
