import { Body, Controller, Get, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  CancelLegacyReturnSchema,
  CreateLegacyReturnSchema,
  LegacyReturnQuerySchema,
  UpdateLegacyReturnSchema,
  type CancelLegacyReturn,
  type CreateLegacyReturn,
  type LegacyReturnQuery,
  type UpdateLegacyReturn,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthenticatedUser } from "../../common/types/request-user";
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { LegacyReturnsService } from "./legacy-returns.service";
import { PrismaService } from "../../prisma/prisma.service";
import { InvoicePdfService } from "../invoice-pdf/invoice-pdf.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */
import { buildLegacyReturnListPdf, buildLegacyReturnPdf } from "./legacy-return-pdf.template";

/**
 * مردودات بدون فواتير.
 *
 * Permissions mirror the invoice-linked sales return exactly: the same people
 * may read and draft, the same people may confirm, and cancelling — which
 * reverses posted accounting — stays with the OWNER. This feature widens
 * nothing.
 */
@Controller("legacy-returns")
export class LegacyReturnsController {
  constructor(
    private readonly service: LegacyReturnsService,
    private readonly prisma: PrismaService,
    private readonly pdf: InvoicePdfService,
  ) {}

  // Literal paths are declared before `:id` — Nest matches in declaration
  // order, and "pdf" would otherwise be read as a document id.

  /** The filtered list, exactly as the screen is showing it. */
  @Get("pdf")
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  async listPdf(
    @Query(new ZodValidationPipe(LegacyReturnQuerySchema)) query: LegacyReturnQuery,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    // Export the whole filtered set rather than the page on screen.
    const data = await this.service.list({ ...query, limit: 200, offset: 0 }, user);
    const customer = query.customerId
      ? await this.prisma.customer.findUnique({ where: { id: query.customerId }, select: { nameAr: true } })
      : null;
    const html = buildLegacyReturnListPdf(
      data.rows,
      { count: data.totalCount, amount: data.totalAmount },
      await this.meta([
        ...(query.from || query.to ? [{ label: "الفترة", value: `${query.from ?? "—"} — ${query.to ?? "—"}` }] : []),
        ...(query.status ? [{ label: "الحالة", value: query.status }] : []),
        ...(customer ? [{ label: "العميل", value: customer.nameAr }] : []),
        ...(query.paperInvoiceNumber ? [{ label: "الفاتورة الورقية", value: query.paperInvoiceNumber }] : []),
        ...(query.q ? [{ label: "بحث", value: query.q }] : []),
      ]),
    );
    return this.send(res, html, `legacy-returns-${new Date().toISOString().slice(0, 10)}.pdf`);
  }

  /** One document. */
  @Get(":id/pdf")
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  async documentPdf(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const doc = await this.service.detail(id, user);
    const html = buildLegacyReturnPdf(doc, await this.meta([]));
    return this.send(res, html, `legacy-return-LRN-${doc.returnNumber}.pdf`);
  }

  private async meta(filters: Array<{ label: string; value: string }>) {
    const company = await this.prisma.companyProfile.findFirst({ select: { nameAr: true } });
    return {
      companyName: company?.nameAr ?? "الشركة",
      printedAt: new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" }),
      filters,
    };
  }

  private async send(res: Response, html: string, filename: string): Promise<void> {
    const buf = await this.pdf.renderHtml(html);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", buf.length);
    res.end(buf);
  }

  @Get()
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  async list(
    @Query(new ZodValidationPipe(LegacyReturnQuerySchema)) query: LegacyReturnQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.list(query, user);
  }

  @Get(":id")
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  async detail(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.detail(id, user);
  }

  @Post()
  @Roles("OWNER", "ACCOUNTANT")
  async create(
    @Body(new ZodValidationPipe(CreateLegacyReturnSchema)) body: CreateLegacyReturn,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.create(body, user);
  }

  @Patch(":id")
  @Roles("OWNER", "ACCOUNTANT")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateLegacyReturnSchema)) body: UpdateLegacyReturn,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.update(id, body, user);
  }

  @Post(":id/confirm")
  @Roles("OWNER", "ACCOUNTANT")
  async confirm(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.confirm(id, user);
  }

  @Post(":id/cancel")
  @Roles("OWNER")
  async cancel(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CancelLegacyReturnSchema)) body: CancelLegacyReturn,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.cancel(id, body, user);
  }
}
