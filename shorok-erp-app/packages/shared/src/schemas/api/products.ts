import { z } from "zod";
import { ProductCategoryEnum } from "../../enums";
import { DecimalStringSchema, UuidSchema } from "../primitives";

export const CreateSkuRequestSchema = z.object({
  // Trimmed before anything else looks at it, so " 900 " and "900" can never
  // become two products.
  code: z.string().trim().min(1).max(60),
  colorNameAr: z.string().trim().min(1).max(120),
  // Optional now: the Arabic name is what the business actually uses, and the
  // add-product form asks for one name. When it is omitted the Arabic name is
  // carried over, which keeps the existing NOT NULL column honest without
  // inventing a translation.
  colorNameEn: z.string().trim().min(1).max(120).optional(),
  category: ProductCategoryEnum.default("NORMAL"),
  /**
   * The starting purchase price per square metre. A display fallback until the
   * product has a confirmed purchase — never posted, never a WAC.
   */
  initialPurchasePricePerMeter: DecimalStringSchema.optional(),
  /**
   * The product's FIRST board size, supplied only when the product is being
   * created from inside a purchase invoice — an invoice line needs an exact
   * variant to post against, and a brand-new product has none.
   *
   * Omitted by the standalone product form, which manages base products only.
   * This is never a placeholder: there is no default size, no zero size, and
   * nothing is created unless the user actually typed one.
   */
  firstVariant: z
    .object({ sizeMetersPerBoard: DecimalStringSchema })
    .optional(),
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


// ── Product master (P12) ──────────────────────────────────────────────────

/** Where the price shown on the catalogue row came from. */
export const PurchasePriceSourceEnum = z.enum([
  "LAST_CONFIRMED_PURCHASE",
  "INITIAL_DEFAULT",
  "NONE",
]);
export type PurchasePriceSource = z.infer<typeof PurchasePriceSourceEnum>;

export const ProductCatalogueQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  active: z.enum(["true", "false", "all"]).default("true"),
});
export type ProductCatalogueQuery = z.infer<typeof ProductCatalogueQuerySchema>;

/** One BASE product. Sizes and variants deliberately absent — they belong to
 *  the purchase workflow, not to the product master. */
export interface ProductCatalogueRow {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  active: boolean;
  createdAt: string;
  /** Null when the product has neither a confirmed purchase nor a starting price. */
  purchasePrice: string | null;
  purchasePriceSource: PurchasePriceSource;
  /** How many exact sizes exist, for context only — never rendered as rows. */
  variantCount: number;
}

export interface ProductCatalogueResponse {
  products: ProductCatalogueRow[];
  total: number;
}
