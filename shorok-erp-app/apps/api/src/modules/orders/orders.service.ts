import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import type { CreateOrderRequest, PriceOverrideStatus } from "@shorok/shared";
import { Prisma, PrismaService } from "../../prisma/prisma.service";
import {
  CollectionExceedsRequiredError,
  ConflictError,
  NotFoundError,
} from "../../common/errors/api-errors";
import { AuditService } from "../audit/audit.service";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { OrdersSummaryBuilder } from "./orders.summary";

export interface PriceClassification {
  status: PriceOverrideStatus;
  /** Absolute deviation as a fixed-2 decimal-string percent (for display + audit only). */
  deviationPercent: string;
  defaultPricePerMeter: string;
  tolerancePercent: string;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly summary: OrdersSummaryBuilder,
  ) {}

  /**
   * Classify the entered sale price against the variant's default price and
   * tolerance. Returns the resolved tolerance, deviation, and intended
   * `priceOverrideStatus`. Pure function (no DB writes).
   */
  classifyPrice(
    salePricePerMeter: string,
    defaultPricePerMeter: string,
    variantTolerancePercent: string | null,
    systemDefaultTolerancePercent: string,
  ): PriceClassification {
    const sale = new Decimal(salePricePerMeter);
    const def = new Decimal(defaultPricePerMeter);
    const tolerance = new Decimal(variantTolerancePercent ?? systemDefaultTolerancePercent);

    const deviation = def.isZero()
      ? new Decimal(0)
      : sale.minus(def).abs().div(def).times(100);

    const status: PriceOverrideStatus = deviation.lte(tolerance)
      ? "WITHIN_TOLERANCE"
      : "PENDING_APPROVAL";

    return {
      status,
      deviationPercent: deviation.toFixed(2),
      defaultPricePerMeter: def.toFixed(2),
      tolerancePercent: tolerance.toFixed(2),
    };
  }

  async create(input: CreateOrderRequest, actor: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      const branch = await tx.branch.findUnique({ where: { id: input.branchId } });
      if (!branch) throw new NotFoundError({ branchId: input.branchId });

      const variant = await tx.productVariant.findUnique({
        where: { id: input.productVariantId },
        include: { sku: true },
      });
      if (!variant) {
        throw new NotFoundError({ productVariantId: input.productVariantId });
      }

      const settings = await tx.systemSettings.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1 },
      });

      const sale = new Decimal(input.salePricePerMeter);
      const boards = new Decimal(input.boardsQuantity);
      if (sale.lte(0)) {
        throw new ConflictError("errors.validation_failed", {
          field: "salePricePerMeter",
        });
      }
      if (boards.lte(0)) {
        throw new ConflictError("errors.validation_failed", { field: "boardsQuantity" });
      }

      const sizePerBoard = new Decimal(variant.sizeMetersPerBoard.toString());
      const meters = boards.times(sizePerBoard);
      const required = meters.times(sale);

      const classification = this.classifyPrice(
        input.salePricePerMeter,
        variant.defaultSalePricePerMeter.toString(),
        variant.priceOverrideTolerancePercent?.toString() ?? null,
        settings.defaultPriceOverrideTolerancePercent.toString(),
      );

      const status =
        classification.status === "WITHIN_TOLERANCE" ? "DRAFT" : "PENDING_PRICE_APPROVAL";

      // Initial collection (optional). Allowed against DRAFT orders per
      // data-model.md ("collections cannot exceed required for non-cancelled
      // orders") — DRAFT is non-cancelled. Status DOES NOT advance until
      // confirmation.
      const initialCollection = input.initialCollectionAmount
        ? new Decimal(input.initialCollectionAmount)
        : new Decimal(0);

      if (initialCollection.isNegative()) {
        throw new ConflictError("errors.validation_failed", {
          field: "initialCollectionAmount",
        });
      }
      if (initialCollection.gt(required)) {
        throw new CollectionExceedsRequiredError({
          required: required.toFixed(2),
          collected: initialCollection.toFixed(2),
        });
      }

      const orderId = (await tx.customerOrder.create({
        data: {
          branchId: input.branchId,
          orderDate: input.orderDate ? new Date(input.orderDate) : new Date(),
          customerName: input.customerName,
          productVariantId: input.productVariantId,
          boardsQuantity: boards.toFixed(4),
          metersQuantity: meters.toFixed(4),
          salePricePerMeter: sale.toFixed(2),
          priceOverrideStatus: classification.status,
          requiredAmount: required.toFixed(2),
          collectedAmount: initialCollection.toFixed(2),
          remainingAmount: required.minus(initialCollection).toFixed(2),
          receiverName: input.receiverName ?? null,
          status,
          createdBy: actor.id,
        },
      })).id;

      // Audit CREATE for the order
      const createSummary = await this.summary.build({
        key: "created",
        actorName: actor.name,
        customerName: input.customerName,
        branchNameAr: branch.nameAr,
        branchNameEn: branch.nameEn,
        extra: { required: required.toFixed(2) },
      });
      await this.audit.write({
        tx,
        actorId: actor.id,
        action: "CREATE",
        entityType: "customer_order",
        entityId: orderId,
        afterSnapshot: {
          status,
          priceOverrideStatus: classification.status,
          deviationPercent: classification.deviationPercent,
          requiredAmount: required.toFixed(2),
          collectedAmount: initialCollection.toFixed(2),
        },
        summaryAr: createSummary.ar,
        summaryEn: createSummary.en,
      });

      // If there's an initial collection, record the row + audit COLLECT.
      if (initialCollection.gt(0)) {
        await tx.orderCollection.create({
          data: {
            orderId,
            amount: initialCollection.toFixed(2),
            paidToAccount: null,
            createdBy: actor.id,
          },
        });
        const collectSummary = await this.summary.build({
          key: "collection_recorded",
          actorName: actor.name,
          customerName: input.customerName,
          branchNameAr: branch.nameAr,
          branchNameEn: branch.nameEn,
          extra: { amount: initialCollection.toFixed(2) },
        });
        await this.audit.write({
          tx,
          actorId: actor.id,
          action: "COLLECT",
          entityType: "customer_order",
          entityId: orderId,
          afterSnapshot: { amount: initialCollection.toFixed(2) },
          summaryAr: collectSummary.ar,
          summaryEn: collectSummary.en,
        });
      }

      return tx.customerOrder.findUniqueOrThrow({
        where: { id: orderId },
        include: { collections: true },
      });
    });
  }

  /** Re-fetch + serialize an order for an API response (consistent shape). */
  async readOrder(tx: Prisma.TransactionClient, orderId: string) {
    return tx.customerOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        collections: { orderBy: { collectedAt: "asc" } },
      },
    });
  }
}
