import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import { Decimal } from "decimal.js";
import {
  RecordCollectionRequestSchema,
  type OrderStatus,
  type RecordCollectionRequest,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  CollectionExceedsRequiredError,
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
} from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { OrderStatusMachine } from "./order-status-machine";
import { OrdersSummaryBuilder } from "./orders.summary";

@Controller("orders")
@Roles("OWNER", "BRANCH_MANAGER", "ACCOUNTANT")
export class CollectionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly summary: OrdersSummaryBuilder,
  ) {}

  /**
   * Records a collection on an order. Per `data-model.md`:
   *   - amount > 0 (refunds are produced ONLY by the cancel flow)
   *   - new collected_amount ≤ required_amount (otherwise 409)
   *   - cancelled orders reject collections
   *
   * Status transitions:
   *   - DRAFT / PENDING_PRICE_APPROVAL: collected sits as advance, status
   *     does NOT advance until /confirm
   *   - CONFIRMED: → PARTIALLY_COLLECTED (or PAID if collection covers it)
   *   - PARTIALLY_COLLECTED: → PAID if collection covers the remainder
   *   - CANCELLED / PAID: rejected as invalid_state_transition
   */
  @Post(":id/collections")
  @HttpCode(201)
  async record(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(RecordCollectionRequestSchema))
    body: RecordCollectionRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const order = await tx.customerOrder.findUnique({
        where: { id },
        include: { branch: true },
      });
      if (!order) throw new NotFoundError({ id });

      if (order.status === "CANCELLED" || order.status === "PAID") {
        throw new InvalidStateTransitionError({ from: order.status, to: order.status });
      }

      const amount = new Decimal(body.amount);
      if (amount.lte(0)) {
        throw new ConflictError("errors.validation_failed", {
          field: "amount",
          reason: "must_be_positive",
        });
      }

      const newCollected = new Decimal(order.collectedAmount.toString()).plus(amount);
      const required = new Decimal(order.requiredAmount.toString());
      if (newCollected.gt(required)) {
        throw new CollectionExceedsRequiredError({
          required: required.toFixed(2),
          attempted: newCollected.toFixed(2),
        });
      }

      // Insert collection row + recompute order amounts.
      await tx.orderCollection.create({
        data: {
          orderId: id,
          amount: amount.toFixed(2),
          paidToAccount: body.paidToAccount ?? null,
          createdBy: user.id,
        },
      });

      const remaining = required.minus(newCollected);
      const targetStatus = OrderStatusMachine.classifyAfterCollection(
        required.toFixed(2),
        newCollected.toFixed(2),
      );

      // Compute the next stored status:
      //  - DRAFT / PENDING_PRICE_APPROVAL → unchanged (advance payment)
      //  - CONFIRMED / PARTIALLY_COLLECTED → drive by classifier
      let nextStatus: OrderStatus = order.status;
      if (order.status === "CONFIRMED" || order.status === "PARTIALLY_COLLECTED") {
        if (targetStatus !== order.status) {
          OrderStatusMachine.assertTransition(order.status, targetStatus);
          nextStatus = targetStatus;
        }
      }

      const updated = await tx.customerOrder.update({
        where: { id },
        data: {
          collectedAmount: newCollected.toFixed(2),
          remainingAmount: remaining.toFixed(2),
          status: nextStatus,
        },
        include: { collections: { orderBy: { collectedAt: "asc" } } },
      });

      const summaries = await this.summary.build({
        key: "collection_recorded",
        actorName: user.name,
        customerName: order.customerName,
        branchNameAr: order.branch.nameAr,
        branchNameEn: order.branch.nameEn,
        extra: { amount: amount.toFixed(2) },
      });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "COLLECT",
        entityType: "customer_order",
        entityId: id,
        afterSnapshot: {
          amount: amount.toFixed(2),
          collectedAmount: newCollected.toFixed(2),
          remainingAmount: remaining.toFixed(2),
          status: nextStatus,
        },
        summaryAr: summaries.ar,
        summaryEn: summaries.en,
      });

      return updated;
    });
  }
}
