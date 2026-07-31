import { Body, Controller, Get, Param, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  CreatePurchaseReturnSchema, UpdatePurchaseReturnSchema, ReturnCancelSchema, ReturnQuerySchema,
  type CreatePurchaseReturn, type UpdatePurchaseReturn, type ReturnCancel, type ReturnQuery,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { InvoicePdfService } from "../invoice-pdf/invoice-pdf.service";
import { buildReturnHtml } from "../invoice-pdf/return-template";
import { purchaseReturnToPdfData } from "../invoice-pdf/return-pdf.mapper";
import { PurchaseReturnsService } from "./purchase-returns.service";

@Controller("purchase-returns")
export class PurchaseReturnsController {
  constructor(
    private readonly service: PurchaseReturnsService,
    private readonly prisma: PrismaService,
    private readonly invoicePdf: InvoicePdfService,
  ) {}

  // Downloadable PDF of a purchase return — DRAFT or CONFIRMED. Read-only, same
  // view auth as GET /:id (branch-scoped 404 = no leak); drafts are watermarked.
  @Get(":id/pdf")
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  async getPdf(
    @Param("id") id: string,
    @Query("locale") localeQ: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const { ret, journalEntryNumber } = await this.service.getRawForPdf(id, user);
    const locale = localeQ === "en" ? "en" : "ar";
    const company = await this.prisma.companyProfile.findFirst({ select: { nameAr: true } });
    const html = buildReturnHtml(purchaseReturnToPdfData(ret, { locale, companyName: company?.nameAr ?? "الشركة", journalEntryNumber }));
    const pdf = await this.invoicePdf.renderHtml(html);

    const tag = ret.status === "CONFIRMED" ? "confirmed" : ret.status === "CANCELLED" ? "cancelled" : "draft";
    const safe = String(ret.returnNumber).replace(/[^A-Za-z0-9._-]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="purchase-return-PR-${safe}-${tag}.pdf"`);
    res.setHeader("Content-Length", pdf.length);
    res.setHeader("Cache-Control", "no-store, private");
    res.end(pdf);
  }

  @Get("returnable/:invoiceId")
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  returnable(@Param("invoiceId") invoiceId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.returnableForInvoice(invoiceId, user);
  }

  @Get()
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  list(@Query(new ZodValidationPipe(ReturnQuerySchema)) query: ReturnQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.service.list(query, user);
  }

  @Get(":id")
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  get(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.get(id, user);
  }

  @Post()
  @Roles("OWNER", "ACCOUNTANT")
  create(@Body(new ZodValidationPipe(CreatePurchaseReturnSchema)) body: CreatePurchaseReturn, @CurrentUser() user: AuthenticatedUser) {
    return this.service.create(body, user);
  }

  @Put(":id")
  @Roles("OWNER", "ACCOUNTANT")
  update(@Param("id") id: string, @Body(new ZodValidationPipe(UpdatePurchaseReturnSchema)) body: UpdatePurchaseReturn, @CurrentUser() user: AuthenticatedUser) {
    return this.service.update(id, body, user);
  }

  @Post(":id/confirm")
  @Roles("OWNER", "ACCOUNTANT")
  confirm(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.confirm(id, user);
  }

  @Post(":id/cancel")
  @Roles("OWNER")
  cancel(@Param("id") id: string, @Body(new ZodValidationPipe(ReturnCancelSchema)) body: ReturnCancel, @CurrentUser() user: AuthenticatedUser) {
    return this.service.cancel(id, body.reason, user);
  }
}
