import { Controller, Get, Query } from "@nestjs/common";
import {
  BranchStockQuerySchema,
  BranchStockSizesQuerySchema,
  type BranchStockProductsResponse,
  type BranchStockQuery,
  type BranchStockSizesQuery,
  type BranchStockSizesResponse,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  BranchForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { PrismaService } from "../../prisma/prisma.service";
import { InventoryAvailabilityService } from "./inventory-availability.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */
import type { BranchSize } from "./inventory-availability.service";

/**
 * Re-reads the shared availability verdict as a *settlement* question.
 *
 * Transfers and settlements agree on the facts and differ on the conclusion. A
 * size holding nothing cannot be transferred out — there is nothing to send —
 * but it can absolutely be adjusted, because the whole point of a settlement is
 * to record stock the system does not yet know about. So "no stock" stays
 * selectable here and only loses its ability to go down, which the engine
 * enforces anyway by refusing to drive a balance negative.
 *
 * Two states genuinely block: a discontinued size, which must not quietly gain
 * stock, and a balance whose boards and metres contradict each other. The
 * second is not stubbornness — a whole-board adjustment moves boards and metres
 * together, so it can never bring a contradictory pair back into agreement. It
 * needs a data repair, and saying so is more useful than offering a control
 * that cannot fix it.
 */
function describeAdjustability(size: BranchSize): {
  hasStock: boolean;
  adjustable: boolean;
  blockedReason: string | null;
  blockedReasonAr: string | null;
} {
  const unblocked = { blockedReason: null, blockedReasonAr: null };

  if (size.verdict.enabled) return { hasStock: true, adjustable: true, ...unblocked };

  if (size.verdict.disabledReason === "VARIANT_INACTIVE") {
    return {
      hasStock: false,
      adjustable: false,
      blockedReason: "VARIANT_INACTIVE",
      blockedReasonAr: "هذا المقاس غير نشط ولا يقبل التعديل.",
    };
  }

  // Exactly zero on both sides is an empty size, not a broken one.
  if (size.boardsOnHand.isZero() && size.metersOnHand.isZero()) {
    return { hasStock: false, adjustable: true, ...unblocked };
  }

  // Anything else that failed is a balance that disagrees with itself, or one
  // that has gone negative. Either way it is a repair, not a settlement.
  return {
    hasStock: false,
    adjustable: false,
    blockedReason: "BALANCE_NEEDS_REVIEW",
    blockedReasonAr: "رصيد هذا المقاس يحتاج مراجعة قبل التعديل.",
  };
}

/**
 * What a branch is holding right now — the reads behind the stock-adjustment
 * pickers.
 *
 * Both answers come from `InventoryAvailabilityService`, the same service the
 * transfer pickers use, so «this product exists in this branch» has exactly one
 * meaning across the system.
 *
 * Strictly read-only: no adjustment, no movement, no balance change, no audit
 * business event, no sequence consumed. Adjusting stock remains the job of the
 * existing `POST /inventory/adjustments` engine, untouched by this file.
 *
 * Roles mirror the adjustment endpoint exactly — these reads exist to feed that
 * screen, so they must not be visible to anyone who could not use them.
 */
@Controller("inventory/branch-stock")
@Roles("OWNER", "BRANCH_MANAGER", "WAREHOUSE")
export class BranchStockController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: InventoryAvailabilityService,
  ) {}

  @Get("products")
  async products(
    @Query(new ZodValidationPipe(BranchStockQuerySchema)) query: BranchStockQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BranchStockProductsResponse> {
    const branch = await this.resolveBranch(query.branchId, user);
    return {
      branchId: branch.id,
      branchNameAr: branch.nameAr,
      products: await this.availability.productsInBranch(branch.id),
      committedChanges: 0,
    };
  }

  @Get("sizes")
  async sizes(
    @Query(new ZodValidationPipe(BranchStockSizesQuerySchema)) query: BranchStockSizesQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BranchStockSizesResponse> {
    const branch = await this.resolveBranch(query.branchId, user);
    const sku = await this.prisma.productSku.findUnique({
      where: { id: query.productSkuId },
      select: { id: true, code: true, colorNameAr: true, active: true },
    });
    if (!sku) throw new NotFoundError({ reason: "PRODUCT_NOT_FOUND", productSkuId: query.productSkuId });
    if (!sku.active) {
      throw new ValidationError({ reason: "PRODUCT_INACTIVE", messageAr: `الصنف «${sku.code}» غير نشط.` });
    }

    const sizes = await this.availability.sizesInBranch(branch.id, sku.id);
    return {
      branchId: branch.id,
      branchNameAr: branch.nameAr,
      productSkuId: sku.id,
      productCode: sku.code,
      productNameAr: sku.colorNameAr,
      sizes: sizes.map((s) => ({
        productVariantId: s.productVariantId,
        sizeBadge: s.display.badge,
        sizeBadgeAr: s.display.badgeAr,
        dimensionsLabelAr: s.display.dimensionsLabelAr,
        boardSizeMeters: s.display.boardSizeMeters,
        boardsOnHand: s.boardsOnHand.toFixed(4),
        metersOnHand: s.metersOnHand.toFixed(4),
        ...describeAdjustability(s),
      })),
      committedChanges: 0,
    };
  }

  /**
   * The global BranchScopeGuard does pick `branchId` out of the query string,
   * so it already refuses a foreign branch. This repeats the check rather than
   * relying on that, because the guard is a convention that could be reshaped
   * later and a stock read should not quietly widen if it is.
   */
  private async resolveBranch(branchId: string, user: AuthenticatedUser) {
    if (user.role !== "OWNER" && !user.allowedBranches.includes(branchId)) {
      throw new BranchForbiddenError({ reason: "UNAUTHORIZED_BRANCH_ACCESS", branchId });
    }
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true, nameAr: true, active: true },
    });
    if (!branch) throw new NotFoundError({ reason: "BRANCH_NOT_FOUND", branchId });
    if (!branch.active) {
      throw new ValidationError({ reason: "BRANCH_INACTIVE", messageAr: `المخزن «${branch.nameAr}» غير نشط.` });
    }
    return branch;
  }
}
