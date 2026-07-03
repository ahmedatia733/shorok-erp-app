import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { I18nService } from "nestjs-i18n";
import {
  CreateExpenseRequestSchema,
  ExpensesQuerySchema,
  UpdateExpenseRequestSchema,
  type CreateExpenseRequest,
  type ExpensesQuery,
  type UpdateExpenseRequest,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

@Controller("expenses")
export class ExpensesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly i18n: I18nService,
  ) {}

  /**
   * GET /expenses?branchId=&from?=&to?=
   *
   * Any authenticated user with access to the branch (BranchScopeGuard
   * already enforces this globally). Supports optional date range filter
   * and cursor pagination — newest first.
   */
  @Get()
  async list(@Query(new ZodValidationPipe(ExpensesQuerySchema)) query: ExpensesQuery) {
    const where = {
      branchId: query.branchId,
      ...(query.from || query.to
        ? {
            expenseDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const rows = await this.prisma.expense.findMany({
      where,
      orderBy: [{ expenseDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: { creator: { select: { id: true, name: true } } },
    });

    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1]?.id ?? null : null;

    return {
      data: data.map((e) => ({
        id: e.id,
        branchId: e.branchId,
        expenseDate: e.expenseDate,
        description: e.description,
        amount: e.amount.toString(),
        paidFromAccount: e.paidFromAccount,
        createdAt: e.createdAt,
        creator: e.creator,
      })),
      nextCursor,
    };
  }

  /**
   * POST /expenses — OWNER, BRANCH_MANAGER, ACCOUNTANT (branch-scoped).
   *
   * Default rule: amount > 0. OWNER alone may post amount < 0 as a
   * correction (e.g., refund/adjustment); the audit summary distinguishes
   * the correction key from the regular create. The Expense table itself
   * is NOT append-only at the DB level (no REVOKE on it), but our policy
   * is "no in-place edits — corrections via additional rows", which is
   * what the OWNER-negative path enforces.
   */
  @Post()
  @Roles("OWNER", "BRANCH_MANAGER", "ACCOUNTANT")
  async create(
    @Body(new ZodValidationPipe(CreateExpenseRequestSchema)) body: CreateExpenseRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const branch = await this.prisma.branch.findUnique({ where: { id: body.branchId } });
    if (!branch) throw new NotFoundError({ branchId: body.branchId });

    const amount = new Decimal(body.amount);
    if (amount.isZero()) {
      throw new ValidationError({ reason: "amount_must_be_nonzero" });
    }
    if (amount.isNegative() && user.role !== "OWNER") {
      throw new ValidationError({ reason: "owner_only_correction" });
    }

    return this.prisma.runInTransaction(async (tx) => {
      // Auto-post to GL if both GL accounts provided
      let journalEntryId: string | null = null;
      const expense = await tx.expense.create({
        data: {
          branchId:           body.branchId,
          expenseDate:        new Date(body.expenseDate),
          description:        body.description,
          amount:             amount.toFixed(2),
          paidFromAccount:    body.paidFromAccount,
          glAccountId:        body.glAccountId        ?? null,
          paymentGlAccountId: body.paymentGlAccountId ?? null,
          journalEntryId:     null,
          createdBy: user.id,
        },
      });

      if (body.glAccountId && body.paymentGlAccountId) {
        const je = await tx.journalEntry.create({
          data: {
            entryType:     "EXPENSE",
            entryDate:     new Date(body.expenseDate),
            description:   body.description,
            referenceType: "expense",
            referenceId:   expense.id,
            createdBy:     user.id,
            lines: {
              create: [
                { accountId: body.glAccountId,        debit: amount.toFixed(2), credit: "0" },
                { accountId: body.paymentGlAccountId, debit: "0", credit: amount.toFixed(2) },
              ],
            },
          },
        });
        journalEntryId = je.id;
        await tx.expense.update({
          where: { id: expense.id },
          data:  { journalEntryId: je.id },
        });
      }

      const summaryKey = amount.isNegative()
        ? "expenses.summary.correction"
        : "expenses.summary.created";
      const argsCommon = {
        actor: user.name,
        amount: amount.abs().toFixed(2),
        description: body.description,
      };
      const summaryAr = (await this.i18n.translate(summaryKey, {
        lang: "ar",
        args: { ...argsCommon, branch: branch.nameAr },
      })) as string;
      const summaryEn = (await this.i18n.translate(summaryKey, {
        lang: "en",
        args: { ...argsCommon, branch: branch.nameEn },
      })) as string;

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "expense",
        entityId: expense.id,
        afterSnapshot: {
          branchId: body.branchId,
          amount: amount.toFixed(2),
          description: body.description,
          paidFromAccount: body.paidFromAccount,
          isCorrection: amount.isNegative(),
        },
        summaryAr,
        summaryEn,
      });

      return {
        id: expense.id,
        branchId: expense.branchId,
        expenseDate: expense.expenseDate,
        description: expense.description,
        amount: expense.amount.toString(),
        paidFromAccount: expense.paidFromAccount,
        glAccountId: expense.glAccountId ?? null,
        paymentGlAccountId: expense.paymentGlAccountId ?? null,
        journalEntryId: expense.journalEntryId ?? null,
        createdAt: expense.createdAt,
      };
    });
  }

  /** PATCH /expenses/:id — OWNER only: edit any expense field. */
  @Patch(":id")
  @Roles("OWNER")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateExpenseRequestSchema)) body: UpdateExpenseRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const before = await tx.expense.findUnique({ where: { id } });
      if (!before) throw new NotFoundError({ id });

      const newAmount = body.amount !== undefined ? new Decimal(body.amount) : null;
      if (newAmount?.isZero()) throw new ValidationError({ reason: "amount_must_be_nonzero" });

      const after = await tx.expense.update({
        where: { id },
        data: {
          ...(body.expenseDate ? { expenseDate: new Date(body.expenseDate) } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(newAmount ? { amount: newAmount.toFixed(2) } : {}),
          ...(body.paidFromAccount !== undefined ? { paidFromAccount: body.paidFromAccount } : {}),
        },
        include: { creator: { select: { id: true, name: true } } },
      });

      const branch = await tx.branch.findUnique({ where: { id: before.branchId } });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "expense",
        entityId: id,
        beforeSnapshot: {
          branchId: before.branchId,
          expenseDate: before.expenseDate,
          description: before.description,
          amount: before.amount.toString(),
          paidFromAccount: before.paidFromAccount,
          createdBy: before.createdBy,
        },
        afterSnapshot: {
          branchId: after.branchId,
          expenseDate: after.expenseDate,
          description: after.description,
          amount: after.amount.toString(),
          paidFromAccount: after.paidFromAccount,
        },
        summaryAr: `${user.name} عدّل مصروف: ${after.description} — ${after.amount} ج.م`,
        summaryEn: `${user.name} edited expense: ${after.description} — ${after.amount} EGP`,
      });

      return {
        id: after.id,
        branchId: after.branchId,
        expenseDate: after.expenseDate,
        description: after.description,
        amount: after.amount.toString(),
        paidFromAccount: after.paidFromAccount,
        createdAt: after.createdAt,
        creator: after.creator,
      };
    });
  }

  /** DELETE /expenses/:id — OWNER only: hard delete. */
  @Delete(":id")
  @Roles("OWNER")
  @HttpCode(204)
  async remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      const expense = await tx.expense.findUnique({ where: { id } });
      if (!expense) throw new NotFoundError({ id });

      // Clear FK reference before deleting journal entry (avoid FK constraint violation)
      const journalEntryId = expense.journalEntryId;
      await tx.expense.update({ where: { id }, data: { journalEntryId: null } });
      await tx.expense.delete({ where: { id } });
      if (journalEntryId) {
        await tx.journalEntry.delete({ where: { id: journalEntryId } });
      }

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "DELETE",
        entityType: "expense",
        entityId: id,
        beforeSnapshot: {
          id: expense.id,
          branchId: expense.branchId,
          expenseDate: expense.expenseDate,
          description: expense.description,
          amount: expense.amount.toString(),
          paidFromAccount: expense.paidFromAccount,
          createdBy: expense.createdBy,
        },
        summaryAr: `${user.name} حذف مصروف: ${expense.description} — ${expense.amount} ج.م`,
        summaryEn: `${user.name} deleted expense: ${expense.description} — ${expense.amount} EGP`,
      });
    });
  }
}
