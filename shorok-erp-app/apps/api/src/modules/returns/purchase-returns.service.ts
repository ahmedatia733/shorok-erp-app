import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import type {
  CreatePurchaseReturn, UpdatePurchaseReturn, ReturnQuery, PostingLine,
} from "@shorok/shared";
import { Prisma, PrismaService } from "../../prisma/prisma.service";
import { BranchForbiddenError, NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { AuditService } from "../audit/audit.service";
import { InventoryEngine } from "../inventory/inventory.engine";
import { PostingEngine } from "../posting/posting.engine";
import { ReversalService } from "../posting/reversal.service";
import { EffectiveConfigService } from "../configuration/effective-config.service";
import { ReturnableService } from "./returnable.service";
import { allocateReturn, type OriginalLineEconomics, type AlreadyReturned } from "./return-allocation";

type Tx = Prisma.TransactionClient;
const D = (v: unknown) => new Decimal((v as { toString(): string } | null)?.toString() ?? "0");
const HALF = Decimal.ROUND_HALF_UP;

/**
 * Purchase returns (مردود مشتريات) — independent documents linked to a
 * CONFIRMED purchase invoice; the invoice is never edited. Value uses the
 * ORIGINAL purchase economics (per-metre price/tax), removes the exact metres
 * from stock, and recomputes the per-metre WAC company-wide (the same scope the
 * purchase confirm maintains). Blocks — never invents accounting — when the
 * historical return value would exceed the current inventory carrying value.
 */
@Injectable()
export class PurchaseReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventoryEngine: InventoryEngine,
    private readonly postingEngine: PostingEngine,
    private readonly reversal: ReversalService,
    private readonly effectiveConfig: EffectiveConfigService,
    private readonly returnable: ReturnableService,
  ) {}

  private assertBranch(user: AuthenticatedUser, branchId: string) {
    if (user.role !== "OWNER" && !user.allowedBranches.includes(branchId)) {
      throw new BranchForbiddenError({ branchId });
    }
  }

  private async buildLines(invoiceId: string, reqLines: CreatePurchaseReturn["lines"], tx?: Tx) {
    const { invoice, lines } = await this.returnable.purchaseInvoiceReturnable(invoiceId, tx);
    if (invoice.status !== "CONFIRMED") {
      throw new ValidationError({ reason: "original_invoice_not_confirmed", status: invoice.status });
    }
    const byId = new Map(lines.map((l) => [l.originalLineId, l]));
    const db = tx ?? this.prisma;
    const originalIds = reqLines.map((r) => r.originalPurchaseInvoiceLineId);
    const agg = await db.purchaseReturnLine.groupBy({
      by: ["originalPurchaseInvoiceLineId"],
      where: {
        originalPurchaseInvoiceLineId: { in: originalIds },
        purchaseReturn: { originalPurchaseInvoiceId: invoiceId, status: "CONFIRMED" },
      },
      _sum: { returnedMetersQuantity: true, returnedBoards: true, returnNetExTax: true, returnTax: true },
    });
    const alreadyById = new Map(agg.map((a) => [a.originalPurchaseInvoiceLineId, a._sum]));

    const built = reqLines.map((r) => {
      const orig = byId.get(r.originalPurchaseInvoiceLineId);
      if (!orig) throw new ValidationError({ reason: "line_not_on_invoice", lineId: r.originalPurchaseInvoiceLineId });
      const requestedMeters = new Decimal(r.returnedMeters);
      if (!requestedMeters.isFinite() || requestedMeters.lte(0)) {
        throw new ValidationError({ reason: "return_meters_must_be_positive", lineId: r.originalPurchaseInvoiceLineId });
      }
      const remaining = new Decimal(orig.remainingMeters);
      if (requestedMeters.gt(remaining)) {
        throw new ValidationError({ reason: "over_return", lineId: r.originalPurchaseInvoiceLineId, requestedMeters: requestedMeters.toFixed(4), remainingMeters: remaining.toFixed(4) });
      }
      const requestedBoards = r.returnedBoards != null ? new Decimal(r.returnedBoards) : null;

      const sum = alreadyById.get(r.originalPurchaseInvoiceLineId);
      const net = new Decimal(orig.originalNetExTax);
      const taxRate = new Decimal(orig.originalTaxRate);
      const already: AlreadyReturned = {
        meters: D(sum?.returnedMetersQuantity), boards: D(sum?.returnedBoards),
        gross: D(sum?.returnNetExTax), discount: new Decimal(0),
        net: D(sum?.returnNetExTax), tax: D(sum?.returnTax), cogs: D(sum?.returnNetExTax),
      };
      const o: OriginalLineEconomics = {
        meters: new Decimal(orig.originalMeters), boards: new Decimal(orig.originalBoards),
        gross: net, discount: new Decimal(0), net,
        lineTax: net.mul(taxRate).div(100).toDecimalPlaces(2, HALF),
        lineCogs: net, // inventory value out basis == returned net ex-tax
      };
      const alloc = allocateReturn(o, already, requestedMeters, requestedBoards);
      if (alloc.boards.lte(0)) throw new ValidationError({ reason: "return_boards_must_be_positive", lineId: r.originalPurchaseInvoiceLineId });
      return { req: r, orig, alloc };
    });
    return { invoice, built };
  }

  private totals(built: Array<{ alloc: { net: Decimal; tax: Decimal; total: Decimal } }>) {
    return {
      subtotal: built.reduce((a, x) => a.add(x.alloc.net), new Decimal(0)),
      taxTotal: built.reduce((a, x) => a.add(x.alloc.tax), new Decimal(0)),
      grandTotal: built.reduce((a, x) => a.add(x.alloc.total), new Decimal(0)),
      inventoryValueOut: built.reduce((a, x) => a.add(x.alloc.net), new Decimal(0)),
    };
  }

  async create(body: CreatePurchaseReturn, user: AuthenticatedUser) {
    const inv = await this.prisma.purchaseInvoice.findUnique({ where: { id: body.originalPurchaseInvoiceId } });
    if (!inv) throw new NotFoundError({ originalPurchaseInvoiceId: body.originalPurchaseInvoiceId });
    this.assertBranch(user, inv.branchId);
    if (inv.status !== "CONFIRMED") throw new ValidationError({ reason: "original_invoice_not_confirmed", status: inv.status });

    const { built } = await this.buildLines(body.originalPurchaseInvoiceId, body.lines);
    const t = this.totals(built);

    return this.prisma.runInTransaction(async (tx) => {
      const ret = await tx.purchaseReturn.create({
        data: {
          originalPurchaseInvoiceId: inv.id, supplierId: inv.supplierId, branchId: inv.branchId,
          returnDate: new Date(body.returnDate), status: "DRAFT",
          reason: body.reason ?? null, notes: body.notes ?? null,
          settlementMode: body.settlementMode, refundTreasuryAccountId: body.refundTreasuryAccountId ?? null,
          subtotal: t.subtotal.toFixed(2), taxTotal: t.taxTotal.toFixed(2),
          grandTotal: t.grandTotal.toFixed(2), inventoryValueOut: t.inventoryValueOut.toFixed(2),
          createdBy: user.id,
          lines: { create: built.map((b) => this.lineData(b)) },
        },
        include: { lines: true },
      });
      await this.audit.write({
        tx, actorId: user.id, action: "CREATE", entityType: "purchase_return", entityId: ret.id,
        afterSnapshot: { status: "DRAFT", grandTotal: t.grandTotal.toFixed(2) },
        summaryAr: `${user.name} أنشأ مردود مشتريات رقم ${ret.returnNumber.toString()}`,
        summaryEn: `${user.name} created purchase return ${ret.returnNumber.toString()}`,
      });
      return this.format(ret);
    });
  }

  private lineData(b: { orig: { originalLineId: string; productVariantId: string; originalUnitPrice: string; originalTaxRate: string }; alloc: { meters: Decimal; boards: Decimal; net: Decimal; tax: Decimal; total: Decimal }; req: { originalPurchaseInvoiceLineId: string; reason?: string; note?: string } }) {
    return {
      originalPurchaseInvoiceLineId: b.orig.originalLineId, productVariantId: b.orig.productVariantId,
      returnedBoards: b.alloc.boards.toFixed(4), returnedMetersQuantity: b.alloc.meters.toFixed(4),
      originalPurchasePricePerMeter: new Decimal(b.orig.originalUnitPrice).toFixed(2),
      originalTaxRate: new Decimal(b.orig.originalTaxRate).toFixed(2),
      returnNetExTax: b.alloc.net.toFixed(2), returnTax: b.alloc.tax.toFixed(2), returnTotal: b.alloc.total.toFixed(2),
      historicalInventoryCostPerMeter: new Decimal(b.orig.originalUnitPrice).toFixed(4),
      inventoryValueOut: b.alloc.net.toFixed(2),
      reason: b.req.reason ?? null, note: b.req.note ?? null,
    };
  }

  async update(id: string, body: UpdatePurchaseReturn, user: AuthenticatedUser) {
    const existing = await this.prisma.purchaseReturn.findUnique({ where: { id }, include: { lines: true } });
    if (!existing) throw new NotFoundError({ id });
    this.assertBranch(user, existing.branchId);
    if (existing.status !== "DRAFT") throw new ValidationError({ reason: "return_not_draft", status: existing.status });

    const reqLines = body.lines ?? existing.lines.map((l) => ({
      originalPurchaseInvoiceLineId: l.originalPurchaseInvoiceLineId,
      returnedMeters: D(l.returnedMetersQuantity).toFixed(4), returnedBoards: D(l.returnedBoards).toFixed(4),
      reason: l.reason ?? undefined, note: l.note ?? undefined,
    }));
    const { built } = await this.buildLines(existing.originalPurchaseInvoiceId, reqLines);
    const t = this.totals(built);

    return this.prisma.runInTransaction(async (tx) => {
      await tx.purchaseReturnLine.deleteMany({ where: { purchaseReturnId: id } });
      const ret = await tx.purchaseReturn.update({
        where: { id },
        data: {
          returnDate: body.returnDate ? new Date(body.returnDate) : undefined,
          reason: body.reason ?? undefined, notes: body.notes ?? undefined,
          settlementMode: body.settlementMode ?? undefined,
          refundTreasuryAccountId: body.refundTreasuryAccountId === undefined ? undefined : body.refundTreasuryAccountId,
          subtotal: t.subtotal.toFixed(2), taxTotal: t.taxTotal.toFixed(2),
          grandTotal: t.grandTotal.toFixed(2), inventoryValueOut: t.inventoryValueOut.toFixed(2),
          lines: { create: built.map((b) => this.lineData(b)) },
        },
        include: { lines: true },
      });
      return this.format(ret);
    });
  }

  async confirm(id: string, user: AuthenticatedUser) {
    const pre = await this.prisma.purchaseReturn.findUnique({ where: { id }, include: { lines: true } });
    if (!pre) throw new NotFoundError({ id });
    this.assertBranch(user, pre.branchId);
    if (pre.status !== "DRAFT") throw new ValidationError({ reason: "return_not_draft", status: pre.status });

    const refundMode = pre.settlementMode === "CASH_REFUND" || pre.settlementMode === "BANK_REFUND";
    if (refundMode) {
      if (user.role !== "OWNER") throw new BranchForbiddenError({ reason: "refund_requires_owner" });
      if (!pre.refundTreasuryAccountId) throw new ValidationError({ reason: "refund_treasury_account_required" });
    }

    const returnDateStr = pre.returnDate.toISOString().slice(0, 10);
    const profile = await this.effectiveConfig.postingProfileAsOf(returnDateStr);
    const apAccountId = profile?.apAccountId ?? null;
    const inventoryAccountId = profile?.inventoryAccountId ?? null;
    const vatInputAccountId = profile?.vatInputAccountId ?? null;

    return this.prisma.runInTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_invoices WHERE id = ${pre.originalPurchaseInvoiceId}::uuid FOR UPDATE`;

      const reqLines = pre.lines.map((l) => ({
        originalPurchaseInvoiceLineId: l.originalPurchaseInvoiceLineId,
        returnedMeters: D(l.returnedMetersQuantity).toFixed(4), returnedBoards: D(l.returnedBoards).toFixed(4),
        reason: l.reason ?? undefined, note: l.note ?? undefined,
      }));
      const { built } = await this.buildLines(pre.originalPurchaseInvoiceId, reqLines, tx);
      const t = this.totals(built);

      if (!inventoryAccountId) throw new ValidationError({ reason: "inventory_account_required" });
      if (!refundMode && !apAccountId) throw new ValidationError({ reason: "ap_account_required" });
      if (t.taxTotal.gt(0) && !vatInputAccountId) throw new ValidationError({ reason: "vat_input_account_required" });

      const returnNumber = pre.returnNumber.toString();

      // Inventory removal + per-metre WAC recompute (company-wide scope), line by
      // line so the aggregate reflects each prior removal within this tx.
      for (const { orig, alloc } of built) {
        // Company-wide on-hand BEFORE this removal (same scope as purchase WAC).
        const agg = await tx.branchInventoryBalance.aggregate({
          _sum: { metersOnHand: true, boardsOnHand: true }, where: { productVariantId: orig.productVariantId },
        });
        const curMeters = D(agg._sum.metersOnHand);
        const curBoards = D(agg._sum.boardsOnHand);
        const variant = await tx.productVariant.findUnique({ where: { id: orig.productVariantId }, select: { avgCostPerMeter: true } });
        const curAvgPerMeter = D(variant?.avgCostPerMeter);
        const curValue = curMeters.mul(curAvgPerMeter);
        const returnedValue = alloc.net; // inventoryValueOut at original purchase price

        // No purchase-price-variance mechanism: refuse rather than distort WAC.
        if (returnedValue.gt(curValue.plus(new Decimal("0.005")))) {
          throw new ValidationError({ reason: "purchase_return_exceeds_inventory_value", returnedValue: returnedValue.toFixed(2), currentInventoryValue: curValue.toFixed(2) });
        }
        const newMeters = curMeters.minus(alloc.meters);
        const newBoards = curBoards.minus(alloc.boards);
        const newValue = curValue.minus(returnedValue);
        if (newMeters.isNegative() || newValue.isNegative()) {
          throw new ValidationError({ reason: "insufficient_inventory_for_return", productVariantId: orig.productVariantId });
        }
        const newAvgPerMeter = newMeters.gt(0) ? newValue.div(newMeters) : new Decimal(0);
        const newAvgPerBoard = newBoards.gt(0) ? newValue.div(newBoards) : new Decimal(0);
        await tx.productVariant.update({
          where: { id: orig.productVariantId },
          data: { avgCostPerMeter: newAvgPerMeter.toFixed(4), avgCost: newAvgPerBoard.toFixed(4), costUpdatedAt: new Date() },
        });
        // Physical removal from the return's branch (engine hard-blocks negative).
        await this.inventoryEngine.apply({
          branchId: pre.branchId, productVariantId: orig.productVariantId, movementType: "PURCHASE_RETURN",
          boardsDelta: alloc.boards.negated().toFixed(4), metersDelta: alloc.meters.negated().toFixed(4),
          reference: { type: "purchase_return", id: pre.id }, actor: user,
          summaryAr: `مردود مشتريات — خصم من المخزون ${returnNumber}`, summaryEn: `Purchase return — stock out ${returnNumber}`,
          humanReadableNote: `مردود مشتريات ${returnNumber}`, tx,
        });
      }

      // Journal: Dr AP[supplier] OR Dr Treasury (refund); Cr Inventory + Cr VAT-input.
      const debitAccountId = refundMode ? pre.refundTreasuryAccountId! : apAccountId!;
      const lines: PostingLine[] = [
        refundMode
          ? { accountId: debitAccountId, debit: t.grandTotal.toFixed(2), credit: "0", note: `استرداد نقدي من المورد - PR-${returnNumber}` }
          : { accountId: debitAccountId, debit: t.grandTotal.toFixed(2), credit: "0", note: `خصم من المورد - PR-${returnNumber}`, partyType: "SUPPLIER", partyId: pre.supplierId },
        { accountId: inventoryAccountId, debit: "0", credit: t.inventoryValueOut.toFixed(2), note: `إخراج من المخزون - PR-${returnNumber}` },
      ];
      if (t.taxTotal.gt(0) && vatInputAccountId) {
        lines.push({ accountId: vatInputAccountId, debit: "0", credit: t.taxTotal.toFixed(2), note: `عكس ض.ق.م مشتريات - PR-${returnNumber}` });
      }
      const posted = await this.postingEngine.post({
        tx, actor: user, sourceType: "PURCHASE_RETURN", sourceId: pre.id, entryType: "JOURNAL",
        entryDate: returnDateStr, reference: `PR-${returnNumber}`,
        description: `مردود مشتريات رقم ${returnNumber}`, idempotencyKey: `PURCHASE_RETURN:${pre.id}`, lines,
      });

      // Rewrite authoritative lines (with correct tax rate snapshot).
      await tx.purchaseReturnLine.deleteMany({ where: { purchaseReturnId: id } });
      for (const { req, orig, alloc } of built) {
        await tx.purchaseReturnLine.create({
          data: {
            purchaseReturnId: id, originalPurchaseInvoiceLineId: orig.originalLineId, productVariantId: orig.productVariantId,
            returnedBoards: alloc.boards.toFixed(4), returnedMetersQuantity: alloc.meters.toFixed(4),
            originalPurchasePricePerMeter: new Decimal(orig.originalUnitPrice).toFixed(2),
            originalTaxRate: new Decimal(orig.originalTaxRate).toFixed(2),
            returnNetExTax: alloc.net.toFixed(2), returnTax: alloc.tax.toFixed(2), returnTotal: alloc.total.toFixed(2),
            historicalInventoryCostPerMeter: new Decimal(orig.originalUnitPrice).toFixed(4), inventoryValueOut: alloc.net.toFixed(2),
            reason: req.reason ?? null, note: req.note ?? null,
          },
        });
      }

      const ret = await tx.purchaseReturn.update({
        where: { id },
        data: {
          status: "CONFIRMED",
          subtotal: t.subtotal.toFixed(2), taxTotal: t.taxTotal.toFixed(2),
          grandTotal: t.grandTotal.toFixed(2), inventoryValueOut: t.inventoryValueOut.toFixed(2),
          journalEntryId: posted.journalEntryId, confirmedAt: new Date(), confirmedBy: user.id,
        },
        include: { lines: true },
      });
      await this.audit.write({
        tx, actorId: user.id, action: "CONFIRM", entityType: "purchase_return", entityId: id,
        afterSnapshot: { status: "CONFIRMED", returnNumber, grandTotal: t.grandTotal.toFixed(2), inventoryValueOut: t.inventoryValueOut.toFixed(2), journalEntryId: posted.journalEntryId },
        summaryAr: `${user.name} أكّد مردود المشتريات رقم ${returnNumber}`,
        summaryEn: `${user.name} confirmed purchase return ${returnNumber}`,
      });
      return this.format(ret);
    });
  }

  async cancel(id: string, reason: string | undefined, user: AuthenticatedUser) {
    const existing = await this.prisma.purchaseReturn.findUnique({ where: { id }, include: { lines: true } });
    if (!existing) throw new NotFoundError({ id });
    this.assertBranch(user, existing.branchId);
    if (existing.status !== "CONFIRMED") throw new ValidationError({ reason: "return_not_confirmed", status: existing.status });

    const returnNumber = existing.returnNumber.toString();
    return this.prisma.runInTransaction(async (tx) => {
      if (existing.journalEntryId) {
        await this.reversal.reverse({ entryId: existing.journalEntryId, reason: `إلغاء مردود مشتريات ${returnNumber}`, actor: user, tx });
      }
      // Add the removed stock back + reverse the WAC effect deterministically:
      // put the exact returned value + metres back (company-wide scope).
      for (const l of existing.lines) {
        const agg = await tx.branchInventoryBalance.aggregate({ _sum: { metersOnHand: true, boardsOnHand: true }, where: { productVariantId: l.productVariantId } });
        const curMeters = D(agg._sum.metersOnHand);
        const curBoards = D(agg._sum.boardsOnHand);
        const variant = await tx.productVariant.findUnique({ where: { id: l.productVariantId }, select: { avgCostPerMeter: true } });
        const curValue = curMeters.mul(D(variant?.avgCostPerMeter));
        const backMeters = D(l.returnedMetersQuantity);
        const backBoards = D(l.returnedBoards);
        const backValue = D(l.inventoryValueOut);
        const newMeters = curMeters.plus(backMeters);
        const newBoards = curBoards.plus(backBoards);
        const newValue = curValue.plus(backValue);
        await tx.productVariant.update({
          where: { id: l.productVariantId },
          data: {
            avgCostPerMeter: newMeters.gt(0) ? newValue.div(newMeters).toFixed(4) : "0",
            avgCost: newBoards.gt(0) ? newValue.div(newBoards).toFixed(4) : "0",
            costUpdatedAt: new Date(),
          },
        });
        await this.inventoryEngine.apply({
          branchId: existing.branchId, productVariantId: l.productVariantId, movementType: "PURCHASE_RETURN",
          boardsDelta: backBoards.toFixed(4), metersDelta: backMeters.toFixed(4),
          reference: { type: "purchase_return_cancel", id: existing.id }, actor: user,
          summaryAr: `إلغاء مردود مشتريات — إعادة للمخزون ${returnNumber}`, summaryEn: `Cancel purchase return restock ${returnNumber}`,
          humanReadableNote: `إلغاء مردود مشتريات ${returnNumber}`, tx,
        });
      }
      const ret = await tx.purchaseReturn.update({
        where: { id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: user.id, cancellationReason: reason ?? null },
        include: { lines: true },
      });
      await this.audit.write({
        tx, actorId: user.id, action: "CANCEL", entityType: "purchase_return", entityId: id,
        beforeSnapshot: { status: "CONFIRMED" }, afterSnapshot: { status: "CANCELLED", reason: reason ?? null },
        summaryAr: `${user.name} ألغى مردود المشتريات رقم ${returnNumber}`,
        summaryEn: `${user.name} cancelled purchase return ${returnNumber}`,
      });
      return this.format(ret);
    });
  }

  async list(query: ReturnQuery, user: AuthenticatedUser) {
    const where: Prisma.PurchaseReturnWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(user.role !== "OWNER" ? { branchId: { in: user.allowedBranches } } : {}),
      ...(query.from || query.to ? { returnDate: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } } : {}),
    };
    const rows = await this.prisma.purchaseReturn.findMany({
      where, include: { lines: true, supplier: { select: { id: true, nameAr: true } } },
      orderBy: [{ returnDate: "desc" }, { returnNumber: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return { items: items.map((r) => this.format(r)), nextCursor: hasMore ? items[items.length - 1]!.id : null };
  }

  async get(id: string, user: AuthenticatedUser) {
    const ret = await this.prisma.purchaseReturn.findUnique({
      where: { id },
      include: {
        lines: { include: { productVariant: { include: { sku: { select: { code: true, colorNameAr: true } } } } } },
        supplier: { select: { id: true, nameAr: true } },
        branch: { select: { id: true, nameAr: true } },
        originalInvoice: { select: { id: true, invoiceNumber: true } },
      },
    });
    if (!ret) throw new NotFoundError({ id });
    this.assertBranch(user, ret.branchId);
    return this.format(ret);
  }

  async returnableForInvoice(invoiceId: string, user: AuthenticatedUser) {
    const data = await this.returnable.purchaseInvoiceReturnable(invoiceId);
    this.assertBranch(user, data.invoice.branchId);
    return data;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private format(r: any) {
    return { ...r, returnNumber: r.returnNumber?.toString() };
  }
}
