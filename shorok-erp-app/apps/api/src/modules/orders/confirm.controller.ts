import { Controller, HttpCode, Param, Post } from "@nestjs/common";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import {
  NotFoundError,
  PriceApprovalRequiredError,
} from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { InventoryEngine } from "../inventory/inventory.engine";
import { InventorySummaryBuilder } from "../inventory/inventory.summary";
import { OrderStatusMachine } from "./order-status-machine";
import { OrdersSummaryBuilder } from "./orders.summary";

@Controller("orders")
@Roles("OWNER", "BRANCH_MANAGER")
export class ConfirmController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: InventoryEngine,
    private readonly inventorySummary: InventorySummaryBuilder,
    private readonly orderSummary: OrdersSummaryBuilder,
  ) {}

  /**
   * Confirms the order — atomically:
   *   1. asserts the state-machine transition (DRAFT|PENDING_PRICE_APPROVAL → CONFIRMED)
   *   2. rejects with `price_approval_required` if pricing approval is missing
   *   3. calls InventoryEngine.apply (SALE) — this enforces the non-negative
   *      invariant and writes both the inventory_movement and an inventory
   *      audit row in the SAME transaction
   *   4. flips order status (CONFIRMED → PARTIALLY_COLLECTED → PAID
   *      depending on collected amount at confirm time)
   *   5. writes a `CONFIRM` audit row for the order itself.
   */
  @Post(":id/confirm")
  @HttpCode(200)
  async confirm(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      const order = await tx.customerOrder.findUnique({
        where: { id },
        include: { productVariant: { include: { sku: true } }, branch: true },
      });
      if (!order) throw new NotFoundError({ id });

      // 1. State machine: must be moving INTO CONFIRMED.
      OrderStatusMachine.assertTransition(order.status, "CONFIRMED");

      // 2. Pricing gate.
      if (order.priceOverrideStatus === "PENDING_APPROVAL") {
        throw new PriceApprovalRequiredError({ orderId: id });
      }

      // 3. Inventory deduction via the engine (locks branch+variant balance,
      //    enforces non-negative, writes movement + inventory audit row).
      const productLabelAr = `${order.productVariant.sku.colorNameAr} (${order.productVariant.sku.code} · ${order.productVariant.sizeMetersPerBoard.toString()} م)`;
      const productLabelEn = `${order.productVariant.sku.colorNameEn} (${order.productVariant.sku.code} · ${order.productVariant.sizeMetersPerBoard.toString()} m)`;
      const boards = order.boardsQuantity.toString();
      const meters = order.metersQuantity.toString();
      const inventorySummaries = await this.inventorySummary.build({
        movementType: "SALE",
        boardsDelta: `-${boards}`,
        metersDelta: `-${meters}`,
        actorName: user.name,
        productLabelAr,
        productLabelEn,
        branchNameAr: order.branch.nameAr,
        branchNameEn: order.branch.nameEn,
      });
      await this.engine.apply({
        branchId: order.branchId,
        productVariantId: order.productVariantId,
        movementType: "SALE",
        boardsDelta: `-${boards}`,
        reference: { type: "customer_order", id: order.id },
        actor: user,
        summaryAr: inventorySummaries.ar,
        summaryEn: inventorySummaries.en,
        tx,
      });

      // 4. Decide final status given the collected amount at confirm time.
      const finalStatus = OrderStatusMachine.classifyAfterCollection(
        order.requiredAmount.toString(),
        order.collectedAmount.toString(),
      );
      // If the chained transition (CONFIRMED → ...) is needed, assert it too.
      if (finalStatus !== "CONFIRMED") {
        OrderStatusMachine.assertTransition("CONFIRMED", finalStatus);
      }
      const updated = await tx.customerOrder.update({
        where: { id },
        data: { status: finalStatus },
        include: { collections: { orderBy: { collectedAt: "asc" } } },
      });

      // 5. Order-level CONFIRM audit row.
      const confirmSummaries = await this.orderSummary.build({
        key: "confirmed",
        actorName: user.name,
        customerName: order.customerName,
        branchNameAr: order.branch.nameAr,
        branchNameEn: order.branch.nameEn,
        extra: { required: order.requiredAmount.toString() },
      });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CONFIRM",
        entityType: "customer_order",
        entityId: id,
        beforeSnapshot: { status: order.status },
        afterSnapshot: { status: finalStatus },
        summaryAr: confirmSummaries.ar,
        summaryEn: confirmSummaries.en,
      });

      return updated;
    });
  }
}
