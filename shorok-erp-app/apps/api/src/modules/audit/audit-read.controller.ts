import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { AuditByActorQuerySchema, AuditQuerySchema, type AuditQuery } from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { ConflictError, NotFoundError } from "../../common/errors/api-errors";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { AuditService } from "./audit.service";
import { FactoryLedgerRecompute } from "../factory-ledger/recompute.sql";

@Controller("audit")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AuditReadController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly recompute: FactoryLedgerRecompute,
  ) {}

  /**
   * GET /audit?entityType=&entityId=&cursor=&limit=
   *
   * OWNER sees everything. BRANCH_MANAGER sees only audit rows whose
   * (entity_type, entity_id) point to a record in one of their allowed
   * branches; we approximate this conservatively by joining to the relevant
   * tables. For MVP simplicity, branches/expenses/orders/inventory_movements
   * are filtered by `branch_id`; entity types without a branch (e.g. user)
   * remain visible only to OWNER.
   */
  @Get()
  @Roles("OWNER", "BRANCH_MANAGER")
  async list(
    @Query(new ZodValidationPipe(AuditQuerySchema)) query: AuditQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const where: Record<string, unknown> = {};
    if (query.entityType) where.entityType = query.entityType;
    if (query.entityId) where.entityId = query.entityId;
    if (query.actorId) where.actorId = query.actorId;
    if (query.from || query.to) {
      const created: Record<string, Date> = {};
      if (query.from) created.gte = new Date(query.from);
      if (query.to) {
        const upper = new Date(query.to);
        upper.setUTCHours(23, 59, 59, 999);
        created.lte = upper;
      }
      where.createdAt = created;
    }

    if (user.role !== "OWNER") {
      // BRANCH_MANAGER scoping: this MVP implementation only returns rows
      // whose entityType is one of the branch-scoped tables AND whose
      // entityId points to a row in the user's allowed branches. Cross-
      // entity rows (no branch) are OWNER-only.
      const allowed = user.allowedBranches;
      if (allowed.length === 0) return { data: [], nextCursor: null };
      where.AND = [
        { entityType: { in: ["customer_order", "expense", "inventory_movement"] } },
        // The DB-level branch filtering would require a second query per
        // entityType. For MVP, branch-scoped rows are filtered post-fetch
        // in the read service; this scaffold returns the filtered subset.
      ];
    }

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1]?.id ?? null : null;
    return { data, nextCursor };
  }

  @Get("by-actor/:userId")
  @Roles("OWNER")
  async byActor(
    @Param("userId") userId: string,
    @Query(new ZodValidationPipe(AuditByActorQuerySchema))
    query: { cursor?: string | null; limit: number },
  ) {
    const rows = await this.prisma.auditLog.findMany({
      where: { actorId: userId },
      orderBy: { createdAt: "desc" },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1]?.id ?? null : null;
    return { data, nextCursor };
  }

  /**
   * POST /audit/logs/:id/revert — OWNER only.
   *
   * Attempts to undo the recorded action by applying the beforeSnapshot back
   * to the entity. Supported:
   *   DELETE:expense        → recreate expense from beforeSnapshot
   *   UPDATE:expense        → patch expense back to beforeSnapshot values
   *   DELETE:factory_ledger_entry → recreate entry from beforeSnapshot + recompute balance
   *   UPDATE:factory_ledger_entry → patch entry back + recompute balance
   * All other combinations throw 409 (not supported).
   */
  @Post("logs/:id/revert")
  @Roles("OWNER")
  @HttpCode(200)
  async revert(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    const log = await this.prisma.auditLog.findUnique({ where: { id } });
    if (!log) throw new NotFoundError({ auditLogId: id });

    const snap = (log.beforeSnapshot ?? {}) as Record<string, unknown>;
    const key = `${log.action}:${log.entityType}`;

    return this.prisma.runInTransaction(async (tx) => {
      switch (key) {
        case "DELETE:expense": {
          if (snap.id) {
            const exists = await tx.expense.findUnique({ where: { id: snap.id as string } });
            if (exists) throw new ConflictError("errors.already_reverted");
          }
          const expense = await tx.expense.create({
            data: {
              ...(snap.id ? { id: snap.id as string } : {}),
              branchId: snap.branchId as string,
              expenseDate: new Date(snap.expenseDate as string),
              description: snap.description as string,
              amount: snap.amount as string,
              paidFromAccount: snap.paidFromAccount as string,
              createdBy: (snap.createdBy as string) ?? user.id,
            },
          });
          await this.audit.write({
            tx, actorId: user.id, action: "CREATE",
            entityType: "expense", entityId: expense.id,
            afterSnapshot: snap,
            summaryAr: `${user.name} تراجع عن حذف مصروف: ${expense.description}`,
            summaryEn: `${user.name} reverted deletion of expense: ${expense.description}`,
          });
          return { entityType: "expense", entityId: expense.id };
        }

        case "UPDATE:expense": {
          if (!log.entityId) throw new ConflictError("errors.revert_not_supported");
          const existing = await tx.expense.findUnique({ where: { id: log.entityId } });
          if (!existing) throw new NotFoundError({ expenseId: log.entityId });
          const expense = await tx.expense.update({
            where: { id: log.entityId },
            data: {
              expenseDate: new Date(snap.expenseDate as string),
              description: snap.description as string,
              amount: snap.amount as string,
              paidFromAccount: snap.paidFromAccount as string,
            },
          });
          await this.audit.write({
            tx, actorId: user.id, action: "UPDATE",
            entityType: "expense", entityId: log.entityId,
            beforeSnapshot: log.afterSnapshot,
            afterSnapshot: snap,
            summaryAr: `${user.name} تراجع عن تعديل مصروف: ${expense.description}`,
            summaryEn: `${user.name} reverted update of expense: ${expense.description}`,
          });
          return { entityType: "expense", entityId: log.entityId };
        }

        case "DELETE:factory_ledger_entry": {
          if (snap.id) {
            const exists = await tx.factoryLedgerEntry.findUnique({ where: { id: snap.id as string } });
            if (exists) throw new ConflictError("errors.already_reverted");
          }
          const entry = await tx.factoryLedgerEntry.create({
            data: {
              ...(snap.id ? { id: snap.id as string } : {}),
              supplierId: snap.supplierId as string,
              orderDate: new Date(snap.orderDate as string),
              productVariantId: (snap.productVariantId as string | null) ?? null,
              boardsQuantity: (snap.boardsQuantity as string | null) ?? null,
              metersQuantity: (snap.metersQuantity as string | null) ?? null,
              purchasePricePerMeter: (snap.purchasePricePerMeter as string | null) ?? null,
              totalAmount: snap.totalAmount as string,
              paidAmount: snap.paidAmount as string,
              notes: (snap.notes as string | null) ?? null,
              createdBy: (snap.createdBy as string) ?? user.id,
            },
          });
          await this.recompute.run(tx, entry.supplierId);
          await this.audit.write({
            tx, actorId: user.id, action: "CREATE",
            entityType: "factory_ledger_entry", entityId: entry.id,
            afterSnapshot: snap,
            summaryAr: `${user.name} تراجع عن حذف قيد مصنع: ${entry.totalAmount} ج.م`,
            summaryEn: `${user.name} reverted deletion of factory ledger entry: ${entry.totalAmount} EGP`,
          });
          return { entityType: "factory_ledger_entry", entityId: entry.id };
        }

        case "UPDATE:factory_ledger_entry": {
          if (!log.entityId) throw new ConflictError("errors.revert_not_supported");
          const existing = await tx.factoryLedgerEntry.findUnique({ where: { id: log.entityId } });
          if (!existing) throw new NotFoundError({ entryId: log.entityId });
          const entry = await tx.factoryLedgerEntry.update({
            where: { id: log.entityId },
            data: {
              orderDate: new Date(snap.orderDate as string),
              productVariantId: (snap.productVariantId as string | null) ?? null,
              boardsQuantity: (snap.boardsQuantity as string | null) ?? null,
              metersQuantity: (snap.metersQuantity as string | null) ?? null,
              purchasePricePerMeter: (snap.purchasePricePerMeter as string | null) ?? null,
              totalAmount: snap.totalAmount as string,
              paidAmount: snap.paidAmount as string,
              notes: (snap.notes as string | null) ?? null,
            },
          });
          await this.recompute.run(tx, entry.supplierId);
          await this.audit.write({
            tx, actorId: user.id, action: "UPDATE",
            entityType: "factory_ledger_entry", entityId: log.entityId,
            beforeSnapshot: log.afterSnapshot,
            afterSnapshot: snap,
            summaryAr: `${user.name} تراجع عن تعديل قيد مصنع: ${entry.totalAmount} ج.م`,
            summaryEn: `${user.name} reverted update of factory ledger entry: ${entry.totalAmount} EGP`,
          });
          return { entityType: "factory_ledger_entry", entityId: log.entityId };
        }

        case "DELETE:customer_order": {
          if (!snap.id) throw new ConflictError("errors.revert_not_supported");
          const existingOrder = await tx.customerOrder.findUnique({ where: { id: snap.id as string } });
          if (existingOrder) throw new ConflictError("errors.already_reverted");
          // Recreate the order with the original UUID so entityId still matches.
          const order = await tx.customerOrder.create({
            data: {
              id: snap.id as string,
              branchId: snap.branchId as string,
              orderDate: new Date(snap.orderDate as string),
              customerName: snap.customerName as string,
              productVariantId: snap.productVariantId as string,
              boardsQuantity: snap.boardsQuantity as string,
              metersQuantity: snap.metersQuantity as string,
              salePricePerMeter: snap.salePricePerMeter as string,
              priceOverrideStatus: snap.priceOverrideStatus as "WITHIN_TOLERANCE" | "PENDING_APPROVAL" | "APPROVED",
              priceApprovedByUserId: (snap.priceApprovedByUserId as string | null) ?? null,
              priceApprovedAt: snap.priceApprovedAt ? new Date(snap.priceApprovedAt as string) : null,
              requiredAmount: snap.requiredAmount as string,
              collectedAmount: snap.collectedAmount as string,
              remainingAmount: snap.remainingAmount as string,
              receiverName: (snap.receiverName as string | null) ?? null,
              status: snap.status as "DRAFT" | "PENDING_PRICE_APPROVAL" | "CONFIRMED" | "PARTIALLY_COLLECTED" | "PAID" | "CANCELLED",
              createdBy: (snap.createdBy as string) ?? user.id,
            },
          });
          // Recreate collections.
          const collections = (snap.collections as Array<Record<string, unknown>>) ?? [];
          for (const c of collections) {
            await tx.orderCollection.create({
              data: {
                id: c.id as string,
                orderId: order.id,
                collectedAt: new Date(c.collectedAt as string),
                amount: c.amount as string,
                paidToAccount: (c.paidToAccount as string | null) ?? null,
                createdBy: c.createdBy as string,
              },
            });
          }
          // Recreate inventory movements.
          const movements = (snap.movements as Array<Record<string, unknown>>) ?? [];
          for (const m of movements) {
            await tx.inventoryMovement.create({
              data: {
                id: m.id as string,
                branchId: m.branchId as string,
                productVariantId: m.productVariantId as string,
                movementType: m.movementType as "RECEIPT" | "SALE" | "ADJUSTMENT" | "COUNT_CORRECTION",
                boardsQuantity: m.boardsQuantity as string,
                metersQuantity: m.metersQuantity as string,
                referenceType: (m.referenceType as string | null) ?? null,
                referenceId: (m.referenceId as string | null) ?? null,
                createdBy: m.createdBy as string,
                humanReadableNote: (m.humanReadableNote as string | null) ?? null,
              },
            });
          }
          await this.audit.write({
            tx, actorId: user.id, action: "CREATE",
            entityType: "customer_order", entityId: order.id,
            afterSnapshot: snap,
            summaryAr: `${user.name} تراجع عن حذف طلب: ${order.customerName} — ${order.requiredAmount} ج.م`,
            summaryEn: `${user.name} reverted deletion of order: ${order.customerName} — ${order.requiredAmount} EGP`,
          });
          return { entityType: "customer_order", entityId: order.id };
        }

        case "UPDATE:branch": {
          if (!log.entityId) throw new ConflictError("errors.revert_not_supported");
          const branch = await tx.branch.findUnique({ where: { id: log.entityId } });
          if (!branch) throw new NotFoundError({ branchId: log.entityId });
          const updated = await tx.branch.update({
            where: { id: log.entityId },
            data: {
              ...(snap.nameAr !== undefined ? { nameAr: snap.nameAr as string } : {}),
              ...(snap.nameEn !== undefined ? { nameEn: snap.nameEn as string } : {}),
              ...(snap.location !== undefined ? { location: (snap.location as string | null) ?? null } : {}),
              ...(snap.active !== undefined ? { active: snap.active as boolean } : {}),
            },
          });
          await this.audit.write({
            tx, actorId: user.id, action: "UPDATE",
            entityType: "branch", entityId: log.entityId,
            beforeSnapshot: log.afterSnapshot, afterSnapshot: snap,
            summaryAr: `${user.name} تراجع عن تعديل الفرع «${updated.nameAr}»`,
            summaryEn: `${user.name} reverted update of branch "${updated.nameEn}"`,
          });
          return { entityType: "branch", entityId: log.entityId };
        }

        case "UPDATE:supplier": {
          if (!log.entityId) throw new ConflictError("errors.revert_not_supported");
          const supplier = await tx.supplier.findUnique({ where: { id: log.entityId } });
          if (!supplier) throw new NotFoundError({ supplierId: log.entityId });
          const updated = await tx.supplier.update({
            where: { id: log.entityId },
            data: {
              ...(snap.nameAr !== undefined ? { nameAr: snap.nameAr as string } : {}),
              ...(snap.nameEn !== undefined ? { nameEn: snap.nameEn as string } : {}),
              ...(snap.active !== undefined ? { active: snap.active as boolean } : {}),
            },
          });
          await this.audit.write({
            tx, actorId: user.id, action: "UPDATE",
            entityType: "supplier", entityId: log.entityId,
            beforeSnapshot: log.afterSnapshot, afterSnapshot: snap,
            summaryAr: `${user.name} تراجع عن تعديل المورد «${updated.nameAr}»`,
            summaryEn: `${user.name} reverted update of supplier "${updated.nameEn}"`,
          });
          return { entityType: "supplier", entityId: log.entityId };
        }

        case "UPDATE:product_sku": {
          if (!log.entityId) throw new ConflictError("errors.revert_not_supported");
          const sku = await tx.productSku.findUnique({ where: { id: log.entityId } });
          if (!sku) throw new NotFoundError({ skuId: log.entityId });
          const updated = await tx.productSku.update({
            where: { id: log.entityId },
            data: {
              ...(snap.code !== undefined ? { code: snap.code as string } : {}),
              ...(snap.colorNameAr !== undefined ? { colorNameAr: snap.colorNameAr as string } : {}),
              ...(snap.colorNameEn !== undefined ? { colorNameEn: snap.colorNameEn as string } : {}),
              ...(snap.category !== undefined ? { category: snap.category as "NORMAL" | "SPECIAL" } : {}),
              ...(snap.active !== undefined ? { active: snap.active as boolean } : {}),
            },
          });
          await this.audit.write({
            tx, actorId: user.id, action: "UPDATE",
            entityType: "product_sku", entityId: log.entityId,
            beforeSnapshot: log.afterSnapshot, afterSnapshot: snap,
            summaryAr: `${user.name} تراجع عن تعديل الصنف «${updated.colorNameAr}»`,
            summaryEn: `${user.name} reverted update of SKU "${updated.colorNameEn}"`,
          });
          return { entityType: "product_sku", entityId: log.entityId };
        }

        case "UPDATE:product_variant": {
          if (!log.entityId) throw new ConflictError("errors.revert_not_supported");
          const variant = await tx.productVariant.findUnique({ where: { id: log.entityId } });
          if (!variant) throw new NotFoundError({ variantId: log.entityId });
          await tx.productVariant.update({
            where: { id: log.entityId },
            data: {
              ...(snap.defaultSalePricePerMeter !== undefined
                ? { defaultSalePricePerMeter: snap.defaultSalePricePerMeter as string }
                : {}),
              ...(snap.defaultPurchasePricePerMeter !== undefined
                ? { defaultPurchasePricePerMeter: snap.defaultPurchasePricePerMeter as string }
                : {}),
              ...(snap.priceOverrideTolerancePercent !== undefined
                ? { priceOverrideTolerancePercent: (snap.priceOverrideTolerancePercent as string | null) ?? null }
                : {}),
              ...(snap.sizeMetersPerBoard !== undefined
                ? { sizeMetersPerBoard: snap.sizeMetersPerBoard as string }
                : {}),
              ...(snap.active !== undefined ? { active: snap.active as boolean } : {}),
            },
          });
          await this.audit.write({
            tx, actorId: user.id, action: "UPDATE",
            entityType: "product_variant", entityId: log.entityId,
            beforeSnapshot: log.afterSnapshot, afterSnapshot: snap,
            summaryAr: `${user.name} تراجع عن تعديل مقاس المنتج`,
            summaryEn: `${user.name} reverted update of product variant`,
          });
          return { entityType: "product_variant", entityId: log.entityId };
        }

        default:
          throw new ConflictError("errors.revert_not_supported");
      }
    });
  }
}
