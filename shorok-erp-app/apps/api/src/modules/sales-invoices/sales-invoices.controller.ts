import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { Decimal } from "decimal.js";
import {
  CreateSalesInvoiceSchema,
  UpdateSalesInvoiceSchema,
  SalesInvoiceQuerySchema,
  ConfirmSalesInvoiceSchema,
  type CreateSalesInvoice,
  type UpdateSalesInvoice,
  type SalesInvoiceQuery,
  type ConfirmSalesInvoice,
  type PostingLine,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { InventoryEngine } from "../inventory/inventory.engine";
import { PostingEngine } from "../posting/posting.engine";
import { ReversalService } from "../posting/reversal.service";
import { EffectiveConfigService } from "../configuration/effective-config.service";
import { InvoicePdfService } from "../invoice-pdf/invoice-pdf.service";
import { salesInvoiceToPdfData } from "../invoice-pdf/invoice-pdf.mapper";
import { SalesRepresentativesService } from "../sales-representatives/sales-representatives.service";
import { lineCogs } from "./sales-cogs";

@Controller("sales-invoices")
export class SalesInvoicesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventoryEngine: InventoryEngine,
    private readonly postingEngine: PostingEngine,
    private readonly reversal: ReversalService,
    private readonly effectiveConfig: EffectiveConfigService,
    private readonly invoicePdf: InvoicePdfService,
    private readonly salesReps: SalesRepresentativesService,
  ) {}

  // ─── helpers ─────────────────────────────────────────────────────────

  private formatLine(l: any) {
    return {
      id: l.id,
      productVariant: l.productVariant
        ? {
            id: l.productVariant.id,
            sku: l.productVariant.sku
              ? {
                  code: l.productVariant.sku.code,
                  colorNameAr: l.productVariant.sku.colorNameAr,
                }
              : null,
            sizeLabel: l.productVariant.sizeMetersPerBoard?.toString() ?? null,
          }
        : null,
      quantity: l.quantity.toString(),
      unitLabel: l.unitLabel,
      unitPrice: l.unitPrice.toFixed(2),
      costPrice: l.costPrice.toFixed(2),
      discountPct: l.discountPct.toFixed(2),
      lineTotal: l.lineTotal.toFixed(2),
      lineCost: l.lineCost.toFixed(2),
      note: l.note ?? null,
    };
  }

  private formatInvoice(inv: any, includeLines = true) {
    const base = {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber?.toString(),
      invoiceDate: inv.invoiceDate,
      dueDate: inv.dueDate ?? null,
      customer: inv.customer
        ? { id: inv.customer.id, code: inv.customer.code, nameAr: inv.customer.nameAr }
        : null,
      branch: inv.branch
        ? { id: inv.branch.id, nameAr: inv.branch.nameAr }
        : null,
      salesRepresentativeId: inv.salesRepresentativeId ?? null,
      salesRepresentative: inv.salesRepresentative
        ? { id: inv.salesRepresentative.id, code: inv.salesRepresentative.code, nameAr: inv.salesRepresentative.nameAr }
        : null,
      status: inv.status,
      notes: inv.notes ?? null,
      subtotal: inv.subtotal.toFixed(2),
      discountAmount: inv.discountAmount.toFixed(2),
      taxRate: inv.taxRate.toFixed(2),
      taxAmount: inv.taxAmount.toFixed(2),
      grandTotal: inv.grandTotal.toFixed(2),
      totalCost: inv.totalCost.toFixed(2),
      arAccountId: inv.arAccountId ?? null,
      revenueAccountId: inv.revenueAccountId ?? null,
      taxAccountId: inv.taxAccountId ?? null,
      cogsAccountId: inv.cogsAccountId ?? null,
      inventoryAccountId: inv.inventoryAccountId ?? null,
      journalEntryId: inv.journalEntryId ?? null,
      cogsJournalEntryId: inv.cogsJournalEntryId ?? null,
      customerTxId: inv.customerTxId ?? null,
      createdAt: inv.createdAt,
    };
    if (includeLines) {
      return {
        ...base,
        lineCount: (inv.lines ?? []).length,
        lines: (inv.lines ?? []).map((l: any) => this.formatLine(l)),
      };
    }
    return {
      ...base,
      lineCount: inv._count?.lines ?? (inv.lines ?? []).length,
    };
  }

  private computeLineTotals(lines: CreateSalesInvoice["lines"]) {
    return lines.map((line) => {
      const qty = new Decimal(line.quantity);
      const unitPrice = new Decimal(line.unitPrice);
      const costPrice = new Decimal(line.costPrice ?? "0");
      const discountPct = new Decimal(line.discountPct ?? "0");

      const lineTotal = qty.mul(unitPrice).mul(new Decimal(1).minus(discountPct.div(100)));
      const lineCost = qty.mul(costPrice);

      return {
        productVariantId: line.productVariantId,
        quantity: qty,
        unitLabel: line.unitLabel ?? "وحدة",
        unitPrice,
        costPrice,
        discountPct,
        lineTotal,
        lineCost,
        note: line.note ?? null,
      };
    });
  }

  // ─── GET /sales-invoices ──────────────────────────────────────────────

  @Get()
  @Roles("OWNER", "ACCOUNTANT")
  async list(
    @Query(new ZodValidationPipe(SalesInvoiceQuerySchema)) query: SalesInvoiceQuery,
  ) {
    const where: any = {
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            invoiceDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const rows = await this.prisma.salesInvoice.findMany({
      where,
      orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        customer: { select: { id: true, code: true, nameAr: true } },
        salesRepresentative: { select: { id: true, code: true, nameAr: true } },
        branch: { select: { id: true, nameAr: true } },
        _count: { select: { lines: true } },
      },
    });

    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return {
      data: data.map((inv) => this.formatInvoice(inv, false)),
      nextCursor,
    };
  }

  // ─── GET /sales-invoices/:id ─────────────────────────────────────────

  @Get(":id")
  @Roles("OWNER", "ACCOUNTANT")
  async getOne(@Param("id") id: string) {
    const inv = await this.prisma.salesInvoice.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, code: true, nameAr: true } },
        salesRepresentative: { select: { id: true, code: true, nameAr: true } },
        branch: { select: { id: true, nameAr: true } },
        lines: {
          include: {
            productVariant: {
              include: { sku: { select: { code: true, colorNameAr: true } } },
            },
          },
        },
      },
    });
    if (!inv) throw new NotFoundError({ id });
    return this.formatInvoice(inv, true);
  }

  // ─── GET /sales-invoices/:id/pdf ─────────────────────────────────────
  // Downloadable Arabic/RTL PDF of the invoice — presentation only, no cost /
  // COGS / profit / account or journal IDs. Same auth as the detail view.

  @Get(":id/pdf")
  @Roles("OWNER", "ACCOUNTANT")
  async getPdf(@Param("id") id: string, @Res() res: Response) {
    const inv = await this.prisma.salesInvoice.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, code: true, nameAr: true, phone: true } },
        branch: { select: { id: true, nameAr: true } },
        lines: {
          include: {
            productVariant: {
              include: { sku: { select: { code: true, colorNameAr: true } } },
            },
          },
        },
      },
    });
    if (!inv) throw new NotFoundError({ id });

    const company = await this.prisma.companyProfile.findFirst({ select: { nameAr: true } });
    const pdf = await this.invoicePdf.renderInvoice(
      salesInvoiceToPdfData(inv, company?.nameAr ?? "الشركة"),
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="SI-${inv.invoiceNumber}.pdf"`);
    res.setHeader("Content-Length", pdf.length);
    res.end(pdf);
  }

  // ─── POST /sales-invoices ─────────────────────────────────────────────

  @Post()
  @Roles("OWNER", "ACCOUNTANT")
  async create(
    @Body(new ZodValidationPipe(CreateSalesInvoiceSchema)) body: CreateSalesInvoice,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const customer = await this.prisma.customer.findUnique({ where: { id: body.customerId } });
    if (!customer || !customer.active) throw new NotFoundError({ customerId: body.customerId });

    const branch = await this.prisma.branch.findUnique({ where: { id: body.branchId } });
    if (!branch || !branch.active) throw new NotFoundError({ branchId: body.branchId });

    // Optional rep dimension — must exist and be active when assigned to a new
    // invoice. It never affects posting, stock, or totals.
    if (body.salesRepresentativeId) await this.salesReps.assertAssignable(body.salesRepresentativeId);

    // Validate all variants exist
    for (const line of body.lines) {
      const variant = await this.prisma.productVariant.findUnique({
        where: { id: line.productVariantId },
      });
      if (!variant || !variant.active) {
        throw new NotFoundError({ productVariantId: line.productVariantId });
      }
    }

    const lineData = this.computeLineTotals(body.lines);
    const taxRate = new Decimal(body.taxRate ?? "0");

    const subtotal = lineData.reduce((acc, l) => acc.add(l.lineTotal), new Decimal(0));
    const discountAmount = lineData.reduce(
      (acc, l) => acc.add(l.quantity.mul(l.unitPrice).mul(l.discountPct.div(100))),
      new Decimal(0),
    );
    const taxAmount = subtotal.mul(taxRate).div(100);
    const grandTotal = subtotal.add(taxAmount);
    const totalCost = lineData.reduce((acc, l) => acc.add(l.lineCost), new Decimal(0));

    // Validate orderId if provided: order must exist and not already have an SI
    if (body.orderId) {
      const order = await this.prisma.customerOrder.findUnique({ where: { id: body.orderId } });
      if (!order) throw new NotFoundError({ orderId: body.orderId });
      if (order.salesInvoiceId) {
        throw new ValidationError({ reason: "order_already_has_invoice", orderId: body.orderId });
      }
    }

    return this.prisma.runInTransaction(async (tx) => {
      const invoice = await tx.salesInvoice.create({
        data: {
          invoiceDate: new Date(body.invoiceDate),
          dueDate: body.dueDate ? new Date(body.dueDate) : null,
          customerId: body.customerId,
          branchId: body.branchId,
          salesRepresentativeId: body.salesRepresentativeId ?? null,
          taxRate: taxRate.toFixed(2),
          notes: body.notes ?? null,
          status: "DRAFT",
          subtotal: subtotal.toFixed(2),
          discountAmount: discountAmount.toFixed(2),
          taxAmount: taxAmount.toFixed(2),
          grandTotal: grandTotal.toFixed(2),
          totalCost: totalCost.toFixed(2),
          createdBy: user.id,
          lines: {
            create: lineData.map((l) => ({
              productVariantId: l.productVariantId,
              quantity: l.quantity.toFixed(4),
              unitLabel: l.unitLabel,
              unitPrice: l.unitPrice.toFixed(2),
              costPrice: l.costPrice.toFixed(2),
              discountPct: l.discountPct.toFixed(2),
              lineTotal: l.lineTotal.toFixed(2),
              lineCost: l.lineCost.toFixed(2),
              note: l.note,
            })),
          },
        },
        include: {
          customer: { select: { id: true, code: true, nameAr: true } },
        salesRepresentative: { select: { id: true, code: true, nameAr: true } },
          branch: { select: { id: true, nameAr: true } },
          lines: {
            include: {
              productVariant: {
                include: { sku: { select: { code: true, colorNameAr: true } } },
              },
            },
          },
        },
      });

      // Link originating order → this invoice (one-to-one)
      if (body.orderId) {
        await tx.customerOrder.update({
          where: { id: body.orderId },
          data: { salesInvoiceId: invoice.id },
        });
      }

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "sales_invoice",
        entityId: invoice.id,
        afterSnapshot: {
          invoiceNumber: invoice.invoiceNumber?.toString(),
          customerId: body.customerId,
          branchId: body.branchId,
          grandTotal: grandTotal.toFixed(2),
          linesCount: lineData.length,
          orderId: body.orderId ?? null,
        },
        summaryAr: `${user.name} أنشأ فاتورة مبيعات رقم ${invoice.invoiceNumber} — إجمالي: ${grandTotal.toFixed(2)} ج.م`,
        summaryEn: `${user.name} created sales invoice ${invoice.invoiceNumber} — total: ${grandTotal.toFixed(2)} EGP`,
      });

      return this.formatInvoice(invoice, true);
    });
  }

  // ─── PUT /sales-invoices/:id ──────────────────────────────────────────

  @Put(":id")
  @Roles("OWNER", "ACCOUNTANT")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateSalesInvoiceSchema)) body: UpdateSalesInvoice,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const existing = await this.prisma.salesInvoice.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError({ id });
    if (existing.status !== "DRAFT") {
      throw new ValidationError({ reason: "only_draft_can_be_updated", status: existing.status });
    }
    // Only a NEW/changed rep assignment is validated for active status. Keeping
    // the invoice's existing (possibly now-inactive) rep while editing other
    // fields must succeed — the historical relationship is preserved, not
    // re-created. Clearing to null is always allowed.
    if (
      body.salesRepresentativeId &&
      body.salesRepresentativeId !== existing.salesRepresentativeId
    ) {
      await this.salesReps.assertAssignable(body.salesRepresentativeId);
    }

    return this.prisma.runInTransaction(async (tx) => {
      // Delete old lines then recompute if new lines are provided
      let lineData = null;
      let subtotal = new Decimal(existing.subtotal.toString());
      let discountAmount = new Decimal(existing.discountAmount.toString());
      let taxRate = new Decimal(existing.taxRate.toString());
      let taxAmount = new Decimal(existing.taxAmount.toString());
      let grandTotal = new Decimal(existing.grandTotal.toString());
      let totalCost = new Decimal(existing.totalCost.toString());

      if (body.lines) {
        // Validate variants
        for (const line of body.lines) {
          const variant = await tx.productVariant.findUnique({
            where: { id: line.productVariantId },
          });
          if (!variant || !variant.active) {
            throw new NotFoundError({ productVariantId: line.productVariantId });
          }
        }

        lineData = this.computeLineTotals(body.lines);
        taxRate = body.taxRate !== undefined ? new Decimal(body.taxRate) : taxRate;

        subtotal = lineData.reduce((acc, l) => acc.add(l.lineTotal), new Decimal(0));
        discountAmount = lineData.reduce(
          (acc, l) => acc.add(l.quantity.mul(l.unitPrice).mul(l.discountPct.div(100))),
          new Decimal(0),
        );
        taxAmount = subtotal.mul(taxRate).div(100);
        grandTotal = subtotal.add(taxAmount);
        totalCost = lineData.reduce((acc, l) => acc.add(l.lineCost), new Decimal(0));

        // Replace lines
        await tx.salesInvoiceLine.deleteMany({ where: { invoiceId: id } });
        await tx.salesInvoiceLine.createMany({
          data: lineData.map((l) => ({
            invoiceId: id,
            productVariantId: l.productVariantId,
            quantity: l.quantity.toFixed(4),
            unitLabel: l.unitLabel,
            unitPrice: l.unitPrice.toFixed(2),
            costPrice: l.costPrice.toFixed(2),
            discountPct: l.discountPct.toFixed(2),
            lineTotal: l.lineTotal.toFixed(2),
            lineCost: l.lineCost.toFixed(2),
            note: l.note,
          })),
        });
      } else if (body.taxRate !== undefined) {
        taxRate = new Decimal(body.taxRate);
        taxAmount = subtotal.mul(taxRate).div(100);
        grandTotal = subtotal.add(taxAmount);
      }

      const invoice = await tx.salesInvoice.update({
        where: { id },
        data: {
          ...(body.invoiceDate ? { invoiceDate: new Date(body.invoiceDate) } : {}),
          ...(body.dueDate !== undefined
            ? { dueDate: body.dueDate ? new Date(body.dueDate) : null }
            : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          ...(body.salesRepresentativeId !== undefined ? { salesRepresentativeId: body.salesRepresentativeId } : {}),
          taxRate: taxRate.toFixed(2),
          subtotal: subtotal.toFixed(2),
          discountAmount: discountAmount.toFixed(2),
          taxAmount: taxAmount.toFixed(2),
          grandTotal: grandTotal.toFixed(2),
          totalCost: totalCost.toFixed(2),
        },
        include: {
          customer: { select: { id: true, code: true, nameAr: true } },
        salesRepresentative: { select: { id: true, code: true, nameAr: true } },
          branch: { select: { id: true, nameAr: true } },
          lines: {
            include: {
              productVariant: {
                include: { sku: { select: { code: true, colorNameAr: true } } },
              },
            },
          },
        },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "sales_invoice",
        entityId: id,
        afterSnapshot: { grandTotal: grandTotal.toFixed(2), linesUpdated: !!lineData },
        summaryAr: `${user.name} عدّل فاتورة مبيعات رقم ${existing.invoiceNumber}`,
        summaryEn: `${user.name} updated sales invoice ${existing.invoiceNumber}`,
      });

      return this.formatInvoice(invoice, true);
    });
  }

  // ─── POST /sales-invoices/:id/confirm ────────────────────────────────

  @Post(":id/confirm")
  @Roles("OWNER", "ACCOUNTANT")
  async confirm(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ConfirmSalesInvoiceSchema)) body: ConfirmSalesInvoice,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const existing = await this.prisma.salesInvoice.findUnique({
      where: { id },
      include: {
        customer: true,
        lines: {
          include: {
            productVariant: { select: { id: true, sizeMetersPerBoard: true, avgCost: true } },
          },
        },
      },
    });
    if (!existing) throw new NotFoundError({ id });
    if (existing.status !== "DRAFT") {
      throw new ValidationError({ reason: "invoice_not_draft", status: existing.status });
    }

    const grandTotal = new Decimal(existing.grandTotal.toString());
    const subtotal = new Decimal(existing.subtotal.toString());
    const taxAmount = new Decimal(existing.taxAmount.toString());
    const invoiceNumber = existing.invoiceNumber.toString();

    // Accounts resolve ONLY from the effective PostingProfile on the invoice
    // date — never from the client (any account fields on the request are
    // ignored). COGS + the stock SALE are mandatory and cannot be toggled off.
    const invoiceDateStr = existing.invoiceDate.toISOString().slice(0, 10);
    const profile = await this.effectiveConfig.postingProfileAsOf(invoiceDateStr);
    const arAccountId        = profile?.arAccountId        ?? null;
    const revenueAccountId   = profile?.revenueAccountId   ?? null;
    const vatOutputAccountId = profile?.vatOutputAccountId ?? null;
    const cogsAccountId      = profile?.cogsAccountId      ?? null;
    const inventoryAccountId = profile?.inventoryAccountId ?? null;

    // COGS from avg_cost (never the user-entered cost_price). Per line:
    // boards = quantityMeters / sizeMetersPerBoard, cost = boards × avg_cost.
    // When avg_cost is 0 the line contributes 0 and, if the whole invoice's
    // COGS is 0, the COGS entry is skipped (a zero entry would break the
    // engine's debit-XOR-credit invariant). Opening cost = Phase 4.
    const lineCosts = existing.lines.map((l) => {
      const avg = l.productVariant?.avgCost.toString() ?? "0";
      const size = l.productVariant?.sizeMetersPerBoard.toString() ?? "0";
      return { lineId: l.id, unitCost: new Decimal(avg), cogs: lineCogs(l.quantity.toString(), size, avg) };
    });
    const totalCogs = lineCosts.reduce((a, x) => a.add(x.cogs), new Decimal(0));

    if (!arAccountId)      throw new ValidationError({ reason: "accounts_receivable_account_required" });
    if (!revenueAccountId) throw new ValidationError({ reason: "revenue_account_required" });
    if (taxAmount.gt(0) && !vatOutputAccountId) {
      throw new ValidationError({ reason: "tax_account_required_when_tax_exists" });
    }
    if (totalCogs.gt(0) && !cogsAccountId)      throw new ValidationError({ reason: "cogs_account_required" });
    if (totalCogs.gt(0) && !inventoryAccountId) throw new ValidationError({ reason: "inventory_account_required" });

    return this.prisma.runInTransaction(async (tx) => {
      // 1. CustomerTransaction (LEGACY — kept for the current customer
      //    statement views; the AR journal line below is the real source of
      //    truth via its party dimension. Removed in Phase 4 migration.)
      const customerTx = await tx.customerTransaction.create({
        data: {
          customerId: existing.customerId,
          type: "INVOICE",
          direction: "DR",
          amount: grandTotal.toFixed(2),
          date: existing.invoiceDate,
          reference: `SI-${invoiceNumber}`,
          description: `فاتورة مبيعات رقم ${invoiceNumber}`,
          createdBy: user.id,
        },
      });

      // 2. Revenue entry via PostingEngine (Dr AR[party] / Cr Revenue + VAT-out)
      const revenueLines: PostingLine[] = [
        { accountId: arAccountId!, debit: grandTotal.toFixed(2), credit: "0", note: `مديونية ${existing.customer.nameAr} - SI-${invoiceNumber}`, partyType: "CUSTOMER", partyId: existing.customerId },
        { accountId: revenueAccountId!, debit: "0", credit: subtotal.toFixed(2), note: `إيرادات مبيعات - SI-${invoiceNumber}` },
      ];
      if (taxAmount.gt(0) && vatOutputAccountId) {
        revenueLines.push({ accountId: vatOutputAccountId, debit: "0", credit: taxAmount.toFixed(2), note: `ضريبة قيمة مضافة - SI-${invoiceNumber}` });
      }
      const revenuePosted = await this.postingEngine.post({
        tx,
        actor: user,
        sourceType: "SALES_INVOICE",
        sourceId: existing.id,
        entryType: "SALES_INVOICE",
        entryDate: invoiceDateStr,
        reference: `SI-${invoiceNumber}`,
        description: `فاتورة مبيعات رقم ${invoiceNumber} — ${existing.customer.nameAr}`,
        idempotencyKey: `SALES_INVOICE:${existing.id}`,
        lines: revenueLines,
      });

      // Document-level rep attribution on the journal HEADER only. The lines
      // carry no rep, so a confirmed invoice never moves the rep's financial
      // balance — invoice activity is informational on the statement.
      if (existing.salesRepresentativeId) {
        await tx.journalEntry.update({
          where: { id: revenuePosted.journalEntryId },
          data: { salesRepresentativeId: existing.salesRepresentativeId },
        });
      }

      // 3. COGS entry via PostingEngine — ONLY when COGS > 0 (avg_cost basis
      //    exists). Skipped for items without a cost basis yet (Phase 4).
      let cogsJournalEntryId: string | null = null;
      if (totalCogs.gt(0) && cogsAccountId && inventoryAccountId) {
        const cogsPosted = await this.postingEngine.post({
          tx,
          actor: user,
          sourceType: "SALES_INVOICE",
          sourceId: existing.id,
          entryType: "JOURNAL",
          entryDate: invoiceDateStr,
          reference: `SI-${invoiceNumber}-COGS`,
          description: `تكلفة البضاعة المباعة - فاتورة ${invoiceNumber}`,
          idempotencyKey: `SALES_INVOICE:${existing.id}:COGS`,
          lines: [
            { accountId: cogsAccountId, debit: totalCogs.toFixed(2), credit: "0", note: `تكلفة مبيعات - SI-${invoiceNumber}` },
            { accountId: inventoryAccountId, debit: "0", credit: totalCogs.toFixed(2), note: `صرف من المخزون - SI-${invoiceNumber}` },
          ],
        });
        cogsJournalEntryId = cogsPosted.journalEntryId;
      }

      // 4. Inventory SALE per line (always) + posting-time snapshots. The
      //    engine's non-negative guard hard-blocks insufficient stock.
      for (const line of existing.lines) {
        if (!line.productVariant) continue;
        const sizePerBoard = new Decimal(line.productVariant.sizeMetersPerBoard.toString());
        const boardsDelta = sizePerBoard.gt(0)
          ? new Decimal(line.quantity.toString()).div(sizePerBoard).negated()
          : new Decimal(0);
        if (!boardsDelta.isZero()) {
          await this.inventoryEngine.apply({
            branchId: existing.branchId,
            productVariantId: line.productVariant.id,
            movementType: "SALE",
            boardsDelta: boardsDelta.toFixed(4),
            reference: { type: "sales_invoice", id: existing.id },
            actor: user,
            summaryAr: `صرف من المخزون — فاتورة مبيعات ${invoiceNumber}`,
            summaryEn: `Stock out — sales invoice ${invoiceNumber}`,
            humanReadableNote: `فاتورة مبيعات ${invoiceNumber}`,
            tx,
          });
        }
        const cost = lineCosts.find((c) => c.lineId === line.id);
        await tx.salesInvoiceLine.update({
          where: { id: line.id },
          data: { unitCostAtPosting: (cost?.unitCost ?? new Decimal(0)).toFixed(2), taxRateAtPosting: existing.taxRate },
        });
      }

      // 5. Update invoice
      const invoice = await tx.salesInvoice.update({
        where: { id },
        data: {
          status: "CONFIRMED",
          customerTxId: customerTx.id,
          journalEntryId: revenuePosted.journalEntryId,
          cogsJournalEntryId,
          arAccountId,
          revenueAccountId,
          taxAccountId: vatOutputAccountId,
          cogsAccountId: totalCogs.gt(0) ? cogsAccountId : null,
          inventoryAccountId: totalCogs.gt(0) ? inventoryAccountId : null,
        },
        include: {
          customer: { select: { id: true, code: true, nameAr: true } },
        salesRepresentative: { select: { id: true, code: true, nameAr: true } },
          branch: { select: { id: true, nameAr: true } },
          lines: {
            include: {
              productVariant: {
                include: { sku: { select: { code: true, colorNameAr: true } } },
              },
            },
          },
        },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CONFIRM",
        entityType: "sales_invoice",
        entityId: id,
        afterSnapshot: {
          status: "CONFIRMED",
          invoiceNumber,
          journalEntryId: revenuePosted.journalEntryId,
          cogsJournalEntryId,
          totalCogs: totalCogs.toFixed(2),
          customerTxId: customerTx.id,
        },
        summaryAr: `${user.name} أكّد فاتورة المبيعات رقم ${invoiceNumber} وتم ترحيل القيود وصرف المخزون`,
        summaryEn: `${user.name} confirmed sales invoice ${invoiceNumber} — posted entries and stock out`,
      });

      return this.formatInvoice(invoice, true);
    });
  }

  // ─── POST /sales-invoices/:id/cancel ─────────────────────────────────

  @Post(":id/cancel")
  @Roles("OWNER")
  async cancel(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    const existing = await this.prisma.salesInvoice.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError({ id });
    if (existing.status !== "DRAFT" && existing.status !== "CONFIRMED") {
      throw new ValidationError({ reason: "cannot_cancel", status: existing.status });
    }

    return this.prisma.runInTransaction(async (tx) => {
      const invoiceNumber = existing.invoiceNumber.toString();

      // Set status + clear ONLY the legacy CustomerTransaction FK (that row is
      // still hard-deleted per Phase-4 plan). journalEntryId / cogsJournalEntryId
      // stay LINKED — the posted entries are reversed, never deleted
      // (Constitution VII), so there is no FK to clear for them.
      await tx.salesInvoice.update({
        where: { id },
        data: {
          status: "CANCELLED",
          customerTxId: null,
        },
      });

      if (existing.status === "CONFIRMED") {
        // Reverse the revenue entry and the COGS entry (when present) through
        // the engine — mirror entries net them to zero, originals stay linked
        // and marked REVERSED. Never delete a posted entry.
        if (existing.journalEntryId) {
          await this.reversal.reverse({
            entryId: existing.journalEntryId,
            reason: `إلغاء فاتورة مبيعات ${invoiceNumber}`,
            actor: user,
            tx,
          });
        }
        if (existing.cogsJournalEntryId) {
          await this.reversal.reverse({
            entryId: existing.cogsJournalEntryId,
            reason: `إلغاء تكلفة مبيعات ${invoiceNumber}`,
            actor: user,
            tx,
          });
        }

        // Legacy CustomerTransaction (DR) — still deleted in 3D; the legacy AR
        // ledger is removed in Phase 4. FK already cleared above.
        if (existing.customerTxId) {
          await tx.customerTransaction.delete({ where: { id: existing.customerTxId } });
        }

        // Restore inventory via a compensating ADJUSTMENT — the original SALE
        // movements are RETAINED (history stays intact), matching the purchase
        // cancel. We add the boards back per line.
        const siLines = await tx.salesInvoiceLine.findMany({
          where: { invoiceId: id },
          include: { productVariant: { select: { id: true, sizeMetersPerBoard: true } } },
        });
        for (const line of siLines) {
          if (!line.productVariant) continue;
          const sizePerBoard = new Decimal(line.productVariant.sizeMetersPerBoard.toString());
          const metersQty = new Decimal(line.quantity.toString());
          const boardsToRestore = metersQty.div(sizePerBoard);
          if (boardsToRestore.isZero()) continue;
          await this.inventoryEngine.apply({
            branchId: existing.branchId,
            productVariantId: line.productVariant.id,
            movementType: "ADJUSTMENT",
            boardsDelta: boardsToRestore.toFixed(4),
            reference: { type: "sales_invoice_cancel", id: existing.id },
            actor: user,
            summaryAr: `استرجاع مخزون — إلغاء فاتورة ${invoiceNumber}`,
            summaryEn: `Stock restored — cancel SI ${invoiceNumber}`,
            tx,
          });
        }
      }

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CANCEL",
        entityType: "sales_invoice",
        entityId: id,
        afterSnapshot: { status: "CANCELLED", invoiceNumber, wasConfirmed: existing.status === "CONFIRMED" },
        summaryAr: `${user.name} ألغى فاتورة المبيعات رقم ${invoiceNumber} وعكس القيود المحاسبية`,
        summaryEn: `${user.name} cancelled sales invoice ${invoiceNumber} and reversed all accounting entries`,
      });

      return { success: true };
    });
  }

  // ─── DELETE /sales-invoices/:id ───────────────────────────────────────

  @Delete(":id")
  @Roles("OWNER")
  @HttpCode(204)
  async remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    const existing = await this.prisma.salesInvoice.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError({ id });
    if (existing.status !== "DRAFT") {
      throw new ValidationError({ reason: "only_draft_can_be_deleted", status: existing.status });
    }

    return this.prisma.runInTransaction(async (tx) => {
      await tx.salesInvoice.delete({ where: { id } });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "DELETE",
        entityType: "sales_invoice",
        entityId: id,
        beforeSnapshot: {
          invoiceNumber: existing.invoiceNumber.toString(),
          status: existing.status,
          grandTotal: existing.grandTotal.toString(),
        },
        summaryAr: `${user.name} حذف فاتورة المبيعات رقم ${existing.invoiceNumber}`,
        summaryEn: `${user.name} deleted sales invoice ${existing.invoiceNumber}`,
      });
    });
  }
}
