import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import type {
  CreatePurchaseReturn, UpdatePurchaseReturn, ReturnQuery, PostingLine,
} from "@shorok/shared";
import { Prisma, PrismaService } from "../../prisma/prisma.service";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { AuditService } from "../audit/audit.service";
import { InventoryEngine } from "../inventory/inventory.engine";
import { PostingEngine } from "../posting/posting.engine";
import { ReversalService } from "../posting/reversal.service";
import { EffectiveConfigService } from "../configuration/effective-config.service";
import { ReturnableService } from "./returnable.service";
import { allocateReturn, type OriginalLineEconomics, type AlreadyReturned } from "./return-allocation";
import { patchText, newText } from "./text-fields";

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

  // Non-owner access to a branch outside allowedBranches → 404 (no existence
  // leak); explicit foreign branchId params are 403'd by the global guard (§3).
  private assertBranch(user: AuthenticatedUser, branchId: string, notFound: Record<string, unknown> = {}) {
    if (user.role !== "OWNER" && !user.allowedBranches.includes(branchId)) {
      throw new NotFoundError(notFound);
    }
  }

  private async buildLines(invoiceId: string, reqLines: CreatePurchaseReturn["lines"], tx?: Tx) {
    const { invoice, lines } = await this.returnable.purchaseInvoiceReturnable(invoiceId, tx);
    if (invoice.status !== "CONFIRMED") {
      throw new ValidationError({ reason: "original_invoice_not_confirmed", status: invoice.status });
    }
    const byId = new Map(lines.map((l) => [l.originalLineId, l]));
    const dupCheck = new Set<string>();
    for (const r of reqLines) {
      if (dupCheck.has(r.originalPurchaseInvoiceLineId)) {
        throw new ValidationError({ reason: "duplicate_original_line", lineId: r.originalPurchaseInvoiceLineId });
      }
      dupCheck.add(r.originalPurchaseInvoiceLineId);
    }
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
      const remainingBoards = new Decimal(orig.remainingBoards);
      const requestedBoards = r.returnedBoards != null ? new Decimal(r.returnedBoards) : null;
      if (requestedBoards != null) {
        if (!requestedBoards.isFinite() || requestedBoards.lte(0)) {
          throw new ValidationError({ reason: "return_boards_must_be_positive", lineId: r.originalPurchaseInvoiceLineId });
        }
        if (requestedBoards.gt(remainingBoards.plus(new Decimal("0.0001")))) {
          throw new ValidationError({ reason: "over_return_boards", lineId: r.originalPurchaseInvoiceLineId, requestedBoards: requestedBoards.toFixed(4), remainingBoards: remainingBoards.toFixed(4) });
        }
      }

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
          reason: newText(body.reason), notes: newText(body.notes),
          settlementMode: body.settlementMode,
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

  private lineData(b: Awaited<ReturnType<PurchaseReturnsService["buildLines"]>>["built"][number]) {
    return {
      originalPurchaseInvoiceLineId: b.orig.originalLineId, productVariantId: b.orig.productVariantId,
      lengthM: b.orig.lengthM, widthM: b.orig.widthM,
      returnedBoards: b.alloc.boards.toFixed(4), returnedMetersQuantity: b.alloc.meters.toFixed(4),
      originalPurchasePricePerMeter: new Decimal(b.orig.originalUnitPrice).toFixed(2),
      originalTaxRate: new Decimal(b.orig.originalTaxRate).toFixed(2),
      returnNetExTax: b.alloc.net.toFixed(2), returnTax: b.alloc.tax.toFixed(2), returnTotal: b.alloc.total.toFixed(2),
      historicalInventoryCostPerMeter: new Decimal(b.orig.originalUnitPrice).toFixed(4),
      inventoryValueOut: b.alloc.net.toFixed(2),
      reason: newText(b.req.reason), note: newText(b.req.note),
    };
  }

  /**
   * §3 — remove (sign −1, confirm) or restore (sign +1, cancel) purchase-return
   * stock AND recompute the per-metre WAC company-wide, at the ORIGINAL purchase
   * value. Variants are locked FOR UPDATE in sorted id order. On removal, refuses
   * (no PPV mechanism) when the historical value exceeds the carrying value, and
   * blocks any negative metres/boards/value.
   */
  private async applyPurchaseReturnToStock(
    tx: Tx,
    lines: Array<{ variantId: string; meters: Decimal; boards: Decimal; value: Decimal }>,
    branchId: string,
    user: AuthenticatedUser,
    returnNumber: string,
    sign: 1 | -1,
    refId: string,
  ) {
    const groups = new Map<string, { meters: Decimal; boards: Decimal; value: Decimal; items: typeof lines }>();
    for (const l of lines) {
      const g = groups.get(l.variantId) ?? { meters: new Decimal(0), boards: new Decimal(0), value: new Decimal(0), items: [] };
      g.meters = g.meters.plus(l.meters); g.boards = g.boards.plus(l.boards); g.value = g.value.plus(l.value); g.items.push(l);
      groups.set(l.variantId, g);
    }
    const variantIds = [...groups.keys()].sort();
    for (const vid of variantIds) {
      await tx.$queryRaw`SELECT id FROM product_variants WHERE id = ${vid}::uuid FOR UPDATE`;
    }
    for (const vid of variantIds) {
      const g = groups.get(vid)!;
      const agg = await tx.branchInventoryBalance.aggregate({ _sum: { metersOnHand: true, boardsOnHand: true }, where: { productVariantId: vid } });
      const curMeters = D(agg._sum.metersOnHand), curBoards = D(agg._sum.boardsOnHand);
      const variant = await tx.productVariant.findUnique({ where: { id: vid }, select: { avgCostPerMeter: true } });
      const curValue = curMeters.mul(D(variant?.avgCostPerMeter));
      if (sign < 0 && g.value.gt(curValue.plus(new Decimal("0.005")))) {
        throw new ValidationError({ reason: "purchase_return_exceeds_inventory_value", returnedValue: g.value.toFixed(2), currentInventoryValue: curValue.toFixed(2) });
      }
      const newMeters = curMeters.plus(g.meters.mul(sign));
      const newBoards = curBoards.plus(g.boards.mul(sign));
      const newValue = curValue.plus(g.value.mul(sign));
      if (newMeters.isNegative() || newBoards.isNegative() || newValue.isNegative()) {
        throw new ValidationError({ reason: "insufficient_inventory_for_return", productVariantId: vid });
      }
      await tx.productVariant.update({
        where: { id: vid },
        data: {
          avgCostPerMeter: newMeters.gt(0) ? newValue.div(newMeters).toFixed(4) : "0",
          avgCost: newBoards.gt(0) ? newValue.div(newBoards).toFixed(4) : "0",
          costUpdatedAt: new Date(),
        },
      });
      for (const it of g.items) {
        await this.inventoryEngine.apply({
          branchId, productVariantId: vid, movementType: "PURCHASE_RETURN",
          boardsDelta: it.boards.mul(sign).toFixed(4), metersDelta: it.meters.mul(sign).toFixed(4),
          reference: { type: sign < 0 ? "purchase_return" : "purchase_return_cancel", id: refId }, actor: user,
          summaryAr: sign < 0 ? `مردود مشتريات — خصم من المخزون ${returnNumber}` : `إلغاء مردود مشتريات — إعادة للمخزون ${returnNumber}`,
          summaryEn: sign < 0 ? `Purchase return — stock out ${returnNumber}` : `Cancel purchase return restock ${returnNumber}`,
          humanReadableNote: `مردود مشتريات ${returnNumber}`, tx,
        });
      }
    }
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
          reason: patchText(body.reason), notes: patchText(body.notes),
          settlementMode: body.settlementMode ?? undefined,
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

    // §9 — supplier cash/bank refunds are NOT supported (no supplier-refund
    // receipt module; direct-posting to treasury would bypass the payment
    // engines). Only supplier-credit settlements confirm in this phase.
    if (pre.settlementMode === "CASH_REFUND" || pre.settlementMode === "BANK_REFUND") {
      throw new ValidationError({ reason: "unsupported_settlement_mode", settlementMode: pre.settlementMode });
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
      if (!apAccountId) throw new ValidationError({ reason: "ap_account_required" });
      if (t.taxTotal.gt(0) && !vatInputAccountId) throw new ValidationError({ reason: "vat_input_account_required" });

      const returnNumber = pre.returnNumber.toString();
      const branchId = pre.branchId;

      // Inventory removal + per-metre WAC recompute, variant-locked (§3). Group
      // by variant, lock variants FOR UPDATE in sorted id order, then recompute.
      await this.applyPurchaseReturnToStock(
        tx, built.map((b) => ({ variantId: b.orig.productVariantId, meters: b.alloc.meters, boards: b.alloc.boards, value: b.alloc.net })),
        branchId, user, returnNumber, -1, pre.id,
      );

      // Journal: Dr AP[supplier]; Cr Inventory + Cr VAT-input. All lines branched.
      const lines: PostingLine[] = [
        { accountId: apAccountId!, debit: t.grandTotal.toFixed(2), credit: "0", note: `خصم من المورد - PR-${returnNumber}`, partyType: "SUPPLIER", partyId: pre.supplierId, branchId },
        { accountId: inventoryAccountId, debit: "0", credit: t.inventoryValueOut.toFixed(2), note: `إخراج من المخزون - PR-${returnNumber}`, branchId },
      ];
      if (t.taxTotal.gt(0) && vatInputAccountId) {
        lines.push({ accountId: vatInputAccountId, debit: "0", credit: t.taxTotal.toFixed(2), note: `عكس ض.ق.م مشتريات - PR-${returnNumber}`, branchId });
      }
      const posted = await this.postingEngine.post({
        tx, actor: user, sourceType: "PURCHASE_RETURN", sourceId: pre.id, entryType: "JOURNAL",
        entryDate: returnDateStr, reference: `PR-${returnNumber}`,
        description: `مردود مشتريات رقم ${returnNumber}`, idempotencyKey: `PURCHASE_RETURN:${pre.id}`, lines,
      });

      // Rewrite authoritative lines (with dimensions + correct tax snapshot).
      await tx.purchaseReturnLine.deleteMany({ where: { purchaseReturnId: id } });
      for (const b of built) {
        await tx.purchaseReturnLine.create({ data: { purchaseReturnId: id, ...this.lineData(b) } });
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
      // Restore the removed stock + reverse the WAC effect (variant-locked, §3).
      await this.applyPurchaseReturnToStock(
        tx, existing.lines.map((l) => ({ variantId: l.productVariantId, meters: D(l.returnedMetersQuantity), boards: D(l.returnedBoards), value: D(l.inventoryValueOut) })),
        existing.branchId, user, returnNumber, 1, existing.id,
      );
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
      ...(query.originalInvoiceId ? { originalPurchaseInvoiceId: query.originalInvoiceId } : {}),
      ...(user.role !== "OWNER" ? { branchId: { in: user.allowedBranches } } : {}),
      ...(query.from || query.to ? { returnDate: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } } : {}),
    };
    const rows = await this.prisma.purchaseReturn.findMany({
      where,
      include: {
        lines: { select: { returnedMetersQuantity: true, returnedBoards: true } },
        supplier: { select: { id: true, nameAr: true } },
        branch: { select: { id: true, nameAr: true } },
        originalInvoice: { select: { id: true, invoiceNumber: true } },
      },
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
    const lines: any[] = r.lines ?? [];
    const totalMeters = lines.reduce((a, l) => a.plus(D(l.returnedMetersQuantity)), new Decimal(0));
    const totalBoards = lines.reduce((a, l) => a.plus(D(l.returnedBoards)), new Decimal(0));
    return {
      ...r,
      returnNumber: r.returnNumber?.toString(),
      totalMeters: totalMeters.toFixed(4),
      totalBoards: totalBoards.toFixed(4),
      originalInvoice: r.originalInvoice ? { ...r.originalInvoice, invoiceNumber: r.originalInvoice.invoiceNumber } : undefined,
    };
  }
}
