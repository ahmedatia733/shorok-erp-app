import { Body, Controller, Delete, Get, HttpCode, Param, Post, Patch, Query } from "@nestjs/common";
import { Decimal } from "decimal.js";
import {
  CreatePurchaseInvoiceRequestSchema,
  PurchaseInvoiceQuerySchema,
  ConfirmPurchaseInvoiceSchema,
  type CreatePurchaseInvoiceRequest,
  type PurchaseInvoiceQuery,
  type ConfirmPurchaseInvoice,
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
import { weightedAverageCost, unitCostPerBoard } from "./costing";

@Controller("purchase-invoices")
export class PurchaseInvoicesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventoryEngine: InventoryEngine,
    private readonly postingEngine: PostingEngine,
    private readonly reversal: ReversalService,
    private readonly effectiveConfig: EffectiveConfigService,
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

    // Phase 3A (T030): confirm now posts through the PostingEngine.
    // Accounts resolve from the PostingProfile in force on the invoice date;
    // if a slot is missing we TEMPORARILY fall back to the account IDs the
    // current UI still sends (to be removed when the UI is rebuilt in Phase 6).
    // If neither exists, a clear typed error is returned.
    const subtotal   = new Decimal(existing.subtotal.toString());
    const taxAmount  = new Decimal(existing.taxAmount.toString());
    const grandTotal = new Decimal(existing.grandTotal.toString());
    const invoiceNumber = existing.invoiceNumber;
    const invoiceDateStr = existing.invoiceDate.toISOString().slice(0, 10);

    // Accounts resolve ONLY from the effective PostingProfile — never from the
    // client (any account fields on the request are ignored).
    const profile = await this.effectiveConfig.postingProfileAsOf(invoiceDateStr);
    const inventoryAccountId = profile?.inventoryAccountId ?? null;
    const apAccountId        = profile?.apAccountId        ?? null;
    const vatInputAccountId  = profile?.vatInputAccountId  ?? null;

    if (!inventoryAccountId) throw new ValidationError({ reason: "inventory_account_required" });
    if (!apAccountId)        throw new ValidationError({ reason: "accounts_payable_account_required" });
    if (taxAmount.gt(0) && !vatInputAccountId) {
      throw new ValidationError({ reason: "tax_account_required_when_tax_exists" });
    }

    return this.prisma.runInTransaction(async (tx) => {
      // ── 1. Journal entry via PostingEngine (balanced/period/idempotent) ──
      const postingLines: PostingLine[] = [
        { accountId: inventoryAccountId, debit: subtotal.toFixed(2), credit: "0", note: `مخزون — فاتورة مشتريات ${invoiceNumber}` },
      ];
      if (taxAmount.gt(0) && vatInputAccountId) {
        postingLines.push({ accountId: vatInputAccountId, debit: taxAmount.toFixed(2), credit: "0", note: `ضريبة مدخلات — فاتورة مشتريات ${invoiceNumber}` });
      }
      postingLines.push({
        accountId: apAccountId,
        debit: "0",
        credit: grandTotal.toFixed(2),
        note: `ذمة للمورد — فاتورة مشتريات ${invoiceNumber}`,
        partyType: "SUPPLIER",
        partyId: existing.supplierId,
      });

      const posted = await this.postingEngine.post({
        tx,
        actor: user,
        sourceType: "PURCHASE_INVOICE",
        sourceId: existing.id,
        entryType: "PURCHASE_INVOICE",
        entryDate: invoiceDateStr,
        description: `فاتورة مشتريات ${invoiceNumber}`,
        idempotencyKey: `PURCHASE_INVOICE:${existing.id}`,
        lines: postingLines,
      });

      // ── 2. Inventory RECEIPT per line + forward WAC update (same tx) ──────
      for (const line of existing.lines) {
        const boards = new Decimal(line.boardsQuantity.toString());
        if (boards.isZero()) continue;

        // WAC uses the global on-hand BEFORE this receipt; avg_cost builds
        // forward from 0 (Phase 4 owns opening cost). Cost basis is ex-tax.
        const unitCost = unitCostPerBoard(line.lineTotal.toString(), boards);
        const agg = await tx.branchInventoryBalance.aggregate({
          _sum: { boardsOnHand: true },
          where: { productVariantId: line.productVariantId },
        });
        const onHand = new Decimal(agg._sum.boardsOnHand?.toString() ?? "0");
        const variant = await tx.productVariant.findUnique({
          where: { id: line.productVariantId },
          select: { avgCost: true },
        });
        const newAvg = weightedAverageCost(onHand, variant?.avgCost.toString() ?? "0", boards, unitCost);

        await this.inventoryEngine.apply({
          branchId: existing.branchId,
          productVariantId: line.productVariantId,
          movementType: "RECEIPT",
          boardsDelta: boards,
          reference: { type: "purchase_invoice", id: existing.id },
          actor: user,
          summaryAr: `استلام مخزون — فاتورة مشتريات ${invoiceNumber}`,
          summaryEn: `Stock receipt — purchase invoice ${invoiceNumber}`,
          humanReadableNote: `فاتورة مشتريات ${invoiceNumber}`,
          tx,
        });

        await tx.productVariant.update({
          where: { id: line.productVariantId },
          data: { avgCost: newAvg.toFixed(4), costUpdatedAt: new Date() },
        });
        await tx.purchaseInvoiceLine.update({
          where: { id: line.id },
          data: { unitCostAtPosting: unitCost.toFixed(2), taxRateAtPosting: line.taxRate },
        });
      }

      // ── 3. Update invoice status + save resolved account links ────────────
      const invoice = await tx.purchaseInvoice.update({
        where: { id },
        data: {
          status:             "CONFIRMED",
          apAccountId,
          taxAccountId:       vatInputAccountId,
          inventoryAccountId,
          journalEntryId:     posted.journalEntryId,
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
          journalEntryId: posted.journalEntryId,
          entryNumber: posted.entryNumber,
          apAccountId,
          taxAccountId: vatInputAccountId,
          inventoryAccountId,
        },
        summaryAr: `${user.name} أكّد فاتورة المشتريات رقم ${invoiceNumber} وتم ترحيل القيد وتحديث المخزون`,
        summaryEn: `${user.name} confirmed purchase invoice ${invoiceNumber} — posted entry and updated inventory`,
      });

      return this.formatInvoice(invoice);
    });
  }

  // ─── POST /purchase-invoices/:id/cancel ───────────────────────────────

  @Post(":id/cancel")
  @Roles("OWNER")
  async cancel(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    const existing = await this.prisma.purchaseInvoice.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!existing) throw new NotFoundError({ id });
    if (existing.status !== "DRAFT" && existing.status !== "CONFIRMED") {
      throw new ValidationError({ reason: "cannot_cancel", status: existing.status });
    }

    return this.prisma.runInTransaction(async (tx) => {
      const invoiceNumber = existing.invoiceNumber;

      if (existing.status === "CONFIRMED") {
        // Reverse the purchase journal entry — never delete a posted entry
        // (Constitution VII). The original stays linked to the invoice (now
        // REVERSED); a mirror entry created through the engine nets it to zero.
        if (existing.journalEntryId) {
          await this.reversal.reverse({
            entryId: existing.journalEntryId,
            reason: `إلغاء فاتورة مشتريات ${invoiceNumber}`,
            actor: user,
            tx,
          });
        }

        // Hotfix T001 (Constitution I & VI): stock reversal goes through the
        // InventoryEngine as compensating negative movements instead of
        // deleting movement rows — history stays intact and the balance row
        // is actually decremented. The engine blocks the cancel if the stock
        // has already been consumed.
        // Guard: invoices confirmed BEFORE this hotfix wrote movement rows
        // WITHOUT a balance update; reversing those would corrupt balances.
        // Engine-applied movements always have a same-transaction audit row
        // (entity_type=inventory_movement) — only those are reversed here.
        const receipts = await tx.inventoryMovement.findMany({
          where: { referenceType: "purchase_invoice", referenceId: id, movementType: "RECEIPT" },
        });
        const audited = await tx.auditLog.findMany({
          where: { entityType: "inventory_movement", entityId: { in: receipts.map((r) => r.id) } },
          select: { entityId: true },
        });
        const engineApplied = new Set(audited.map((a) => a.entityId));
        for (const receipt of receipts.filter((r) => engineApplied.has(r.id))) {
          const boards = new Decimal(receipt.boardsQuantity.toString());
          if (boards.isZero()) continue;
          await this.inventoryEngine.apply({
            branchId: receipt.branchId,
            productVariantId: receipt.productVariantId,
            movementType: "ADJUSTMENT",
            boardsDelta: boards.negated(),
            reference: { type: "purchase_invoice_cancel", id },
            actor: user,
            summaryAr: `إلغاء استلام مخزون — فاتورة مشتريات ${invoiceNumber}`,
            summaryEn: `Reverse stock receipt — cancelled purchase invoice ${invoiceNumber}`,
            humanReadableNote: `إلغاء فاتورة مشتريات ${invoiceNumber}`,
            tx,
          });
        }
      }

      // Mark cancelled only after the reversal + stock compensation succeed;
      // keep journalEntryId linked to the (now REVERSED) original entry.
      await tx.purchaseInvoice.update({ where: { id }, data: { status: "CANCELLED" } });

      await this.audit.write({
        tx,
        actorId: user.id,
        action:  "CANCEL",
        entityType: "purchase_invoice",
        entityId: id,
        afterSnapshot: { status: "CANCELLED", invoiceNumber, wasConfirmed: existing.status === "CONFIRMED" },
        summaryAr: `${user.name} ألغى فاتورة المشتريات رقم ${invoiceNumber} وعكس القيود المحاسبية والمخزون`,
        summaryEn: `${user.name} cancelled purchase invoice ${invoiceNumber} and reversed all accounting + inventory entries`,
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
