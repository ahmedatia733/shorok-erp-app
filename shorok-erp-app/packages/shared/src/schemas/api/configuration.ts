import { z } from "zod";
import { UuidSchema, IsoDateSchema } from "../primitives";

// ── Financial periods ───────────────────────────────────────────────────────

export const FinancialPeriodStatusEnum = z.enum(["OPEN", "CLOSED"]);
export type FinancialPeriodStatus = z.infer<typeof FinancialPeriodStatusEnum>;

export const CreatePeriodSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
});
export type CreatePeriod = z.infer<typeof CreatePeriodSchema>;

export const ReopenPeriodSchema = z.object({
  reason: z.string().min(3).max(500),
});
export type ReopenPeriod = z.infer<typeof ReopenPeriodSchema>;

// ── Company profile ─────────────────────────────────────────────────────────

export const UpdateCompanyProfileSchema = z.object({
  nameAr: z.string().min(1).max(200),
  nameEn: z.string().min(1).max(200),
  logoUrl: z.string().max(2000).optional().nullable(),
  brandPrimaryColor: z.string().max(20).optional().nullable(),
  taxRegistrationNo: z.string().max(60).optional().nullable(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
  defaultLocale: z.enum(["ar", "en"]).default("ar"),
  printFooterAr: z.string().max(2000).optional().nullable(),
  printFooterEn: z.string().max(2000).optional().nullable(),
  printBrandingPolicy: z.enum(["CURRENT", "AS_POSTED"]).default("CURRENT"),
});
export type UpdateCompanyProfile = z.infer<typeof UpdateCompanyProfileSchema>;

// ── Posting profile (versioned) ─────────────────────────────────────────────

export const PostingProfileSlots = [
  "arAccountId",
  "apAccountId",
  "revenueAccountId",
  "cogsAccountId",
  "inventoryAccountId",
  "vatInputAccountId",
  "vatOutputAccountId",
  "discountAccountId",
  "roundingAccountId",
  "retainedEarningsAccountId",
  "openingEquityAccountId",
  "shrinkageAccountId",
] as const;

export const CreatePostingProfileSchema = z.object({
  effectiveFrom: IsoDateSchema,
  arAccountId: UuidSchema.optional().nullable(),
  apAccountId: UuidSchema.optional().nullable(),
  revenueAccountId: UuidSchema.optional().nullable(),
  cogsAccountId: UuidSchema.optional().nullable(),
  inventoryAccountId: UuidSchema.optional().nullable(),
  vatInputAccountId: UuidSchema.optional().nullable(),
  vatOutputAccountId: UuidSchema.optional().nullable(),
  discountAccountId: UuidSchema.optional().nullable(),
  roundingAccountId: UuidSchema.optional().nullable(),
  retainedEarningsAccountId: UuidSchema.optional().nullable(),
  openingEquityAccountId: UuidSchema.optional().nullable(),
  shrinkageAccountId: UuidSchema.optional().nullable(),
});
export type CreatePostingProfile = z.infer<typeof CreatePostingProfileSchema>;

// ── Tax profile (versioned) ─────────────────────────────────────────────────

export const CreateTaxProfileSchema = z.object({
  nameKey: z.string().min(1).max(100),
  rate: z.string().regex(/^\d+(\.\d{1,2})?$/), // e.g. "14.00"
  inputAccountId: UuidSchema.optional().nullable(),
  outputAccountId: UuidSchema.optional().nullable(),
  registrationStatus: z.enum(["REGISTERED", "NOT_REGISTERED"]).default("REGISTERED"),
  filingCycle: z.enum(["MONTHLY", "QUARTERLY"]).default("MONTHLY"),
  effectiveFrom: IsoDateSchema,
  active: z.boolean().default(true),
});
export type CreateTaxProfile = z.infer<typeof CreateTaxProfileSchema>;

// ── Expense categories ──────────────────────────────────────────────────────

export const CreateExpenseCategorySchema = z.object({
  nameAr: z.string().min(1).max(160),
  nameEn: z.string().min(1).max(160),
  accountId: UuidSchema,
  taxableDefault: z.boolean().default(false),
});
export type CreateExpenseCategory = z.infer<typeof CreateExpenseCategorySchema>;

export const UpdateExpenseCategorySchema = z.object({
  nameAr: z.string().min(1).max(160).optional(),
  nameEn: z.string().min(1).max(160).optional(),
  accountId: UuidSchema.optional(),
  taxableDefault: z.boolean().optional(),
  active: z.boolean().optional(),
});
export type UpdateExpenseCategory = z.infer<typeof UpdateExpenseCategorySchema>;
