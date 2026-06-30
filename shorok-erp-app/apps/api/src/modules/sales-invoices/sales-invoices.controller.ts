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
} from "@nestjs/common";
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
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

@Controller("sales-invoices")
export class SalesInvoicesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
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

    return this.prisma.runInTransaction(async (tx) => {
      const invoice = await tx.salesInvoice.create({
        data: {
          invoiceDate: new Date(body.invoiceDate),
          dueDate: body.dueDate ? new Date(body.dueDate) : null,
          customerId: body.customerId,
          branchId: body.branchId,
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
        action: "CREATE",
        entityType: "sales_invoice",
        entityId: invoice.id,
        afterSnapshot: {
          invoiceNumber: invoice.invoiceNumber?.toString(),
          customerId: body.customerId,
          branchId: body.branchId,
          grandTotal: grandTotal.toFixed(2),
          linesCount: lineData.length,
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
          taxRate: taxRate.toFixed(2),
          subtotal: subtotal.toFixed(2),
          discountAmount: discountAmount.toFixed(2),
          taxAmount: taxAmount.toFixed(2),
          grandTotal: grandTotal.toFixed(2),
          totalCost: totalCost.toFixed(2),
        },
        include: {
          customer: { select: { id: true, code: true, nameAr: true } },
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
      include: { customer: true },
    });
    if (!existing) throw new NotFoundError({ id });
    if (existing.status !== "DRAFT") {
      throw new ValidationError({ reason: "invoice_not_draft", status: existing.status });
    }

    const grandTotal = new Decimal(existing.grandTotal.toString());
    const subtotal = new Decimal(existing.subtotal.toString());
    const taxAmount = new Decimal(existing.taxAmount.toString());
    const totalCost = new Decimal(existing.totalCost.toString());
    const invoiceNumber = existing.invoiceNumber.toString();

    // Validate accounts
    const arAccount = await this.prisma.account.findUnique({ where: { id: body.arAccountId } });
    if (!arAccount || !arAccount.active || !arAccount.isLeaf) {
      throw new ValidationError({ reason: "invalid_ar_account", id: body.arAccountId });
    }

    const revenueAccount = await this.prisma.account.findUnique({
      where: { id: body.revenueAccountId },
    });
    if (!revenueAccount || !revenueAccount.active || !revenueAccount.isLeaf) {
      throw new ValidationError({ reason: "invalid_revenue_account", id: body.revenueAccountId });
    }

    if (taxAmount.gt(0) && body.postJournalEntry) {
      if (!body.taxAccountId) {
        throw new ValidationError({ reason: "tax_account_required_when_tax_exists" });
      }
      const taxAccount = await this.prisma.account.findUnique({
        where: { id: body.taxAccountId },
      });
      if (!taxAccount || !taxAccount.active || !taxAccount.isLeaf) {
        throw new ValidationError({ reason: "invalid_tax_account", id: body.taxAccountId });
      }
    }

    if (body.postCogs) {
      if (!body.cogsAccountId || !body.inventoryAccountId) {
        throw new ValidationError({ reason: "cogs_accounts_required_when_post_cogs" });
      }
      const cogsAccount = await this.prisma.account.findUnique({
        where: { id: body.cogsAccountId },
      });
      if (!cogsAccount || !cogsAccount.active || !cogsAccount.isLeaf) {
        throw new ValidationError({ reason: "invalid_cogs_account", id: body.cogsAccountId });
      }
      const inventoryAccount = await this.prisma.account.findUnique({
        where: { id: body.inventoryAccountId },
      });
      if (!inventoryAccount || !inventoryAccount.active || !inventoryAccount.isLeaf) {
        throw new ValidationError({
          reason: "invalid_inventory_account",
          id: body.inventoryAccountId,
        });
      }
    }

    return this.prisma.runInTransaction(async (tx) => {
      // 1. Create CustomerTransaction (always)
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

      // 2. Create JournalEntry #1 (Revenue & Receivables)
      let journalEntry: { id: string } | null = null;
      if (body.postJournalEntry) {
        // Build lines
        const jeLines: Array<{ accountId: string; debit: string; credit: string; note: string }> = [];

        jeLines.push({
          accountId: body.arAccountId,
          debit: grandTotal.toFixed(2),
          credit: "0.00",
          note: `مديونية ${existing.customer.nameAr} - SI-${invoiceNumber}`,
        });

        jeLines.push({
          accountId: body.revenueAccountId,
          debit: "0.00",
          credit: subtotal.toFixed(2),
          note: `إيرادات مبيعات - SI-${invoiceNumber}`,
        });

        if (taxAmount.gt(0) && body.taxAccountId) {
          jeLines.push({
            accountId: body.taxAccountId,
            debit: "0.00",
            credit: taxAmount.toFixed(2),
            note: `ضريبة قيمة مضافة - SI-${invoiceNumber}`,
          });
        }

        // Assert balance
        const totalDebit = jeLines.reduce((a, l) => a.add(l.debit), new Decimal(0));
        const totalCredit = jeLines.reduce((a, l) => a.add(l.credit), new Decimal(0));
        if (!totalDebit.eq(totalCredit)) {
          throw new ValidationError({ reason: "unbalanced" });
        }

        journalEntry = await tx.journalEntry.create({
          data: {
            entryType: "RECEIPT",
            reference: `SI-${invoiceNumber}`,
            entryDate: existing.invoiceDate,
            description: `فاتورة مبيعات رقم ${invoiceNumber} — ${existing.customer.nameAr}`,
            referenceType: "sales_invoice",
            referenceId: existing.id,
            createdBy: user.id,
            lines: {
              create: jeLines.map((l) => ({
                accountId: l.accountId,
                debit: l.debit,
                credit: l.credit,
                note: l.note,
              })),
            },
          },
        });
      }

      // 3. Create JournalEntry #2 (COGS) if requested
      let cogsJournalEntry: { id: string } | null = null;
      if (body.postCogs && body.cogsAccountId && body.inventoryAccountId) {
        cogsJournalEntry = await tx.journalEntry.create({
          data: {
            entryType: "JOURNAL",
            reference: `SI-${invoiceNumber}-COGS`,
            entryDate: existing.invoiceDate,
            description: `تكلفة البضاعة المباعة - فاتورة ${invoiceNumber}`,
            referenceType: "sales_invoice",
            referenceId: existing.id,
            createdBy: user.id,
            lines: {
              create: [
                {
                  accountId: body.cogsAccountId,
                  debit: totalCost.toFixed(2),
                  credit: "0.00",
                  note: `تكلفة مبيعات - SI-${invoiceNumber}`,
                },
                {
                  accountId: body.inventoryAccountId,
                  debit: "0.00",
                  credit: totalCost.toFixed(2),
                  note: `صرف من المخزون - SI-${invoiceNumber}`,
                },
              ],
            },
          },
        });
      }

      // 4. Update invoice
      const invoice = await tx.salesInvoice.update({
        where: { id },
        data: {
          status: "CONFIRMED",
          customerTxId: customerTx.id,
          journalEntryId: journalEntry?.id ?? null,
          cogsJournalEntryId: cogsJournalEntry?.id ?? null,
          arAccountId: body.arAccountId,
          revenueAccountId: body.revenueAccountId,
          taxAccountId: body.taxAccountId ?? null,
          cogsAccountId: body.cogsAccountId ?? null,
          inventoryAccountId: body.inventoryAccountId ?? null,
        },
        include: {
          customer: { select: { id: true, code: true, nameAr: true } },
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
          journalEntryId: journalEntry?.id ?? null,
          cogsJournalEntryId: cogsJournalEntry?.id ?? null,
          customerTxId: customerTx.id,
        },
        summaryAr: `${user.name} أكّد فاتورة المبيعات رقم ${invoiceNumber} وتم إنشاء القيود المحاسبية`,
        summaryEn: `${user.name} confirmed sales invoice ${invoiceNumber} and created journal entries`,
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
      const grandTotal = new Decimal(existing.grandTotal.toString());

      // If CONFIRMED, create reversal CustomerTransaction
      if (existing.status === "CONFIRMED") {
        await tx.customerTransaction.create({
          data: {
            customerId: existing.customerId,
            type: "ADJUSTMENT",
            direction: "CR",
            amount: grandTotal.toFixed(2),
            date: new Date(),
            reference: `SI-${invoiceNumber}-REV`,
            description: `إلغاء فاتورة مبيعات رقم ${invoiceNumber}`,
            createdBy: user.id,
          },
        });
      }

      await tx.salesInvoice.update({
        where: { id },
        data: { status: "CANCELLED" },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CANCEL",
        entityType: "sales_invoice",
        entityId: id,
        afterSnapshot: { status: "CANCELLED", invoiceNumber, wasConfirmed: existing.status === "CONFIRMED" },
        summaryAr: `${user.name} ألغى فاتورة المبيعات رقم ${invoiceNumber}`,
        summaryEn: `${user.name} cancelled sales invoice ${invoiceNumber}`,
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
