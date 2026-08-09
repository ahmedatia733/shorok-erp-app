import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { BranchForbiddenError, NotFoundError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { PrismaService } from "../../prisma/prisma.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */

const QuerySchema = z.object({ branchId: z.string().uuid() });
type AvailabilityQuery = z.infer<typeof QuerySchema>;

/**
 * What a sales invoice may actually sell, from one branch.
 *
 * The sales picker used to offer every active variant in the catalogue, with no
 * regard for stock or branch. Nothing could be *sold* that way — confirming an
 * invoice runs the inventory engine, whose non-negative guard refuses to take
 * stock that is not there — but the refusal arrived at the end, after the whole
 * invoice had been typed.
 *
 * So this asks the same question the engine will ask, up front: which exact
 * variants does THIS branch actually hold. The rule is the engine's own — a
 * balance with boards and metres both above zero — not a looser one invented
 * for the dropdown.
 *
 * Buying is not the same question and does not come here: a product with no
 * stock is perfectly purchasable, which is how it gets stock.
 *
 * One set-based query. Availability is never asked per product.
 */
@Controller("sales-invoices/available-products")
export class SalesAvailabilityController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  async list(
    @Query(new ZodValidationPipe(QuerySchema)) query: AvailabilityQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // The global branch guard already inspects a parameter named `branchId`.
    // This repeats the check rather than relying on that, because a stock read
    // should not quietly widen if the guard is ever reshaped.
    if (user.role !== "OWNER" && !user.allowedBranches.includes(query.branchId)) {
      throw new BranchForbiddenError({ reason: "UNAUTHORIZED_BRANCH_ACCESS", branchId: query.branchId });
    }
    const branch = await this.prisma.branch.findUnique({
      where: { id: query.branchId },
      select: { id: true, nameAr: true },
    });
    if (!branch) throw new NotFoundError({ reason: "BRANCH_NOT_FOUND", branchId: query.branchId });

    const rows = await this.prisma.$queryRaw<
      Array<{
        variant_id: string;
        size: Prisma.Decimal;
        cost_per_meter: Prisma.Decimal;
        sku_id: string;
        code: string;
        name_ar: string;
        name_en: string;
        boards: Prisma.Decimal;
        meters: Prisma.Decimal;
      }>
    >(Prisma.sql`
      SELECT v.id            AS variant_id,
             v.size_meters_per_board       AS size,
             v.default_purchase_price_per_meter AS cost_per_meter,
             s.id            AS sku_id,
             s.code          AS code,
             s.color_name_ar AS name_ar,
             s.color_name_en AS name_en,
             b.boards_on_hand AS boards,
             b.meters_on_hand AS meters
        FROM branch_inventory_balances b
        JOIN product_variants v ON v.id = b.product_variant_id
        JOIN product_skus    s ON s.id = v.sku_id
       WHERE b.branch_id = ${query.branchId}::uuid
         AND v.active
         AND s.active
         AND b.boards_on_hand > 0
         AND b.meters_on_hand > 0
       ORDER BY s.code ASC, v.size_meters_per_board ASC
    `);

    return {
      branchId: branch.id,
      branchNameAr: branch.nameAr,
      variants: rows.map((r) => ({
        id: r.variant_id,
        skuId: r.sku_id,
        skuCode: r.code,
        skuNameAr: r.name_ar,
        skuNameEn: r.name_en,
        sizeMetersPerBoard: r.size.toFixed(4),
        /** The per-metre cost the sales form auto-loads; the sale price is manual. */
        defaultPurchasePricePerMeter: r.cost_per_meter.toFixed(2),
        boardsOnHand: r.boards.toFixed(4),
        metersOnHand: r.meters.toFixed(4),
      })),
      committedChanges: 0,
    };
  }
}
