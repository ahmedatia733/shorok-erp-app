import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import type {
  ExecutePurchaseInvoiceRevision,
  InvoiceRevisionPreview,
  InvoiceRevisionResult,
  PostingLine,
  PreviewPurchaseInvoiceRevision,
  PurchaseInvoiceRevisionPayload,
  RevisionIssue,
  RevisionJournalPreview,
  RevisionLineDiff,
  RevisionStockEffect,
  RevisionValuationVariant,
} from "@shorok/shared";
// Value imports, NOT `import type`: Nest reads these classes from the emitted
// decorator metadata to resolve the constructor, and a type-only import is
// erased at compile time — the code would compile and then fail to inject.
// The rule is disabled here so `eslint --fix` cannot silently reintroduce it.
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Prisma, PrismaService } from "../../prisma/prisma.service";
import { ConflictError, NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { AuditService } from "../audit/audit.service";
import { InventoryEngine } from "../inventory/inventory.engine";
import { PostingEngine } from "../posting/posting.engine";
import { ReversalService } from "../posting/reversal.service";
import { EffectiveConfigService } from "../configuration/effective-config.service";
import { ReturnableService } from "../returns/returnable.service";
import { computePurchaseInvoiceTotals, computePurchaseLineTotals } from "../purchase-invoices/purchase-line-math";
import { PostingPeriodService, type ResolvedPostingDate } from "./posting-period.service";
import { previewFingerprint, snapshotFingerprint } from "./revision-fingerprint";
import { D, issue, money, qty, rate, StockProjection } from "./revision-support";
import { ValuationReplayService, type VariantReplay } from "./valuation-replay.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */

type Tx = Prisma.TransactionClient;

/**
 * Revision of a CONFIRMED purchase invoice.
 *
 * A purchase is where cost enters the system, so revising one is not simply a
 * matter of reversing a journal: the shared per-variant WAC that receipt set has
 * since been consumed by every sale that followed. Changing the cost after the
 * fact therefore changes both what the remaining stock is worth AND what those
 * later sales should have cost.
 *
 * The valuation replay answers that exactly (see `valuation-replay.ts`), and the
 * result is posted as a dedicated adjustment journal:
 *
 *   Δ receipt value  =  Δ inventory value  +  Δ COGS
 *
 * The purchase journal's own reversal/replacement already moves Δ receipt value
 * through Inventory, so the adjustment moves the Δ COGS part out of Inventory
 * into COGS. That identity is asserted numerically before anything is written —
 * if it does not hold, the revision refuses to post rather than guess.
 */
@Injectable()
export class PurchaseInvoiceRevisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryEngine,
    private readonly posting: PostingEngine,
    private readonly reversal: ReversalService,
    private readonly config: EffectiveConfigService,
    private readonly returnable: ReturnableService,
    private readonly periods: PostingPeriodService,
    private readonly replay: ValuationReplayService,
  ) {}

  async preview(
    invoiceId: string,
    body: PreviewPurchaseInvoiceRevision,
    actor: AuthenticatedUser,
  ): Promise<InvoiceRevisionPreview> {
    const calc = await this.calculate(this.prisma, invoiceId, body.expectedRevisionNumber, body.payload, actor);
    return calc.preview;
  }

  async execute(
    invoiceId: string,
    body: ExecutePurchaseInvoiceRevision,
    actor: AuthenticatedUser,
  ): Promise<InvoiceRevisionResult> {
    const replayed = await this.prisma.purchaseInvoiceRevision.findUnique({
      where: { idempotencyKey: body.idempotencyKey },
    });
    if (replayed) return this.resultFrom(this.prisma, replayed, true);

    return this.prisma.runInTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;

      const inside = await tx.purchaseInvoiceRevision.findUnique({
        where: { idempotencyKey: body.idempotencyKey },
      });
      if (inside) return this.resultFrom(tx, inside, true);

      const calc = await this.calculate(tx, invoiceId, body.expectedRevisionNumber, body.payload, actor);
      if (calc.preview.previewFingerprint !== body.previewFingerprint) {
        throw new ConflictError("errors.revision_preview_stale", {
          reason: "revision_preview_stale",
          expected: body.previewFingerprint,
          actual: calc.preview.previewFingerprint,
        });
      }
      if (calc.preview.blocking.length > 0) {
        throw new ValidationError({
          reason: "revision_blocked",
          issues: calc.preview.blocking.map((b) => b.code),
          messages: calc.preview.blocking.map((b) => b.messageAr),
        });
      }
      const unacknowledged = calc.preview.warnings
        .map((w) => w.code)
        .filter((code) => !(body.acknowledgedWarnings ?? []).includes(code));
      if (unacknowledged.length > 0) {
        throw new ValidationError({ reason: "revision_warnings_not_acknowledged", warnings: unacknowledged });
      }

      return this.commit(tx, calc, body, actor);
    });
  }

  async history(invoiceId: string, actor: AuthenticatedUser) {
    const invoice = await this.prisma.purchaseInvoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, invoiceNumber: true, branchId: true, revisionNumber: true, status: true },
    });
    if (!invoice) throw new NotFoundError({ id: invoiceId });
    if (actor.role !== "OWNER" && !actor.allowedBranches.includes(invoice.branchId)) {
      throw new NotFoundError({ id: invoiceId });
    }
    const rows = await this.prisma.purchaseInvoiceRevision.findMany({
      where: { purchaseInvoiceId: invoiceId },
      orderBy: { revisionNumber: "asc" },
      include: { actor: { select: { id: true, name: true } } },
    });
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      currentRevision: invoice.revisionNumber,
      status: invoice.status,
      revisions: rows.map((r) => this.formatRevision(r)),
    };
  }

  async getRevision(invoiceId: string, revisionNumber: number, actor: AuthenticatedUser) {
    const invoice = await this.prisma.purchaseInvoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, branchId: true },
    });
    if (!invoice) throw new NotFoundError({ id: invoiceId });
    if (actor.role !== "OWNER" && !actor.allowedBranches.includes(invoice.branchId)) {
      throw new NotFoundError({ id: invoiceId });
    }
    const row = await this.prisma.purchaseInvoiceRevision.findUnique({
      where: { purchaseInvoiceId_revisionNumber: { purchaseInvoiceId: invoiceId, revisionNumber } },
      include: { actor: { select: { id: true, name: true } } },
    });
    if (!row) throw new NotFoundError({ invoiceId, revisionNumber });
    return { ...this.formatRevision(row), beforeSnapshot: row.beforeSnapshot, afterSnapshot: row.afterSnapshot, delta: row.delta };
  }

  private formatRevision(r: {
    id: string; revisionNumber: number; previousRevisionNumber: number; reason: string; status: string;
    documentDate: Date; previousDocumentDate: Date; postingDate: Date; crossesClosedPeriod: boolean;
    revisedBy: string; createdAt: Date; delta: Prisma.JsonValue;
    reversalJournalEntryId: string | null; replacementJournalEntryId: string | null;
    valuationJournalEntryIds: Prisma.JsonValue; reversalMovementIds: Prisma.JsonValue;
    replacementMovementIds: Prisma.JsonValue; actor?: { id: string; name: string } | null;
  }) {
    const delta = (r.delta ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      revisionNumber: r.revisionNumber,
      previousRevisionNumber: r.previousRevisionNumber,
      reason: r.reason,
      status: r.status,
      documentDate: r.documentDate.toISOString().slice(0, 10),
      previousDocumentDate: r.previousDocumentDate.toISOString().slice(0, 10),
      postingDate: r.postingDate.toISOString().slice(0, 10),
      crossesClosedPeriod: r.crossesClosedPeriod,
      revisedBy: r.revisedBy,
      revisedByName: r.actor?.name ?? null,
      createdAt: r.createdAt.toISOString(),
      totalDelta: (delta.totalDelta as string) ?? "0.00",
      stockDelta: delta.stockDelta ?? [],
      partyDelta: delta.partyDelta ?? null,
      valuation: delta.valuation ?? null,
      reversalJournalEntryIds: [r.reversalJournalEntryId].filter(Boolean),
      replacementJournalEntryIds: [r.replacementJournalEntryId].filter(Boolean),
      valuationJournalEntryIds: (r.valuationJournalEntryIds ?? []) as string[],
      reversalMovementIds: (r.reversalMovementIds ?? []) as string[],
      replacementMovementIds: (r.replacementMovementIds ?? []) as string[],
    };
  }

  // ── calculation (zero writes) ────────────────────────────────────────────

  private async calculate(
    db: Tx | PrismaService,
    invoiceId: string,
    expectedRevision: number,
    payload: PurchaseInvoiceRevisionPayload,
    actor: AuthenticatedUser,
  ) {
    const blocking: RevisionIssue[] = [];
    const warnings: RevisionIssue[] = [];

    const invoice = await db.purchaseInvoice.findUnique({
      where: { id: invoiceId },
      include: {
        supplier: { select: { id: true, nameAr: true, active: true } },
        branch: { select: { id: true, nameAr: true, active: true } },
        lines: {
          orderBy: { id: "asc" },
          include: {
            productVariant: {
              select: { id: true, sizeMetersPerBoard: true, active: true, avgCostPerMeter: true, sku: { select: { code: true, colorNameAr: true } } },
            },
          },
        },
      },
    });
    if (!invoice) throw new NotFoundError({ id: invoiceId });
    if (actor.role !== "OWNER" && !actor.allowedBranches.includes(invoice.branchId)) {
      throw new NotFoundError({ id: invoiceId });
    }
    if (invoice.status !== "CONFIRMED") {
      throw new ValidationError({ reason: "invoice_not_confirmed", status: invoice.status });
    }
    if (invoice.revisionNumber !== expectedRevision) {
      throw new ConflictError("errors.revision_number_stale", {
        reason: "revision_number_stale",
        expected: expectedRevision,
        actual: invoice.revisionNumber,
      });
    }

    const lastRevision = await db.purchaseInvoiceRevision.findFirst({
      where: { purchaseInvoiceId: invoiceId },
      orderBy: { revisionNumber: "desc" },
    });
    const effective = {
      journalEntryId: lastRevision?.replacementJournalEntryId ?? invoice.journalEntryId,
      movementIds: lastRevision ? ((lastRevision.replacementMovementIds ?? []) as string[]) : null,
    };
    const effectiveMovements = effective.movementIds
      ? await db.inventoryMovement.findMany({ where: { id: { in: effective.movementIds } }, orderBy: { id: "asc" } })
      : await db.inventoryMovement.findMany({
          where: { referenceType: "purchase_invoice", referenceId: invoiceId, movementType: "RECEIPT" },
          orderBy: { id: "asc" },
        });

    const supplier = await db.supplier.findUnique({
      where: { id: payload.supplierId },
      select: { id: true, nameAr: true, active: true },
    });
    if (!supplier) blocking.push(issue("supplier_not_found", "المورد المحدد غير موجود."));
    else if (!supplier.active) blocking.push(issue("supplier_inactive", `المورد «${supplier.nameAr}» غير نشط.`));

    const branch = await db.branch.findUnique({
      where: { id: payload.branchId },
      select: { id: true, nameAr: true, active: true },
    });
    if (!branch) blocking.push(issue("branch_not_found", "الفرع/المخزن المحدد غير موجود."));
    else if (!branch.active) blocking.push(issue("branch_inactive", `الفرع «${branch.nameAr}» غير نشط.`));

    const variantIds = [...new Set(payload.lines.map((l) => l.productVariantId))];
    const variants = await db.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, sizeMetersPerBoard: true, active: true, avgCostPerMeter: true, avgCost: true, sku: { select: { code: true, colorNameAr: true } } },
    });
    const variantById = new Map(variants.map((v) => [v.id, v]));
    for (const id of variantIds) {
      const v = variantById.get(id);
      if (!v) blocking.push(issue("variant_not_found", "أحد الأصناف المحددة غير موجود.", { productVariantId: id }));
      else if (!v.active) blocking.push(issue("variant_inactive", `الصنف «${v.sku.code}» غير نشط ولا يمكن استخدامه.`, { productVariantId: id }));
    }

    const originalLineById = new Map(invoice.lines.map((l) => [l.id, l]));
    for (const l of payload.lines) {
      if (l.lineId && !originalLineById.has(l.lineId)) {
        blocking.push(issue("line_not_part_of_invoice", "أحد البنود لا ينتمي إلى هذه الفاتورة.", { lineId: l.lineId }));
      }
    }

    const sizes = new Map(variants.map((v) => [v.id, D(v.sizeMetersPerBoard)]));
    const priced = computePurchaseLineTotals(payload.lines, sizes);
    const totals = computePurchaseInvoiceTotals(priced);
    priced.forEach((p, i) => {
      if (!p.metersQuantity.gt(0)) {
        blocking.push(issue("line_meters_required", `البند رقم ${i + 1}: عدد الأمتار يجب أن يكون أكبر من صفر.`));
      }
      if (p.unitPrice.isNegative()) {
        blocking.push(issue("line_price_invalid", `البند رقم ${i + 1}: سعر الشراء غير صالح.`));
      }
    });

    // ── linked purchase returns ───────────────────────────────────────────
    const returnable = await this.returnable.purchaseInvoiceReturnable(invoiceId, db as Tx);
    const returnedByLine = new Map(
      returnable.lines.map((l) => [l.originalLineId, { boards: D(l.previouslyReturnedBoards), variantId: l.productVariantId }]),
    );
    const keptLineIds = new Set(payload.lines.map((l) => l.lineId).filter(Boolean) as string[]);
    for (const [lineId, ret] of returnedByLine) {
      if (!ret.boards.gt(0)) continue;
      const code = originalLineById.get(lineId)?.productVariant?.sku?.code ?? "";
      if (!keptLineIds.has(lineId)) {
        blocking.push(issue("line_with_return_removed", `لا يمكن حذف البند «${code}» لأن عليه مردود مشتريات مؤكد بكمية ${ret.boards.toFixed(0)} لوح.`, { lineId }));
        continue;
      }
      const revised = payload.lines.find((l) => l.lineId === lineId)!;
      if (revised.productVariantId !== ret.variantId) {
        blocking.push(issue("line_with_return_variant_changed", `لا يمكن تغيير صنف البند «${code}» لأن عليه مردود مشتريات مؤكد.`, { lineId }));
      }
      if (D(revised.boardsQuantity).lt(ret.boards)) {
        blocking.push(
          issue(
            "quantity_below_linked_return",
            `كمية البند «${code}» بعد التعديل (${D(revised.boardsQuantity).toFixed(0)} لوح) أقل من الكمية المرتجعة المؤكدة (${ret.boards.toFixed(0)} لوح).`,
            { lineId },
          ),
        );
      }
    }

    // ── stock: undoing a receipt must not drive any branch negative ───────
    const stockReversal: RevisionStockEffect[] = [];
    const stockApplication: RevisionStockEffect[] = [];
    const projection = new StockProjection();
    const branchNames = new Map<string, string>([[invoice.branch.id, invoice.branch.nameAr]]);
    if (branch) branchNames.set(branch.id, branch.nameAr);

    const involved = new Set<string>();
    for (const m of effectiveMovements) involved.add(`${m.branchId}|${m.productVariantId}`);
    for (const p of priced) involved.add(`${payload.branchId}|${p.productVariantId}`);
    const balances = await db.branchInventoryBalance.findMany({
      where: {
        OR: [...involved].map((k) => {
          const [branchId, productVariantId] = k.split("|");
          return { branchId: branchId!, productVariantId: productVariantId! };
        }),
      },
    });
    for (const k of involved) {
      const [branchId, productVariantId] = k.split("|");
      const b = balances.find((x) => x.branchId === branchId && x.productVariantId === productVariantId);
      projection.seed(branchId!, productVariantId!, D(b?.boardsOnHand), D(b?.metersOnHand));
    }
    for (const m of effectiveMovements) {
      const boards = D(m.boardsQuantity).negated();
      const meters = D(m.metersQuantity).negated();
      projection.apply(m.branchId, m.productVariantId, boards, meters);
      stockReversal.push({
        branchId: m.branchId,
        branchNameAr: branchNames.get(m.branchId) ?? "",
        productVariantId: m.productVariantId,
        productCode: invoice.lines.find((l) => l.productVariantId === m.productVariantId)?.productVariant?.sku?.code ?? null,
        boardsDelta: qty(boards),
        metersDelta: qty(meters),
      });
    }
    for (const p of priced) {
      projection.apply(payload.branchId, p.productVariantId, p.boardsQuantity, p.metersQuantity);
      stockApplication.push({
        branchId: payload.branchId,
        branchNameAr: branch?.nameAr ?? "",
        productVariantId: p.productVariantId,
        productCode: variantById.get(p.productVariantId)?.sku.code ?? null,
        boardsDelta: qty(p.boardsQuantity),
        metersDelta: qty(p.metersQuantity),
      });
    }
    for (const neg of projection.negatives()) {
      const code = variantById.get(neg.productVariantId)?.sku.code
        ?? invoice.lines.find((l) => l.productVariantId === neg.productVariantId)?.productVariant?.sku?.code
        ?? "";
      blocking.push(
        issue(
          "reversal_would_make_stock_negative",
          `لا يمكن عكس استلام الصنف «${code}» من «${branchNames.get(neg.branchId) ?? ""}» لأن الكمية صُرفت بالفعل (المتبقي بعد العكس ${neg.boards} لوح / ${neg.meters} متر).`,
          neg,
        ),
      );
    }

    const branchQuantityDelta: RevisionStockEffect[] = [];
    const netByKey = new Map<string, { boards: Decimal; meters: Decimal }>();
    for (const e of [...stockReversal, ...stockApplication]) {
      const k = `${e.branchId}|${e.productVariantId}`;
      const cur = netByKey.get(k) ?? { boards: new Decimal(0), meters: new Decimal(0) };
      netByKey.set(k, { boards: cur.boards.plus(e.boardsDelta), meters: cur.meters.plus(e.metersDelta) });
    }
    for (const [k, v] of netByKey) {
      const [branchId, productVariantId] = k.split("|");
      if (v.boards.isZero() && v.meters.isZero()) continue;
      branchQuantityDelta.push({
        branchId: branchId!,
        branchNameAr: branchNames.get(branchId!) ?? "",
        productVariantId: productVariantId!,
        productCode: variantById.get(productVariantId!)?.sku.code ?? null,
        boardsDelta: qty(v.boards),
        metersDelta: qty(v.meters),
      });
    }

    // ── period ────────────────────────────────────────────────────────────
    const originalPostingDate = invoice.invoiceDate.toISOString().slice(0, 10);
    let period: ResolvedPostingDate;
    try {
      period = await this.periods.resolve(payload.invoiceDate, originalPostingDate, db as Tx);
    } catch {
      blocking.push(issue("no_open_posting_period", "لا توجد فترة محاسبية مفتوحة يمكن ترحيل التعديل فيها."));
      period = { documentDate: payload.invoiceDate, postingDate: payload.invoiceDate, crossesClosedPeriod: true, noteAr: null };
    }
    if (period.crossesClosedPeriod) {
      warnings.push(issue("posting_moved_to_open_period", period.noteAr ?? "سيتم الترحيل في أول فترة مفتوحة."));
    }

    // ── VALUATION REPLAY ──────────────────────────────────────────────────
    const substitutions = [...new Set(priced.map((p) => p.productVariantId))].map((variantId) => ({
      productVariantId: variantId,
      meters: priced.filter((p) => p.productVariantId === variantId).reduce((a, p) => a.plus(p.metersQuantity), new Decimal(0)),
      value: priced.filter((p) => p.productVariantId === variantId).reduce((a, p) => a.plus(p.lineTotal), new Decimal(0)),
    }));

    let replays: VariantReplay[] = [];
    let replayFailure: string | null = null;
    try {
      replays = await this.replay.forPurchaseRevision({
        purchaseInvoiceId: invoiceId,
        substitutions,
        tx: db as Tx,
      });
    } catch (e) {
      replayFailure = e instanceof Error ? e.message : "unknown";
    }
    if (replayFailure) {
      blocking.push(
        issue(
          "safe_wac_replay_not_established",
          "تعذّر إعادة احتساب متوسط التكلفة بشكل موثوق لهذه الأصناف، ولذلك لا يمكن تنفيذ التعديل. راجع حركات المخزون قبل المحاولة مرة أخرى.",
          { detail: replayFailure.slice(0, 160) },
        ),
      );
    }

    const variantMeta = await db.productVariant.findMany({
      where: { id: { in: replays.map((r) => r.productVariantId) } },
      select: { id: true, sizeMetersPerBoard: true, sku: { select: { code: true } } },
    });
    const metaById = new Map(variantMeta.map((v) => [v.id, v]));

    const valuationVariants: RevisionValuationVariant[] = replays.map((r) => {
      const c = r.comparison;
      const meta = metaById.get(r.productVariantId);
      if (!c.reproducedPresent) {
        blocking.push(
          issue(
            "safe_wac_replay_not_established",
            `إعادة احتساب متوسط تكلفة الصنف «${meta?.sku.code ?? ""}» لم تُطابق الرصيد الحالي المسجّل، ولذلك لا يمكن تنفيذ التعديل.`,
            { productVariantId: r.productVariantId },
          ),
        );
      }
      if (!c.conservationHolds) {
        blocking.push(
          issue(
            "valuation_conservation_failed",
            `اختلّت معادلة القيمة للصنف «${meta?.sku.code ?? ""}» (فرق القيمة الداخلة لا يساوي فرق قيمة المخزون زائد فرق التكلفة).`,
            { productVariantId: r.productVariantId },
          ),
        );
      }
      if (c.issueRateMismatches.length > 0) {
        warnings.push(
          issue(
            "historical_cogs_differs_from_pool",
            `الصنف «${meta?.sku.code ?? ""}»: تكلفة ${c.issueRateMismatches.length} من عمليات البيع السابقة المسجّلة تختلف عن متوسط التكلفة المحتسب في نفس اللحظة؛ سيتم اعتماد الاحتساب.`,
            { productVariantId: r.productVariantId },
          ),
        );
      }
      const currentValue = r.presentMeters.times(r.presentWacPerMeter);
      return {
        productVariantId: r.productVariantId,
        productCode: meta?.sku.code ?? null,
        sizeLabel: meta ? D(meta.sizeMetersPerBoard).toFixed(2) : null,
        currentWacPerMeter: rate(r.presentWacPerMeter),
        projectedWacPerMeter: rate(c.revised.endingWacPerMeter),
        currentGlobalMeters: qty(r.presentMeters),
        projectedGlobalMeters: qty(c.revised.ending.meters),
        currentInventoryValue: money(currentValue),
        projectedInventoryValue: money(c.revised.ending.value),
        inventoryValueDelta: money(c.inventoryValueDelta),
        cogsDelta: money(c.cogsDelta),
        replayEventCount: r.eventCount,
        replayReproducedCurrentState: c.reproducedPresent,
      };
    });

    const totalCogsDelta = replays.reduce((a, r) => a.plus(r.comparison.cogsDelta), new Decimal(0));
    const totalInvValueDelta = replays.reduce((a, r) => a.plus(r.comparison.inventoryValueDelta), new Decimal(0));
    // Value that a count correction or an adjustment carried out of the pool at
    // a rate this revision changes. Those movements never touched the ledger, so
    // the difference belongs in the inventory-difference account, not in stock
    // and not in cost of sales.
    const totalAdjustmentDelta = replays.reduce((a, r) => a.plus(r.comparison.adjustmentDelta), new Decimal(0));

    // The identity that makes the adjustment journal correct rather than
    // plausible: everything that changed on the way in has to land in exactly
    // one of stock, cost of sales, or the inventory difference.
    const receiptValueDelta = replays.reduce((a, r) => a.plus(r.comparison.knownValueInDelta), new Decimal(0));
    const identityGap = receiptValueDelta
      .minus(totalInvValueDelta)
      .minus(totalCogsDelta)
      .plus(totalAdjustmentDelta);
    if (replays.length > 0 && identityGap.abs().gt(new Decimal("0.02"))) {
      blocking.push(
        issue(
          "valuation_identity_failed",
          "لم يتحقق التوازن بين فرق قيمة المشتريات وفرق قيمة المخزون وفرق تكلفة المبيعات وفروق الجرد، ولذلك لا يمكن تنفيذ التعديل.",
          {
            receiptValueDelta: money(receiptValueDelta),
            inventoryValueDelta: money(totalInvValueDelta),
            cogsDelta: money(totalCogsDelta),
            adjustmentDelta: money(totalAdjustmentDelta),
            gap: money(identityGap),
          },
        ),
      );
    }

    const replayRequired = !totalCogsDelta.isZero() || !totalInvValueDelta.isZero() || !totalAdjustmentDelta.isZero();
    const valuation = {
      replayRequired,
      reasonAr: replayRequired
        ? "تعديل فاتورة الشراء يغيّر متوسط التكلفة المشترك، وقد صُرفت كميات بعده؛ لذلك أُعيد احتساب الحركة الزمنية لكل صنف متأثر عبر جميع الفروع، وسيتم ترحيل فروق قيمة المخزون وتكلفة المبيعات في قيد تسوية مستقل."
        : "لا يوجد أي فرق في قيمة المخزون أو تكلفة المبيعات بعد إعادة الاحتساب، فلا حاجة إلى قيد تسوية.",
      replayStartAt: replays[0]?.replayStartAt ? replays[0]!.replayStartAt!.toISOString() : null,
      variants: valuationVariants,
      totalInventoryValueDelta: money(totalInvValueDelta),
      totalCogsDelta: money(totalCogsDelta),
    };

    // ── accounts + journal previews ───────────────────────────────────────
    const profile = await this.config.postingProfileAsOf(period.postingDate);
    const inventoryAccountId = profile?.inventoryAccountId ?? null;
    const apAccountId = profile?.apAccountId ?? null;
    const vatInputAccountId = profile?.vatInputAccountId ?? null;
    const cogsAccountId = profile?.cogsAccountId ?? null;
    const shrinkageAccountId = profile?.shrinkageAccountId ?? null;
    if (!inventoryAccountId) blocking.push(issue("inventory_account_required", "لم يتم تحديد حساب المخزون في إعدادات الترحيل."));
    if (!apAccountId) blocking.push(issue("accounts_payable_account_required", "لم يتم تحديد حساب الموردين في إعدادات الترحيل."));
    if (totals.taxAmount.gt(0) && !vatInputAccountId) {
      blocking.push(issue("tax_account_required", "الفاتورة عليها ضريبة ولم يتم تحديد حساب ضريبة المدخلات."));
    }
    if (!totalCogsDelta.isZero() && !cogsAccountId) {
      blocking.push(issue("cogs_account_required", "التعديل ينتج عنه فرق في تكلفة المبيعات ولم يتم تحديد حساب تكلفة المبيعات."));
    }
    if (!totalAdjustmentDelta.isZero() && !shrinkageAccountId) {
      blocking.push(
        issue(
          "shrinkage_account_required",
          "التعديل ينتج عنه فرق تقييم على حركات جرد/تسوية سابقة، ولم يتم تحديد حساب فروق الجرد في إعدادات الترحيل.",
        ),
      );
    }

    const accountIds = [inventoryAccountId, apAccountId, vatInputAccountId, cogsAccountId, shrinkageAccountId].filter(Boolean) as string[];
    const accountRows = await db.account.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, code: true, nameAr: true },
    });
    const accountById = new Map(accountRows.map((a) => [a.id, a]));
    const labelOf = (id: string) => accountById.get(id) ?? { code: "", nameAr: "" };

    const invoiceNumber = invoice.invoiceNumber;
    const journals: RevisionJournalPreview[] = [];
    const effectiveJournal = effective.journalEntryId
      ? await db.journalEntry.findUnique({ where: { id: effective.journalEntryId }, include: { lines: true } })
      : null;
    if (!effectiveJournal) blocking.push(issue("no_effective_journal", "لا يوجد قيد محاسبي حالي لهذه الفاتورة يمكن عكسه."));
    if (effectiveJournal) {
      journals.push({
        kind: "REVERSAL",
        descriptionAr: `عكس قيد فاتورة المشتريات ${invoiceNumber}`,
        postingDate: period.postingDate,
        totalDebit: money(effectiveJournal.lines.reduce((a, l) => a.plus(D(l.credit)), new Decimal(0))),
        totalCredit: money(effectiveJournal.lines.reduce((a, l) => a.plus(D(l.debit)), new Decimal(0))),
        lines: effectiveJournal.lines.map((l) => ({
          accountId: l.accountId,
          accountCode: labelOf(l.accountId).code,
          accountNameAr: labelOf(l.accountId).nameAr,
          debit: money(D(l.credit)),
          credit: money(D(l.debit)),
          partyType: l.partyType as "CUSTOMER" | "SUPPLIER" | null,
          partyId: l.partyId,
          branchId: l.branchId,
          note: l.note,
        })),
      });
    }
    const nextRevision = invoice.revisionNumber + 1;
    if (inventoryAccountId && apAccountId) {
      const lines = this.replacementLines({
        inventoryAccountId, apAccountId, vatInputAccountId, totals,
        invoiceNumber, supplierId: payload.supplierId, branchId: payload.branchId, nextRevision,
      });
      journals.push({
        kind: "REPLACEMENT",
        descriptionAr: `إعادة ترحيل فاتورة المشتريات ${invoiceNumber} — النسخة ${nextRevision}`,
        postingDate: period.postingDate,
        totalDebit: money(lines.reduce((a, l) => a.plus(D(l.debit)), new Decimal(0))),
        totalCredit: money(lines.reduce((a, l) => a.plus(D(l.credit)), new Decimal(0))),
        lines: lines.map((l) => ({
          accountId: l.accountId,
          accountCode: labelOf(l.accountId).code,
          accountNameAr: labelOf(l.accountId).nameAr,
          debit: l.debit,
          credit: l.credit,
          partyType: (l.partyType ?? null) as "CUSTOMER" | "SUPPLIER" | null,
          partyId: l.partyId ?? null,
          branchId: l.branchId ?? null,
          note: l.note ?? null,
        })),
      });
    }
    const needsValuationEntry = !totalCogsDelta.isZero() || !totalAdjustmentDelta.isZero();
    if (needsValuationEntry && inventoryAccountId) {
      const lines = this.valuationLines({
        cogsAccountId, inventoryAccountId, shrinkageAccountId,
        cogsDelta: totalCogsDelta, adjustmentDelta: totalAdjustmentDelta,
        invoiceNumber, nextRevision,
      });
      journals.push({
        kind: "VALUATION_ADJUSTMENT",
        descriptionAr: `تسوية تقييم المخزون وتكلفة المبيعات — تعديل فاتورة المشتريات ${invoiceNumber}`,
        postingDate: period.postingDate,
        totalDebit: money(lines.reduce((a, l) => a.plus(D(l.debit)), new Decimal(0))),
        totalCredit: money(lines.reduce((a, l) => a.plus(D(l.credit)), new Decimal(0))),
        lines: lines.map((l) => ({
          accountId: l.accountId,
          accountCode: labelOf(l.accountId).code,
          accountNameAr: labelOf(l.accountId).nameAr,
          debit: l.debit,
          credit: l.credit,
          partyType: null,
          partyId: null,
          branchId: l.branchId ?? null,
          note: l.note ?? null,
        })),
      });
    }

    // ── linked payments ───────────────────────────────────────────────────
    const allocations = await db.paymentVoucherAllocation.findMany({
      where: { purchaseInvoiceId: invoiceId },
      include: { paymentVoucher: { select: { id: true, voucherNumber: true, voucherDate: true, amount: true, status: true } } },
    });
    const applied = allocations
      .filter((a) => a.paymentVoucher.status === "POSTED")
      .reduce((a, x) => a.plus(D(x.amount)), new Decimal(0));
    const oldTotal = D(invoice.grandTotal);
    const outstandingAfter = totals.grandTotal.minus(applied);
    const partyChanged = payload.supplierId !== invoice.supplierId;
    if (partyChanged && applied.gt(0)) {
      warnings.push(
        issue(
          "party_changed_with_vouchers",
          `تم تغيير المورد مع وجود مدفوعات بمبلغ ${money(applied)} ج.م مسجلة على المورد السابق «${invoice.supplier.nameAr}». ستبقى سندات الصرف كما هي وسيظهر لدى المورد السابق رصيد مدين (دفعة مقدمة) بنفس المبلغ.`,
        ),
      );
    }
    if (!partyChanged && outstandingAfter.isNegative()) {
      warnings.push(
        issue(
          "revision_creates_supplier_advance",
          `إجمالي الفاتورة بعد التعديل (${money(totals.grandTotal)}) أقل من المدفوع (${money(applied)})، وسينتج عن ذلك رصيد مدين (دفعة مقدمة) لدى المورد بمبلغ ${money(outstandingAfter.negated())} ج.م.`,
        ),
      );
    }

    const linkedReturns = await db.purchaseReturn.findMany({
      where: { originalPurchaseInvoiceId: invoiceId },
      select: { id: true, returnNumber: true, status: true, returnDate: true, lines: { select: { returnedBoards: true } } },
      orderBy: { returnNumber: "asc" },
    });

    // ── snapshots ─────────────────────────────────────────────────────────
    const before = {
      invoiceId,
      header: {
        invoiceNumber,
        status: invoice.status,
        revisionNumber: invoice.revisionNumber,
        invoiceDate: invoice.invoiceDate.toISOString().slice(0, 10),
        dueDate: invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : null,
        supplierId: invoice.supplierId,
        supplierNameAr: invoice.supplier.nameAr,
        branchId: invoice.branchId,
        branchNameAr: invoice.branch.nameAr,
        basedOn: invoice.basedOn,
        docDirection: invoice.docDirection,
        customsNumber: invoice.customsNumber,
        notes: invoice.notes,
        subtotal: money(D(invoice.subtotal)),
        taxAmount: money(D(invoice.taxAmount)),
        grandTotal: money(oldTotal),
      },
      lines: invoice.lines.map((l) => ({
        lineId: l.id,
        productVariantId: l.productVariantId,
        productCode: l.productVariant?.sku?.code ?? null,
        colorName: l.productVariant?.sku?.colorNameAr ?? null,
        sizeLabel: l.productVariant ? D(l.productVariant.sizeMetersPerBoard).toFixed(2) : null,
        boards: qty(D(l.boardsQuantity)),
        meters: qty(D(l.metersQuantity)),
        lengthM: l.lengthM != null ? qty(D(l.lengthM)) : null,
        widthM: l.widthM != null ? qty(D(l.widthM)) : null,
        heightM: l.heightM != null ? qty(D(l.heightM)) : null,
        colorCode: l.colorCode,
        unitLabel: l.unitLabel,
        unitPrice: money(D(l.unitPrice)),
        lineTotal: money(D(l.lineTotal)),
        taxRate: D(l.taxRate).toFixed(2),
        taxAmount: money(D(l.taxAmount)),
        isFree: l.isFree ? "true" : "false",
        unitCostAtPosting: l.unitCostAtPosting != null ? money(D(l.unitCostAtPosting)) : null,
      })),
      posting: {
        journalEntryId: effective.journalEntryId,
        movementIds: effectiveMovements.map((m) => m.id),
      },
    };

    const after = {
      invoiceId,
      header: {
        invoiceNumber,
        status: "CONFIRMED",
        revisionNumber: nextRevision,
        invoiceDate: payload.invoiceDate,
        dueDate: payload.dueDate ?? null,
        supplierId: payload.supplierId,
        supplierNameAr: supplier?.nameAr ?? "",
        branchId: payload.branchId,
        branchNameAr: branch?.nameAr ?? "",
        basedOn: payload.basedOn ?? null,
        docDirection: payload.docDirection ?? null,
        customsNumber: payload.customsNumber ?? null,
        notes: payload.notes ?? null,
        subtotal: money(totals.subtotal),
        taxAmount: money(totals.taxAmount),
        grandTotal: money(totals.grandTotal),
      },
      lines: priced.map((p, i) => {
        const src = payload.lines[i]!;
        const v = variantById.get(p.productVariantId);
        return {
          lineId: src.lineId ?? null,
          productVariantId: p.productVariantId,
          productCode: v?.sku.code ?? null,
          colorName: v?.sku.colorNameAr ?? null,
          sizeLabel: v ? D(v.sizeMetersPerBoard).toFixed(2) : null,
          boards: qty(p.boardsQuantity),
          meters: qty(p.metersQuantity),
          lengthM: p.lengthM ? qty(p.lengthM) : null,
          widthM: p.widthM ? qty(p.widthM) : null,
          heightM: p.heightM ? qty(p.heightM) : null,
          colorCode: p.colorCode,
          unitLabel: p.unitLabel,
          unitPrice: money(p.unitPrice),
          lineTotal: money(p.lineTotal),
          taxRate: p.taxRate.toFixed(2),
          taxAmount: money(p.taxAmount),
          isFree: p.isFree ? "true" : "false",
          unitCostAtPosting: p.boardsQuantity.gt(0) ? money(p.lineTotal.div(p.boardsQuantity)) : "0.00",
        };
      }),
      posting: null,
    };

    const lineDiffs = this.diffLines(before.lines, after.lines, returnedByLine);
    const headerFields: InvoiceRevisionPreview["header"] = (
      ["invoiceDate", "dueDate", "supplierNameAr", "branchNameAr", "basedOn", "docDirection", "customsNumber", "notes"] as const
    ).map((field) => ({
      field,
      before: (before.header as unknown as Record<string, string | null>)[field] ?? null,
      after: (after.header as unknown as Record<string, string | null>)[field] ?? null,
    }));

    const effects = { totals: after.header, lineDiffs, stockReversal, stockApplication, journals, valuation };
    const valuationState = replays.map((r) => ({
      productVariantId: r.productVariantId,
      wac: rate(r.presentWacPerMeter),
      meters: qty(r.presentMeters),
      events: r.eventCount,
    }));
    const linkageState = {
      returns: linkedReturns.map((r) => ({ id: r.id, status: r.status })),
      allocations: allocations.map((a) => ({ id: a.id, amount: money(D(a.amount)), status: a.paymentVoucher.status })),
    };
    const fingerprint = previewFingerprint({
      invoiceKind: "PURCHASE",
      invoiceId,
      currentRevision: invoice.revisionNumber,
      beforeSnapshot: before,
      afterSnapshot: after,
      effects,
      valuationState,
      linkageState,
      postingDate: period.postingDate,
      actorId: actor.id,
    });

    const preview: InvoiceRevisionPreview = {
      invoiceId,
      invoiceNumber,
      invoiceKind: "PURCHASE",
      currentRevision: invoice.revisionNumber,
      proposedRevision: nextRevision,
      currentStatus: invoice.status,
      resultingStatus: "CONFIRMED",
      header: headerFields,
      currentLines: before.lines as unknown as Record<string, string | null>[],
      revisedLines: after.lines as unknown as Record<string, string | null>[],
      lineDiffs,
      currentTotals: {
        subtotal: money(D(invoice.subtotal)),
        taxAmount: money(D(invoice.taxAmount)),
        grandTotal: money(oldTotal),
      },
      revisedTotals: {
        subtotal: money(totals.subtotal),
        taxAmount: money(totals.taxAmount),
        grandTotal: money(totals.grandTotal),
      },
      totalDelta: money(totals.grandTotal.minus(oldTotal)),
      stockReversal,
      stockApplication,
      branchQuantityDelta,
      linkedReturns: linkedReturns.map((r) => ({
        returnId: r.id,
        returnNumber: r.returnNumber.toString(),
        status: r.status,
        date: r.returnDate.toISOString().slice(0, 10),
        boards: qty(r.lines.reduce((a, l) => a.plus(D(l.returnedBoards)), new Decimal(0))),
      })),
      linkedVouchers: allocations.map((a) => ({
        voucherId: a.paymentVoucher.id,
        voucherNumber: a.paymentVoucher.voucherNumber.toString(),
        date: a.paymentVoucher.voucherDate.toISOString().slice(0, 10),
        amount: money(D(a.paymentVoucher.amount)),
        allocated: money(D(a.amount)),
      })),
      partyImpactBefore: {
        partyType: "SUPPLIER",
        partyId: invoice.supplierId,
        partyNameAr: invoice.supplier.nameAr,
        balanceDelta: money(oldTotal),
        allocatedAmount: money(applied),
        outstandingAfter: money(oldTotal.minus(applied)),
        creditAfter: money(Decimal.max(new Decimal(0), applied.minus(oldTotal))),
      },
      partyImpactAfter: {
        partyType: "SUPPLIER",
        partyId: payload.supplierId,
        partyNameAr: supplier?.nameAr ?? "",
        balanceDelta: money(totals.grandTotal),
        allocatedAmount: money(partyChanged ? new Decimal(0) : applied),
        outstandingAfter: money(partyChanged ? totals.grandTotal : outstandingAfter),
        creditAfter: money(partyChanged ? new Decimal(0) : Decimal.max(new Decimal(0), applied.minus(totals.grandTotal))),
      },
      valuation,
      journals,
      documentDate: payload.invoiceDate,
      postingDate: period.postingDate,
      crossesClosedPeriod: period.crossesClosedPeriod,
      periodNoteAr: period.noteAr,
      blocking,
      warnings,
      previewFingerprint: fingerprint,
      committedChanges: 0,
    };

    return {
      preview, invoice, effective, effectiveMovements, priced, totals, period, before, after,
      invoiceNumber, supplier, branch, replays, totalCogsDelta, totalAdjustmentDelta,
      accounts: { inventoryAccountId, apAccountId, vatInputAccountId, cogsAccountId, shrinkageAccountId },
      nextRevision,
    };
  }

  private replacementLines(input: {
    inventoryAccountId: string;
    apAccountId: string;
    vatInputAccountId: string | null;
    totals: { subtotal: Decimal; taxAmount: Decimal; grandTotal: Decimal };
    invoiceNumber: string;
    supplierId: string;
    branchId: string;
    nextRevision: number;
  }): PostingLine[] {
    const lines: PostingLine[] = [
      {
        accountId: input.inventoryAccountId,
        debit: money(input.totals.subtotal),
        credit: "0",
        note: `مخزون — فاتورة مشتريات ${input.invoiceNumber} (نسخة ${input.nextRevision})`,
        branchId: input.branchId,
      },
    ];
    if (input.totals.taxAmount.gt(0) && input.vatInputAccountId) {
      lines.push({
        accountId: input.vatInputAccountId,
        debit: money(input.totals.taxAmount),
        credit: "0",
        note: `ضريبة مدخلات — فاتورة مشتريات ${input.invoiceNumber} (نسخة ${input.nextRevision})`,
      });
    }
    lines.push({
      accountId: input.apAccountId,
      debit: "0",
      credit: money(input.totals.grandTotal),
      note: `ذمة للمورد — فاتورة مشتريات ${input.invoiceNumber} (نسخة ${input.nextRevision})`,
      partyType: "SUPPLIER",
      partyId: input.supplierId,
    });
    return lines;
  }

  /**
   * The purchase journal's reversal + replacement already moves the whole change
   * in receipt value through Inventory. Only the part still physically in stock
   * belongs there, so this entry pushes the rest out:
   *
   *   the share already sold          → cost of sales
   *   the share carried off by a count
   *   correction or adjustment        → inventory differences
   *
   * Both sides are netted into a single balanced entry so the ledger shows one
   * correction rather than a scatter of fragments.
   */
  private valuationLines(input: {
    cogsAccountId: string | null;
    inventoryAccountId: string;
    shrinkageAccountId: string | null;
    cogsDelta: Decimal;
    adjustmentDelta: Decimal;
    invoiceNumber: string;
    nextRevision: number;
  }): PostingLine[] {
    const note = `تسوية تقييم — تعديل فاتورة مشتريات ${input.invoiceNumber} (نسخة ${input.nextRevision})`;
    const lines: PostingLine[] = [];
    // Positive cogsDelta = cost of sales was understated → charge it now.
    const cogsAmount = input.cogsDelta.abs();
    if (cogsAmount.gt(0) && input.cogsAccountId) {
      lines.push(
        input.cogsDelta.isPositive()
          ? { accountId: input.cogsAccountId, debit: money(cogsAmount), credit: "0", note }
          : { accountId: input.cogsAccountId, debit: "0", credit: money(cogsAmount), note },
      );
    }
    // adjustmentDelta is signed "value entered the pool", so a negative value
    // means the correction carried MORE value out and the loss grew.
    const adjAmount = input.adjustmentDelta.abs();
    if (adjAmount.gt(0) && input.shrinkageAccountId) {
      lines.push(
        input.adjustmentDelta.isNegative()
          ? { accountId: input.shrinkageAccountId, debit: money(adjAmount), credit: "0", note }
          : { accountId: input.shrinkageAccountId, debit: "0", credit: money(adjAmount), note },
      );
    }
    // Inventory takes the balancing side.
    const net = lines.reduce((a, l) => a.plus(new Decimal(l.debit || "0")).minus(new Decimal(l.credit || "0")), new Decimal(0));
    if (net.isZero()) return [];
    lines.push(
      net.isPositive()
        ? { accountId: input.inventoryAccountId, debit: "0", credit: money(net), note }
        : { accountId: input.inventoryAccountId, debit: money(net.negated()), credit: "0", note },
    );
    return lines;
  }

  private diffLines(
    before: Array<Record<string, string | null>>,
    after: Array<Record<string, string | null>>,
    returned: Map<string, { boards: Decimal; variantId: string }>,
  ): RevisionLineDiff[] {
    const out: RevisionLineDiff[] = [];
    const afterById = new Map(after.filter((l) => l.lineId).map((l) => [l.lineId!, l]));
    const comparable = (l: Record<string, string | null>) =>
      JSON.stringify([l.productVariantId, l.boards, l.meters, l.unitPrice, l.taxRate, l.lineTotal, l.isFree]);
    for (const b of before) {
      const a = b.lineId ? afterById.get(b.lineId) : undefined;
      out.push({
        lineId: b.lineId ?? null,
        productVariantId: b.productVariantId!,
        productCode: b.productCode ?? null,
        colorName: b.colorName ?? null,
        sizeLabel: b.sizeLabel ?? null,
        change: !a ? "REMOVED" : comparable(a) === comparable(b) ? "UNCHANGED" : "CHANGED",
        before: b,
        after: a ?? null,
        linkedReturnedBoards: (returned.get(b.lineId ?? "")?.boards ?? new Decimal(0)).toFixed(4),
        blocked: [],
      });
    }
    for (const a of after) {
      if (a.lineId && before.some((b) => b.lineId === a.lineId)) continue;
      out.push({
        lineId: a.lineId ?? null,
        productVariantId: a.productVariantId!,
        productCode: a.productCode ?? null,
        colorName: a.colorName ?? null,
        sizeLabel: a.sizeLabel ?? null,
        change: "ADDED",
        before: null,
        after: a,
        linkedReturnedBoards: "0.0000",
        blocked: [],
      });
    }
    return out;
  }

  // ── commit ───────────────────────────────────────────────────────────────

  private async commit(
    tx: Tx,
    calc: Awaited<ReturnType<PurchaseInvoiceRevisionService["calculate"]>>,
    body: ExecutePurchaseInvoiceRevision,
    actor: AuthenticatedUser,
  ): Promise<InvoiceRevisionResult> {
    const {
      invoice, effective, effectiveMovements, priced, totals, period, before, after,
      invoiceNumber, accounts, replays, totalCogsDelta, totalAdjustmentDelta, nextRevision,
    } = calc;
    const payload = body.payload;

    const lockIds = [
      ...new Set([...invoice.lines.map((l) => l.productVariantId), ...priced.map((p) => p.productVariantId)]),
    ].sort();
    for (const id of lockIds) {
      await tx.$queryRaw`SELECT id FROM product_variants WHERE id = ${id}::uuid FOR UPDATE`;
    }

    // ── 1. reverse the accounting currently in force ──────────────────────
    let reversalJournalEntryId: string | null = null;
    if (effective.journalEntryId) {
      const r = await this.reversal.reverse({
        entryId: effective.journalEntryId,
        reason: `تعديل فاتورة المشتريات ${invoiceNumber} — النسخة ${nextRevision}`,
        reversalDate: period.postingDate,
        actor,
        tx,
      });
      reversalJournalEntryId = r.journalEntryId;
    }

    // ── 2. stock: receive the revised quantities FIRST, then undo the old ──
    // Order matters. Undoing a receipt of 25 boards when only 10 are still on
    // hand would drive the branch negative mid-transaction and the engine would
    // (rightly) refuse — even though the end state is perfectly valid because
    // the revised receipt puts the quantity straight back. Receiving first can
    // never create a transient shortfall, so the only failures left are the real
    // ones: stock that has genuinely been consumed and cannot be un-received.
    const replacementMovementIds: string[] = [];
    for (const p of priced) {
      if (p.boardsQuantity.isZero()) continue;
      const applied = await this.inventory.apply({
        branchId: payload.branchId,
        productVariantId: p.productVariantId,
        movementType: "RECEIPT",
        boardsDelta: p.boardsQuantity.toFixed(4),
        metersDelta: p.metersQuantity.toFixed(4),
        reference: { type: "purchase_invoice_revision", id: invoice.id },
        actor,
        summaryAr: `استلام مخزون — فاتورة مشتريات ${invoiceNumber} (نسخة ${nextRevision})`,
        summaryEn: `Stock receipt — purchase invoice ${invoiceNumber} revision ${nextRevision}`,
        humanReadableNote: `فاتورة مشتريات ${invoiceNumber} — النسخة ${nextRevision}`,
        tx,
      });
      replacementMovementIds.push(applied.movementId);
    }

    const reversalMovementIds: string[] = [];
    for (const m of effectiveMovements) {
      const boards = D(m.boardsQuantity).negated();
      if (boards.isZero()) continue;
      const applied = await this.inventory.apply({
        branchId: m.branchId,
        productVariantId: m.productVariantId,
        movementType: "ADJUSTMENT",
        boardsDelta: boards.toFixed(4),
        metersDelta: D(m.metersQuantity).negated().toFixed(4),
        reference: { type: "purchase_invoice_revision_reversal", id: invoice.id },
        actor,
        summaryAr: `عكس استلام مخزون — تعديل فاتورة مشتريات ${invoiceNumber} (نسخة ${nextRevision})`,
        summaryEn: `Reverse stock receipt — purchase invoice ${invoiceNumber} revision ${nextRevision}`,
        humanReadableNote: `تعديل فاتورة مشتريات ${invoiceNumber} — النسخة ${nextRevision}`,
        tx,
      });
      reversalMovementIds.push(applied.movementId);
    }

    // ── 3. rewrite header + lines ─────────────────────────────────────────
    const keptIds = new Set(payload.lines.map((l) => l.lineId).filter(Boolean) as string[]);
    for (const l of invoice.lines) {
      if (keptIds.has(l.id)) continue;
      await tx.purchaseInvoiceLine.delete({ where: { id: l.id } });
    }
    const replacementLineIds: string[] = [];
    for (const [i, p] of priced.entries()) {
      const src = payload.lines[i]!;
      const data = {
        productVariantId: p.productVariantId,
        colorCode: p.colorCode,
        boardsQuantity: p.boardsQuantity.toFixed(4),
        lengthM: p.lengthM ? p.lengthM.toFixed(4) : null,
        widthM: p.widthM ? p.widthM.toFixed(4) : null,
        heightM: p.heightM ? p.heightM.toFixed(4) : null,
        metersQuantity: p.metersQuantity.toFixed(4),
        unitLabel: p.unitLabel,
        unitPrice: money(p.unitPrice),
        lineTotal: money(p.lineTotal),
        taxRate: p.taxRate.toFixed(2),
        taxAmount: money(p.taxAmount),
        isFree: p.isFree,
        unitCostAtPosting: p.boardsQuantity.gt(0) ? money(p.lineTotal.div(p.boardsQuantity)) : "0.00",
        taxRateAtPosting: p.taxRate.toFixed(2),
      };
      if (src.lineId) {
        const updated = await tx.purchaseInvoiceLine.update({ where: { id: src.lineId }, data });
        replacementLineIds.push(updated.id);
      } else {
        const created = await tx.purchaseInvoiceLine.create({ data: { ...data, invoiceId: invoice.id } });
        replacementLineIds.push(created.id);
      }
    }

    // ── 4. set the WAC the replay computed, and prove the quantity ties ───
    const valuationEvidence: Array<Record<string, string>> = [];
    for (const r of replays) {
      const c = r.comparison;
      const onHand = await tx.branchInventoryBalance.aggregate({
        _sum: { metersOnHand: true, boardsOnHand: true },
        where: { productVariantId: r.productVariantId },
      });
      const actualMeters = D(onHand._sum.metersOnHand);
      if (actualMeters.minus(c.revised.ending.meters).abs().gt(new Decimal("0.0001"))) {
        throw new ValidationError({
          reason: "replay_quantity_mismatch",
          productVariantId: r.productVariantId,
          replayed: qty(c.revised.ending.meters),
          actual: qty(actualMeters),
        });
      }
      const boards = D(onHand._sum.boardsOnHand);
      await tx.productVariant.update({
        where: { id: r.productVariantId },
        data: {
          avgCostPerMeter: c.revised.endingWacPerMeter.toFixed(4),
          avgCost: boards.gt(0) ? c.revised.ending.value.div(boards).toFixed(4) : "0.0000",
          costUpdatedAt: new Date(),
        },
      });
      valuationEvidence.push({
        productVariantId: r.productVariantId,
        replayEvents: String(r.eventCount),
        wacBefore: rate(r.presentWacPerMeter),
        wacAfter: rate(c.revised.endingWacPerMeter),
        inventoryValueDelta: money(c.inventoryValueDelta),
        cogsDelta: money(c.cogsDelta),
        reproducedPresent: String(c.reproducedPresent),
        conservationHolds: String(c.conservationHolds),
      });
    }

    // ── 5. post the replacement + the valuation adjustment ────────────────
    const replacement = await this.posting.post({
      tx,
      actor,
      sourceType: "PURCHASE_INVOICE",
      sourceId: invoice.id,
      entryType: "PURCHASE_INVOICE",
      entryDate: period.postingDate,
      reference: `${invoiceNumber}-REV${nextRevision}`,
      description: `فاتورة مشتريات ${invoiceNumber} — النسخة ${nextRevision}`,
      idempotencyKey: `PURCHASE_INVOICE:${invoice.id}:REV:${nextRevision}`,
      lines: this.replacementLines({
        inventoryAccountId: accounts.inventoryAccountId!,
        apAccountId: accounts.apAccountId!,
        vatInputAccountId: accounts.vatInputAccountId,
        totals,
        invoiceNumber,
        supplierId: payload.supplierId,
        branchId: payload.branchId,
        nextRevision,
      }),
    });

    const valuationJournalEntryIds: string[] = [];
    const valuationEntryLines = accounts.inventoryAccountId
      ? this.valuationLines({
          cogsAccountId: accounts.cogsAccountId,
          inventoryAccountId: accounts.inventoryAccountId,
          shrinkageAccountId: accounts.shrinkageAccountId,
          cogsDelta: totalCogsDelta,
          adjustmentDelta: totalAdjustmentDelta,
          invoiceNumber,
          nextRevision,
        })
      : [];
    if (valuationEntryLines.length >= 2) {
      const posted = await this.posting.post({
        tx,
        actor,
        sourceType: "ADJUSTMENT",
        sourceId: invoice.id,
        entryType: "JOURNAL",
        entryDate: period.postingDate,
        reference: `${invoiceNumber}-REV${nextRevision}-VAL`,
        description: `تسوية تقييم المخزون وتكلفة المبيعات — تعديل فاتورة مشتريات ${invoiceNumber} (نسخة ${nextRevision})`,
        idempotencyKey: `PURCHASE_INVOICE:${invoice.id}:REV:${nextRevision}:VALUATION`,
        lines: valuationEntryLines,
      });
      valuationJournalEntryIds.push(posted.journalEntryId);
    }

    // ── 6. header ─────────────────────────────────────────────────────────
    await tx.purchaseInvoice.update({
      where: { id: invoice.id },
      data: {
        invoiceDate: new Date(payload.invoiceDate),
        dueDate: payload.dueDate ? new Date(payload.dueDate) : null,
        supplierId: payload.supplierId,
        branchId: payload.branchId,
        basedOn: payload.basedOn ?? null,
        docDirection: payload.docDirection ?? null,
        customsNumber: payload.customsNumber ?? null,
        notes: payload.notes ?? null,
        subtotal: money(totals.subtotal),
        taxAmount: money(totals.taxAmount),
        grandTotal: money(totals.grandTotal),
        revisionNumber: nextRevision,
        lastRevisedAt: new Date(),
        lastRevisedBy: actor.id,
        apAccountId: accounts.apAccountId,
        taxAccountId: accounts.vatInputAccountId,
        inventoryAccountId: accounts.inventoryAccountId,
      },
    });

    const delta = {
      totalDelta: money(totals.grandTotal.minus(D(invoice.grandTotal))),
      cogsDelta: money(totalCogsDelta),
      adjustmentDelta: money(totalAdjustmentDelta),
      stockDelta: calc.preview.branchQuantityDelta,
      partyDelta: { before: calc.preview.partyImpactBefore, after: calc.preview.partyImpactAfter },
      lineDiffs: calc.preview.lineDiffs,
      valuation: { ...calc.preview.valuation, applied: valuationEvidence },
      linkedReturns: calc.preview.linkedReturns,
      linkedVouchers: calc.preview.linkedVouchers,
      replacementLineIds,
      acknowledgedWarnings: body.acknowledgedWarnings ?? [],
    };

    const revision = await tx.purchaseInvoiceRevision.create({
      data: {
        purchaseInvoiceId: invoice.id,
        revisionNumber: nextRevision,
        previousRevisionNumber: invoice.revisionNumber,
        reason: body.reason,
        status: "POSTED",
        originalInvoiceStatus: invoice.status,
        resultingInvoiceStatus: "CONFIRMED",
        previousDocumentDate: invoice.invoiceDate,
        documentDate: new Date(payload.invoiceDate),
        postingDate: new Date(period.postingDate),
        crossesClosedPeriod: period.crossesClosedPeriod,
        beforeSnapshot: before as unknown as Prisma.InputJsonValue,
        afterSnapshot: after as unknown as Prisma.InputJsonValue,
        delta: delta as unknown as Prisma.InputJsonValue,
        beforeFingerprint: snapshotFingerprint(before),
        afterFingerprint: snapshotFingerprint(after),
        previewFingerprint: body.previewFingerprint,
        idempotencyKey: body.idempotencyKey,
        reversalJournalEntryId,
        replacementJournalEntryId: replacement.journalEntryId,
        valuationJournalEntryIds: valuationJournalEntryIds as unknown as Prisma.InputJsonValue,
        reversalMovementIds: reversalMovementIds as unknown as Prisma.InputJsonValue,
        replacementMovementIds: replacementMovementIds as unknown as Prisma.InputJsonValue,
        // The system has no SupplierTransaction table — a supplier's balance is
        // derived entirely from journal lines carrying partyType SUPPLIER, so
        // the AP lines above ARE the reversal and replacement party entries.
        reversalPartyTxIds: [] as unknown as Prisma.InputJsonValue,
        replacementPartyTxIds: [] as unknown as Prisma.InputJsonValue,
        revisedBy: actor.id,
      },
      include: { actor: { select: { id: true, name: true } } },
    });

    await this.audit.write({
      tx,
      actorId: actor.id,
      action: "UPDATE",
      entityType: "purchase_invoice_revision",
      entityId: revision.id,
      beforeSnapshot: {
        invoiceId: invoice.id,
        invoiceNumber,
        revisionNumber: invoice.revisionNumber,
        fingerprint: snapshotFingerprint(before),
        grandTotal: money(D(invoice.grandTotal)),
      },
      afterSnapshot: {
        invoiceId: invoice.id,
        invoiceNumber,
        revisionNumber: nextRevision,
        fingerprint: snapshotFingerprint(after),
        grandTotal: money(totals.grandTotal),
        reason: body.reason,
        journalEntryIds: [reversalJournalEntryId, replacement.journalEntryId, ...valuationJournalEntryIds].filter(Boolean),
        movementIds: [...reversalMovementIds, ...replacementMovementIds],
        cogsDelta: money(totalCogsDelta),
      },
      summaryAr: `${actor.name} عدّل فاتورة المشتريات المؤكدة ${invoiceNumber} — النسخة ${nextRevision}: ${body.reason}`,
      summaryEn: `${actor.name} revised confirmed purchase invoice ${invoiceNumber} — revision ${nextRevision}: ${body.reason}`,
    });

    return this.resultFrom(tx, revision, false);
  }

  private async resultFrom(
    db: Tx | PrismaService,
    revision: Prisma.PurchaseInvoiceRevisionGetPayload<Record<string, never>> & { actor?: { id: string; name: string } | null },
    idempotentReplay: boolean,
  ): Promise<InvoiceRevisionResult> {
    const row = await db.purchaseInvoice.findUnique({
      where: { id: revision.purchaseInvoiceId },
      include: {
        supplier: { select: { id: true, nameAr: true } },
        branch: { select: { id: true, nameAr: true } },
        lines: {
          orderBy: { id: "asc" },
          include: { productVariant: { include: { sku: { select: { code: true, colorNameAr: true } } } } },
        },
      },
    });
    // Decimals are formatted here rather than shipped raw, matching the invoice
    // controller's contract.
    const invoice = row && {
      id: row.id,
      invoiceNumber: row.invoiceNumber,
      invoiceDate: row.invoiceDate,
      dueDate: row.dueDate,
      status: row.status,
      revisionNumber: row.revisionNumber,
      lastRevisedAt: row.lastRevisedAt,
      lastRevisedBy: row.lastRevisedBy,
      supplier: row.supplier,
      branch: row.branch,
      notes: row.notes,
      subtotal: row.subtotal.toFixed(2),
      taxAmount: row.taxAmount.toFixed(2),
      grandTotal: row.grandTotal.toFixed(2),
      lines: row.lines.map((l) => ({
        id: l.id,
        productVariantId: l.productVariantId,
        productCode: l.productVariant?.sku?.code ?? null,
        colorName: l.productVariant?.sku?.colorNameAr ?? null,
        boardsQuantity: l.boardsQuantity.toFixed(4),
        metersQuantity: l.metersQuantity.toFixed(4),
        unitLabel: l.unitLabel,
        unitPrice: l.unitPrice.toFixed(2),
        lineTotal: l.lineTotal.toFixed(2),
        taxRate: l.taxRate.toFixed(2),
        taxAmount: l.taxAmount.toFixed(2),
        isFree: l.isFree,
      })),
    };
    const actorName =
      revision.actor?.name ??
      (await db.user.findUnique({ where: { id: revision.revisedBy }, select: { name: true } }))?.name ??
      null;
    const delta = (revision.delta ?? {}) as Record<string, unknown>;
    return {
      invoice,
      revision: {
        id: revision.id,
        revisionNumber: revision.revisionNumber,
        previousRevisionNumber: revision.previousRevisionNumber,
        reason: revision.reason,
        status: revision.status,
        documentDate: revision.documentDate.toISOString().slice(0, 10),
        postingDate: revision.postingDate.toISOString().slice(0, 10),
        crossesClosedPeriod: revision.crossesClosedPeriod,
        revisedBy: revision.revisedBy,
        revisedByName: actorName,
        createdAt: revision.createdAt.toISOString(),
      },
      reversalJournalEntryIds: [revision.reversalJournalEntryId].filter(Boolean) as string[],
      replacementJournalEntryIds: [revision.replacementJournalEntryId].filter(Boolean) as string[],
      valuationJournalEntryIds: (revision.valuationJournalEntryIds ?? []) as string[],
      reversalMovementIds: (revision.reversalMovementIds ?? []) as string[],
      replacementMovementIds: (revision.replacementMovementIds ?? []) as string[],
      reversalPartyTransactionIds: (revision.reversalPartyTxIds ?? []) as string[],
      replacementPartyTransactionIds: (revision.replacementPartyTxIds ?? []) as string[],
      valuation: (delta.valuation ?? null) as InvoiceRevisionResult["valuation"],
      idempotentReplay,
    };
  }
}
