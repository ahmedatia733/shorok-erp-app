import { z } from "zod";

export const RoleEnum = z.enum([
  "OWNER",
  "BRANCH_MANAGER",
  "WAREHOUSE",
  "ACCOUNTANT",
  "VIEWER",
]);
export type Role = z.infer<typeof RoleEnum>;

export const UserStatusEnum = z.enum(["ACTIVE", "DISABLED"]);
export type UserStatus = z.infer<typeof UserStatusEnum>;

export const ProductCategoryEnum = z.enum(["NORMAL", "SPECIAL"]);
export type ProductCategory = z.infer<typeof ProductCategoryEnum>;

export const MovementTypeEnum = z.enum([
  "RECEIPT",
  "SALE",
  "ADJUSTMENT",
  "COUNT_CORRECTION",
]);
export type MovementType = z.infer<typeof MovementTypeEnum>;

export const OrderStatusEnum = z.enum([
  "DRAFT",
  "PENDING_PRICE_APPROVAL",
  "CONFIRMED",
  "PARTIALLY_COLLECTED",
  "PAID",
  "CANCELLED",
]);
export type OrderStatus = z.infer<typeof OrderStatusEnum>;

export const PriceOverrideStatusEnum = z.enum([
  "WITHIN_TOLERANCE",
  "PENDING_APPROVAL",
  "APPROVED",
]);
export type PriceOverrideStatus = z.infer<typeof PriceOverrideStatusEnum>;

export const AuditActionEnum = z.enum([
  "CREATE",
  "UPDATE",
  "CONFIRM",
  "CANCEL",
  "APPROVE",
  "COLLECT",
  "IMPORT",
  "LOGIN",
  "LOGOUT",
]);
export type AuditAction = z.infer<typeof AuditActionEnum>;
