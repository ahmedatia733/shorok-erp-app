import { Controller, Get, Param, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
/* Injected dependencies must stay VALUE imports: Nest resolves them from the
   emitted decorator metadata, which a type-only import erases. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { InvoicePdfService } from "../invoice-pdf/invoice-pdf.service";
import { PrismaService } from "../../prisma/prisma.service";
import { InvoiceProfitabilityService, type ProfitabilityOptions } from "./invoice-profitability.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */
import type { ReportFilters } from "./sales-rep-reports.service";
import { resolveRange, type DatePreset } from "./report-range";
import { buildInvoiceProfitabilityPdf, buildInvoiceProfitabilityDetailPdf } from "./invoice-profitability-pdf.template";
import { buildInvoiceProfitabilityWorkbook } from "./invoice-profitability-excel";

/** Non-OWNER reports are restricted, in SQL, to the user's allowed branches. */
const branchScopeOf = (user: AuthenticatedUser): string[] | undefined =>
  user.role === "OWNER" ? undefined : user.allowedBranches;

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Preset = z
  .enum(["today", "yesterday", "this_week", "this_month", "last_month", "q1", "q2", "q3", "q4", "this_year", "last_year", "custom"])
  .default("this_month");

const Query$ = z.object({
  preset: Preset,
  from: DateStr.optional(),
  to: DateStr.optional(),
  branchId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  salesRepresentativeId: z.string().uuid().optional(),
  productVariantId: z.string().uuid().optional(),
  productCode: z.string().max(60).optional(),
  productNameAr: z.string().max(120).optional(),
  invoiceNumber: z.string().max(40).optional(),
  costCoverage: z.enum(["ALL", "COMPLETE", "INCOMPLETE"]).default("ALL"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});
type QueryType = z.infer<typeof Query$>;

/** An export that would render tens of thousands of rows is refused rather than
 *  allowed to exhaust the API container mid-request. */
const EXPORT_ROW_CAP = 3000;

/**
 * تقرير ربحية الفواتير — read-only.
 *
 * Every route is a GET that only reads. Nothing here creates a reporting row,
 * caches a result, or writes an audit entry: viewing a report is not a business
 * event, and this feature was required to leave the database untouched.
 *
 * Access matches the other margin-bearing reports (trial balance, statements,
 * sales profitability): OWNER and ACCOUNTANT. The guard is what enforces it —
 * hiding the sidebar entry is presentation, not security.
 */
@Controller("reports/sales/invoice-profitability")
export class InvoiceProfitabilityController {
  constructor(
    private readonly svc: InvoiceProfitabilityService,
    private readonly pdf: InvoicePdfService,
    private readonly prisma: PrismaService,
  ) {}

  private filters(q: QueryType, user: AuthenticatedUser): ReportFilters {
    const range = resolveRange(q.preset as DatePreset, { from: q.from, to: q.to });
    return {
      from: range.from,
      to: range.to,
      branchId: q.branchId,
      customerId: q.customerId,
      salesRepresentativeId: q.salesRepresentativeId,
      productVariantId: q.productVariantId,
      productCode: q.productCode,
      productNameAr: q.productNameAr,
      allowedBranchIds: branchScopeOf(user),
    };
  }

  private options(q: QueryType): ProfitabilityOptions {
    return {
      invoiceNumber: q.invoiceNumber,
      costCoverage: q.costCoverage,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /** The invoice list + summary cards. */
  @Get()
  @Roles("OWNER", "ACCOUNTANT")
  report(@Query(new ZodValidationPipe(Query$)) q: QueryType, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.report(this.filters(q, user), this.options(q));
  }

  /** The aggregation tabs: by product, customer, branch and representative. */
  @Get("aggregates")
  @Roles("OWNER", "ACCOUNTANT")
  aggregates(@Query(new ZodValidationPipe(Query$)) q: QueryType, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.aggregates(this.filters(q, user), this.options(q));
  }

  /** The whole filtered report as a PDF. Declared before `:invoiceId`. */
  @Get("pdf")
  @Roles("OWNER", "ACCOUNTANT")
  async listPdf(
    @Query(new ZodValidationPipe(Query$)) q: QueryType,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const f = this.filters(q, user);
    const data = await this.svc.report(f, { ...this.options(q), page: 1, pageSize: EXPORT_ROW_CAP });
    this.guardSize(data.totalInvoices);
    const company = await this.companyName();
    const html = buildInvoiceProfitabilityPdf({
      company,
      printedAt: new Date(),
      from: f.from,
      to: f.to,
      filters: await this.filterLabels(q, f),
      summary: data.summary,
      invoices: data.invoices,
    });
    this.stream(res, await this.pdf.renderHtml(html), `invoice-profitability-${f.from}_${f.to}.pdf`, "application/pdf");
  }

  /** The filtered report as a multi-sheet workbook. */
  @Get("export")
  @Roles("OWNER", "ACCOUNTANT")
  async excel(
    @Query(new ZodValidationPipe(Query$)) q: QueryType,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const f = this.filters(q, user);
    const [data, aggregates] = await Promise.all([
      this.svc.report(f, { ...this.options(q), page: 1, pageSize: EXPORT_ROW_CAP }),
      this.svc.aggregates(f, this.options(q)),
    ]);
    this.guardSize(data.totalInvoices);
    const buffer = await buildInvoiceProfitabilityWorkbook({
      company: await this.companyName(),
      printedAt: new Date(),
      from: f.from,
      to: f.to,
      filters: await this.filterLabels(q, f),
      summary: data.summary,
      invoices: data.invoices,
      aggregates,
    });
    this.stream(
      res,
      buffer,
      `invoice-profitability-${f.from}_${f.to}.xlsx`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  }

  /** One invoice's profitability, line by line. */
  @Get(":invoiceId")
  @Roles("OWNER", "ACCOUNTANT")
  async detail(
    @Param("invoiceId") invoiceId: string,
    @Query(new ZodValidationPipe(Query$)) q: QueryType,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const detail = await this.svc.invoiceDetail(this.filters(q, user), invoiceId);
    if (!detail) throw new NotFoundError({ reason: "invoice_not_found", invoiceId });
    return detail;
  }

  /** One invoice's profitability as a PDF. */
  @Get(":invoiceId/pdf")
  @Roles("OWNER", "ACCOUNTANT")
  async detailPdf(
    @Param("invoiceId") invoiceId: string,
    @Query(new ZodValidationPipe(Query$)) q: QueryType,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const detail = await this.svc.invoiceDetail(this.filters(q, user), invoiceId);
    if (!detail) throw new NotFoundError({ reason: "invoice_not_found", invoiceId });
    const html = buildInvoiceProfitabilityDetailPdf({
      company: await this.companyName(),
      printedAt: new Date(),
      detail,
    });
    this.stream(res, await this.pdf.renderHtml(html), `invoice-profit-${detail.invoice.invoiceNumber}.pdf`, "application/pdf");
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private guardSize(rows: number) {
    if (rows > EXPORT_ROW_CAP) {
      throw new ValidationError({
        reason: "export_too_large",
        rows,
        maximum: EXPORT_ROW_CAP,
        messageAr: `التقرير يحتوي على ${rows} فاتورة، والحد الأقصى للتصدير ${EXPORT_ROW_CAP}. برجاء تضييق نطاق التاريخ أو الفلاتر.`,
      });
    }
  }

  private async companyName(): Promise<string> {
    const profile = await this.prisma.companyProfile.findFirst({ select: { nameAr: true } });
    return profile?.nameAr ?? "الشروق";
  }

  /** Human-readable filter echo for the PDF/Excel header. */
  private async filterLabels(q: QueryType, f: ReportFilters): Promise<Array<{ label: string; value: string }>> {
    const out: Array<{ label: string; value: string }> = [{ label: "الفترة", value: `${f.from} — ${f.to}` }];
    if (q.branchId) {
      const b = await this.prisma.branch.findUnique({ where: { id: q.branchId }, select: { nameAr: true } });
      if (b) out.push({ label: "الفرع", value: b.nameAr });
    }
    if (q.customerId) {
      const c = await this.prisma.customer.findUnique({ where: { id: q.customerId }, select: { code: true, nameAr: true } });
      if (c) out.push({ label: "العميل", value: `${c.code} — ${c.nameAr}` });
    }
    if (q.salesRepresentativeId) {
      const r = await this.prisma.salesRepresentative.findUnique({
        where: { id: q.salesRepresentativeId },
        select: { nameAr: true },
      });
      if (r) out.push({ label: "مندوب المبيعات", value: r.nameAr });
    }
    if (q.productCode) out.push({ label: "كود الصنف", value: q.productCode });
    if (q.productNameAr) out.push({ label: "الصنف", value: q.productNameAr });
    if (q.invoiceNumber) out.push({ label: "رقم الفاتورة", value: q.invoiceNumber });
    if (q.costCoverage !== "ALL") {
      out.push({ label: "اكتمال التكلفة", value: q.costCoverage === "COMPLETE" ? "مكتملة فقط" : "غير مكتملة فقط" });
    }
    return out;
  }

  private stream(res: Response, body: Buffer, filename: string, contentType: string) {
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(body.length));
    res.end(body);
  }
}
