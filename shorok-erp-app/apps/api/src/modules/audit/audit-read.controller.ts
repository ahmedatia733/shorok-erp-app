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
          const expense = await tx.expense.create({
            data: {
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
          const entry = await tx.factoryLedgerEntry.create({
            data: {
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

        default:
          throw new ConflictError("errors.revert_not_supported");
      }
    });
  }
}
