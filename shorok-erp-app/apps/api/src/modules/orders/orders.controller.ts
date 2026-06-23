import { Body, Controller, Delete, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { Decimal } from "decimal.js";
import {
  CreateOrderRequestSchema,
  UpdateOrderRequestSchema,
  type CreateOrderRequest,
  type UpdateOrderRequest,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
} from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { OrdersService } from "./orders.service";
import { OrdersSummaryBuilder } from "./orders.summary";

@Controller("orders")
export class OrdersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
    private readonly summary: OrdersSummaryBuilder,
  ) {}

  @Post()
  @Roles("OWNER", "BRANCH_MANAGER")
  async create(
    @Body(new ZodValidationPipe(CreateOrderRequestSchema)) body: CreateOrderRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.create(body, user);
  }

  @Patch(":id")
  @Roles("OWNER", "BRANCH_MANAGER")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateOrderRequestSchema)) body: UpdateOrderRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const before = await tx.customerOrder.findUnique({
        where: { id },
        include: { productVariant: true },
      });
      if (!before) throw new NotFoundError({ id });
      // Branch scope is enforced by global guard — but the body can't change
      // branchId, so re-check via the loaded order.
      if (user.role !== "OWNER" && !user.allowedBranches.includes(before.branchId)) {
        throw new NotFoundError({ id });
      }
      // Per spec: PATCH only allowed while DRAFT. Once confirmed, immutable.
      if (before.status !== "DRAFT") {
        throw new InvalidStateTransitionError({ from: before.status, to: before.status });
      }

      // Recompute derived fields if any pricing-relevant field changed.
      const sale = new Decimal(body.salePricePerMeter ?? before.salePricePerMeter.toString());
      const boards = new Decimal(body.boardsQuantity ?? before.boardsQuantity.toString());
      if (sale.lte(0) || boards.lte(0)) {
        throw new ConflictError("errors.validation_failed");
      }

      const sizePerBoard = new Decimal(before.productVariant.sizeMetersPerBoard.toString());
      const meters = boards.times(sizePerBoard);
      const required = meters.times(sale);

      const settings = await tx.systemSettings.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1 },
      });
      const classification = this.orders.classifyPrice(
        sale.toFixed(2),
        before.productVariant.defaultSalePricePerMeter.toString(),
        before.productVariant.priceOverrideTolerancePercent?.toString() ?? null,
        settings.defaultPriceOverrideTolerancePercent.toString(),
      );

      const collected = new Decimal(before.collectedAmount.toString());
      if (collected.gt(required)) {
        throw new ConflictError("errors.collection_exceeds_required", {
          required: required.toFixed(2),
          collected: collected.toFixed(2),
        });
      }

      const after = await tx.customerOrder.update({
        where: { id },
        data: {
          ...(body.orderDate ? { orderDate: new Date(body.orderDate) } : {}),
          ...(body.customerName !== undefined ? { customerName: body.customerName } : {}),
          ...(body.productVariantId !== undefined
            ? { productVariantId: body.productVariantId }
            : {}),
          ...(body.boardsQuantity !== undefined
            ? { boardsQuantity: boards.toFixed(4), metersQuantity: meters.toFixed(4) }
            : {}),
          ...(body.salePricePerMeter !== undefined ? { salePricePerMeter: sale.toFixed(2) } : {}),
          ...(body.receiverName !== undefined ? { receiverName: body.receiverName ?? null } : {}),
          requiredAmount: required.toFixed(2),
          remainingAmount: required.minus(collected).toFixed(2),
          priceOverrideStatus: classification.status,
          // If price status flips, status flips too: WITHIN_TOLERANCE → DRAFT,
          // otherwise → PENDING_PRICE_APPROVAL. Order was DRAFT here.
          status: classification.status === "WITHIN_TOLERANCE" ? "DRAFT" : "PENDING_PRICE_APPROVAL",
          // Reset prior approval if the price changed and is again classifiable.
          priceApprovedByUserId: classification.status === "APPROVED" ? before.priceApprovedByUserId : null,
          priceApprovedAt: classification.status === "APPROVED" ? before.priceApprovedAt : null,
        },
        include: { collections: { orderBy: { collectedAt: "asc" } } },
      });

      const branch = await tx.branch.findUniqueOrThrow({ where: { id: before.branchId } });
      const summaries = await this.summary.build({
        key: "updated",
        actorName: user.name,
        customerName: after.customerName,
        branchNameAr: branch.nameAr,
        branchNameEn: branch.nameEn,
      });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "customer_order",
        entityId: id,
        beforeSnapshot: {
          requiredAmount: before.requiredAmount.toString(),
          status: before.status,
          priceOverrideStatus: before.priceOverrideStatus,
        },
        afterSnapshot: {
          requiredAmount: after.requiredAmount.toString(),
          status: after.status,
          priceOverrideStatus: after.priceOverrideStatus,
        },
        summaryAr: summaries.ar,
        summaryEn: summaries.en,
      });

      return after;
    });
  }

  /** DELETE /orders/:id — OWNER only: hard delete (cascade collections + inventory movements). */
  @Delete(":id")
  @Roles("OWNER")
  @HttpCode(204)
  async remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      const order = await tx.customerOrder.findUnique({
        where: { id },
        include: { productVariant: { include: { sku: true } } },
      });
      if (!order) throw new NotFoundError({ id });

      // Delete child collections (FK restrict, must go first).
      await tx.orderCollection.deleteMany({ where: { orderId: id } });

      // Remove any inventory movements tied to this order.
      await tx.inventoryMovement.deleteMany({
        where: { referenceId: id, referenceType: "sale_order" },
      });

      await tx.customerOrder.delete({ where: { id } });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "DELETE",
        entityType: "customer_order",
        entityId: id,
        beforeSnapshot: {
          customerName: order.customerName,
          status: order.status,
          requiredAmount: order.requiredAmount.toString(),
        },
        summaryAr: `${user.name} حذف طلب: ${order.customerName} — ${order.requiredAmount} ج.م`,
        summaryEn: `${user.name} deleted order: ${order.customerName} — ${order.requiredAmount} EGP`,
      });
    });
  }
}
