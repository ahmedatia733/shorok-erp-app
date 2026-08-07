import { Controller, Get, Query } from "@nestjs/common";
import {
  ProductCatalogueQuerySchema,
  type ProductCatalogueQuery,
  type ProductCatalogueResponse,
  type ProductCatalogueRow,
  type PurchasePriceState,
} from "@shorok/shared";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { PrismaService } from "../../prisma/prisma.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */

interface CatalogueRow {
  id: string;
  code: string;
  color_name_ar: string;
  color_name_en: string | null;
  active: boolean;
  created_at: Date;
  initial_purchase_price_per_meter: string | null;
  latest_confirmed_price: string | null;
  variant_count: bigint;
  /** Purchase-eligible sizes = ACTIVE variants, the same set the purchase
   *  invoice selector offers. */
  eligible_count: bigint;
  distinct_default_prices: bigint;
  single_default_price: string | null;
}

/**
 * إدارة الأصناف — the base-product catalogue.
 *
 * One row per ProductSku, never one per size. A product with ك, ص and three
 * custom boards is still one product here; which of its sizes exists, and how
 * many boards of each, is the purchase and stock story told elsewhere.
 *
 * A separate read from `GET /products/skus` on purpose. That endpoint returns
 * raw model rows and several screens already depend on its shape; bolting a
 * derived price onto it would change what they receive. This one exists to
 * answer a different question and can be shaped for it.
 */
@Controller("products/catalogue")
export class ProductCatalogueController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles("OWNER", "ACCOUNTANT")
  async list(
    @Query(new ZodValidationPipe(ProductCatalogueQuerySchema)) query: ProductCatalogueQuery,
  ): Promise<ProductCatalogueResponse> {
    const search = query.q ? `%${query.q}%` : null;
    const activeFilter = query.active === "all" ? null : query.active === "true";

    /**
     * One query, not one per product.
     *
     * `DISTINCT ON (sku_id)` picks each product's most recent confirmed
     * purchase line in a single pass. Ordering is invoice date, then invoice
     * number, then line id — deterministic, so two products purchased on the
     * same day still resolve the same way every time.
     *
     * Only CONFIRMED invoices count: a cancelled purchase is not what the
     * product currently costs. Revisions need no special handling because a
     * revision rewrites its invoice in place and the invoice stays CONFIRMED,
     * so the rows read here are already the current ones.
     */
    const rows = await this.prisma.$queryRaw<CatalogueRow[]>`
      WITH latest_confirmed AS (
        SELECT DISTINCT ON (v.sku_id)
               v.sku_id,
               l.unit_price
        FROM purchase_invoice_lines l
        JOIN product_variants v   ON v.id = l.product_variant_id
        JOIN purchase_invoices pi ON pi.id = l.invoice_id
        WHERE pi.status::text = 'CONFIRMED'
        ORDER BY v.sku_id, pi.invoice_date DESC, pi.invoice_number DESC, l.id DESC
      ),
      -- Purchase-eligible sizes only: GET /products/variants filters on
      -- active = true, so that is exactly the set a new purchase can choose
      -- from, and exactly the set whose defaults define the product's default.
      eligible AS (
        SELECT sku_id,
               count(*)                                   AS eligible_count,
               count(DISTINCT default_purchase_price_per_meter) AS distinct_default_prices,
               min(default_purchase_price_per_meter)      AS one_price
        FROM product_variants
        WHERE active
        GROUP BY sku_id
      )
      SELECT s.id,
             s.code,
             s.color_name_ar,
             s.color_name_en,
             s.active,
             s.created_at,
             s.initial_purchase_price_per_meter::text AS initial_purchase_price_per_meter,
             lc.unit_price::text                      AS latest_confirmed_price,
             (SELECT count(*) FROM product_variants pv WHERE pv.sku_id = s.id) AS variant_count,
             coalesce(e.eligible_count, 0)            AS eligible_count,
             coalesce(e.distinct_default_prices, 0)   AS distinct_default_prices,
             e.one_price::text                        AS single_default_price
      FROM product_skus s
      LEFT JOIN latest_confirmed lc ON lc.sku_id = s.id
      LEFT JOIN eligible e          ON e.sku_id  = s.id
      WHERE (${activeFilter}::boolean IS NULL OR s.active = ${activeFilter}::boolean)
        AND (${search}::text IS NULL
             OR s.code ILIKE ${search}::text
             OR s.color_name_ar ILIKE ${search}::text
             OR s.color_name_en ILIKE ${search}::text)
      ORDER BY s.code ASC
    `;

    const products: ProductCatalogueRow[] = rows.map((r) => {
      const eligible = Number(r.eligible_count);
      const distinct = Number(r.distinct_default_prices);

      // The editable default describes what the NEXT purchase should start
      // from, so it comes from the sizes a purchase can actually choose — never
      // from what some past invoice happened to cost. A product whose sizes
      // disagree has no single answer, and saying "متعددة" is more honest than
      // picking one of them.
      let defaultPurchasePrice: string | null = null;
      let purchasePriceState: PurchasePriceState = "NONE";

      if (eligible > 0 && distinct === 1) {
        defaultPurchasePrice = r.single_default_price;
        purchasePriceState = "SINGLE";
      } else if (eligible > 0 && distinct > 1) {
        purchasePriceState = "MULTIPLE";
      } else if (r.initial_purchase_price_per_meter !== null) {
        // No size to ask yet, so the figure typed when the product was created
        // is the product's default.
        defaultPurchasePrice = r.initial_purchase_price_per_meter;
        purchasePriceState = "SINGLE";
      }

      return {
        id: r.id,
        code: r.code,
        nameAr: r.color_name_ar,
        nameEn: r.color_name_en,
        active: r.active,
        createdAt: r.created_at.toISOString(),
        defaultPurchasePrice,
        purchasePriceState,
        eligibleVariantCount: eligible,
        latestConfirmedPurchasePrice: r.latest_confirmed_price,
        variantCount: Number(r.variant_count),
      };
    });

    return { products, total: products.length };
  }
}
