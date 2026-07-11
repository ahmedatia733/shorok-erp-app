import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { I18nService } from "nestjs-i18n";
import {
  CreateExpenseRequestSchema,
  ExpensesQuerySchema,
  UpdateExpenseRequestSchema,
  ReverseEntrySchema,
  type CreateExpenseRequest,
  type ExpensesQuery,
  type UpdateExpenseRequest,
  type PostingLine,
  type ReverseEntry,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { PostingEngine } from "../posting/posting.engine";
import { ReversalService } from "../posting/reversal.service";
import { EffectiveConfigService } from "../configuration/effective-config.service";

@Controller("expenses")
export class ExpensesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly i18n: I18nService,
    private readonly postingEngine: PostingEngine,
    private readonly reversal: ReversalService,
    private readonly effectiveConfig: EffectiveConfigService,
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
    if (!branch || !branch.active) throw new NotFoundError({ branchId: body.branchId });

    const amount = new Decimal(body.amount);
    if (amount.isZero()) {
      throw new ValidationError({ reason: "amount_must_be_nonzero" });
    }
    if (amount.isNegative() && user.role !== "OWNER") {
      throw new ValidationError({ reason: "owner_only_correction" });
    }

    return this.prisma.runInTransaction(async (tx) => {
      // ── Phase 3C posting decision ──────────────────────────────────────────
      // Negative amounts are OWNER corrections and stay record-only in 3C
      // (refund/reversal semantics belong to Phase 3D). A positive expense with
      // no posting signal at all is a legacy record-only expense (transitional
      // backward-compat). Otherwise we resolve accounts and post through the
      // PostingEngine, throwing typed errors on incomplete posting intent.
      const isCorrection = amount.isNegative();
      const hasPostingSignal =
        !!body.expenseCategoryId ||
        !!body.glAccountId ||
        !!body.paymentGlAccountId ||
        !!body.supplierId ||
        body.taxable === true ||
        !!body.taxRate ||
        !!body.apAccountId ||
        !!body.vatInputAccountId;

      // Resolved plan (null when we take the record-only path).
      let plan: {
        expenseAccountId: string;
        creditAccountId: string;
        creditParty?: { partyType: "SUPPLIER"; partyId: string };
        vatAccountId: string | null;
        taxAmount: Decimal;
        rate: Decimal;
        isTaxable: boolean;
      } | null = null;

      if (!isCorrection && hasPostingSignal) {
        const profile = await this.effectiveConfig.postingProfileAsOf(body.expenseDate, tx);
        const taxProfile = await this.effectiveConfig.taxProfileAsOf(body.expenseDate, tx);

        // Expense (debit) account: category mapping first, then body fallback.
        let expenseAccountId: string;
        if (body.expenseCategoryId) {
          const cat = await tx.expenseCategory.findUnique({ where: { id: body.expenseCategoryId } });
          if (!cat || !cat.active) throw new ValidationError({ reason: "expense_account_required" });
          expenseAccountId = cat.accountId;
        } else if (body.glAccountId) {
          expenseAccountId = body.glAccountId;
        } else {
          throw new ValidationError({ reason: "expense_account_required" });
        }

        // Input VAT: only when taxable requested or an explicit rate > 0.
        const rate = new Decimal(body.taxRate ?? taxProfile?.rate?.toString() ?? "0");
        const isTaxable = body.taxable === true || rate.gt(0);
        let vatAccountId: string | null = null;
        let taxAmount = new Decimal(0);
        if (isTaxable && rate.gt(0)) {
          vatAccountId =
            taxProfile?.inputAccountId ?? profile?.vatInputAccountId ?? body.vatInputAccountId ?? null;
          if (!vatAccountId) throw new ValidationError({ reason: "vat_input_account_required" });
          taxAmount = amount.mul(rate).div(100);
        }

        // Credit side: on-credit AP (with supplier party) or treasury payment.
        let creditAccountId: string;
        let creditParty: { partyType: "SUPPLIER"; partyId: string } | undefined;
        if (body.supplierId) {
          const ap = profile?.apAccountId ?? body.apAccountId ?? null;
          if (!ap) throw new ValidationError({ reason: "ap_account_required" });
          creditAccountId = ap;
          creditParty = { partyType: "SUPPLIER", partyId: body.supplierId };
        } else if (body.paymentGlAccountId) {
          creditAccountId = body.paymentGlAccountId;
        } else {
          throw new ValidationError({ reason: "payment_account_required" });
        }

        plan = { expenseAccountId, creditAccountId, creditParty, vatAccountId, taxAmount, rate, isTaxable };
      }

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
          expenseCategoryId:  body.expenseCategoryId  ?? null,
          supplierId:         body.supplierId         ?? null,
          taxable:            plan?.isTaxable ?? false,
          taxRateAtPosting:   plan && plan.isTaxable && plan.rate.gt(0) ? plan.rate.toFixed(2) : null,
          status:             plan ? "POSTED" : "RECORDED",
          journalEntryId:     null,
          createdBy: user.id,
        },
      });

      if (plan) {
        const total = amount.add(plan.taxAmount);
        const lines: PostingLine[] = [
          { accountId: plan.expenseAccountId, debit: amount.toFixed(2), credit: "0" },
          ...(plan.taxAmount.gt(0)
            ? [{ accountId: plan.vatAccountId!, debit: plan.taxAmount.toFixed(2), credit: "0" }]
            : []),
          {
            accountId: plan.creditAccountId,
            debit: "0",
            credit: total.toFixed(2),
            ...(plan.creditParty ?? {}),
          },
        ];
        const result = await this.postingEngine.post({
          sourceType: "EXPENSE",
          sourceId: expense.id,
          entryDate: body.expenseDate,
          entryType: "EXPENSE",
          description: body.description,
          idempotencyKey: `EXPENSE:${expense.id}`,
          lines,
          actor: user,
          tx,
        });
        journalEntryId = result.journalEntryId;
        await tx.expense.update({
          where: { id: expense.id },
          data:  { journalEntryId },
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
          journalEntryId,
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
        expenseCategoryId: expense.expenseCategoryId ?? null,
        supplierId: expense.supplierId ?? null,
        taxable: expense.taxable,
        status: expense.status,
        journalEntryId,
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

  /**
   * DELETE /expenses/:id — OWNER only. Only RECORDED (record-only, no GL entry)
   * expenses — including OWNER negative corrections — may be hard-deleted. A
   * POSTED/REVERSED expense carries a GL entry and is immutable (Constitution
   * VII): it must be corrected via POST /expenses/:id/reverse.
   */
  @Delete(":id")
  @Roles("OWNER")
  @HttpCode(204)
  async remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      const expense = await tx.expense.findUnique({ where: { id } });
      if (!expense) throw new NotFoundError({ id });
      if (expense.status !== "RECORDED") {
        throw new ValidationError({ reason: "use_reverse_instead", status: expense.status });
      }

      await tx.expense.delete({ where: { id } });

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

  /**
   * POST /expenses/:id/reverse — OWNER: reverse a POSTED expense's GL entry
   * and retain the row (Constitution VII). The original journalEntryId stays
   * linked (now REVERSED); reversalJournalEntryId points to the mirror entry;
   * status becomes REVERSED. Idempotent — a repeat reverse returns the same
   * reversal. Record-only expenses have no GL entry to reverse.
   */
  @Post(":id/reverse")
  @Roles("OWNER")
  async reverseExpense(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ReverseEntrySchema)) body: ReverseEntry,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const expense = await tx.expense.findUnique({ where: { id } });
      if (!expense) throw new NotFoundError({ id });
      if (expense.status === "RECORDED" || !expense.journalEntryId) {
        throw new ValidationError({ reason: "expense_not_posted", status: expense.status });
      }

      const result = await this.reversal.reverse({
        entryId: expense.journalEntryId,
        reason: body.reason,
        reversalDate: body.reversalDate,
        actor: user,
        tx,
      });

      await tx.expense.update({
        where: { id },
        data: { status: "REVERSED", reversalJournalEntryId: result.journalEntryId },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CANCEL",
        entityType: "expense",
        entityId: id,
        beforeSnapshot: { status: expense.status, journalEntryId: expense.journalEntryId },
        afterSnapshot: { status: "REVERSED", reversalJournalEntryId: result.journalEntryId, reason: body.reason },
        summaryAr: `${user.name} عكس مصروف: ${expense.description} — ${expense.amount} ج.م`,
        summaryEn: `${user.name} reversed expense: ${expense.description} — ${expense.amount} EGP`,
      });

      return { id, status: "REVERSED", journalEntryId: expense.journalEntryId, reversalJournalEntryId: result.journalEntryId, idempotent: result.idempotent };
    });
  }
}
