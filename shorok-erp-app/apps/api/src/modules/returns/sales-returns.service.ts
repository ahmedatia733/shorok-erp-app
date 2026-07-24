import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import type {
  CreateSalesReturn, UpdateSalesReturn, ReturnQuery, PostingLine,
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
import { allocateReturn, zeroAlready, type OriginalLineEconomics, type AlreadyReturned } from "./return-allocation";

type Tx = Prisma.TransactionClient;
const D = (v: unknown) => new Decimal((v as { toString(): string } | null)?.toString() ?? "0");

/**
 * Sales returns (مردود مبيعات) — independent documents linked to a CONFIRMED
 * sales invoice. The invoice is NEVER edited. Money and COGS come only from the
 * original line's historical snapshots (never current prices/costs). Confirmed
 * returns post through the single PostingEngine path (contra-revenue + VAT +
 * customer credit/refund) and reverse COGS by adding the exact metres back to
 * stock. Cancellation reverses everything via persisted values.
 */
@Injectable()
export class SalesReturnsService {
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

  // ── build allocation for a set of requested lines against an invoice ───────
  private async buildLines(
    invoiceId: string,
    reqLines: CreateSalesReturn["lines"],
    tx?: Tx,
  ) {
    const { invoice, lines } = await this.returnable.salesInvoiceReturnable(invoiceId, tx);
    if (invoice.status !== "CONFIRMED") {
      throw new ValidationError({ reason: "original_invoice_not_confirmed", status: invoice.status });
    }
    const byId = new Map(lines.map((l) => [l.originalLineId, l]));

    // Defense-in-depth against duplicate original lines (also blocked at the DTO):
    // two items for the same line would each validate against the same remaining.
    const dupCheck = new Set<string>();
    for (const r of reqLines) {
      if (dupCheck.has(r.originalSalesInvoiceLineId)) {
        throw new ValidationError({ reason: "duplicate_original_line", lineId: r.originalSalesInvoiceLineId });
      }
      dupCheck.add(r.originalSalesInvoiceLineId);
    }

    // Already-confirmed money sums per original line (for the residual on the
    // final return). Read inside the same tx so concurrent confirms serialize.
    const db = tx ?? this.prisma;
    const originalIds = reqLines.map((r) => r.originalSalesInvoiceLineId);
    const moneyAgg = await db.salesReturnLine.groupBy({
      by: ["originalSalesInvoiceLineId"],
      where: {
        originalSalesInvoiceLineId: { in: originalIds },
        salesReturn: { originalSalesInvoiceId: invoiceId, status: "CONFIRMED" },
      },
      _sum: {
        returnedMetersQuantity: true, returnedBoards: true, returnSubtotal: true,
        returnDiscount: true, returnNetExTax: true, returnTax: true, returnCogs: true,
      },
    });
    const alreadyById = new Map(moneyAgg.map((a) => [a.originalSalesInvoiceLineId, a._sum]));

    const built = reqLines.map((r) => {
      const orig = byId.get(r.originalSalesInvoiceLineId);
      if (!orig) throw new ValidationError({ reason: "line_not_on_invoice", lineId: r.originalSalesInvoiceLineId });
      // A legacy line whose metres can't be reliably reconstructed is blocked —
      // never guess (boards are NOT metres). §7.
      if (orig.legacyAmbiguous) {
        throw new ValidationError({ reason: "legacy_return_quantity_ambiguous", lineId: r.originalSalesInvoiceLineId, productCode: orig.productCode });
      }

      const requestedMeters = new Decimal(r.returnedMeters);
      if (!requestedMeters.isFinite() || requestedMeters.lte(0)) {
        throw new ValidationError({ reason: "return_meters_must_be_positive", lineId: r.originalSalesInvoiceLineId });
      }
      const remaining = new Decimal(orig.remainingMeters);
      if (requestedMeters.gt(remaining)) {
        throw new ValidationError({
          reason: "over_return", lineId: r.originalSalesInvoiceLineId,
          requestedMeters: requestedMeters.toFixed(4), remainingMeters: remaining.toFixed(4),
        });
      }
      // Board/piece validation (§5): positive, and cumulative ≤ original boards.
      const remainingBoards = new Decimal(orig.remainingBoards);
      const requestedBoards = r.returnedBoards != null ? new Decimal(r.returnedBoards) : null;
      if (requestedBoards != null) {
        if (!requestedBoards.isFinite() || requestedBoards.lte(0)) {
          throw new ValidationError({ reason: "return_boards_must_be_positive", lineId: r.originalSalesInvoiceLineId });
        }
        if (requestedBoards.gt(remainingBoards.plus(new Decimal("0.0001")))) {
          throw new ValidationError({ reason: "over_return_boards", lineId: r.originalSalesInvoiceLineId, requestedBoards: requestedBoards.toFixed(4), remainingBoards: remainingBoards.toFixed(4) });
        }
      }

      const sum = alreadyById.get(r.originalSalesInvoiceLineId);
      const already: AlreadyReturned = {
        meters: D(sum?.returnedMetersQuantity), boards: D(sum?.returnedBoards),
        gross: D(sum?.returnSubtotal), discount: D(sum?.returnDiscount),
        net: D(sum?.returnNetExTax), tax: D(sum?.returnTax), cogs: D(sum?.returnCogs),
      };
      const taxRate = new Decimal(orig.originalTaxRate);
      const net = new Decimal(orig.originalNetExTax);
      const o: OriginalLineEconomics = {
        meters: new Decimal(orig.originalMeters), boards: new Decimal(orig.originalBoards),
        gross: new Decimal(orig.originalGross), discount: new Decimal(orig.originalDiscount),
        net, lineTax: net.mul(taxRate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
        lineCogs: new Decimal(orig.originalLineCogs),
      };
      const alloc = allocateReturn(o, already, requestedMeters, requestedBoards);
      if (alloc.boards.lte(0)) {
        throw new ValidationError({ reason: "return_boards_must_be_positive", lineId: r.originalSalesInvoiceLineId });
      }
      return { req: r, orig, alloc };
    });

    return { invoice, built };
  }

  private totals(built: Array<{ alloc: { net: Decimal; discount: Decimal; tax: Decimal; total: Decimal; cogs: Decimal } }>) {
    const z = new Decimal(0);
    return {
      subtotal: built.reduce((a, x) => a.add(x.alloc.net), z),
      discountTotal: built.reduce((a, x) => a.add(x.alloc.discount), new Decimal(0)),
      taxTotal: built.reduce((a, x) => a.add(x.alloc.tax), new Decimal(0)),
      grandTotal: built.reduce((a, x) => a.add(x.alloc.total), new Decimal(0)),
      cogsReversalTotal: built.reduce((a, x) => a.add(x.alloc.cogs), new Decimal(0)),
    };
  }

  /** SalesReturnLine create payload from a built item. Dimensions/snapshots come
   *  ONLY from the original invoice line (never the client) — §6. */
  private lineCreateData(b: Awaited<ReturnType<SalesReturnsService["buildLines"]>>["built"][number]) {
    const { req, orig, alloc } = b;
    return {
      originalSalesInvoiceLineId: orig.originalLineId,
      productVariantId: orig.productVariantId,
      lengthM: orig.lengthM, widthM: orig.widthM,
      returnedBoards: alloc.boards.toFixed(4),
      returnedMetersQuantity: alloc.meters.toFixed(4),
      originalSalePricePerMeter: new Decimal(orig.originalUnitPrice).toFixed(2),
      originalDiscountPct: new Decimal(orig.originalDiscountPct).toFixed(2),
      originalTaxRate: new Decimal(orig.originalTaxRate).toFixed(2),
      returnSubtotal: alloc.gross.toFixed(2),
      returnDiscount: alloc.discount.toFixed(2),
      returnNetExTax: alloc.net.toFixed(2),
      returnTax: alloc.tax.toFixed(2),
      returnTotal: alloc.total.toFixed(2),
      originalCostPerMeterAtPosting: orig.originalCostPerMeter,
      returnCogs: alloc.cogs.toFixed(2),
      inventoryDisposition: req.inventoryDisposition ?? "RETURN_TO_AVAILABLE_STOCK",
      reason: req.reason ?? null,
      note: req.note ?? null,
    };
  }

  /**
   * §2/§3 — apply a sales return to stock AND its per-metre WAC, company-wide.
   * The returned merchandise re-enters (sign +1) or leaves again on cancel
   * (sign −1) at its HISTORICAL persisted returnCogs, so the GL inventory value
   * and the operational WAC never diverge:
   *   newInventoryValue = currentValue ± Σ returnCogs
   *   newMeters         = currentMeters ± Σ metres
   *   newAvgCostPerMeter = newInventoryValue / newMeters   (0 when metres = 0)
   * Variants are locked FOR UPDATE in sorted id order (no deadlock / lost
   * update). Cancellation is blocked if it would drive metres/boards/value
   * negative (returned stock already consumed).
   */
  private async applyReturnToStock(
    tx: Tx,
    lines: Array<{ variantId: string; meters: Decimal; boards: Decimal; cogs: Decimal }>,
    branchId: string,
    user: AuthenticatedUser,
    returnNumber: string,
    sign: 1 | -1,
    refId: string,
  ) {
    const groups = new Map<string, { meters: Decimal; boards: Decimal; cogs: Decimal; items: typeof lines }>();
    for (const l of lines) {
      const g = groups.get(l.variantId) ?? { meters: new Decimal(0), boards: new Decimal(0), cogs: new Decimal(0), items: [] };
      g.meters = g.meters.plus(l.meters); g.boards = g.boards.plus(l.boards); g.cogs = g.cogs.plus(l.cogs); g.items.push(l);
      groups.set(l.variantId, g);
    }
    const variantIds = [...groups.keys()].sort();
    // Deterministic-order variant locks (the single costing lock, §3).
    for (const vid of variantIds) {
      await tx.$queryRaw`SELECT id FROM product_variants WHERE id = ${vid}::uuid FOR UPDATE`;
    }
    for (const vid of variantIds) {
      const g = groups.get(vid)!;
      const agg = await tx.branchInventoryBalance.aggregate({ _sum: { metersOnHand: true, boardsOnHand: true }, where: { productVariantId: vid } });
      const curMeters = D(agg._sum.metersOnHand), curBoards = D(agg._sum.boardsOnHand);
      const variant = await tx.productVariant.findUnique({ where: { id: vid }, select: { avgCostPerMeter: true } });
      const curValue = curMeters.mul(D(variant?.avgCostPerMeter));
      const newMeters = curMeters.plus(g.meters.mul(sign));
      const newBoards = curBoards.plus(g.boards.mul(sign));
      const newValue = curValue.plus(g.cogs.mul(sign));
      if (newMeters.isNegative() || newBoards.isNegative() || newValue.isNegative()) {
        throw new ValidationError({ reason: "return_reversal_would_make_stock_negative", productVariantId: vid });
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
          branchId, productVariantId: vid, movementType: "SALE_RETURN",
          boardsDelta: it.boards.mul(sign).toFixed(4), metersDelta: it.meters.mul(sign).toFixed(4),
          reference: { type: sign > 0 ? "sales_return" : "sales_return_cancel", id: refId }, actor: user,
          summaryAr: sign > 0 ? `ارتجاع مبيعات للمخزون — مردود ${returnNumber}` : `إلغاء ارتجاع مبيعات — مردود ${returnNumber}`,
          summaryEn: sign > 0 ? `Sales return to stock — return ${returnNumber}` : `Cancel sales return restock — return ${returnNumber}`,
          humanReadableNote: `مردود مبيعات ${returnNumber}`, tx,
        });
      }
    }
  }

  // ── CREATE (draft) ─────────────────────────────────────────────────────────
  async create(body: CreateSalesReturn, user: AuthenticatedUser) {
    const inv = await this.prisma.salesInvoice.findUnique({ where: { id: body.originalSalesInvoiceId } });
    if (!inv) throw new NotFoundError({ originalSalesInvoiceId: body.originalSalesInvoiceId });
    this.assertBranch(user, inv.branchId);
    if (inv.status !== "CONFIRMED") {
      throw new ValidationError({ reason: "original_invoice_not_confirmed", status: inv.status });
    }

    const { built } = await this.buildLines(body.originalSalesInvoiceId, body.lines);
    const t = this.totals(built);

    return this.prisma.runInTransaction(async (tx) => {
      const ret = await tx.salesReturn.create({
        data: {
          originalSalesInvoiceId: inv.id,
          customerId: inv.customerId,
          branchId: inv.branchId,
          salesRepresentativeId: inv.salesRepresentativeId,
          returnDate: new Date(body.returnDate),
          status: "DRAFT",
          reason: body.reason ?? null,
          notes: body.notes ?? null,
          settlementMode: body.settlementMode,
          subtotal: t.subtotal.toFixed(2),
          discountTotal: t.discountTotal.toFixed(2),
          taxTotal: t.taxTotal.toFixed(2),
          grandTotal: t.grandTotal.toFixed(2),
          cogsReversalTotal: t.cogsReversalTotal.toFixed(2),
          createdBy: user.id,
          lines: { create: built.map((b) => this.lineCreateData(b)) },
        },
        include: { lines: true },
      });
      await this.audit.write({
        tx, actorId: user.id, action: "CREATE", entityType: "sales_return", entityId: ret.id,
        afterSnapshot: { status: "DRAFT", grandTotal: t.grandTotal.toFixed(2) },
        summaryAr: `${user.name} أنشأ مردود مبيعات رقم ${ret.returnNumber.toString()}`,
        summaryEn: `${user.name} created sales return ${ret.returnNumber.toString()}`,
      });
      return this.format(ret);
    });
  }

  // ── UPDATE (draft only) ─────────────────────────────────────────────────────
  async update(id: string, body: UpdateSalesReturn, user: AuthenticatedUser) {
    const existing = await this.prisma.salesReturn.findUnique({ where: { id }, include: { lines: true } });
    if (!existing) throw new NotFoundError({ id });
    this.assertBranch(user, existing.branchId);
    if (existing.status !== "DRAFT") throw new ValidationError({ reason: "return_not_draft", status: existing.status });

    const reqLines = body.lines
      ? body.lines
      : existing.lines.map((l) => ({
          originalSalesInvoiceLineId: l.originalSalesInvoiceLineId,
          returnedMeters: D(l.returnedMetersQuantity).toFixed(4),
          returnedBoards: D(l.returnedBoards).toFixed(4),
          inventoryDisposition: "RETURN_TO_AVAILABLE_STOCK" as const,
          reason: l.reason ?? undefined, note: l.note ?? undefined,
        }));
    const { built } = await this.buildLines(existing.originalSalesInvoiceId, reqLines);
    const t = this.totals(built);

    return this.prisma.runInTransaction(async (tx) => {
      await tx.salesReturnLine.deleteMany({ where: { salesReturnId: id } });
      const ret = await tx.salesReturn.update({
        where: { id },
        data: {
          returnDate: body.returnDate ? new Date(body.returnDate) : undefined,
          reason: body.reason ?? undefined,
          notes: body.notes ?? undefined,
          settlementMode: body.settlementMode ?? undefined,
          subtotal: t.subtotal.toFixed(2),
          discountTotal: t.discountTotal.toFixed(2),
          taxTotal: t.taxTotal.toFixed(2),
          grandTotal: t.grandTotal.toFixed(2),
          cogsReversalTotal: t.cogsReversalTotal.toFixed(2),
          lines: { create: built.map((b) => this.lineCreateData(b)) },
        },
        include: { lines: true },
      });
      return this.format(ret);
    });
  }

  // ── CONFIRM ──────────────────────────────────────────────────────────────
  async confirm(id: string, user: AuthenticatedUser) {
    const pre = await this.prisma.salesReturn.findUnique({ where: { id }, include: { lines: true } });
    if (!pre) throw new NotFoundError({ id });
    this.assertBranch(user, pre.branchId);
    if (pre.status !== "DRAFT") throw new ValidationError({ reason: "return_not_draft", status: pre.status });

    // §9 — cash/bank refunds are NOT supported: there is no customer-refund
    // voucher module, and posting straight to treasury would bypass the payment
    // engines. Only customer-credit settlements confirm in this phase.
    if (pre.settlementMode === "CASH_REFUND" || pre.settlementMode === "BANK_REFUND") {
      throw new ValidationError({ reason: "unsupported_settlement_mode", settlementMode: pre.settlementMode });
    }

    const returnDateStr = pre.returnDate.toISOString().slice(0, 10);
    const profile = await this.effectiveConfig.postingProfileAsOf(returnDateStr);
    const salesReturnsAccountId = profile?.salesReturnsAccountId ?? null;
    const arAccountId = profile?.arAccountId ?? null;
    const vatOutputAccountId = profile?.vatOutputAccountId ?? null;
    const cogsAccountId = profile?.cogsAccountId ?? null;
    const inventoryAccountId = profile?.inventoryAccountId ?? null;

    return this.prisma.runInTransaction(async (tx) => {
      // Lock the ORIGINAL invoice so two concurrent confirms against the same
      // invoice serialize — neither can double-spend the remaining quantity.
      await tx.$queryRaw`SELECT id FROM sales_invoices WHERE id = ${pre.originalSalesInvoiceId}::uuid FOR UPDATE`;

      // Recompute allocation from persisted request INSIDE the lock (residual +
      // fresh over-return validation against currently-confirmed returns).
      const reqLines = pre.lines.map((l) => ({
        originalSalesInvoiceLineId: l.originalSalesInvoiceLineId,
        returnedMeters: D(l.returnedMetersQuantity).toFixed(4),
        returnedBoards: D(l.returnedBoards).toFixed(4),
        inventoryDisposition: "RETURN_TO_AVAILABLE_STOCK" as const,
        reason: l.reason ?? undefined, note: l.note ?? undefined,
      }));
      const { invoice, built } = await this.buildLines(pre.originalSalesInvoiceId, reqLines, tx);
      const t = this.totals(built);

      if (!salesReturnsAccountId) throw new ValidationError({ reason: "sales_returns_account_required" });
      if (t.grandTotal.gt(0)) {
        if (t.taxTotal.gt(0) && !vatOutputAccountId) throw new ValidationError({ reason: "tax_account_required" });
        if (!arAccountId) throw new ValidationError({ reason: "ar_account_required" });
      }
      if (t.cogsReversalTotal.gt(0) && (!cogsAccountId || !inventoryAccountId)) {
        throw new ValidationError({ reason: "cogs_or_inventory_account_required" });
      }

      const returnNumber = pre.returnNumber.toString();
      const branchId = pre.branchId;
      const rep = invoice.salesRepresentativeId ?? undefined;

      // 1. Commercial entry: Dr Sales-Returns (net) + Dr VAT-output (tax);
      //    Cr AR[customer credit]. Every line carries branch (+ rep) dimensions.
      const lines: PostingLine[] = [
        { accountId: salesReturnsAccountId, debit: t.subtotal.toFixed(2), credit: "0", note: `مردود مبيعات SR-${returnNumber}`, branchId, salesRepresentativeId: rep },
      ];
      if (t.taxTotal.gt(0) && vatOutputAccountId) {
        lines.push({ accountId: vatOutputAccountId, debit: t.taxTotal.toFixed(2), credit: "0", note: `عكس ض.ق.م - SR-${returnNumber}`, branchId, salesRepresentativeId: rep });
      }
      lines.push({ accountId: arAccountId!, debit: "0", credit: t.grandTotal.toFixed(2), note: `رصيد دائن للعميل - SR-${returnNumber}`, partyType: "CUSTOMER", partyId: pre.customerId, branchId, salesRepresentativeId: rep });
      const posted = await this.postingEngine.post({
        tx, actor: user, sourceType: "SALES_RETURN", sourceId: pre.id, entryType: "JOURNAL",
        entryDate: returnDateStr, reference: `SR-${returnNumber}`,
        description: `مردود مبيعات رقم ${returnNumber}`,
        idempotencyKey: `SALES_RETURN:${pre.id}`,
        lines,
      });
      if (rep) {
        await tx.journalEntry.update({ where: { id: posted.journalEntryId }, data: { salesRepresentativeId: rep } });
      }

      // 2. COGS reversal: Dr Inventory / Cr COGS (adds cost back, reduces net COGS).
      let cogsJournalEntryId: string | null = null;
      if (t.cogsReversalTotal.gt(0) && cogsAccountId && inventoryAccountId) {
        const cogsPosted = await this.postingEngine.post({
          tx, actor: user, sourceType: "SALES_RETURN", sourceId: pre.id, entryType: "JOURNAL",
          entryDate: returnDateStr, reference: `SR-${returnNumber}-COGS`,
          description: `عكس تكلفة مبيعات - مردود ${returnNumber}`,
          idempotencyKey: `SALES_RETURN:${pre.id}:COGS`,
          lines: [
            { accountId: inventoryAccountId, debit: t.cogsReversalTotal.toFixed(2), credit: "0", note: `ارتجاع للمخزون - SR-${returnNumber}`, branchId, salesRepresentativeId: rep },
            { accountId: cogsAccountId, debit: "0", credit: t.cogsReversalTotal.toFixed(2), note: `عكس ت.ب.م - SR-${returnNumber}`, branchId, salesRepresentativeId: rep },
          ],
        });
        cogsJournalEntryId = cogsPosted.journalEntryId;
        await tx.journalEntry.update({ where: { id: cogsJournalEntryId }, data: { salesRepresentativeId: rep ?? null } });
      }

      // 3. Inventory + per-metre WAC recompute (§2/§3). Add the exact returned
      //    metres/boards back and RAISE the variant's WAC by the historical
      //    returnCogs (the returned merchandise re-enters stock at its original
      //    cost). Variants are locked in a deterministic order to avoid
      //    deadlocks and lost updates.
      await this.applyReturnToStock(tx, built.map((b) => ({ variantId: b.orig.productVariantId, meters: b.alloc.meters, boards: b.alloc.boards, cogs: b.alloc.cogs })), pre.branchId, user, returnNumber, 1, pre.id);

      // 4. Rewrite line snapshots to the authoritative (residual-corrected) values.
      await tx.salesReturnLine.deleteMany({ where: { salesReturnId: id } });
      for (const b of built) {
        await tx.salesReturnLine.create({ data: { salesReturnId: id, ...this.lineCreateData(b) } });
      }

      // 5. Legacy customer statement row (credit) — reduces the customer's
      //    receivable / builds a credit (OFFSET naturally nets via the AR party).
      const ctxRow = await tx.customerTransaction.create({
        data: {
          customerId: pre.customerId, type: "RETURN", direction: "CR",
          amount: t.grandTotal.toFixed(2), date: pre.returnDate,
          reference: `SR-${returnNumber}`, description: `مردود مبيعات رقم ${returnNumber}`, createdBy: user.id,
        },
      });
      const customerTransactionId: string | null = ctxRow.id;

      const ret = await tx.salesReturn.update({
        where: { id },
        data: {
          status: "CONFIRMED",
          subtotal: t.subtotal.toFixed(2), discountTotal: t.discountTotal.toFixed(2),
          taxTotal: t.taxTotal.toFixed(2), grandTotal: t.grandTotal.toFixed(2),
          cogsReversalTotal: t.cogsReversalTotal.toFixed(2),
          journalEntryId: posted.journalEntryId, cogsJournalEntryId,
          customerTransactionId, salesReturnsAccountId,
          confirmedAt: new Date(), confirmedBy: user.id,
        },
        include: { lines: true },
      });
      await this.audit.write({
        tx, actorId: user.id, action: "CONFIRM", entityType: "sales_return", entityId: id,
        afterSnapshot: { status: "CONFIRMED", returnNumber, grandTotal: t.grandTotal.toFixed(2), cogsReversalTotal: t.cogsReversalTotal.toFixed(2), journalEntryId: posted.journalEntryId, cogsJournalEntryId },
        summaryAr: `${user.name} أكّد مردود المبيعات رقم ${returnNumber} وتم ترحيل القيود وإرجاع المخزون`,
        summaryEn: `${user.name} confirmed sales return ${returnNumber} — posted entries and restocked`,
      });
      return this.format(ret);
    });
  }

  // ── CANCEL ─────────────────────────────────────────────────────────────────
  async cancel(id: string, reason: string | undefined, user: AuthenticatedUser) {
    const existing = await this.prisma.salesReturn.findUnique({ where: { id }, include: { lines: true } });
    if (!existing) throw new NotFoundError({ id });
    this.assertBranch(user, existing.branchId);
    if (existing.status !== "CONFIRMED") throw new ValidationError({ reason: "return_not_confirmed", status: existing.status });

    const returnNumber = existing.returnNumber.toString();
    return this.prisma.runInTransaction(async (tx) => {
      // Reverse the posted journals (exact mirror of the persisted entries).
      if (existing.journalEntryId) {
        await this.reversal.reverse({ entryId: existing.journalEntryId, reason: `إلغاء مردود ${returnNumber}`, actor: user, tx });
      }
      if (existing.cogsJournalEntryId) {
        await this.reversal.reverse({ entryId: existing.cogsJournalEntryId, reason: `إلغاء مردود ${returnNumber} - تكلفة`, actor: user, tx });
      }
      // Remove the stock the return added back AND reverse the exact WAC effect
      // (−Σ returnCogs), variant-locked; blocks if goods were already consumed.
      await this.applyReturnToStock(
        tx,
        existing.lines.map((l) => ({ variantId: l.productVariantId, meters: D(l.returnedMetersQuantity), boards: D(l.returnedBoards), cogs: D(l.returnCogs) })),
        existing.branchId, user, returnNumber, -1, existing.id,
      );
      // Reverse the legacy statement row with an opposite entry.
      if (existing.customerTransactionId) {
        await tx.customerTransaction.create({
          data: {
            customerId: existing.customerId, type: "RETURN", direction: "DR",
            amount: D(existing.grandTotal).toFixed(2), date: new Date(),
            reference: `SR-${returnNumber}-CXL`, description: `إلغاء مردود مبيعات رقم ${returnNumber}`, createdBy: user.id,
          },
        });
      }
      const ret = await tx.salesReturn.update({
        where: { id },
        data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: user.id, cancellationReason: reason ?? null },
        include: { lines: true },
      });
      await this.audit.write({
        tx, actorId: user.id, action: "CANCEL", entityType: "sales_return", entityId: id,
        beforeSnapshot: { status: "CONFIRMED" }, afterSnapshot: { status: "CANCELLED", reason: reason ?? null },
        summaryAr: `${user.name} ألغى مردود المبيعات رقم ${returnNumber}`,
        summaryEn: `${user.name} cancelled sales return ${returnNumber}`,
      });
      return this.format(ret);
    });
  }

  // ── reads ───────────────────────────────────────────────────────────────────
  async list(query: ReturnQuery, user: AuthenticatedUser) {
    const where: Prisma.SalesReturnWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.originalInvoiceId ? { originalSalesInvoiceId: query.originalInvoiceId } : {}),
      ...(user.role !== "OWNER" ? { branchId: { in: user.allowedBranches } } : {}),
      ...(query.from || query.to ? { returnDate: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } } : {}),
    };
    const rows = await this.prisma.salesReturn.findMany({
      where,
      include: {
        lines: { select: { returnedMetersQuantity: true, returnedBoards: true } },
        customer: { select: { id: true, code: true, nameAr: true } },
        branch: { select: { id: true, nameAr: true } },
        salesRepresentative: { select: { id: true, code: true, nameAr: true } },
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
    const ret = await this.prisma.salesReturn.findUnique({
      where: { id },
      include: {
        lines: { include: { productVariant: { include: { sku: { select: { code: true, colorNameAr: true } } } } } },
        customer: { select: { id: true, code: true, nameAr: true } },
        branch: { select: { id: true, nameAr: true } },
        salesRepresentative: { select: { id: true, code: true, nameAr: true } },
        originalInvoice: { select: { id: true, invoiceNumber: true } },
      },
    });
    if (!ret) throw new NotFoundError({ id });
    this.assertBranch(user, ret.branchId);
    return this.format(ret);
  }

  async returnableForInvoice(invoiceId: string, user: AuthenticatedUser) {
    const data = await this.returnable.salesInvoiceReturnable(invoiceId);
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
      originalInvoice: r.originalInvoice ? { ...r.originalInvoice, invoiceNumber: r.originalInvoice.invoiceNumber?.toString() } : undefined,
    };
  }
}
