import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { CancelOrderRequestSchema, type CancelOrderRequest } from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  ForbiddenError,
  NotFoundError,
} from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { InventoryEngine } from "../inventory/inventory.engine";
import { InventorySummaryBuilder } from "../inventory/inventory.summary";
import { OrderStatusMachine } from "./order-status-machine";
import { OrdersSummaryBuilder } from "./orders.summary";

@Controller("orders")
export class CancelController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: InventoryEngine,
    private readonly inventorySummary: InventorySummaryBuilder,
    private readonly orderSummary: OrdersSummaryBuilder,
  ) {}

  /**
   * Cancels an order. Per `endpoints.md`:
   *   - OWNER: any cancellable state
   *   - BRANCH_MANAGER: CONFIRMED only (post-collection cancellations are
   *     OWNER-only because they involve refunds)
   *
   * Cancellation atomically:
   *   - asserts the state-machine transition to CANCELLED
   *   - reverses inventory via InventoryEngine (positive boards delta to
   *     unwind the SALE that confirm posted)
   *   - appends a refund OrderCollection (negative amount) for the
   *     previously collected amount, so the ledger remains correct
   *   - flips status to CANCELLED
   *   - writes order-level CANCEL audit + collection-refund audit
   */
  @Post(":id/cancel")
  @HttpCode(200)
  @Roles("OWNER", "BRANCH_MANAGER")
  async cancel(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CancelOrderRequestSchema))
    body: CancelOrderRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const order = await tx.customerOrder.findUnique({
        where: { id },
        include: { productVariant: { include: { sku: true } }, branch: true },
      });
      if (!order) throw new NotFoundError({ id });

      // RBAC: BRANCH_MANAGER can only cancel CONFIRMED. OWNER bypasses.
      if (user.role !== "OWNER" && order.status !== "CONFIRMED") {
        throw new ForbiddenError({ reason: "owner_only_cancellation" });
      }

      // State machine catches DRAFT (which can't be cancelled per spec) and
      // CANCELLED (terminal). PENDING_PRICE_APPROVAL → CANCELLED is allowed
      // and skips the inventory reversal because no SALE was ever posted.
      OrderStatusMachine.assertTransition(order.status, "CANCELLED");

      const isPostConfirm =
        order.status === "CONFIRMED" ||
        order.status === "PARTIALLY_COLLECTED" ||
        order.status === "PAID";

      if (isPostConfirm) {
        // 1. Reverse inventory: positive boards delta returns the stock.
        const boards = order.boardsQuantity.toString();
        const meters = order.metersQuantity.toString();
        const productLabelAr = `${order.productVariant.sku.colorNameAr} (${order.productVariant.sku.code} · ${order.productVariant.sizeMetersPerBoard.toString()} م)`;
        const productLabelEn = `${order.productVariant.sku.colorNameEn} (${order.productVariant.sku.code} · ${order.productVariant.sizeMetersPerBoard.toString()} m)`;
        const inventorySummaries = await this.inventorySummary.build({
          movementType: "ADJUSTMENT",
          boardsDelta: boards,
          metersDelta: meters,
          actorName: user.name,
          productLabelAr,
          productLabelEn,
          branchNameAr: order.branch.nameAr,
          branchNameEn: order.branch.nameEn,
        });
        await this.engine.apply({
          branchId: order.branchId,
          productVariantId: order.productVariantId,
          movementType: "ADJUSTMENT",
          boardsDelta: boards,
          reference: { type: "customer_order_cancel", id: order.id },
          actor: user,
          summaryAr: inventorySummaries.ar,
          summaryEn: inventorySummaries.en,
          humanReadableNote: body.reason ?? null,
          tx,
        });

        // 2. Refund any previously-collected amount as a negative-amount
        //    OrderCollection row so the ledger nets to zero. The
        //    "collection cannot exceed required" check exempts cancelled
        //    orders, so a negative row is allowed once status is CANCELLED;
        //    we therefore append the refund row AFTER flipping status to
        //    CANCELLED below... but we want the collected_amount to be
        //    consistent BEFORE the row is appended. So we:
        //      a) update collectedAmount/remainingAmount on the order
        //      b) flip status to CANCELLED
        //      c) insert the negative OrderCollection row
        const collected = new Decimal(order.collectedAmount.toString());
        const required = new Decimal(order.requiredAmount.toString());
        if (collected.gt(0)) {
          // Net refund: collectedAmount drops to 0, remainingAmount stays
          // at required (the order is voided).
          await tx.customerOrder.update({
            where: { id },
            data: {
              collectedAmount: "0",
              remainingAmount: required.toFixed(2),
              status: "CANCELLED",
            },
          });
          await tx.orderCollection.create({
            data: {
              orderId: id,
              amount: collected.negated().toFixed(2),
              paidToAccount: null,
              createdBy: user.id,
            },
          });
          const refundSummaries = await this.orderSummary.build({
            key: "collection_refunded",
            actorName: user.name,
            customerName: order.customerName,
            branchNameAr: order.branch.nameAr,
            branchNameEn: order.branch.nameEn,
            extra: { amount: collected.toFixed(2) },
          });
          await this.audit.write({
            tx,
            actorId: user.id,
            action: "COLLECT",
            entityType: "customer_order",
            entityId: id,
            afterSnapshot: { refunded: collected.toFixed(2) },
            summaryAr: refundSummaries.ar,
            summaryEn: refundSummaries.en,
          });
        } else {
          await tx.customerOrder.update({
            where: { id },
            data: { status: "CANCELLED" },
          });
        }
      } else {
        // PENDING_PRICE_APPROVAL → CANCELLED: just flip status.
        await tx.customerOrder.update({
          where: { id },
          data: { status: "CANCELLED" },
        });
      }

      // Order-level CANCEL audit
      const cancelSummaries = await this.orderSummary.build({
        key: "cancelled",
        actorName: user.name,
        customerName: order.customerName,
        branchNameAr: order.branch.nameAr,
        branchNameEn: order.branch.nameEn,
      });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CANCEL",
        entityType: "customer_order",
        entityId: id,
        beforeSnapshot: { status: order.status },
        afterSnapshot: { status: "CANCELLED" },
        summaryAr: cancelSummaries.ar,
        summaryEn: cancelSummaries.en,
      });

      return tx.customerOrder.findUniqueOrThrow({
        where: { id },
        include: { collections: { orderBy: { collectedAt: "asc" } } },
      });
    });
  }
}
