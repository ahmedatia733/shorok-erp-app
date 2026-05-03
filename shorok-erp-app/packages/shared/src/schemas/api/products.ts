import { z } from "zod";
import { ProductCategoryEnum } from "../../enums";
import { DecimalStringSchema, UuidSchema } from "../primitives";

export const CreateSkuRequestSchema = z.object({
  code: z.string().min(1).max(60),
  colorNameAr: z.string().min(1).max(120),
  colorNameEn: z.string().min(1).max(120),
  category: ProductCategoryEnum.default("NORMAL"),
});
export type CreateSkuRequest = z.infer<typeof CreateSkuRequestSchema>;

export const UpdateSkuRequestSchema = CreateSkuRequestSchema.partial().extend({
  active: z.boolean().optional(),
});
export type UpdateSkuRequest = z.infer<typeof UpdateSkuRequestSchema>;

export const CreateVariantRequestSchema = z.object({
  skuId: UuidSchema,
  sizeMetersPerBoard: DecimalStringSchema,
  defaultSalePricePerMeter: DecimalStringSchema,
  defaultPurchasePricePerMeter: DecimalStringSchema,
  priceOverrideTolerancePercent: DecimalStringSchema.nullable().optional(),
});
export type CreateVariantRequest = z.infer<typeof CreateVariantRequestSchema>;

export const UpdateVariantRequestSchema = CreateVariantRequestSchema.partial()
  .omit({ skuId: true })
  .extend({ active: z.boolean().optional() });
export type UpdateVariantRequest = z.infer<typeof UpdateVariantRequestSchema>;
