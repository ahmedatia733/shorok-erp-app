import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { Decimal } from "decimal.js";
import type {
  CancelLegacyReturn,
  CreateLegacyReturn,
  LegacyReturnLineInput,
  LegacyReturnQuery,
  UpdateLegacyReturn,
} from "@shorok/shared";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { PrismaService } from "../../prisma/prisma.service";
import { PostingEngine } from "../posting/posting.engine";
import { ReversalService } from "../posting/reversal.service";
import { EffectiveConfigService } from "../configuration/effective-config.service";
import { AuditService } from "../audit/audit.service";
import { ReturnStockService } from "./return-stock.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */
import { resolvePurchaseVariant } from "../products/variant-resolution";
import { classifyBoardSize } from "../inventory-transfers/size-classification";

type Tx = Prisma.TransactionClient;
const D = (v: unknown): Decimal => new Decimal((v ?? 0).toString());

const BADGE_AR: Record<string, string> = { LARGE: "ك", SMALL: "ص", CUSTOM: "م/خ" };

interface BuiltLine {
  productVariantId: string;
  lengthM: Decimal | null;
  widthM: Decimal | null;
  returnedBoards: Decimal;
  returnedMeters: Decimal;
  unitPricePerMeter: Decimal;
  discountPct: Decimal;
  taxRate: Decimal;
  lineSubtotal: Decimal;
  lineDiscount: Decimal;
  lineNetExTax: Decimal;
  lineTax: Decimal;
  lineTotal: Decimal;
  note: string | null;
}

/**
 * مردودات بدون فواتير.
 *
 * A customer walks in with a paper invoice from before this ERP existed and
 * hands back goods that are still fit to sell. There is no electronic invoice
 * to return against, so this document does not pretend there is one: the paper
 * is recorded as a reference and nothing else.
 *
 * Two things it deliberately does NOT do:
 *
 *   - It never guesses the selling price. The operator reads it off the paper,
 *     because only the paper knows what this customer actually paid.
 *   - It never guesses the original cost either — that number was never
 *     recorded. By the approved policy it values the goods at the variant's
 *     weighted-average cost AT CONFIRMATION, freezes that number on the line,
 *     and uses the frozen number for the reversal too. Goods arriving at the
 *     current average cannot move the average, so a return whose true cost is
 *     unknowable does not distort what everything else is valued at.
 *
 * Everything downstream is the existing machinery: ReturnStockService for the
 * costing lock and stock, PostingEngine for the journals, the customer
 * transaction ledger for the credit, AuditService for the trail.
 */
@Injectable()
export class LegacyReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingEngine,
    private readonly reversal: ReversalService,
    private readonly effectiveConfig: EffectiveConfigService,
    private readonly audit: AuditService,
    private readonly returnStock: ReturnStockService,
  ) {}

  // ── helpers ──────────────────────────────────────────────────────────────

  private assertBranch(user: AuthenticatedUser, branchId: string): void {
    if (user.role !== "OWNER" && !user.allowedBranches.includes(branchId)) {
      throw new ValidationError({ reason: "branch_not_allowed", branchId });
    }
  }

  /** Money rounds to 2dp; quantities keep the 4dp the inventory tables use. */
  private computeLine(input: LegacyReturnLineInput, variantSize: Decimal, variantId: string): BuiltLine {
    const boards = D(input.returnedBoards);
    // Metres are the canonical quantity everywhere in this system, derived from
    // the board size actually returned — never from the boards alone.
    const meters = boards.mul(variantSize);
    const price = D(input.unitPricePerMeter);
    const discountPct = D(input.discountPct ?? "0");
    const taxRate = D(input.taxRate ?? "0");

    const subtotal = meters.mul(price);
    const discount = subtotal.mul(discountPct).div(100);
    const net = subtotal.minus(discount);
    const tax = net.mul(taxRate).div(100);

    return {
      productVariantId: variantId,
      lengthM: input.lengthM ? D(input.lengthM) : null,
      widthM: input.widthM ? D(input.widthM) : null,
      returnedBoards: boards,
      returnedMeters: meters,
      unitPricePerMeter: price,
      discountPct,
      taxRate,
      lineSubtotal: new Decimal(subtotal.toFixed(2)),
      lineDiscount: new Decimal(discount.toFixed(2)),
      lineNetExTax: new Decimal(net.toFixed(2)),
      lineTax: new Decimal(tax.toFixed(2)),
      lineTotal: new Decimal(net.plus(tax).toFixed(2)),
      note: input.note ?? null,
    };
  }

  /**
   * Turns each requested line into an exact variant and its computed figures.
   *
   * The variant is resolved by the same code a purchase uses, so a size this
   * product has never carried can arrive here too — created only from a real
   * measurement, never as a placeholder.
   */
  private async buildLines(tx: Tx, lines: LegacyReturnLineInput[]): Promise<BuiltLine[]> {
    const built: BuiltLine[] = [];
    for (const line of lines) {
      const { productVariantId } = await resolvePurchaseVariant(tx, line);
      const variant = await tx.productVariant.findUnique({
        where: { id: productVariantId },
        select: { id: true, active: true, sizeMetersPerBoard: true },
      });
      if (!variant || !variant.active) throw new NotFoundError({ productVariantId });
      built.push(this.computeLine(line, D(variant.sizeMetersPerBoard), variant.id));
    }
    return built;
  }

  private totals(lines: BuiltLine[]) {
    const sum = (pick: (l: BuiltLine) => Decimal) =>
      lines.reduce((acc, l) => acc.plus(pick(l)), new Decimal(0));
    return {
      subtotal: sum((l) => l.lineSubtotal),
      discountTotal: sum((l) => l.lineDiscount),
      taxTotal: sum((l) => l.lineTax),
      grandTotal: sum((l) => l.lineTotal),
    };
  }

  private lineData(l: BuiltLine) {
    return {
      productVariantId: l.productVariantId,
      lengthM: l.lengthM?.toFixed(4) ?? null,
      widthM: l.widthM?.toFixed(4) ?? null,
      returnedBoards: l.returnedBoards.toFixed(4),
      returnedMeters: l.returnedMeters.toFixed(4),
      unitPricePerMeter: l.unitPricePerMeter.toFixed(2),
      discountPct: l.discountPct.toFixed(2),
      taxRate: l.taxRate.toFixed(2),
      lineSubtotal: l.lineSubtotal.toFixed(2),
      lineDiscount: l.lineDiscount.toFixed(2),
      lineNetExTax: l.lineNetExTax.toFixed(2),
      lineTax: l.lineTax.toFixed(2),
      lineTotal: l.lineTotal.toFixed(2),
      note: l.note,
    };
  }

  // ── create / update (draft only) ─────────────────────────────────────────

  async create(body: CreateLegacyReturn, user: AuthenticatedUser) {
    this.assertBranch(user, body.branchId);
    const customer = await this.prisma.customer.findUnique({ where: { id: body.customerId } });
    if (!customer) throw new NotFoundError({ customerId: body.customerId });
    const branch = await this.prisma.branch.findUnique({ where: { id: body.branchId } });
    if (!branch) throw new NotFoundError({ branchId: body.branchId });

    return this.prisma.runInTransaction(async (tx) => {
      const built = await this.buildLines(tx, body.lines);
      const t = this.totals(built);
      const doc = await tx.legacySalesReturn.create({
        data: {
          customerId: body.customerId,
          branchId: body.branchId,
          paperInvoiceNumber: body.paperInvoiceNumber.trim(),
          paperInvoiceDate: new Date(body.paperInvoiceDate),
          returnDate: new Date(body.returnDate),
          notes: body.notes ?? null,
          status: "DRAFT",
          subtotal: t.subtotal.toFixed(2),
          discountTotal: t.discountTotal.toFixed(2),
          taxTotal: t.taxTotal.toFixed(2),
          grandTotal: t.grandTotal.toFixed(2),
          createdBy: user.id,
          lines: { create: built.map((b) => this.lineData(b)) },
        },
      });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "legacy_sales_return",
        entityId: doc.id,
        afterSnapshot: { returnNumber: doc.returnNumber.toString(), grandTotal: doc.grandTotal.toString() },
        summaryAr: `${user.name} أنشأ مردوداً بدون فاتورة رقم ${doc.returnNumber}`,
        summaryEn: `${user.name} created legacy return ${doc.returnNumber}`,
      });
      return this.detail(doc.id, user, tx);
    });
  }

  async update(id: string, body: UpdateLegacyReturn, user: AuthenticatedUser) {
    const existing = await this.prisma.legacySalesReturn.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError({ id });
    this.assertBranch(user, existing.branchId);
    // A confirmed document has moved stock and money. Correcting it means
    // cancelling it and entering a new one, not quietly rewriting the record.
    if (existing.status !== "DRAFT") {
      throw new ValidationError({
        reason: "legacy_return_not_draft",
        status: existing.status,
        messageAr: "لا يمكن تعديل مردود مؤكد أو ملغي. ألغِ المستند وأنشئ مردوداً جديداً.",
      });
    }
    if (body.branchId) this.assertBranch(user, body.branchId);

    return this.prisma.runInTransaction(async (tx) => {
      const lines = body.lines;
      let totals = {
        subtotal: D(existing.subtotal),
        discountTotal: D(existing.discountTotal),
        taxTotal: D(existing.taxTotal),
        grandTotal: D(existing.grandTotal),
      };
      if (lines) {
        const built = await this.buildLines(tx, lines);
        totals = this.totals(built);
        await tx.legacySalesReturnLine.deleteMany({ where: { legacySalesReturnId: id } });
        for (const b of built) {
          await tx.legacySalesReturnLine.create({ data: { legacySalesReturnId: id, ...this.lineData(b) } });
        }
      }
      await tx.legacySalesReturn.update({
        where: { id },
        data: {
          ...(body.customerId ? { customerId: body.customerId } : {}),
          ...(body.branchId ? { branchId: body.branchId } : {}),
          ...(body.paperInvoiceNumber ? { paperInvoiceNumber: body.paperInvoiceNumber.trim() } : {}),
          ...(body.paperInvoiceDate ? { paperInvoiceDate: new Date(body.paperInvoiceDate) } : {}),
          ...(body.returnDate ? { returnDate: new Date(body.returnDate) } : {}),
          ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
          subtotal: totals.subtotal.toFixed(2),
          discountTotal: totals.discountTotal.toFixed(2),
          taxTotal: totals.taxTotal.toFixed(2),
          grandTotal: totals.grandTotal.toFixed(2),
        },
      });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "legacy_sales_return",
        entityId: id,
        summaryAr: `${user.name} عدّل مسودة مردود بدون فاتورة رقم ${existing.returnNumber}`,
        summaryEn: `${user.name} updated legacy return draft ${existing.returnNumber}`,
      });
      return this.detail(id, user, tx);
    });
  }

  // ── confirm ──────────────────────────────────────────────────────────────

  /**
   * Posts the document: stock in, customer credited, journals written.
   *
   * Idempotent by re-reading the row inside the transaction under a row lock —
   * a second click finds it already CONFIRMED and returns that, rather than
   * posting twice. Everything below happens in one transaction, so a failure
   * anywhere leaves the document a draft with nothing posted.
   */
  async confirm(id: string, user: AuthenticatedUser) {
    const pre = await this.prisma.legacySalesReturn.findUnique({ where: { id }, include: { lines: true } });
    if (!pre) throw new NotFoundError({ id });
    this.assertBranch(user, pre.branchId);
    if (pre.status === "CONFIRMED") return this.detail(id, user);
    if (pre.status !== "DRAFT") {
      throw new ValidationError({ reason: "legacy_return_not_draft", status: pre.status });
    }

    const returnDateStr = pre.returnDate.toISOString().slice(0, 10);
    const profile = await this.effectiveConfig.postingProfileAsOf(returnDateStr);
    const salesReturnsAccountId = profile?.salesReturnsAccountId ?? null;
    const arAccountId = profile?.arAccountId ?? null;
    const vatOutputAccountId = profile?.vatOutputAccountId ?? null;
    const cogsAccountId = profile?.cogsAccountId ?? null;
    const inventoryAccountId = profile?.inventoryAccountId ?? null;

    return this.prisma.runInTransaction(async (tx) => {
      // Serialize concurrent confirms of the SAME document.
      await tx.$queryRaw`SELECT id FROM legacy_sales_returns WHERE id = ${id}::uuid FOR UPDATE`;
      const fresh = await tx.legacySalesReturn.findUnique({ where: { id }, include: { lines: true } });
      if (!fresh) throw new NotFoundError({ id });
      if (fresh.status === "CONFIRMED") return this.detail(id, user, tx);
      if (fresh.status !== "DRAFT") {
        throw new ValidationError({ reason: "legacy_return_not_draft", status: fresh.status });
      }

      const t = {
        subtotal: D(fresh.subtotal),
        discountTotal: D(fresh.discountTotal),
        taxTotal: D(fresh.taxTotal),
        grandTotal: D(fresh.grandTotal),
      };

      if (!salesReturnsAccountId) throw new ValidationError({ reason: "sales_returns_account_required" });
      if (t.grandTotal.gt(0)) {
        if (t.taxTotal.gt(0) && !vatOutputAccountId) throw new ValidationError({ reason: "tax_account_required" });
        if (!arAccountId) throw new ValidationError({ reason: "ar_account_required" });
      }
      if (!cogsAccountId || !inventoryAccountId) {
        throw new ValidationError({ reason: "cogs_or_inventory_account_required" });
      }

      // ── the approved cost policy ────────────────────────────────────────
      // The original cost is unknowable, so the goods are valued at what stock
      // of this exact variant is worth right now — read once, frozen on the
      // line, and used again unchanged when the document is cancelled.
      const variantIds = [...new Set(fresh.lines.map((l) => l.productVariantId))].sort();
      for (const vid of variantIds) {
        await tx.$queryRaw`SELECT id FROM product_variants WHERE id = ${vid}::uuid FOR UPDATE`;
      }
      const wac = new Map<string, Decimal>();
      for (const vid of variantIds) {
        const v = await tx.productVariant.findUnique({
          where: { id: vid },
          select: { avgCostPerMeter: true, sku: { select: { code: true, colorNameAr: true } }, sizeMetersPerBoard: true },
        });
        const cost = D(v?.avgCostPerMeter);
        // No usable cost means no posting. Zero, the selling price and the
        // purchase default are all forbidden substitutes — the document waits
        // until the variant has a real weighted-average cost.
        if (!cost.isFinite() || cost.lte(0)) {
          throw new ValidationError({
            reason: "legacy_return_cost_unavailable",
            productVariantId: vid,
            productCode: v?.sku.code ?? null,
            messageAr: `لا يوجد متوسط تكلفة معتمد للصنف «${v?.sku.colorNameAr ?? ""}» مقاس ${D(v?.sizeMetersPerBoard).toFixed(2)} م، ولا يمكن تأكيد المرتجع بدون تكلفة حقيقية. سجّل شراءً لهذا المقاس أولاً.`,
          });
        }
        wac.set(vid, cost);
      }

      const stockLines = fresh.lines.map((l) => {
        const cost = wac.get(l.productVariantId)!;
        const meters = D(l.returnedMeters);
        return {
          lineId: l.id,
          variantId: l.productVariantId,
          meters,
          boards: D(l.returnedBoards),
          costPerMeter: cost,
          cogs: new Decimal(meters.mul(cost).toFixed(2)),
        };
      });
      const cogsTotal = stockLines.reduce((a, l) => a.plus(l.cogs), new Decimal(0));

      const returnNumber = fresh.returnNumber.toString();
      const branchId = fresh.branchId;

      // 1. Commercial: Dr Sales-Returns (net) + Dr VAT-output (tax); Cr AR.
      //    The customer's account is credited — this document has no other
      //    settlement, and no cash or bank account is touched anywhere.
      const commercial = await this.posting.post({
        tx,
        actor: user,
        sourceType: "SALES_RETURN",
        sourceId: fresh.id,
        entryType: "JOURNAL",
        entryDate: returnDateStr,
        reference: `LRN-${returnNumber}`,
        description: `مردود بدون فاتورة رقم ${returnNumber}`,
        idempotencyKey: `LEGACY_RETURN:${fresh.id}`,
        lines: [
          {
            accountId: salesReturnsAccountId,
            debit: t.subtotal.minus(t.discountTotal).toFixed(2),
            credit: "0",
            note: `مردودات مبيعات — بدون فاتورة ${returnNumber}`,
            branchId,
          },
          ...(t.taxTotal.gt(0) && vatOutputAccountId
            ? [{ accountId: vatOutputAccountId, debit: t.taxTotal.toFixed(2), credit: "0", note: `عكس ض.ق.م — ${returnNumber}`, branchId }]
            : []),
          {
            accountId: arAccountId!,
            debit: "0",
            credit: t.grandTotal.toFixed(2),
            note: `إضافة قيمة المرتجع لحساب العميل — ${returnNumber}`,
            branchId,
            partyType: "CUSTOMER" as const,
            partyId: fresh.customerId,
          },
        ],
      });

      // 2. Inventory: Dr Inventory / Cr COGS at the snapshotted cost.
      let cogsJournalEntryId: string | null = null;
      if (cogsTotal.gt(0)) {
        const posted = await this.posting.post({
          tx,
          actor: user,
          sourceType: "SALES_RETURN",
          sourceId: fresh.id,
          entryType: "JOURNAL",
          entryDate: returnDateStr,
          reference: `LRN-${returnNumber}-COGS`,
          description: `تكلفة مردود بدون فاتورة رقم ${returnNumber}`,
          idempotencyKey: `LEGACY_RETURN_COGS:${fresh.id}`,
          lines: [
            { accountId: inventoryAccountId, debit: cogsTotal.toFixed(2), credit: "0", note: `ارتجاع للمخزون — ${returnNumber}`, branchId },
            { accountId: cogsAccountId, debit: "0", credit: cogsTotal.toFixed(2), note: `عكس ت.ب.م — ${returnNumber}`, branchId },
          ],
        });
        cogsJournalEntryId = posted.journalEntryId;
      }

      // 3. Stock in, through the one costing path both return kinds share.
      await this.returnStock.apply(
        tx,
        stockLines.map((l) => ({ variantId: l.variantId, meters: l.meters, boards: l.boards, cogs: l.cogs })),
        branchId,
        user,
        1,
        {
          applyRefType: "legacy_sales_return",
          reverseRefType: "legacy_sales_return_cancel",
          refId: fresh.id,
          summaryApplyAr: `مردود بدون فاتورة للمخزون — ${returnNumber}`,
          summaryReverseAr: `إلغاء مردود بدون فاتورة — ${returnNumber}`,
          summaryApplyEn: `Legacy return to stock — ${returnNumber}`,
          summaryReverseEn: `Cancel legacy return restock — ${returnNumber}`,
          humanReadableNote: `مردود بدون فاتورة ${returnNumber}`,
        },
      );

      // 4. Freeze the cost basis on each line.
      for (const l of stockLines) {
        await tx.legacySalesReturnLine.update({
          where: { id: l.lineId },
          data: { costPerMeterSnapshot: l.costPerMeter.toFixed(4), lineCogs: l.cogs.toFixed(2) },
        });
      }

      // 5. The customer statement row.
      const ctx = await tx.customerTransaction.create({
        data: {
          customerId: fresh.customerId,
          type: "RETURN",
          direction: "CR",
          amount: t.grandTotal.toFixed(2),
          date: fresh.returnDate,
          reference: `LRN-${returnNumber}`,
          description: `مردود بدون فاتورة رقم ${returnNumber}`,
          createdBy: user.id,
        },
      });

      await tx.legacySalesReturn.update({
        where: { id },
        data: {
          status: "CONFIRMED",
          cogsTotal: cogsTotal.toFixed(2),
          journalEntryId: commercial.journalEntryId,
          cogsJournalEntryId,
          customerTransactionId: ctx.id,
          salesReturnsAccountId,
          confirmedAt: new Date(),
          confirmedBy: user.id,
        },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CONFIRM",
        entityType: "legacy_sales_return",
        entityId: id,
        afterSnapshot: { returnNumber, grandTotal: t.grandTotal.toFixed(2), cogsTotal: cogsTotal.toFixed(2) },
        summaryAr: `${user.name} أكّد مردوداً بدون فاتورة رقم ${returnNumber} بقيمة ${t.grandTotal.toFixed(2)}`,
        summaryEn: `${user.name} confirmed legacy return ${returnNumber} for ${t.grandTotal.toFixed(2)}`,
      });

      return this.detail(id, user, tx);
    });
  }

  // ── cancel ───────────────────────────────────────────────────────────────

  /**
   * Reverses everything the confirmation did, using the SAME numbers.
   *
   * The cost reversed is the one frozen on the line, not whatever the average
   * has drifted to since — otherwise cancelling a return could quietly change
   * the value of stock that has nothing to do with it. If the returned goods
   * have already been sold on, the reversal is refused rather than driving
   * stock negative.
   */
  async cancel(id: string, body: CancelLegacyReturn, user: AuthenticatedUser) {
    const pre = await this.prisma.legacySalesReturn.findUnique({ where: { id }, include: { lines: true } });
    if (!pre) throw new NotFoundError({ id });
    this.assertBranch(user, pre.branchId);
    if (pre.status === "CANCELLED") return this.detail(id, user);
    if (pre.status !== "CONFIRMED") {
      throw new ValidationError({
        reason: "legacy_return_not_confirmed",
        status: pre.status,
        messageAr: "لا يمكن إلغاء مستند غير مؤكد.",
      });
    }

    return this.prisma.runInTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM legacy_sales_returns WHERE id = ${id}::uuid FOR UPDATE`;
      const fresh = await tx.legacySalesReturn.findUnique({ where: { id }, include: { lines: true } });
      if (!fresh) throw new NotFoundError({ id });
      if (fresh.status === "CANCELLED") return this.detail(id, user, tx);
      if (fresh.status !== "CONFIRMED") {
        throw new ValidationError({ reason: "legacy_return_not_confirmed", status: fresh.status });
      }

      const returnNumber = fresh.returnNumber.toString();
      const cancelDate = new Date().toISOString().slice(0, 10);

      // Stock back out first: if the goods are gone this refuses, and nothing
      // else has been written yet.
      await this.returnStock.apply(
        tx,
        fresh.lines.map((l) => ({
          variantId: l.productVariantId,
          meters: D(l.returnedMeters),
          boards: D(l.returnedBoards),
          cogs: D(l.lineCogs),
        })),
        fresh.branchId,
        user,
        -1,
        {
          applyRefType: "legacy_sales_return",
          reverseRefType: "legacy_sales_return_cancel",
          refId: fresh.id,
          summaryApplyAr: `مردود بدون فاتورة للمخزون — ${returnNumber}`,
          summaryReverseAr: `إلغاء مردود بدون فاتورة — ${returnNumber}`,
          summaryApplyEn: `Legacy return to stock — ${returnNumber}`,
          summaryReverseEn: `Cancel legacy return restock — ${returnNumber}`,
          humanReadableNote: `إلغاء مردود بدون فاتورة ${returnNumber}`,
        },
      );

      // Mirror journals — the originals stay exactly as posted.
      if (fresh.journalEntryId) {
        await this.reversal.reverse({
          tx,
          entryId: fresh.journalEntryId,
          reason: `إلغاء مردود بدون فاتورة رقم ${returnNumber} — ${body.reason.trim()}`,
          reversalDate: cancelDate,
          actor: user,
        });
      }
      if (fresh.cogsJournalEntryId) {
        await this.reversal.reverse({
          tx,
          entryId: fresh.cogsJournalEntryId,
          reason: `إلغاء تكلفة مردود بدون فاتورة رقم ${returnNumber}`,
          reversalDate: cancelDate,
          actor: user,
        });
      }

      // Undo the customer credit with an opposite statement row.
      await tx.customerTransaction.create({
        data: {
          customerId: fresh.customerId,
          type: "RETURN",
          direction: "DR",
          amount: D(fresh.grandTotal).toFixed(2),
          date: new Date(cancelDate),
          reference: `LRN-${returnNumber}-CANCEL`,
          description: `إلغاء مردود بدون فاتورة رقم ${returnNumber}`,
          createdBy: user.id,
        },
      });

      await tx.legacySalesReturn.update({
        where: { id },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          cancelledBy: user.id,
          cancellationReason: body.reason.trim(),
        },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CANCEL",
        entityType: "legacy_sales_return",
        entityId: id,
        afterSnapshot: { returnNumber, reason: body.reason.trim() },
        summaryAr: `${user.name} ألغى مردوداً بدون فاتورة رقم ${returnNumber}`,
        summaryEn: `${user.name} cancelled legacy return ${returnNumber}`,
      });

      return this.detail(id, user, tx);
    });
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async list(query: LegacyReturnQuery, user: AuthenticatedUser) {
    const where: Prisma.LegacySalesReturnWhereInput = {
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.paperInvoiceNumber
        ? { paperInvoiceNumber: { contains: query.paperInvoiceNumber, mode: "insensitive" } }
        : {}),
      ...(query.from || query.to
        ? {
            returnDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      // A non-OWNER only ever sees their own branches.
      ...(user.role !== "OWNER" ? { branchId: { in: user.allowedBranches } } : {}),
    };
    if (query.q) {
      const q = query.q.trim();
      where.OR = [
        { paperInvoiceNumber: { contains: q, mode: "insensitive" } },
        { customer: { nameAr: { contains: q, mode: "insensitive" } } },
        ...(/^\d+$/.test(q) ? [{ returnNumber: BigInt(q) }] : []),
      ];
    }

    const [rows, totalCount, agg] = await Promise.all([
      this.prisma.legacySalesReturn.findMany({
        where,
        include: {
          customer: { select: { code: true, nameAr: true } },
          branch: { select: { nameAr: true } },
          creator: { select: { name: true } },
          _count: { select: { lines: true } },
        },
        orderBy: [{ returnDate: "desc" }, { returnNumber: "desc" }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.legacySalesReturn.count({ where }),
      this.prisma.legacySalesReturn.aggregate({ where, _sum: { grandTotal: true } }),
    ]);

    return {
      rows: rows.map((r) => ({
        id: r.id,
        returnNumber: r.returnNumber.toString(),
        status: r.status as "DRAFT" | "CONFIRMED" | "CANCELLED",
        customerId: r.customerId,
        customerCode: r.customer.code ?? null,
        customerNameAr: r.customer.nameAr,
        branchId: r.branchId,
        branchNameAr: r.branch.nameAr,
        paperInvoiceNumber: r.paperInvoiceNumber,
        paperInvoiceDate: r.paperInvoiceDate.toISOString().slice(0, 10),
        returnDate: r.returnDate.toISOString().slice(0, 10),
        lineCount: r._count.lines,
        subtotal: r.subtotal.toFixed(2),
        discountTotal: r.discountTotal.toFixed(2),
        taxTotal: r.taxTotal.toFixed(2),
        grandTotal: r.grandTotal.toFixed(2),
        cogsTotal: r.cogsTotal.toFixed(2),
        createdByName: r.creator.name,
        createdAt: r.createdAt.toISOString(),
      })),
      totalCount,
      totalAmount: D(agg._sum.grandTotal).toFixed(2),
      limit: query.limit,
      offset: query.offset,
    };
  }

  async detail(id: string, user: AuthenticatedUser, tx?: Tx) {
    const db = tx ?? this.prisma;
    const r = await db.legacySalesReturn.findUnique({
      where: { id },
      include: {
        customer: { select: { code: true, nameAr: true } },
        branch: { select: { nameAr: true } },
        creator: { select: { name: true } },
        confirmer: { select: { name: true } },
        canceller: { select: { name: true } },
        lines: {
          include: {
            productVariant: {
              select: { id: true, sizeMetersPerBoard: true, sku: { select: { id: true, code: true, colorNameAr: true } } },
            },
          },
        },
      },
    });
    if (!r) throw new NotFoundError({ id });
    this.assertBranch(user, r.branchId);

    const entryNumber = async (jid: string | null) => {
      if (!jid) return null;
      const j = await db.journalEntry.findUnique({ where: { id: jid }, select: { entryNumber: true } });
      return j ? j.entryNumber.toString() : null;
    };

    return {
      id: r.id,
      returnNumber: r.returnNumber.toString(),
      status: r.status as "DRAFT" | "CONFIRMED" | "CANCELLED",
      customerId: r.customerId,
      customerCode: r.customer.code ?? null,
      customerNameAr: r.customer.nameAr,
      branchId: r.branchId,
      branchNameAr: r.branch.nameAr,
      paperInvoiceNumber: r.paperInvoiceNumber,
      paperInvoiceDate: r.paperInvoiceDate.toISOString().slice(0, 10),
      returnDate: r.returnDate.toISOString().slice(0, 10),
      lineCount: r.lines.length,
      subtotal: r.subtotal.toFixed(2),
      discountTotal: r.discountTotal.toFixed(2),
      taxTotal: r.taxTotal.toFixed(2),
      grandTotal: r.grandTotal.toFixed(2),
      cogsTotal: r.cogsTotal.toFixed(2),
      createdByName: r.creator.name,
      createdAt: r.createdAt.toISOString(),
      settlementMode: "KEEP_AS_CUSTOMER_CREDIT" as const,
      notes: r.notes,
      lines: r.lines.map((l) => {
        const size = D(l.productVariant.sizeMetersPerBoard);
        return {
          id: l.id,
          productVariantId: l.productVariantId,
          productSkuId: l.productVariant.sku.id,
          productCode: l.productVariant.sku.code,
          productNameAr: l.productVariant.sku.colorNameAr,
          sizeMetersPerBoard: size.toFixed(4),
          sizeBadgeAr: BADGE_AR[classifyBoardSize(size.toFixed(4))] ?? "م/خ",
          lengthM: l.lengthM ? D(l.lengthM).toFixed(4) : null,
          widthM: l.widthM ? D(l.widthM).toFixed(4) : null,
          returnedBoards: D(l.returnedBoards).toFixed(4),
          returnedMeters: D(l.returnedMeters).toFixed(4),
          unitPricePerMeter: D(l.unitPricePerMeter).toFixed(2),
          discountPct: D(l.discountPct).toFixed(2),
          taxRate: D(l.taxRate).toFixed(2),
          lineSubtotal: D(l.lineSubtotal).toFixed(2),
          lineDiscount: D(l.lineDiscount).toFixed(2),
          lineNetExTax: D(l.lineNetExTax).toFixed(2),
          lineTax: D(l.lineTax).toFixed(2),
          lineTotal: D(l.lineTotal).toFixed(2),
          costPerMeterSnapshot: l.costPerMeterSnapshot ? D(l.costPerMeterSnapshot).toFixed(4) : null,
          lineCogs: D(l.lineCogs).toFixed(2),
          note: l.note,
        };
      }),
      journalEntryId: r.journalEntryId,
      journalEntryNumber: await entryNumber(r.journalEntryId),
      cogsJournalEntryId: r.cogsJournalEntryId,
      cogsJournalEntryNumber: await entryNumber(r.cogsJournalEntryId),
      customerTransactionId: r.customerTransactionId,
      confirmedAt: r.confirmedAt?.toISOString() ?? null,
      confirmedByName: r.confirmer?.name ?? null,
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
      cancelledByName: r.canceller?.name ?? null,
      cancellationReason: r.cancellationReason,
    };
  }
}
