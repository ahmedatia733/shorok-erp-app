import { z } from "zod";

export const AccountCategoryEnum = z.enum([
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "REVENUE",
  "COST_OF_SALES",
  "EXPENSE",
]);
export type AccountCategory = z.infer<typeof AccountCategoryEnum>;

export const AccountTypeEnum = z.enum([
  "FIXED_ASSET",
  "CURRENT_ASSET",
  "LIABILITY",
  "EQUITY",
  "REVENUE",
  "COST_OF_SALES",
  "EXPENSE",
]);
export type AccountType = z.infer<typeof AccountTypeEnum>;

export const CreateAccountRequestSchema = z.object({
  code: z.string().min(1).max(20),
  nameAr: z.string().min(1).max(160),
  nameEn: z.string().min(1).max(160),
  category: AccountCategoryEnum,
  accountType: AccountTypeEnum,
  parentId: z.string().uuid().optional(),
});
export type CreateAccountRequest = z.infer<typeof CreateAccountRequestSchema>;

export const UpdateAccountRequestSchema = z.object({
  nameAr: z.string().min(1).max(160).optional(),
  nameEn: z.string().min(1).max(160).optional(),
  active: z.boolean().optional(),
});
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequestSchema>;

export const AccountBalanceQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});
export type AccountBalanceQuery = z.infer<typeof AccountBalanceQuerySchema>;
