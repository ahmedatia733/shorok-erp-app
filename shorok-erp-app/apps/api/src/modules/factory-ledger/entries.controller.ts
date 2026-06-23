import { Body, Controller, Delete, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { I18nService } from "nestjs-i18n";
import {
  CreateFactoryEntryRequestSchema,
  UpdateFactoryEntryRequestSchema,
  type CreateFactoryEntryRequest,
  type UpdateFactoryEntryRequest,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { FactoryLedgerRecompute } from "./recompute.sql";
import { serializeEntry } from "./serializer";

/**
 * T100 — POST /factory-ledger/entries
 *
 * Records a purchase row from a supplier. Required: supplier (active),
 * product variant (active), boards quantity, purchase price per meter.
 * Derived inside the same transaction: meters_quantity = boards * size,
 * total_amount = meters * price. paid_amount may be 0 (full credit).
 *
 * After insert, the supplier's running_balance column is recomputed for
 * every row of the supplier so a back-dated entry slots into the right
 * chronological position. Append-only — corrections are new rows.
 */
@Controller("factory-ledger")
export class FactoryLedgerEntriesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly recompute: FactoryLedgerRecompute,
    private readonly i18n: I18nService,
  ) {}

  @Post("entries")
  @Roles("OWNER", "ACCOUNTANT")
  async create(
    @Body(new ZodValidationPipe(CreateFactoryEntryRequestSchema))
    body: CreateFactoryEntryRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: body.supplierId },
    });
    if (!supplier) throw new NotFoundError({ supplierId: body.supplierId });
    if (!supplier.active) {
      throw new ValidationError({ reason: "supplier_inactive", supplierId: supplier.id });
    }

    const variant = await this.prisma.productVariant.findUnique({
      where: { id: body.productVariantId },
      include: { sku: true },
    });
    if (!variant || !variant.active) {
      throw new NotFoundError({ productVariantId: body.productVariantId });
    }

    // decimal.js considers 0 positive (no sign), so use .gt(0) for the
    // "strictly positive" predicates.
    const boards = new Decimal(body.boardsQuantity);
    if (!boards.gt(0)) {
      throw new ValidationError({ reason: "boards_must_be_positive" });
    }
    const pricePerMeter = new Decimal(body.purchasePricePerMeter);
    if (!pricePerMeter.gt(0)) {
      throw new ValidationError({ reason: "price_must_be_positive" });
    }
    const paidAmount = new Decimal(body.paidAmount);
    if (paidAmount.lt(0)) {
      throw new ValidationError({ reason: "paid_must_be_nonnegative" });
    }

    const sizePerBoard = new Decimal(variant.sizeMetersPerBoard.toString());
    const meters = boards.times(sizePerBoard);
    const totalAmount = meters.times(pricePerMeter);

    return this.prisma.runInTransaction(async (tx) => {
      const entry = await tx.factoryLedgerEntry.create({
        data: {
          supplierId: body.supplierId,
          orderDate: new Date(body.orderDate),
          productVariantId: body.productVariantId,
          boardsQuantity: boards.toFixed(4),
          metersQuantity: meters.toFixed(4),
          purchasePricePerMeter: pricePerMeter.toFixed(2),
          totalAmount: totalAmount.toFixed(2),
          paidAmount: paidAmount.toFixed(2),
          // running_balance is set by the recompute pass below; default 0 here.
          notes: body.notes ?? null,
          createdBy: user.id,
        },
      });

      await this.recompute.run(tx, body.supplierId);

      const argsCommon = {
        actor: user.name,
        boards: boards.toFixed(2),
        meters: meters.toFixed(2),
        total: totalAmount.toFixed(2),
        paid: paidAmount.toFixed(2),
      };
      const summaryAr = (await this.i18n.translate(
        "factory-ledger.summary.purchase_recorded",
        { lang: "ar", args: { ...argsCommon, supplier: supplier.nameAr } },
      )) as string;
      const summaryEn = (await this.i18n.translate(
        "factory-ledger.summary.purchase_recorded",
        { lang: "en", args: { ...argsCommon, supplier: supplier.nameEn } },
      )) as string;

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "factory_ledger_entry",
        entityId: entry.id,
        afterSnapshot: {
          supplierId: body.supplierId,
          orderDate: body.orderDate,
          productVariantId: body.productVariantId,
          boardsQuantity: boards.toFixed(4),
          metersQuantity: meters.toFixed(4),
          purchasePricePerMeter: pricePerMeter.toFixed(2),
          totalAmount: totalAmount.toFixed(2),
          paidAmount: paidAmount.toFixed(2),
          kind: "purchase",
        },
        summaryAr,
        summaryEn,
      });

      const refreshed = await tx.factoryLedgerEntry.findUniqueOrThrow({
        where: { id: entry.id },
      });
      return serializeEntry(refreshed);
    });
  }

  /** PATCH /factory-ledger/entries/:id — OWNER only: edit entry fields + recompute balance. */
  @Patch("entries/:id")
  @Roles("OWNER")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateFactoryEntryRequestSchema)) body: UpdateFactoryEntryRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const before = await tx.factoryLedgerEntry.findUnique({ where: { id } });
      if (!before) throw new NotFoundError({ id });

      let metersQuantity: string | undefined;
      let totalAmount: string | undefined;

      if (body.boardsQuantity !== undefined || body.productVariantId !== undefined) {
        const variantId = body.productVariantId ?? before.productVariantId;
        const variant = variantId
          ? await tx.productVariant.findUnique({ where: { id: variantId } })
          : null;
        const size = variant
          ? new Decimal(variant.sizeMetersPerBoard.toString())
          : new Decimal(0);
        const boards = new Decimal(body.boardsQuantity ?? before.boardsQuantity?.toString() ?? "0");
        const meters = boards.times(size);
        const price = new Decimal(
          body.purchasePricePerMeter ?? before.purchasePricePerMeter?.toString() ?? "0",
        );
        metersQuantity = meters.toFixed(4);
        totalAmount = meters.times(price).toFixed(2);
      } else if (body.purchasePricePerMeter !== undefined) {
        const meters = new Decimal(before.metersQuantity?.toString() ?? "0");
        totalAmount = meters.times(new Decimal(body.purchasePricePerMeter)).toFixed(2);
      }

      const after = await tx.factoryLedgerEntry.update({
        where: { id },
        data: {
          ...(body.orderDate ? { orderDate: new Date(body.orderDate) } : {}),
          ...(body.productVariantId !== undefined ? { productVariantId: body.productVariantId } : {}),
          ...(body.boardsQuantity !== undefined
            ? { boardsQuantity: new Decimal(body.boardsQuantity).toFixed(4) }
            : {}),
          ...(metersQuantity !== undefined ? { metersQuantity } : {}),
          ...(body.purchasePricePerMeter !== undefined
            ? { purchasePricePerMeter: new Decimal(body.purchasePricePerMeter).toFixed(2) }
            : {}),
          ...(totalAmount !== undefined ? { totalAmount } : {}),
          ...(body.paidAmount !== undefined
            ? { paidAmount: new Decimal(body.paidAmount).toFixed(2) }
            : {}),
          ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
        },
      });

      await this.recompute.run(tx, after.supplierId);

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "factory_ledger_entry",
        entityId: id,
        beforeSnapshot: {
          supplierId: before.supplierId,
          orderDate: before.orderDate,
          productVariantId: before.productVariantId,
          boardsQuantity: before.boardsQuantity?.toString() ?? null,
          metersQuantity: before.metersQuantity?.toString() ?? null,
          purchasePricePerMeter: before.purchasePricePerMeter?.toString() ?? null,
          totalAmount: before.totalAmount.toString(),
          paidAmount: before.paidAmount.toString(),
          notes: before.notes,
          createdBy: before.createdBy,
        },
        afterSnapshot: {
          orderDate: after.orderDate,
          productVariantId: after.productVariantId,
          boardsQuantity: after.boardsQuantity?.toString() ?? null,
          purchasePricePerMeter: after.purchasePricePerMeter?.toString() ?? null,
          totalAmount: after.totalAmount.toString(),
          paidAmount: after.paidAmount.toString(),
          notes: after.notes,
        },
        summaryAr: `${user.name} عدّل قيد مصنع: ${after.totalAmount} ج.م`,
        summaryEn: `${user.name} edited factory ledger entry: ${after.totalAmount} EGP`,
      });

      const refreshed = await tx.factoryLedgerEntry.findUniqueOrThrow({ where: { id } });
      return serializeEntry(refreshed);
    });
  }

  /** DELETE /factory-ledger/entries/:id — OWNER only: hard delete + recompute running balance. */
  @Delete("entries/:id")
  @Roles("OWNER")
  @HttpCode(204)
  async remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      const entry = await tx.factoryLedgerEntry.findUnique({ where: { id } });
      if (!entry) throw new NotFoundError({ id });

      await tx.factoryLedgerEntry.delete({ where: { id } });
      await this.recompute.run(tx, entry.supplierId);

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "DELETE",
        entityType: "factory_ledger_entry",
        entityId: id,
        beforeSnapshot: {
          supplierId: entry.supplierId,
          orderDate: entry.orderDate,
          productVariantId: entry.productVariantId,
          boardsQuantity: entry.boardsQuantity?.toString() ?? null,
          metersQuantity: entry.metersQuantity?.toString() ?? null,
          purchasePricePerMeter: entry.purchasePricePerMeter?.toString() ?? null,
          totalAmount: entry.totalAmount.toString(),
          paidAmount: entry.paidAmount.toString(),
          notes: entry.notes,
          createdBy: entry.createdBy,
        },
        summaryAr: `${user.name} حذف قيد مصنع: ${entry.totalAmount} ج.م`,
        summaryEn: `${user.name} deleted factory ledger entry: ${entry.totalAmount} EGP`,
      });
    });
  }
}
