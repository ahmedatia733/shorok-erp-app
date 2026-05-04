import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { I18nService } from "nestjs-i18n";
import {
  CreateExpenseRequestSchema,
  ExpensesQuerySchema,
  type CreateExpenseRequest,
  type ExpensesQuery,
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
      const expense = await tx.expense.create({
        data: {
          branchId: body.branchId,
          expenseDate: new Date(body.expenseDate),
          description: body.description,
          amount: amount.toFixed(2),
          paidFromAccount: body.paidFromAccount,
          createdBy: user.id,
        },
      });

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
        createdAt: expense.createdAt,
      };
    });
  }
}
