import { Body, Controller, Get, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  CreateExpenseAccountSchema,
  ExpenseDashboardQuerySchema,
  ExpenseDetailQuerySchema,
  ExpenseItemsQuerySchema,
  ExpenseMovementsQuerySchema,
  UpdateExpenseAccountSchema,
  type CreateExpenseAccount,
  type ExpenseDashboardQuery,
  type ExpenseDetailQuery,
  type ExpenseItemsQuery,
  type ExpenseMovementsQuery,
  type UpdateExpenseAccount,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { PrismaService } from "../../prisma/prisma.service";
import { AccountsService } from "../accounts/accounts.service";
import { InvoicePdfService } from "../invoice-pdf/invoice-pdf.service";
import { ExpenseAccountsService } from "./expense-accounts.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */
import {
  buildDashboardPdf,
  buildDetailPdf,
  buildItemsPdf,
  buildMovementsPdf,
  type ExpensePdfMeta,
} from "./expense-pdf.template";

/**
 * إدارة المصروفات — the expenses area.
 *
 * Reads aggregate the existing ledger; writes go through `AccountsService`, the
 * same code the Chart of Accounts screen uses. That is the whole point of this
 * controller: an expense item is a GL account, so adding one from here, from the
 * journal quick-add, or from the chart of accounts must all be the one operation
 * — there is no expense-only record to keep in step.
 *
 * Reads are OWNER + ACCOUNTANT, matching the trial balance and the account
 * statement, which already expose these very debits and credits to an
 * accountant. Writes are OWNER only, exactly as POST/PATCH /accounts. No
 * permission is widened by this feature.
 *
 * The PDF routes render with the same Chromium worker the invoices use and
 * touch no table; `committedChanges: 0` on every JSON response says the same
 * thing about the reads.
 */
@Controller("expense-accounts")
export class ExpenseAccountsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expenses: ExpenseAccountsService,
    private readonly accounts: AccountsService,
    private readonly pdf: InvoicePdfService,
  ) {}

  // ── reads ────────────────────────────────────────────────────────────────
  // Literal paths are declared before `:id`, because Nest matches in
  // declaration order and "dashboard" would otherwise be read as an id.

  @Get()
  @Roles("OWNER", "ACCOUNTANT")
  async items(@Query(new ZodValidationPipe(ExpenseItemsQuerySchema)) query: ExpenseItemsQuery) {
    return this.expenses.items(query);
  }

  @Get("dashboard")
  @Roles("OWNER", "ACCOUNTANT")
  async dashboard(
    @Query(new ZodValidationPipe(ExpenseDashboardQuerySchema)) query: ExpenseDashboardQuery,
  ) {
    return this.expenses.dashboard(query.from, query.to);
  }

  @Get("movements")
  @Roles("OWNER", "ACCOUNTANT")
  async movements(
    @Query(new ZodValidationPipe(ExpenseMovementsQuerySchema)) query: ExpenseMovementsQuery,
  ) {
    return this.expenses.movements(query);
  }

  // ── PDF ──────────────────────────────────────────────────────────────────

  @Get("pdf/dashboard")
  @Roles("OWNER", "ACCOUNTANT")
  async dashboardPdf(
    @Query(new ZodValidationPipe(ExpenseDashboardQuerySchema)) query: ExpenseDashboardQuery,
    @Res() res: Response,
  ) {
    const data = await this.expenses.dashboard(query.from, query.to);
    const html = buildDashboardPdf(data, await this.meta([{ label: "الفترة", value: `${data.from} — ${data.to}` }]));
    return this.send(res, html, `expenses-dashboard-${data.to}.pdf`);
  }

  @Get("pdf/items")
  @Roles("OWNER", "ACCOUNTANT")
  async itemsPdf(
    @Query(new ZodValidationPipe(ExpenseItemsQuerySchema)) query: ExpenseItemsQuery,
    @Res() res: Response,
  ) {
    // The list endpoint is not paginated, so the export is the whole filtered
    // set by construction rather than whatever page the screen was showing.
    const data = await this.expenses.items(query);
    const html = buildItemsPdf(
      data,
      await this.meta([
        { label: "الفترة", value: `${data.from} — ${data.to}` },
        { label: "الحالة", value: STATUS_LABEL[query.status ?? "all"] },
        ...(query.search ? [{ label: "بحث", value: query.search }] : []),
      ]),
    );
    return this.send(res, html, `expenses-items-${data.to}.pdf`);
  }

  @Get("pdf/movements")
  @Roles("OWNER", "ACCOUNTANT")
  async movementsPdf(
    @Query(new ZodValidationPipe(ExpenseMovementsQuerySchema)) query: ExpenseMovementsQuery,
    @Res() res: Response,
  ) {
    // Export the whole filtered set, not the page the user happens to be on.
    // Capped rather than unbounded: one Chromium process renders this, and an
    // accidental decade-wide range should fail clearly instead of exhausting
    // the container.
    const probe = await this.expenses.movements({ ...query, limit: 1, offset: 0 });
    if (probe.totalCount > PDF_ROW_CAP) {
      throw new ValidationError({
        reason: "export_too_large",
        totalCount: probe.totalCount,
        maxRows: PDF_ROW_CAP,
        messageAr: `النتائج ${probe.totalCount} حركة، والحد الأقصى للتصدير ${PDF_ROW_CAP}. برجاء تضييق الفترة أو الفلاتر.`,
      });
    }

    const data = await this.expenses.movements({ ...query, limit: PDF_ROW_CAP, offset: 0 });
    const item = query.accountId
      ? await this.prisma.account.findUnique({
          where: { id: query.accountId },
          select: { code: true, nameAr: true },
        })
      : null;

    const html = buildMovementsPdf(
      data,
      await this.meta([
        { label: "الفترة", value: `${data.from} — ${data.to}` },
        { label: "بند المصروف", value: item ? `${item.code} — ${item.nameAr}` : "كل البنود" },
        ...(query.search ? [{ label: "بحث", value: query.search }] : []),
        ...(query.minAmount ? [{ label: "من مبلغ", value: query.minAmount }] : []),
        ...(query.maxAmount ? [{ label: "إلى مبلغ", value: query.maxAmount }] : []),
      ]),
    );
    return this.send(res, html, `expenses-movements-${data.to}.pdf`);
  }

  @Get("pdf/:id")
  @Roles("OWNER", "ACCOUNTANT")
  async detailPdf(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(ExpenseDetailQuerySchema)) query: ExpenseDetailQuery,
    @Res() res: Response,
  ) {
    const data = await this.expenses.detail(id, query.from, query.to);
    const html = buildDetailPdf(
      data,
      await this.meta([
        { label: "الفترة", value: `${data.from} — ${data.to}` },
        { label: "البند", value: `${data.code} — ${data.nameAr}` },
      ]),
    );
    const safeCode = data.code.replace(/[^A-Za-z0-9._-]/g, "_");
    return this.send(res, html, `expense-${safeCode}-${data.to}.pdf`);
  }

  @Get(":id")
  @Roles("OWNER", "ACCOUNTANT")
  async detail(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(ExpenseDetailQuerySchema)) query: ExpenseDetailQuery,
  ) {
    return this.expenses.detail(id, query.from, query.to);
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /**
   * Creates one expense item — that is, one Chart-of-Accounts account whose
   * category is EXPENSE.
   *
   * The category, the account type and the leaf flag are derived rather than
   * asked for: they are how the system records "this is an expense account", and
   * the person adding «الكهرباء» should not have to know that. No parent is set,
   * which matches every existing expense account in the chart and, more
   * importantly, avoids demoting a parent that already carries postings — the
   * Income Statement counts leaf accounts only, so demoting one would silently
   * rewrite history.
   */
  @Post()
  @Roles("OWNER")
  async create(
    @Body(new ZodValidationPipe(CreateExpenseAccountSchema)) body: CreateExpenseAccount,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.accounts.create(
      {
        code: body.code,
        nameAr: body.nameAr,
        // The chart requires both names; an Arabic-only entry keeps its Arabic
        // name on both sides rather than being given an invented translation.
        nameEn: body.nameEn?.trim() || body.nameAr,
        category: "EXPENSE",
        accountType: "EXPENSE",
      },
      user,
    );
  }

  /**
   * Renames an expense item or takes it out of circulation.
   *
   * There is deliberately no delete. An account that has been posted to is part
   * of the record: deactivating keeps it in every historical journal and report
   * while removing it from the pickers that offer accounts for new entries.
   */
  @Patch(":id")
  @Roles("OWNER")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateExpenseAccountSchema)) body: UpdateExpenseAccount,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const existing = await this.prisma.account.findUnique({
      where: { id },
      select: { id: true, category: true },
    });
    if (!existing || existing.category !== "EXPENSE") {
      throw new NotFoundError({ reason: "EXPENSE_ITEM_NOT_FOUND", accountId: id });
    }
    return this.accounts.update(id, body, user);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async meta(filters: ExpensePdfMeta["filters"]): Promise<ExpensePdfMeta> {
    const company = await this.prisma.companyProfile.findFirst({ select: { nameAr: true } });
    return {
      companyName: company?.nameAr ?? "الشركة",
      printedAt: new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" }),
      filters,
    };
  }

  private async send(res: Response, html: string, filename: string): Promise<void> {
    const pdf = await this.pdf.renderHtml(html);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", pdf.length);
    res.end(pdf);
  }
}

/** One Chromium process renders each export; this keeps a stray range survivable. */
const PDF_ROW_CAP = 3000;

const STATUS_LABEL: Record<string, string> = {
  all: "الكل",
  active: "نشط",
  inactive: "غير نشط",
};
