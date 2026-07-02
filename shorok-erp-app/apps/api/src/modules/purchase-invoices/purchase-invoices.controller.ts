import { Body, Controller, Delete, Get, HttpCode, Param, Post, Patch, Query } from "@nestjs/common";
import { Decimal } from "decimal.js";
import {
  CreatePurchaseInvoiceRequestSchema,
  PurchaseInvoiceQuerySchema,
  ConfirmPurchaseInvoiceSchema,
  type CreatePurchaseInvoiceRequest,
  type PurchaseInvoiceQuery,
  type ConfirmPurchaseInvoice,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

@Controller("purchase-invoices")
export class PurchaseInvoicesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private formatInvoice(inv: any) {
    return {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      dueDate: inv.dueDate ?? null,
      supplierId: inv.supplierId,
      supplierNameAr: inv.supplier?.nameAr ?? "",
      supplierNameEn: inv.supplier?.nameEn ?? "",
      branchId: inv.branchId,
      branchNameAr: inv.branch?.nameAr ?? "",
      branchNameEn: inv.branch?.nameEn ?? "",
      factoryLedgerEntryId: inv.factoryLedgerEntryId ?? null,
      basedOn: inv.basedOn ?? null,
      docDirection: inv.docDirection ?? null,
      customsNumber: inv.customsNumber ?? null,
      notes: inv.notes ?? null,
      status: inv.status,
      subtotal: inv.subtotal.toFixed(2),
      taxAmount: inv.taxAmount.toFixed(2),
      grandTotal: inv.grandTotal.toFixed(2),
      apAccountId:        inv.apAccountId        ?? null,
      taxAccountId:       inv.taxAccountId       ?? null,
      inventoryAccountId: inv.inventoryAccountId ?? null,
      journalEntryId:     inv.journalEntryId     ?? null,
      createdAt: inv.createdAt,
      createdByName: inv.creator?.name ?? "",
      lines: (inv.lines ?? []).map((l: any) => ({
        id: l.id,
        productVariantId: l.productVariantId,
        skuCode: l.productVariant?.sku?.code ?? "",
        skuNameAr: l.productVariant?.sku?.colorNameAr ?? "",
        skuNameEn: l.productVariant?.sku?.colorNameEn ?? "",
        sizeMetersPerBoard: l.productVariant?.sizeMetersPerBoard?.toString() ?? "",
        colorCode: l.colorCode ?? null,
        boardsQuantity: l.boardsQuantity.toString(),
        lengthM: l.lengthM?.toString() ?? null,
        widthM: l.widthM?.toString() ?? null,
        heightM: l.heightM?.toString() ?? null,
        metersQuantity: l.metersQuantity.toString(),
        unitLabel: l.unitLabel ?? null,
        unitPrice: l.unitPrice.toString(),
        lineTotal: l.lineTotal.toString(),
        taxRate: l.taxRate.toString(),
        taxAmount: l.taxAmount.toString(),
        isFree: l.isFree,
      })),
    };
  }

  private async generateInvoiceNumber(year: number): Promise<string> {
    const prefix = `PI-${year}-`;
    const result = await this.prisma.$queryRaw<Array<{ max_num: string | null }>>`
      SELECT MAX(invoice_number) as max_num
      FROM purchase_invoices
      WHERE invoice_number LIKE ${prefix + "%"}
    `;
    const maxNum = result[0]?.max_num;
    let next = 1;
    if (maxNum) {
      const parts = maxNum.split("-");
      const lastPart = parts[parts.length - 1];
      next = parseInt(lastPart, 10) + 1;
    }
    return `${prefix}${String(next).padStart(4, "0")}`;
  }

  @Get()
  @Roles("OWNER", "ACCOUNTANT")
  async list(@Query(new ZodValidationPipe(PurchaseInvoiceQuerySchema)) query: PurchaseInvoiceQuery) {
    const where: any = {
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
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

    const rows = await this.prisma.purchaseInvoice.findMany({
      where,
      orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        supplier: { select: { id: true, nameAr: true, nameEn: true } },
        branch: { select: { id: true, nameAr: true, nameEn: true } },
        creator: { select: { id: true, name: true } },
        lines: {
          include: { productVariant: { include: { sku: true } } },
        },
      },
    });

    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return {
      data: data.map((inv) => this.formatInvoice(inv)),
      nextCursor,
    };
  }

  @Get(":id")
  @Roles("OWNER", "ACCOUNTANT")
  async getOne(@Param("id") id: string) {
    const inv = await this.prisma.purchaseInvoice.findUnique({
      where: { id },
      include: {
        supplier: { select: { id: true, nameAr: true, nameEn: true } },
        branch: { select: { id: true, nameAr: true, nameEn: true } },
        creator: { select: { id: true, name: true } },
        lines: {
          include: { productVariant: { include: { sku: true } } },
        },
      },
    });
    if (!inv) throw new NotFoundError({ id });
    return this.formatInvoice(inv);
  }

  @Post()
  @Roles("OWNER", "ACCOUNTANT")
  async create(
    @Body(new ZodValidationPipe(CreatePurchaseInvoiceRequestSchema)) body: CreatePurchaseInvoiceRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id: body.supplierId } });
    if (!supplier || !supplier.active) throw new NotFoundError({ supplierId: body.supplierId });

    const branch = await this.prisma.branch.findUnique({ where: { id: body.branchId } });
    if (!branch || !branch.active) throw new NotFoundError({ branchId: body.branchId });

    // Validate all variants and compute line totals
    const lineData: Array<{
      productVariantId: string;
      colorCode: string | null;
      boardsQuantity: Decimal;
      lengthM: Decimal | null;
      widthM: Decimal | null;
      heightM: Decimal | null;
      metersQuantity: Decimal;
      unitLabel: string | null;
      unitPrice: Decimal;
      lineTotal: Decimal;
      taxRate: Decimal;
      taxAmount: Decimal;
      isFree: boolean;
    }> = [];

    for (const line of body.lines) {
      const variant = await this.prisma.productVariant.findUnique({
        where: { id: line.productVariantId },
      });
      if (!variant || !variant.active) {
        throw new NotFoundError({ productVariantId: line.productVariantId });
      }

      const boardsQty = new Decimal(line.boardsQuantity);
      const lengthM = line.lengthM ? new Decimal(line.lengthM) : null;
      const widthM = line.widthM ? new Decimal(line.widthM) : null;

      let metersQty: Decimal;
      if (lengthM) {
        metersQty = boardsQty.mul(lengthM).mul(widthM ?? new Decimal(1));
      } else {
        metersQty = boardsQty.mul(variant.sizeMetersPerBoard.toString());
      }

      const unitPrice = new Decimal(line.unitPrice);
      const taxRate = new Decimal(line.taxRate);

      let lineTotal: Decimal;
      let lineTaxAmount: Decimal;
      if (line.isFree) {
        lineTotal = new Decimal(0);
        lineTaxAmount = new Decimal(0);
      } else {
        lineTotal = metersQty.mul(unitPrice);
        lineTaxAmount = lineTotal.mul(taxRate).div(100);
      }

      lineData.push({
        productVariantId: line.productVariantId,
        colorCode: line.colorCode ?? null,
        boardsQuantity: boardsQty,
        lengthM,
        widthM,
        heightM: line.heightM ? new Decimal(line.heightM) : null,
        metersQuantity: metersQty,
        unitLabel: line.unitLabel ?? null,
        unitPrice,
        lineTotal,
        taxRate,
        taxAmount: lineTaxAmount,
        isFree: line.isFree,
      });
    }

    const subtotal = lineData.reduce((acc, l) => acc.add(l.lineTotal), new Decimal(0));
    const totalTax = lineData.reduce((acc, l) => acc.add(l.taxAmount), new Decimal(0));
    const grandTotal = subtotal.add(totalTax);

    return this.prisma.runInTransaction(async (tx) => {
      const year = new Date(body.invoiceDate).getFullYear();
      const invoiceNumber = await this.generateInvoiceNumber(year);

      const invoice = await tx.purchaseInvoice.create({
        data: {
          invoiceNumber,
          invoiceDate: new Date(body.invoiceDate),
          dueDate: body.dueDate ? new Date(body.dueDate) : null,
          supplierId: body.supplierId,
          branchId: body.branchId,
          factoryLedgerEntryId: body.factoryLedgerEntryId ?? null,
          basedOn: body.basedOn ?? null,
          docDirection: body.docDirection ?? null,
          customsNumber: body.customsNumber ?? null,
          notes: body.notes ?? null,
          status: "DRAFT",
          subtotal: subtotal.toFixed(2),
          taxAmount: totalTax.toFixed(2),
          grandTotal: grandTotal.toFixed(2),
          createdBy: user.id,
          lines: {
            create: lineData.map((l) => ({
              productVariantId: l.productVariantId,
              colorCode: l.colorCode,
              boardsQuantity: l.boardsQuantity.toFixed(4),
              lengthM: l.lengthM ? l.lengthM.toFixed(4) : null,
              widthM: l.widthM ? l.widthM.toFixed(4) : null,
              heightM: l.heightM ? l.heightM.toFixed(4) : null,
              metersQuantity: l.metersQuantity.toFixed(4),
              unitLabel: l.unitLabel,
              unitPrice: l.unitPrice.toFixed(2),
              lineTotal: l.lineTotal.toFixed(2),
              taxRate: l.taxRate.toFixed(2),
              taxAmount: l.taxAmount.toFixed(2),
              isFree: l.isFree,
            })),
          },
        },
        include: {
          supplier: { select: { id: true, nameAr: true, nameEn: true } },
          branch: { select: { id: true, nameAr: true, nameEn: true } },
          lines: {
            include: { productVariant: { include: { sku: true } } },
          },
        },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "purchase_invoice",
        entityId: invoice.id,
        afterSnapshot: {
          invoiceNumber: invoice.invoiceNumber,
          supplierId: body.supplierId,
          branchId: body.branchId,
          grandTotal: grandTotal.toFixed(2),
          linesCount: lineData.length,
        },
        summaryAr: `${user.name} أنشأ فاتورة مشتريات رقم ${invoice.invoiceNumber} — إجمالي: ${grandTotal.toFixed(2)} ج.م`,
        summaryEn: `${user.name} created purchase invoice ${invoice.invoiceNumber} — total: ${grandTotal.toFixed(2)} EGP`,
      });

      return this.formatInvoice(invoice);
    });
  }

  @Post(":id/confirm")
  @Roles("OWNER")
  async confirm(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ConfirmPurchaseInvoiceSchema)) body: ConfirmPurchaseInvoice,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const existing = await this.prisma.purchaseInvoice.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!existing) throw new NotFoundError({ id });
    if (existing.status !== "DRAFT") {
      throw new ValidationError({ reason: "invoice_not_draft", status: existing.status });
    }

    return this.prisma.runInTransaction(async (tx) => {
      // ── 1. Journal entry: DR Inventory + DR Tax / CR AP ──────────────────
      const subtotal   = new Decimal(existing.subtotal.toString());
      const taxAmount  = new Decimal(existing.taxAmount.toString());
      const grandTotal = new Decimal(existing.grandTotal.toString());
      const invoiceNumber = existing.invoiceNumber;

      const journalLines: Array<{ accountId: string; debit: string; credit: string; note: string }> = [];

      if (body.inventoryAccountId) {
        journalLines.push({
          accountId: body.inventoryAccountId,
          debit:  subtotal.toFixed(2),
          credit: "0",
          note: `مخزون — فاتورة مشتريات ${invoiceNumber}`,
        });
      }

      if (body.taxAccountId && taxAmount.gt(0)) {
        journalLines.push({
          accountId: body.taxAccountId,
          debit:  taxAmount.toFixed(2),
          credit: "0",
          note: `ضريبة مدخلات — فاتورة مشتريات ${invoiceNumber}`,
        });
      }

      journalLines.push({
        accountId: body.apAccountId,
        debit:  "0",
        credit: grandTotal.toFixed(2),
        note: `ذمة للمورد — فاتورة مشتريات ${invoiceNumber}`,
      });

      const journalEntry = await tx.journalEntry.create({
        data: {
          entryType:     "PURCHASE_INVOICE",
          entryDate:     existing.invoiceDate,
          description:   `فاتورة مشتريات ${invoiceNumber}`,
          referenceType: "purchase_invoice",
          referenceId:   existing.id,
          createdBy:     user.id,
          lines: { create: journalLines },
        },
      });

      // ── 2. Inventory movements ────────────────────────────────────────────
      for (const line of existing.lines) {
        await tx.inventoryMovement.create({
          data: {
            branchId:        existing.branchId,
            productVariantId: line.productVariantId,
            movementType:    "RECEIPT",
            boardsQuantity:  line.boardsQuantity,
            metersQuantity:  line.metersQuantity,
            referenceType:   "purchase_invoice",
            referenceId:     existing.id,
            createdBy:       user.id,
            humanReadableNote: `فاتورة مشتريات ${invoiceNumber}`,
          },
        });
      }

      // ── 3. Update invoice status + save account links ─────────────────────
      const invoice = await tx.purchaseInvoice.update({
        where: { id },
        data: {
          status:             "CONFIRMED",
          apAccountId:        body.apAccountId,
          taxAccountId:       body.taxAccountId       ?? null,
          inventoryAccountId: body.inventoryAccountId ?? null,
          journalEntryId:     journalEntry.id,
        },
        include: {
          supplier: { select: { id: true, nameAr: true, nameEn: true } },
          branch:   { select: { id: true, nameAr: true, nameEn: true } },
          lines: { include: { productVariant: { include: { sku: true } } } },
        },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action:  "CONFIRM",
        entityType: "purchase_invoice",
        entityId: id,
        afterSnapshot: {
          status: "CONFIRMED",
          invoiceNumber,
          journalEntryId: journalEntry.id,
          apAccountId:        body.apAccountId,
          taxAccountId:       body.taxAccountId       ?? null,
          inventoryAccountId: body.inventoryAccountId ?? null,
        },
        summaryAr: `${user.name} أكّد فاتورة المشتريات رقم ${invoiceNumber} وتم إنشاء القيد المحاسبي وتحديث المخزون`,
        summaryEn: `${user.name} confirmed purchase invoice ${invoiceNumber} — journal entry and inventory updated`,
      });

      return this.formatInvoice(invoice);
    });
  }

  // ─── POST /purchase-invoices/:id/cancel ───────────────────────────────

  @Post(":id/cancel")
  @Roles("OWNER")
  async cancel(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    const existing = await this.prisma.purchaseInvoice.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError({ id });
    if (existing.status !== "DRAFT" && existing.status !== "CONFIRMED") {
      throw new ValidationError({ reason: "cannot_cancel", status: existing.status });
    }

    return this.prisma.runInTransaction(async (tx) => {
      const invoiceNumber = existing.invoiceNumber;

      // Clear FK references first so we can safely delete journal entry
      await tx.purchaseInvoice.update({
        where: { id },
        data: {
          status:             "CANCELLED",
          journalEntryId:     null,
          apAccountId:        null,
          taxAccountId:       null,
          inventoryAccountId: null,
        },
      });

      if (existing.status === "CONFIRMED") {
        // Delete journal entry (lines cascade via onDelete: Cascade)
        if (existing.journalEntryId) {
          await tx.journalEntry.delete({ where: { id: existing.journalEntryId } });
        }

        // Delete inventory movements
        await tx.inventoryMovement.deleteMany({
          where: { referenceType: "purchase_invoice", referenceId: id },
        });
      }

      await this.audit.write({
        tx,
        actorId: user.id,
        action:  "CANCEL",
        entityType: "purchase_invoice",
        entityId: id,
        afterSnapshot: { status: "CANCELLED", invoiceNumber, wasConfirmed: existing.status === "CONFIRMED" },
        summaryAr: `${user.name} ألغى فاتورة المشتريات رقم ${invoiceNumber} وتم حذف القيود المحاسبية والمخزون`,
        summaryEn: `${user.name} cancelled purchase invoice ${invoiceNumber} and deleted all accounting + inventory entries`,
      });

      return { success: true };
    });
  }

  @Delete(":id")
  @Roles("OWNER")
  @HttpCode(204)
  async remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    const invoice = await this.prisma.purchaseInvoice.findUnique({ where: { id } });
    if (!invoice) throw new NotFoundError({ id });
    if (invoice.status !== "DRAFT") {
      throw new ValidationError({ reason: "only_draft_can_be_deleted", status: invoice.status });
    }

    return this.prisma.runInTransaction(async (tx) => {
      await tx.purchaseInvoice.delete({ where: { id } });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "DELETE",
        entityType: "purchase_invoice",
        entityId: id,
        beforeSnapshot: {
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          grandTotal: invoice.grandTotal.toString(),
        },
        summaryAr: `${user.name} حذف فاتورة المشتريات رقم ${invoice.invoiceNumber}`,
        summaryEn: `${user.name} deleted purchase invoice ${invoice.invoiceNumber}`,
      });
    });
  }
}
