import { Controller, HttpCode, Param, Post } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { NotFoundError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { OrdersService } from "./orders.service";
import { OrdersSummaryBuilder } from "./orders.summary";

@Controller("orders")
@Roles("OWNER")
export class PriceApprovalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
    private readonly summary: OrdersSummaryBuilder,
  ) {}

  /**
   * OWNER-only price-approval gate. Sets `priceOverrideStatus = APPROVED`
   * and stamps the approver. Does NOT confirm the order — confirmation is
   * a separate action so the operator can review the approval first. Order
   * status remains `PENDING_PRICE_APPROVAL` until `/confirm` is called.
   */
  @Post(":id/price-approval")
  @HttpCode(200)
  async approve(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      const order = await tx.customerOrder.findUnique({
        where: { id },
        include: { productVariant: true, branch: true },
      });
      if (!order) throw new NotFoundError({ id });

      const settings = await tx.systemSettings.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1 },
      });
      const classification = this.orders.classifyPrice(
        order.salePricePerMeter.toString(),
        order.productVariant.defaultSalePricePerMeter.toString(),
        order.productVariant.priceOverrideTolerancePercent?.toString() ?? null,
        settings.defaultPriceOverrideTolerancePercent.toString(),
      );

      const updated = await tx.customerOrder.update({
        where: { id },
        data: {
          priceOverrideStatus: "APPROVED",
          priceApprovedByUserId: user.id,
          priceApprovedAt: new Date(),
        },
        include: { collections: { orderBy: { collectedAt: "asc" } } },
      });

      const summaries = await this.summary.build({
        key: "price_approved",
        actorName: user.name,
        customerName: order.customerName,
        branchNameAr: order.branch.nameAr,
        branchNameEn: order.branch.nameEn,
        extra: { deviation: classification.deviationPercent },
      });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "APPROVE",
        entityType: "customer_order",
        entityId: id,
        beforeSnapshot: { priceOverrideStatus: order.priceOverrideStatus },
        afterSnapshot: { priceOverrideStatus: "APPROVED" },
        summaryAr: summaries.ar,
        summaryEn: summaries.en,
      });

      // Decimal sanity — shouldn't happen but suppress lint warning.
      void Decimal;

      return updated;
    });
  }
}
