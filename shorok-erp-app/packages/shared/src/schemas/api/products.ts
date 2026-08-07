import { z } from "zod";
import { ProductCategoryEnum } from "../../enums";
import { DecimalStringSchema, UuidSchema } from "../primitives";

/**
 * A purchase price, at the precision the column actually stores.
 *
 * `DecimalStringSchema` accepts any number of decimals, which would let
 * "1.234" through into a DECIMAL(14,2) column and be silently rounded to 1.23 —
 * a price the user never typed. Two places is the money precision everywhere
 * else in this system, so anything finer is rejected rather than quietly
 * altered. Zero and negatives are not prices.
 */
export const PurchasePriceSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, { message: "must be a price with at most 2 decimals" })
  .refine((v) => Number(v) > 0, { message: "must be greater than zero" });

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
  initialPurchasePricePerMeter: PurchasePriceSchema.optional(),
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

/**
 * Editing a product is NOT creating one, so this is written out rather than
 * derived from the create schema. Deriving it meant `firstVariant` — added for
 * the purchase-invoice quick add — silently became part of the update contract,
 * which would have let an edit create a board size.
 *
 * The purchase price is deliberately not a bare field. A product can have
 * different defaults per size, and "no value sent" must mean "leave the prices
 * alone", never "unify them to nothing". So changing a price is an explicit,
 * separate intent.
 */
export const UpdateSkuRequestSchema = z.object({
  code: z.string().trim().min(1).max(60).optional(),
  colorNameAr: z.string().trim().min(1).max(120).optional(),
  colorNameEn: z.string().trim().min(1).max(120).optional(),
  active: z.boolean().optional(),
  purchasePriceUpdate: z
    .object({
      apply: z.literal(true),
      value: PurchasePriceSchema,
    })
    .optional(),
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

/**
 * What the product's DEFAULT purchase price currently is — the figure future
 * purchases start from, not what a past invoice happened to cost.
 *
 * SINGLE   every purchase-eligible size agrees on one default (or the product
 *          has no sizes yet and falls back to the price typed at creation)
 * MULTIPLE the sizes disagree, so there is no single product-level answer and
 *          the screen must not invent one by picking a favourite
 * NONE     nothing has been set anywhere
 */
export const PurchasePriceStateEnum = z.enum(["SINGLE", "MULTIPLE", "NONE"]);
export type PurchasePriceState = z.infer<typeof PurchasePriceStateEnum>;

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
  /** The current default for FUTURE purchases. Null when MULTIPLE or NONE. */
  defaultPurchasePrice: string | null;
  purchasePriceState: PurchasePriceState;
  /** How many purchase-eligible sizes this product currently has. */
  eligibleVariantCount: number;
  /**
   * The most recent confirmed purchase, for reference only. It is history, not
   * the editable default, and the screen does not need it.
   */
  latestConfirmedPurchasePrice: string | null;
  /** How many exact sizes exist, for context only — never rendered as rows. */
  variantCount: number;
}

export interface ProductCatalogueResponse {
  products: ProductCatalogueRow[];
  total: number;
}
