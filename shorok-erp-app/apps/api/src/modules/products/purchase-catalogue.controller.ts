import { Controller, Get } from "@nestjs/common";
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { PrismaService } from "../../prisma/prisma.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */

/**
 * What a purchase invoice may buy.
 *
 * The purchase picker used to be fed by `GET /products/variants`, which starts
 * from ProductVariant rows. That had two consequences neither of them intended:
 * a product with no sizes yet could not be shown at all — there was no row to
 * show — and a product with three sizes appeared three times.
 *
 * Buying is exactly where a product's first size enters the system, so this
 * answers from the base product instead: every active ProductSku once, with
 * whatever sizes it already has attached. A product with no sizes is a normal,
 * valid answer here, and the purchase line supplies the real size.
 *
 * Sales deliberately does NOT use this. Selling requires stock, which is a
 * different question answered by the sales availability endpoint.
 *
 * One query, no per-product follow-up.
 */
@Controller("products/purchase-catalogue")
export class PurchaseCatalogueController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const skus = await this.prisma.productSku.findMany({
      where: { active: true },
      select: {
        id: true,
        code: true,
        colorNameAr: true,
        colorNameEn: true,
        initialPurchasePricePerMeter: true,
        variants: {
          // Only sizes that may still be bought. A retired size is not offered,
          // and the purchase line refuses to revive one.
          where: { active: true },
          select: {
            id: true,
            sizeMetersPerBoard: true,
            defaultPurchasePricePerMeter: true,
          },
          orderBy: { sizeMetersPerBoard: "asc" },
        },
      },
      orderBy: { code: "asc" },
    });

    return {
      products: skus.map((s) => ({
        productSkuId: s.id,
        code: s.code,
        nameAr: s.colorNameAr,
        nameEn: s.colorNameEn,
        /** What a new size starts from; the invoice's own price still governs. */
        initialPurchasePricePerMeter: s.initialPurchasePricePerMeter?.toFixed(2) ?? null,
        variants: s.variants.map((v) => ({
          productVariantId: v.id,
          sizeMetersPerBoard: v.sizeMetersPerBoard.toFixed(4),
          defaultPurchasePricePerMeter: v.defaultPurchasePricePerMeter.toFixed(2),
        })),
      })),
      committedChanges: 0,
    };
  }
}
