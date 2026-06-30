import { z } from "zod";

export const CreateFixedAssetSchema = z.object({
  code: z.string().min(1).max(20),
  nameAr: z.string().min(1).max(200),
  nameEn: z.string().max(200).optional().default(""),
  acquisitionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  acquisitionCost: z.string().regex(/^\d+(\.\d{1,2})?$/),
  salvageValue: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/)
    .optional()
    .default("0"),
  usefulLifeMonths: z.coerce.number().int().min(1),
  depreciationMethod: z.enum(["STRAIGHT_LINE"]).default("STRAIGHT_LINE"),
  assetAccountId: z.string().uuid(),
  accumulatedDepAccountId: z.string().uuid(),
  depreciationExpenseAccountId: z.string().uuid(),
  notes: z.string().max(500).optional(),
});
export type CreateFixedAsset = z.infer<typeof CreateFixedAssetSchema>;

export const UpdateFixedAssetSchema = z.object({
  nameAr: z.string().min(1).max(200).optional(),
  nameEn: z.string().max(200).optional(),
  notes: z.string().max(500).optional(),
  active: z.boolean().optional(),
});
export type UpdateFixedAsset = z.infer<typeof UpdateFixedAssetSchema>;

export const RunDepreciationSchema = z.object({
  periodDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  postJournalEntry: z.boolean().default(true),
  notes: z.string().max(300).optional(),
});
export type RunDepreciation = z.infer<typeof RunDepreciationSchema>;
