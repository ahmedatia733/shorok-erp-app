import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import type {
  ExecuteSalesInvoiceRevision,
  InvoiceRevisionPreview,
  InvoiceRevisionResult,
  PostingLine,
  PreviewSalesInvoiceRevision,
  RevisionIssue,
  RevisionJournalPreview,
  RevisionLineDiff,
  RevisionStockEffect,
  SalesInvoiceRevisionPayload,
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
import { computeSalesInvoiceTotals, computeSalesLineTotals } from "../sales-invoices/sales-line-math";
import { PostingPeriodService, type ResolvedPostingDate } from "./posting-period.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */
import { previewFingerprint, snapshotFingerprint } from "./revision-fingerprint";
import { D, issue, money, qty, rate, repriceGlobalPool, StockProjection } from "./revision-support";

type Tx = Prisma.TransactionClient;

/**
 * Revision of a CONFIRMED sales invoice.
 *
 * The invoice is a posted document, so it is never rewritten accounting-wise.
 * Every revision reverses the version currently in force, posts the revised one
 * and records both, leaving the invoice number, the status and all original
 * journals, movements and party rows exactly where they were.
 *
 * COGS follows the historical-cost rule the return services already use: a line
 * that existed before keeps the per-metre cost it was posted at, so revising a
 * price alone never disturbs cost, and revising a quantity moves cost at the
 * rate that quantity actually left stock at. A genuinely new line has no
 * history, so it costs at the current pooled WAC.
 */
@Injectable()
export class SalesInvoiceRevisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryEngine,
    private readonly posting: PostingEngine,
    private readonly reversal: ReversalService,
    private readonly config: EffectiveConfigService,
    private readonly returnable: ReturnableService,
    private readonly periods: PostingPeriodService,
  ) {}

  // ── public API ───────────────────────────────────────────────────────────

  async preview(
    invoiceId: string,
    body: PreviewSalesInvoiceRevision,
    actor: AuthenticatedUser,
  ): Promise<InvoiceRevisionPreview> {
    const calc = await this.calculate(this.prisma, invoiceId, body.expectedRevisionNumber, body.payload, actor);
    return calc.preview;
  }

  async execute(
    invoiceId: string,
    body: ExecuteSalesInvoiceRevision,
    actor: AuthenticatedUser,
  ): Promise<InvoiceRevisionResult> {
    // Idempotency barrier #1 — outside the transaction, so a retry after a
    // successful commit never even opens one.
    const replayed = await this.prisma.salesInvoiceRevision.findUnique({
      where: { idempotencyKey: body.idempotencyKey },
    });
    if (replayed) return this.resultFrom(this.prisma, replayed, true);

    return this.prisma.runInTransaction(async (tx) => {
      // Serialise revisions of the same invoice. Everything below re-reads
      // through `tx`, so nothing decided before the lock is trusted.
      await tx.$queryRaw`SELECT id FROM sales_invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;

      const inside = await tx.salesInvoiceRevision.findUnique({
        where: { idempotencyKey: body.idempotencyKey },
      });
      if (inside) return this.resultFrom(tx, inside, true);

      const calc = await this.calculate(tx, invoiceId, body.expectedRevisionNumber, body.payload, actor);

      // The preview the owner approved must still describe reality.
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
    const invoice = await this.prisma.salesInvoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, invoiceNumber: true, branchId: true, revisionNumber: true, status: true, createdAt: true },
    });
    if (!invoice) throw new NotFoundError({ id: invoiceId });
    if (actor.role !== "OWNER" && !actor.allowedBranches.includes(invoice.branchId)) {
      throw new NotFoundError({ id: invoiceId });
    }
    const rows = await this.prisma.salesInvoiceRevision.findMany({
      where: { salesInvoiceId: invoiceId },
      orderBy: { revisionNumber: "asc" },
      include: { actor: { select: { id: true, name: true } } },
    });
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber.toString(),
      currentRevision: invoice.revisionNumber,
      status: invoice.status,
      revisions: rows.map((r) => this.formatRevision(r)),
    };
  }

  async getRevision(invoiceId: string, revisionNumber: number, actor: AuthenticatedUser) {
    const invoice = await this.prisma.salesInvoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, branchId: true },
    });
    if (!invoice) throw new NotFoundError({ id: invoiceId });
    if (actor.role !== "OWNER" && !actor.allowedBranches.includes(invoice.branchId)) {
      throw new NotFoundError({ id: invoiceId });
    }
    const row = await this.prisma.salesInvoiceRevision.findUnique({
      where: { salesInvoiceId_revisionNumber: { salesInvoiceId: invoiceId, revisionNumber } },
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
    reversalCogsJournalEntryId: string | null; replacementCogsJournalEntryId: string | null;
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
      reversalJournalEntryIds: [r.reversalJournalEntryId, r.reversalCogsJournalEntryId].filter(Boolean),
      replacementJournalEntryIds: [r.replacementJournalEntryId, r.replacementCogsJournalEntryId].filter(Boolean),
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
    payload: SalesInvoiceRevisionPayload,
    actor: AuthenticatedUser,
  ) {
    const blocking: RevisionIssue[] = [];
    const warnings: RevisionIssue[] = [];

    const invoice = await db.salesInvoice.findUnique({
      where: { id: invoiceId },
      include: {
        customer: { select: { id: true, code: true, nameAr: true, active: true } },
        branch: { select: { id: true, nameAr: true, active: true } },
        salesRepresentative: { select: { id: true, code: true, nameAr: true } },
        lines: {
          orderBy: { id: "asc" },
          include: {
            productVariant: {
              select: { id: true, sizeMetersPerBoard: true, active: true, avgCostPerMeter: true, avgCost: true, sku: { select: { code: true, colorNameAr: true } } },
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

    // ── what is currently in force ────────────────────────────────────────
    const lastRevision = await db.salesInvoiceRevision.findFirst({
      where: { salesInvoiceId: invoiceId },
      orderBy: { revisionNumber: "desc" },
    });
    const effective = {
      journalEntryId: lastRevision?.replacementJournalEntryId ?? invoice.journalEntryId,
      cogsJournalEntryId: lastRevision?.replacementCogsJournalEntryId ?? invoice.cogsJournalEntryId,
      customerTxIds: lastRevision
        ? ((lastRevision.replacementPartyTxIds ?? []) as string[])
        : invoice.customerTxId
          ? [invoice.customerTxId]
          : [],
      movementIds: lastRevision ? ((lastRevision.replacementMovementIds ?? []) as string[]) : null,
    };

    const effectiveMovements = effective.movementIds
      ? await db.inventoryMovement.findMany({ where: { id: { in: effective.movementIds } }, orderBy: { id: "asc" } })
      : await db.inventoryMovement.findMany({
          where: { referenceType: "sales_invoice", referenceId: invoiceId, movementType: "SALE" },
          orderBy: { id: "asc" },
        });

    // ── revised party / branch / rep ──────────────────────────────────────
    const customer = await db.customer.findUnique({
      where: { id: payload.customerId },
      select: { id: true, code: true, nameAr: true, active: true },
    });
    if (!customer) blocking.push(issue("customer_not_found", "العميل المحدد غير موجود."));
    else if (!customer.active) blocking.push(issue("customer_inactive", `العميل «${customer.nameAr}» غير نشط.`));

    const branch = await db.branch.findUnique({
      where: { id: payload.branchId },
      select: { id: true, nameAr: true, active: true },
    });
    if (!branch) blocking.push(issue("branch_not_found", "الفرع/المخزن المحدد غير موجود."));
    else if (!branch.active) blocking.push(issue("branch_inactive", `الفرع «${branch.nameAr}» غير نشط.`));

    if (payload.salesRepresentativeId && payload.salesRepresentativeId !== invoice.salesRepresentativeId) {
      const rep = await db.salesRepresentative.findUnique({
        where: { id: payload.salesRepresentativeId },
        select: { id: true, active: true, nameAr: true },
      });
      if (!rep) blocking.push(issue("representative_not_found", "المندوب المحدد غير موجود."));
      else if (!rep.active) blocking.push(issue("representative_inactive", `المندوب «${rep.nameAr}» غير نشط.`));
    }

    // ── revised lines ─────────────────────────────────────────────────────
    const variantIds = [...new Set(payload.lines.map((l) => l.productVariantId))];
    const variants = await db.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: {
        id: true, sizeMetersPerBoard: true, active: true, avgCostPerMeter: true, avgCost: true,
        sku: { select: { code: true, colorNameAr: true } },
      },
    });
    const variantById = new Map(variants.map((v) => [v.id, v]));
    for (const id of variantIds) {
      const v = variantById.get(id);
      if (!v) blocking.push(issue("variant_not_found", "أحد الأصناف المحددة غير موجود.", { productVariantId: id }));
      else if (!v.active) {
        blocking.push(issue("variant_inactive", `الصنف «${v.sku.code}» غير نشط ولا يمكن استخدامه.`, { productVariantId: id }));
      }
    }

    const originalLineById = new Map(invoice.lines.map((l) => [l.id, l]));
    for (const l of payload.lines) {
      if (l.lineId && !originalLineById.has(l.lineId)) {
        blocking.push(issue("line_not_part_of_invoice", "أحد البنود لا ينتمي إلى هذه الفاتورة.", { lineId: l.lineId }));
      }
    }

    const sizes = new Map(variants.map((v) => [v.id, D(v.sizeMetersPerBoard)]));
    const priced = computeSalesLineTotals(payload.lines, sizes);
    const taxRate = D(payload.taxRate ?? "0");
    const totals = computeSalesInvoiceTotals(priced, taxRate);

    priced.forEach((p, i) => {
      if (!p.meters.gt(0)) {
        blocking.push(issue("line_meters_required", `البند رقم ${i + 1}: عدد الأمتار يجب أن يكون أكبر من صفر.`));
      }
    });

    // ── linked returns: the immutable floor under every line ──────────────
    const returnable = await this.returnable.salesInvoiceReturnable(invoiceId, db as Tx);
    const returnedByLine = new Map(
      returnable.lines.map((l) => [l.originalLineId, { boards: D(l.previouslyReturnedBoards), variantId: l.productVariantId }]),
    );
    const keptLineIds = new Set(payload.lines.map((l) => l.lineId).filter(Boolean) as string[]);
    for (const [lineId, ret] of returnedByLine) {
      if (!ret.boards.gt(0)) continue;
      const original = originalLineById.get(lineId);
      const code = original?.productVariant?.sku?.code ?? "";
      if (!keptLineIds.has(lineId)) {
        blocking.push(
          issue("line_with_return_removed", `لا يمكن حذف البند «${code}» لأن عليه مردود مبيعات مؤكد بكمية ${ret.boards.toFixed(0)} لوح.`, { lineId }),
        );
        continue;
      }
      const revised = payload.lines.find((l) => l.lineId === lineId)!;
      if (revised.productVariantId !== ret.variantId) {
        blocking.push(
          issue("line_with_return_variant_changed", `لا يمكن تغيير صنف البند «${code}» لأن عليه مردود مبيعات مؤكد.`, { lineId }),
        );
      }
      if (D(revised.quantity).lt(ret.boards)) {
        blocking.push(
          issue(
            "quantity_below_linked_return",
            `كمية البند «${code}» بعد التعديل (${D(revised.quantity).toFixed(0)} لوح) أقل من الكمية المرتجعة المؤكدة (${ret.boards.toFixed(0)} لوح).`,
            { lineId },
          ),
        );
      }
    }
    if (returnable.lines.some((l) => l.legacyAmbiguous)) {
      warnings.push(
        issue("return_linkage_ambiguous", "بعض بنود الفاتورة قديمة ولا يمكن إثبات ارتباط المرتجعات بها بدقة؛ راجع المرتجعات قبل الاعتماد."),
      );
    }

    // ── COGS: historical for surviving lines, current WAC for new ones ────
    const perLineCogs = priced.map((p, i) => {
      const lineId = payload.lines[i]!.lineId ?? null;
      const original = lineId ? originalLineById.get(lineId) : undefined;
      const sameVariant = original?.productVariantId === p.productVariantId;
      const historical = original?.unitCostPerMeterAtPosting != null ? D(original.unitCostPerMeterAtPosting) : null;
      const costPerMeter = sameVariant && historical != null ? historical : D(variantById.get(p.productVariantId)?.avgCostPerMeter);
      const legacyPerBoard = sameVariant && original?.unitCostAtPosting != null
        ? D(original.unitCostAtPosting)
        : D(variantById.get(p.productVariantId)?.avgCost);
      return {
        lineId,
        productVariantId: p.productVariantId,
        meters: p.meters,
        boards: p.quantity,
        costPerMeter,
        legacyPerBoard,
        cogs: p.meters.times(costPerMeter),
        basis: sameVariant && historical != null ? ("HISTORICAL" as const) : ("CURRENT_WAC" as const),
      };
    });
    const replacementCogs = perLineCogs.reduce((a, x) => a.plus(x.cogs), new Decimal(0));
    const reversalCogs = invoice.lines.reduce((a, l) => a.plus(D(l.lineCogsAtPosting)), new Decimal(0));

    // ── stock effects ─────────────────────────────────────────────────────
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
        productCode: variantById.get(m.productVariantId)?.sku.code ?? invoice.lines.find((l) => l.productVariantId === m.productVariantId)?.productVariant?.sku?.code ?? null,
        boardsDelta: qty(boards),
        metersDelta: qty(meters),
      });
    }
    for (const p of priced) {
      projection.apply(payload.branchId, p.productVariantId, p.quantity.negated(), p.meters.negated());
      stockApplication.push({
        branchId: payload.branchId,
        branchNameAr: branch?.nameAr ?? "",
        productVariantId: p.productVariantId,
        productCode: variantById.get(p.productVariantId)?.sku.code ?? null,
        boardsDelta: qty(p.quantity.negated()),
        metersDelta: qty(p.meters.negated()),
      });
    }
    for (const neg of projection.negatives()) {
      const code = variantById.get(neg.productVariantId)?.sku.code ?? "";
      blocking.push(
        issue(
          "insufficient_stock_in_revised_branch",
          `الرصيد غير كافٍ للصنف «${code}» في «${branchNames.get(neg.branchId) ?? ""}» بعد التعديل (${neg.boards} لوح / ${neg.meters} متر).`,
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
      period = {
        documentDate: payload.invoiceDate,
        postingDate: payload.invoiceDate,
        crossesClosedPeriod: true,
        noteAr: null,
      };
    }
    if (period.crossesClosedPeriod) {
      warnings.push(issue("posting_moved_to_open_period", period.noteAr ?? "سيتم الترحيل في أول فترة مفتوحة."));
    }

    // ── accounts + journal previews (in memory; no number allocated) ──────
    const profile = await this.config.postingProfileAsOf(period.postingDate);
    const arAccountId = profile?.arAccountId ?? null;
    const revenueAccountId = profile?.revenueAccountId ?? null;
    const vatOutputAccountId = profile?.vatOutputAccountId ?? null;
    const cogsAccountId = profile?.cogsAccountId ?? null;
    const inventoryAccountId = profile?.inventoryAccountId ?? null;
    if (!arAccountId) blocking.push(issue("accounts_receivable_account_required", "لم يتم تحديد حساب العملاء في إعدادات الترحيل."));
    if (!revenueAccountId) blocking.push(issue("revenue_account_required", "لم يتم تحديد حساب الإيرادات في إعدادات الترحيل."));
    if (totals.taxAmount.gt(0) && !vatOutputAccountId) {
      blocking.push(issue("tax_account_required", "الفاتورة عليها ضريبة ولم يتم تحديد حساب ضريبة المخرجات."));
    }
    if (replacementCogs.gt(0) && (!cogsAccountId || !inventoryAccountId)) {
      blocking.push(issue("cogs_account_required", "لم يتم تحديد حساب تكلفة المبيعات أو المخزون في إعدادات الترحيل."));
    }

    const accountIds = [arAccountId, revenueAccountId, vatOutputAccountId, cogsAccountId, inventoryAccountId].filter(Boolean) as string[];
    const accounts = await db.account.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, code: true, nameAr: true },
    });
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    const invoiceNumber = invoice.invoiceNumber.toString();
    const journals: RevisionJournalPreview[] = [];
    const effectiveJournal = effective.journalEntryId
      ? await db.journalEntry.findUnique({ where: { id: effective.journalEntryId }, include: { lines: true } })
      : null;
    const effectiveCogsJournal = effective.cogsJournalEntryId
      ? await db.journalEntry.findUnique({ where: { id: effective.cogsJournalEntryId }, include: { lines: true } })
      : null;
    if (!effectiveJournal) {
      blocking.push(issue("no_effective_journal", "لا يوجد قيد محاسبي حالي لهذه الفاتورة يمكن عكسه."));
    }

    const labelOf = (id: string) => accountById.get(id) ?? { code: "", nameAr: "" };
    if (effectiveJournal) {
      journals.push({
        kind: "REVERSAL",
        descriptionAr: `عكس قيد فاتورة المبيعات رقم ${invoiceNumber}`,
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
    if (effectiveCogsJournal) {
      journals.push({
        kind: "REVERSAL_COGS",
        descriptionAr: `عكس قيد تكلفة المبيعات للفاتورة رقم ${invoiceNumber}`,
        postingDate: period.postingDate,
        totalDebit: money(effectiveCogsJournal.lines.reduce((a, l) => a.plus(D(l.credit)), new Decimal(0))),
        totalCredit: money(effectiveCogsJournal.lines.reduce((a, l) => a.plus(D(l.debit)), new Decimal(0))),
        lines: effectiveCogsJournal.lines.map((l) => ({
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
    if (arAccountId && revenueAccountId) {
      const lines = this.replacementRevenueLines({
        arAccountId, revenueAccountId, vatOutputAccountId,
        totals, invoiceNumber, customerId: payload.customerId,
        customerName: customer?.nameAr ?? "",
        nextRevision: invoice.revisionNumber + 1,
      });
      journals.push({
        kind: "REPLACEMENT",
        descriptionAr: `إعادة ترحيل فاتورة المبيعات رقم ${invoiceNumber} — النسخة ${invoice.revisionNumber + 1}`,
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
    if (replacementCogs.gt(0) && cogsAccountId && inventoryAccountId) {
      journals.push({
        kind: "REPLACEMENT_COGS",
        descriptionAr: `إعادة ترحيل تكلفة المبيعات للفاتورة رقم ${invoiceNumber}`,
        postingDate: period.postingDate,
        totalDebit: money(replacementCogs),
        totalCredit: money(replacementCogs),
        lines: [
          { accountId: cogsAccountId, accountCode: labelOf(cogsAccountId).code, accountNameAr: labelOf(cogsAccountId).nameAr, debit: money(replacementCogs), credit: "0.00", partyType: null, partyId: null, branchId: payload.branchId, note: `تكلفة مبيعات - SI-${invoiceNumber}` },
          { accountId: inventoryAccountId, accountCode: labelOf(inventoryAccountId).code, accountNameAr: labelOf(inventoryAccountId).nameAr, debit: "0.00", credit: money(replacementCogs), partyType: null, partyId: null, branchId: payload.branchId, note: `صرف من المخزون - SI-${invoiceNumber}` },
        ],
      });
    }

    // ── linked vouchers and the resulting party position ──────────────────
    const allocations = await db.receiptVoucherAllocation.findMany({
      where: { salesInvoiceId: invoiceId },
      include: { receiptVoucher: { select: { id: true, voucherNumber: true, voucherDate: true, amount: true, status: true, customerId: true } } },
    });
    const applied = allocations
      .filter((a) => a.receiptVoucher.status === "POSTED")
      .reduce((a, x) => a.plus(D(x.amount)), new Decimal(0));
    const oldTotal = D(invoice.grandTotal);
    const outstandingAfter = totals.grandTotal.minus(applied);
    const partyChanged = payload.customerId !== invoice.customerId;
    if (partyChanged && applied.gt(0)) {
      warnings.push(
        issue(
          "party_changed_with_vouchers",
          `تم تغيير العميل مع وجود تحصيلات بمبلغ ${money(applied)} ج.م مسجلة على العميل السابق «${invoice.customer.nameAr}». ستبقى سندات القبض كما هي على العميل السابق وسيظهر لديه رصيد دائن بنفس المبلغ.`,
        ),
      );
    }
    if (!partyChanged && outstandingAfter.isNegative()) {
      warnings.push(
        issue(
          "revision_creates_customer_credit",
          `إجمالي الفاتورة بعد التعديل (${money(totals.grandTotal)}) أقل من المحصّل (${money(applied)})، وسينتج عن ذلك رصيد دائن للعميل بمبلغ ${money(outstandingAfter.negated())} ج.م.`,
        ),
      );
    }

    const linkedReturns = await db.salesReturn.findMany({
      where: { originalSalesInvoiceId: invoiceId },
      select: { id: true, returnNumber: true, status: true, returnDate: true, lines: { select: { returnedBoards: true } } },
      orderBy: { returnNumber: "asc" },
    });

    // ── valuation ─────────────────────────────────────────────────────────
    const affectedVariantIds = [...new Set([...invoice.lines.map((l) => l.productVariantId), ...variantIds])].sort();
    const poolBefore = await db.branchInventoryBalance.groupBy({
      by: ["productVariantId"],
      where: { productVariantId: { in: affectedVariantIds } },
      _sum: { metersOnHand: true, boardsOnHand: true },
    });
    const poolByVariant = new Map(poolBefore.map((p) => [p.productVariantId, p]));
    const allVariants = await db.productVariant.findMany({
      where: { id: { in: affectedVariantIds } },
      select: { id: true, avgCostPerMeter: true, avgCost: true, sizeMetersPerBoard: true, sku: { select: { code: true } } },
    });

    const valuationVariants = allVariants.map((v) => {
      const reversedMeters = invoice.lines.filter((l) => l.productVariantId === v.id)
        .reduce((a, l) => a.plus(D(l.metersQuantity ?? D(l.quantity).times(D(l.productVariant?.sizeMetersPerBoard)))), new Decimal(0));
      const reversedValue = invoice.lines.filter((l) => l.productVariantId === v.id)
        .reduce((a, l) => a.plus(D(l.lineCogsAtPosting)), new Decimal(0));
      const issuedMeters = perLineCogs.filter((l) => l.productVariantId === v.id).reduce((a, l) => a.plus(l.meters), new Decimal(0));
      const issuedValue = perLineCogs.filter((l) => l.productVariantId === v.id).reduce((a, l) => a.plus(l.cogs), new Decimal(0));
      const pool = poolByVariant.get(v.id);
      const currentMeters = D(pool?._sum.metersOnHand);
      const currentBoards = D(pool?._sum.boardsOnHand);
      const after = repriceGlobalPool({
        currentMeters,
        currentBoards,
        currentWacPerMeter: D(v.avgCostPerMeter),
        metersDelta: reversedMeters.minus(issuedMeters),
        boardsDelta: new Decimal(0),
        valueDelta: reversedValue.minus(issuedValue),
      });
      return {
        productVariantId: v.id,
        productCode: v.sku.code,
        sizeLabel: D(v.sizeMetersPerBoard).toFixed(2),
        currentWacPerMeter: rate(D(v.avgCostPerMeter)),
        projectedWacPerMeter: rate(after.wacPerMeter),
        currentGlobalMeters: qty(currentMeters),
        projectedGlobalMeters: qty(after.meters),
        currentInventoryValue: money(currentMeters.times(D(v.avgCostPerMeter))),
        projectedInventoryValue: money(after.value),
        inventoryValueDelta: money(after.value.minus(currentMeters.times(D(v.avgCostPerMeter)))),
        cogsDelta: money(issuedValue.minus(reversedValue)),
        replayEventCount: 0,
        replayReproducedCurrentState: true,
      };
    });

    const valuation = {
      replayRequired: false,
      reasonAr:
        "بيع البضاعة يصرف من المخزون بالتكلفة السائدة ولا يغيّر متوسط التكلفة، ولا يعتمد أي مستند لاحق على تكلفة هذه الفاتورة " +
        "(كل فاتورة تحتفظ بتكلفتها لحظة الترحيل). لذلك يكفي تعديل قيمة المخزون بالتكلفة التاريخية — بنفس القاعدة المطبقة في مردودات المبيعات — دون إعادة احتساب زمنية.",
      replayStartAt: null as string | null,
      variants: valuationVariants,
      totalInventoryValueDelta: money(valuationVariants.reduce((a, v) => a.plus(D(v.inventoryValueDelta)), new Decimal(0))),
      totalCogsDelta: money(replacementCogs.minus(reversalCogs)),
    };

    // ── snapshots + diffs ─────────────────────────────────────────────────
    const before = this.snapshot({
      invoice,
      lines: invoice.lines.map((l) => ({
        lineId: l.id,
        productVariantId: l.productVariantId,
        productCode: l.productVariant?.sku?.code ?? null,
        colorName: l.productVariant?.sku?.colorNameAr ?? null,
        sizeLabel: l.productVariant ? D(l.productVariant.sizeMetersPerBoard).toFixed(2) : null,
        boards: qty(D(l.quantity)),
        meters: qty(D(l.metersQuantity ?? D(l.quantity).times(D(l.productVariant?.sizeMetersPerBoard)))),
        lengthM: l.lengthM != null ? qty(D(l.lengthM)) : null,
        widthM: l.widthM != null ? qty(D(l.widthM)) : null,
        unitLabel: l.unitLabel,
        unitPrice: money(D(l.unitPrice)),
        costPrice: money(D(l.costPrice)),
        discountPct: D(l.discountPct).toFixed(2),
        lineTotal: money(D(l.lineTotal)),
        costPerMeterAtPosting: l.unitCostPerMeterAtPosting != null ? rate(D(l.unitCostPerMeterAtPosting)) : null,
        lineCogsAtPosting: l.lineCogsAtPosting != null ? money(D(l.lineCogsAtPosting)) : null,
        note: l.note,
      })),
      header: {
        invoiceNumber,
        status: invoice.status,
        revisionNumber: invoice.revisionNumber,
        invoiceDate: invoice.invoiceDate.toISOString().slice(0, 10),
        dueDate: invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : null,
        customerId: invoice.customerId,
        customerNameAr: invoice.customer.nameAr,
        branchId: invoice.branchId,
        branchNameAr: invoice.branch.nameAr,
        salesRepresentativeId: invoice.salesRepresentativeId,
        notes: invoice.notes,
        taxRate: D(invoice.taxRate).toFixed(2),
        subtotal: money(D(invoice.subtotal)),
        discountAmount: money(D(invoice.discountAmount)),
        taxAmount: money(D(invoice.taxAmount)),
        grandTotal: money(oldTotal),
        totalCost: money(D(invoice.totalCost)),
      },
      posting: {
        journalEntryId: effective.journalEntryId,
        cogsJournalEntryId: effective.cogsJournalEntryId,
        customerTxIds: effective.customerTxIds,
        movementIds: effectiveMovements.map((m) => m.id),
      },
    });

    const after = this.snapshot({
      invoice,
      lines: priced.map((p, i) => {
        const src = payload.lines[i]!;
        const v = variantById.get(p.productVariantId);
        const cogs = perLineCogs[i]!;
        return {
          lineId: src.lineId ?? null,
          productVariantId: p.productVariantId,
          productCode: v?.sku.code ?? null,
          colorName: v?.sku.colorNameAr ?? null,
          sizeLabel: v ? D(v.sizeMetersPerBoard).toFixed(2) : null,
          boards: qty(p.quantity),
          meters: qty(p.meters),
          lengthM: p.lengthM ? qty(p.lengthM) : null,
          widthM: p.widthM ? qty(p.widthM) : null,
          unitLabel: p.unitLabel,
          unitPrice: money(p.unitPrice),
          costPrice: money(p.costPrice),
          discountPct: p.discountPct.toFixed(2),
          lineTotal: money(p.lineTotal),
          costPerMeterAtPosting: rate(cogs.costPerMeter),
          lineCogsAtPosting: money(cogs.cogs),
          note: p.note,
        };
      }),
      header: {
        invoiceNumber,
        status: "CONFIRMED",
        revisionNumber: invoice.revisionNumber + 1,
        invoiceDate: payload.invoiceDate,
        dueDate: payload.dueDate ?? null,
        customerId: payload.customerId,
        customerNameAr: customer?.nameAr ?? "",
        branchId: payload.branchId,
        branchNameAr: branch?.nameAr ?? "",
        salesRepresentativeId: payload.salesRepresentativeId ?? null,
        notes: payload.notes ?? null,
        taxRate: taxRate.toFixed(2),
        subtotal: money(totals.subtotal),
        discountAmount: money(totals.discountAmount),
        taxAmount: money(totals.taxAmount),
        grandTotal: money(totals.grandTotal),
        totalCost: money(replacementCogs),
      },
      posting: null,
    });

    const lineDiffs = this.diffLines(before.lines, after.lines, returnedByLine, blocking);

    const headerFields: InvoiceRevisionPreview["header"] = (
      ["invoiceDate", "dueDate", "customerNameAr", "branchNameAr", "salesRepresentativeId", "notes", "taxRate"] as const
    ).map((field) => ({
      field,
      before: (before.header as Record<string, string | null>)[field] ?? null,
      after: (after.header as Record<string, string | null>)[field] ?? null,
    }));

    const effects = {
      totals: after.header,
      lineDiffs,
      stockReversal,
      stockApplication,
      journals,
      valuation,
      cogs: { reversal: money(reversalCogs), replacement: money(replacementCogs) },
    };
    const valuationState = valuationVariants.map((v) => ({
      productVariantId: v.productVariantId,
      wac: v.currentWacPerMeter,
      meters: v.currentGlobalMeters,
    }));
    const linkageState = {
      returns: linkedReturns.map((r) => ({ id: r.id, status: r.status })),
      allocations: allocations.map((a) => ({ id: a.id, amount: money(D(a.amount)), status: a.receiptVoucher.status })),
    };

    const fingerprint = previewFingerprint({
      invoiceKind: "SALES",
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
      invoiceKind: "SALES",
      currentRevision: invoice.revisionNumber,
      proposedRevision: invoice.revisionNumber + 1,
      currentStatus: invoice.status,
      resultingStatus: "CONFIRMED",
      header: headerFields,
      currentLines: before.lines as unknown as Record<string, string | null>[],
      revisedLines: after.lines as unknown as Record<string, string | null>[],
      lineDiffs,
      currentTotals: {
        subtotal: money(D(invoice.subtotal)),
        discountAmount: money(D(invoice.discountAmount)),
        taxRate: D(invoice.taxRate).toFixed(2),
        taxAmount: money(D(invoice.taxAmount)),
        grandTotal: money(oldTotal),
        totalCost: money(D(invoice.totalCost)),
      },
      revisedTotals: {
        subtotal: money(totals.subtotal),
        discountAmount: money(totals.discountAmount),
        taxRate: taxRate.toFixed(2),
        taxAmount: money(totals.taxAmount),
        grandTotal: money(totals.grandTotal),
        totalCost: money(replacementCogs),
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
        voucherId: a.receiptVoucher.id,
        voucherNumber: a.receiptVoucher.voucherNumber.toString(),
        date: a.receiptVoucher.voucherDate.toISOString().slice(0, 10),
        amount: money(D(a.receiptVoucher.amount)),
        allocated: money(D(a.amount)),
      })),
      partyImpactBefore: {
        partyType: "CUSTOMER",
        partyId: invoice.customerId,
        partyNameAr: invoice.customer.nameAr,
        balanceDelta: money(oldTotal),
        allocatedAmount: money(applied),
        outstandingAfter: money(oldTotal.minus(applied)),
        creditAfter: money(Decimal.max(new Decimal(0), applied.minus(oldTotal))),
      },
      partyImpactAfter: {
        partyType: "CUSTOMER",
        partyId: payload.customerId,
        partyNameAr: customer?.nameAr ?? "",
        balanceDelta: money(totals.grandTotal),
        allocatedAmount: money(partyChanged ? new Decimal(0) : applied),
        outstandingAfter: money(partyChanged ? totals.grandTotal : outstandingAfter),
        creditAfter: money(
          partyChanged ? new Decimal(0) : Decimal.max(new Decimal(0), applied.minus(totals.grandTotal)),
        ),
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
      preview, invoice, effective, effectiveMovements, effectiveJournal, effectiveCogsJournal,
      priced, perLineCogs, totals, taxRate, period, before, after,
      reversalCogs, replacementCogs, invoiceNumber, customer, branch,
      accounts: { arAccountId, revenueAccountId, vatOutputAccountId, cogsAccountId, inventoryAccountId },
      valuationVariants, poolByVariant, allVariants, applied,
    };
  }

  private replacementRevenueLines(input: {
    arAccountId: string;
    revenueAccountId: string;
    vatOutputAccountId: string | null;
    totals: { subtotal: Decimal; taxAmount: Decimal; grandTotal: Decimal };
    invoiceNumber: string;
    customerId: string;
    customerName: string;
    nextRevision: number;
  }): PostingLine[] {
    const lines: PostingLine[] = [
      {
        accountId: input.arAccountId,
        debit: money(input.totals.grandTotal),
        credit: "0",
        note: `مديونية ${input.customerName} - SI-${input.invoiceNumber} (نسخة ${input.nextRevision})`,
        partyType: "CUSTOMER",
        partyId: input.customerId,
      },
      {
        accountId: input.revenueAccountId,
        debit: "0",
        credit: money(input.totals.subtotal),
        note: `إيرادات مبيعات - SI-${input.invoiceNumber} (نسخة ${input.nextRevision})`,
      },
    ];
    if (input.totals.taxAmount.gt(0) && input.vatOutputAccountId) {
      lines.push({
        accountId: input.vatOutputAccountId,
        debit: "0",
        credit: money(input.totals.taxAmount),
        note: `ضريبة قيمة مضافة - SI-${input.invoiceNumber} (نسخة ${input.nextRevision})`,
      });
    }
    return lines;
  }

  private snapshot(input: {
    invoice: { id: string };
    header: Record<string, string | number | null>;
    lines: Array<Record<string, string | null>>;
    posting: Record<string, unknown> | null;
  }) {
    return { invoiceId: input.invoice.id, header: input.header, lines: input.lines, posting: input.posting };
  }

  private diffLines(
    before: Array<Record<string, string | null>>,
    after: Array<Record<string, string | null>>,
    returned: Map<string, { boards: Decimal; variantId: string }>,
    _blocking: RevisionIssue[],
  ): RevisionLineDiff[] {
    const out: RevisionLineDiff[] = [];
    const afterById = new Map(after.filter((l) => l.lineId).map((l) => [l.lineId!, l]));
    const comparable = (l: Record<string, string | null>) =>
      JSON.stringify([l.productVariantId, l.boards, l.meters, l.unitPrice, l.discountPct, l.lineTotal, l.note ?? null]);

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
    calc: Awaited<ReturnType<SalesInvoiceRevisionService["calculate"]>>,
    body: ExecuteSalesInvoiceRevision,
    actor: AuthenticatedUser,
  ): Promise<InvoiceRevisionResult> {
    const {
      invoice, effective, effectiveMovements, priced, perLineCogs, totals, taxRate,
      period, before, after, reversalCogs, replacementCogs, invoiceNumber, accounts,
    } = calc;
    const payload = body.payload;
    const nextRevision = invoice.revisionNumber + 1;

    // Deterministic lock order over every variant this revision touches, so two
    // revisions that share a product can never deadlock against each other.
    const lockIds = [...new Set([...invoice.lines.map((l) => l.productVariantId), ...priced.map((p) => p.productVariantId)])].sort();
    for (const id of lockIds) {
      await tx.$queryRaw`SELECT id FROM product_variants WHERE id = ${id}::uuid FOR UPDATE`;
    }

    // Pool state read BEFORE any movement, so the revaluation below is applied
    // to the same numbers the preview was calculated from.
    const poolBefore = await tx.branchInventoryBalance.groupBy({
      by: ["productVariantId"],
      where: { productVariantId: { in: lockIds } },
      _sum: { metersOnHand: true, boardsOnHand: true },
    });
    const poolByVariant = new Map(poolBefore.map((p) => [p.productVariantId, p]));
    const variantRows = await tx.productVariant.findMany({
      where: { id: { in: lockIds } },
      select: { id: true, avgCostPerMeter: true, avgCost: true },
    });
    const wacByVariant = new Map(variantRows.map((v) => [v.id, { perMeter: D(v.avgCostPerMeter), perBoard: D(v.avgCost) }]));

    // ── 1. reverse the accounting currently in force ──────────────────────
    let reversalJournalEntryId: string | null = null;
    let reversalCogsJournalEntryId: string | null = null;
    if (effective.journalEntryId) {
      const r = await this.reversal.reverse({
        entryId: effective.journalEntryId,
        reason: `تعديل فاتورة المبيعات ${invoiceNumber} — النسخة ${nextRevision}`,
        reversalDate: period.postingDate,
        actor,
        tx,
      });
      reversalJournalEntryId = r.journalEntryId;
    }
    if (effective.cogsJournalEntryId) {
      const r = await this.reversal.reverse({
        entryId: effective.cogsJournalEntryId,
        reason: `تعديل تكلفة فاتورة المبيعات ${invoiceNumber} — النسخة ${nextRevision}`,
        reversalDate: period.postingDate,
        actor,
        tx,
      });
      reversalCogsJournalEntryId = r.journalEntryId;
    }

    // ── 2. reverse the party transaction (never delete it) ────────────────
    // `customer_transactions.type` is constrained by the database to
    // INVOICE | RECEIPT | RETURN | ADJUSTMENT | OPENING. A revision's party
    // effect is an adjustment of that legacy ledger, so it uses the existing
    // vocabulary rather than widening a CHECK constraint on a live table for
    // one feature. The reference and description carry the provenance, and the
    // revision row holds the exact ids on both sides.
    const reversalPartyTxIds: string[] = [];
    for (const txId of effective.customerTxIds) {
      const existing = await tx.customerTransaction.findUnique({ where: { id: txId } });
      if (!existing) continue;
      const created = await tx.customerTransaction.create({
        data: {
          customerId: existing.customerId,
          type: "ADJUSTMENT",
          direction: existing.direction === "DR" ? "CR" : "DR",
          amount: existing.amount,
          date: new Date(period.postingDate),
          reference: `SI-${invoiceNumber}-REV${nextRevision}-R`,
          description: `عكس قيد فاتورة مبيعات رقم ${invoiceNumber} — تعديل النسخة ${nextRevision}`,
          createdBy: actor.id,
        },
      });
      reversalPartyTxIds.push(created.id);
    }

    // ── 3. return the currently issued stock to the branch it left ────────
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
        reference: { type: "sales_invoice_revision_reversal", id: invoice.id },
        actor,
        summaryAr: `إرجاع مخزون — تعديل فاتورة مبيعات ${invoiceNumber} (نسخة ${nextRevision})`,
        summaryEn: `Stock restored — sales invoice ${invoiceNumber} revision ${nextRevision}`,
        humanReadableNote: `تعديل فاتورة مبيعات ${invoiceNumber} — النسخة ${nextRevision}`,
        tx,
      });
      reversalMovementIds.push(applied.movementId);
    }

    // ── 4. rewrite the invoice header and lines ───────────────────────────
    const keptIds = new Set(payload.lines.map((l) => l.lineId).filter(Boolean) as string[]);
    for (const l of invoice.lines) {
      if (keptIds.has(l.id)) continue;
      // Safe by construction: a line carrying a confirmed return is blocked
      // from removal in `calculate`, and the FK is ON DELETE RESTRICT anyway.
      await tx.salesInvoiceLine.delete({ where: { id: l.id } });
    }
    const replacementLineIds: string[] = [];
    for (const [i, p] of priced.entries()) {
      const src = payload.lines[i]!;
      const cogs = perLineCogs[i]!;
      const data = {
        productVariantId: p.productVariantId,
        quantity: p.quantity.toFixed(4),
        lengthM: p.lengthM ? p.lengthM.toFixed(4) : null,
        widthM: p.widthM ? p.widthM.toFixed(4) : null,
        metersQuantity: p.meters.toFixed(4),
        unitLabel: p.unitLabel,
        unitPrice: money(p.unitPrice),
        costPrice: money(p.costPrice),
        discountPct: p.discountPct.toFixed(2),
        lineTotal: money(p.lineTotal),
        lineCost: money(p.lineCost),
        note: p.note,
        unitCostAtPosting: money(cogs.legacyPerBoard),
        unitCostPerMeterAtPosting: rate(cogs.costPerMeter),
        lineCogsAtPosting: money(cogs.cogs),
        taxRateAtPosting: taxRate.toFixed(2),
      };
      if (src.lineId) {
        // Update in place: the row id is what confirmed returns point at.
        const updated = await tx.salesInvoiceLine.update({ where: { id: src.lineId }, data });
        replacementLineIds.push(updated.id);
      } else {
        const created = await tx.salesInvoiceLine.create({ data: { ...data, invoiceId: invoice.id } });
        replacementLineIds.push(created.id);
      }
    }

    // ── 5. issue the revised quantities from the revised branch ───────────
    const replacementMovementIds: string[] = [];
    for (const p of priced) {
      if (p.quantity.isZero()) continue;
      const applied = await this.inventory.apply({
        branchId: payload.branchId,
        productVariantId: p.productVariantId,
        movementType: "SALE",
        boardsDelta: p.quantity.negated().toFixed(4),
        metersDelta: p.meters.negated().toFixed(4),
        reference: { type: "sales_invoice_revision", id: invoice.id },
        actor,
        summaryAr: `صرف من المخزون — فاتورة مبيعات ${invoiceNumber} (نسخة ${nextRevision})`,
        summaryEn: `Stock out — sales invoice ${invoiceNumber} revision ${nextRevision}`,
        humanReadableNote: `فاتورة مبيعات ${invoiceNumber} — النسخة ${nextRevision}`,
        tx,
      });
      replacementMovementIds.push(applied.movementId);
    }

    // ── 6. revalue the shared pool at historical cost ─────────────────────
    const valuationEvidence: Array<Record<string, string>> = [];
    for (const variantId of lockIds) {
      const reversedMeters = invoice.lines
        .filter((l) => l.productVariantId === variantId)
        .reduce((a, l) => a.plus(D(l.metersQuantity ?? D(l.quantity).times(D(l.productVariant?.sizeMetersPerBoard)))), new Decimal(0));
      const reversedValue = invoice.lines
        .filter((l) => l.productVariantId === variantId)
        .reduce((a, l) => a.plus(D(l.lineCogsAtPosting)), new Decimal(0));
      const issuedMeters = perLineCogs.filter((l) => l.productVariantId === variantId).reduce((a, l) => a.plus(l.meters), new Decimal(0));
      const issuedValue = perLineCogs.filter((l) => l.productVariantId === variantId).reduce((a, l) => a.plus(l.cogs), new Decimal(0));
      const metersDelta = reversedMeters.minus(issuedMeters);
      const valueDelta = reversedValue.minus(issuedValue);
      if (metersDelta.isZero() && valueDelta.isZero()) continue;

      const pool = poolByVariant.get(variantId);
      const wac = wacByVariant.get(variantId) ?? { perMeter: new Decimal(0), perBoard: new Decimal(0) };
      const boardsDelta = invoice.lines.filter((l) => l.productVariantId === variantId).reduce((a, l) => a.plus(D(l.quantity)), new Decimal(0))
        .minus(perLineCogs.filter((l) => l.productVariantId === variantId).reduce((a, l) => a.plus(l.boards), new Decimal(0)));
      const after2 = repriceGlobalPool({
        currentMeters: D(pool?._sum.metersOnHand),
        currentBoards: D(pool?._sum.boardsOnHand),
        currentWacPerMeter: wac.perMeter,
        metersDelta,
        boardsDelta,
        valueDelta,
      });
      if (after2.value.isNegative()) {
        throw new ValidationError({ reason: "revision_would_make_inventory_value_negative", productVariantId: variantId });
      }
      await tx.productVariant.update({
        where: { id: variantId },
        data: {
          avgCostPerMeter: after2.wacPerMeter.toFixed(4),
          avgCost: after2.wacPerBoard.toFixed(4),
          costUpdatedAt: new Date(),
        },
      });
      valuationEvidence.push({
        productVariantId: variantId,
        wacBefore: rate(wac.perMeter),
        wacAfter: rate(after2.wacPerMeter),
        metersDelta: qty(metersDelta),
        valueDelta: money(valueDelta),
      });
    }

    // ── 7. post the replacement accounting ────────────────────────────────
    const replacementLines = this.replacementRevenueLines({
      arAccountId: accounts.arAccountId!,
      revenueAccountId: accounts.revenueAccountId!,
      vatOutputAccountId: accounts.vatOutputAccountId,
      totals,
      invoiceNumber,
      customerId: payload.customerId,
      customerName: calc.customer?.nameAr ?? "",
      nextRevision,
    });
    const replacement = await this.posting.post({
      tx,
      actor,
      sourceType: "SALES_INVOICE",
      sourceId: invoice.id,
      entryType: "SALES_INVOICE",
      entryDate: period.postingDate,
      reference: `SI-${invoiceNumber}-REV${nextRevision}`,
      description: `فاتورة مبيعات رقم ${invoiceNumber} — النسخة ${nextRevision} — ${calc.customer?.nameAr ?? ""}`,
      idempotencyKey: `SALES_INVOICE:${invoice.id}:REV:${nextRevision}`,
      lines: replacementLines,
    });
    if (payload.salesRepresentativeId) {
      await tx.journalEntry.update({
        where: { id: replacement.journalEntryId },
        data: { salesRepresentativeId: payload.salesRepresentativeId },
      });
    }

    let replacementCogsJournalEntryId: string | null = null;
    if (replacementCogs.gt(0) && accounts.cogsAccountId && accounts.inventoryAccountId) {
      const posted = await this.posting.post({
        tx,
        actor,
        sourceType: "SALES_INVOICE",
        sourceId: invoice.id,
        entryType: "JOURNAL",
        entryDate: period.postingDate,
        reference: `SI-${invoiceNumber}-REV${nextRevision}-COGS`,
        description: `تكلفة البضاعة المباعة - فاتورة ${invoiceNumber} — النسخة ${nextRevision}`,
        idempotencyKey: `SALES_INVOICE:${invoice.id}:REV:${nextRevision}:COGS`,
        lines: [
          { accountId: accounts.cogsAccountId, debit: money(replacementCogs), credit: "0", note: `تكلفة مبيعات - SI-${invoiceNumber}`, branchId: payload.branchId },
          { accountId: accounts.inventoryAccountId, debit: "0", credit: money(replacementCogs), note: `صرف من المخزون - SI-${invoiceNumber}`, branchId: payload.branchId },
        ],
      });
      replacementCogsJournalEntryId = posted.journalEntryId;
    }

    // ── 8. replacement party transaction ──────────────────────────────────
    const replacementPartyTxIds: string[] = [];
    const replacementTx = await tx.customerTransaction.create({
      data: {
        customerId: payload.customerId,
        type: "ADJUSTMENT",
        direction: "DR",
        amount: money(totals.grandTotal),
        date: new Date(period.postingDate),
        reference: `SI-${invoiceNumber}-REV${nextRevision}`,
        description: `فاتورة مبيعات رقم ${invoiceNumber} — النسخة ${nextRevision}`,
        createdBy: actor.id,
      },
    });
    replacementPartyTxIds.push(replacementTx.id);

    // ── 9. header ─────────────────────────────────────────────────────────
    await tx.salesInvoice.update({
      where: { id: invoice.id },
      data: {
        invoiceDate: new Date(payload.invoiceDate),
        dueDate: payload.dueDate ? new Date(payload.dueDate) : null,
        customerId: payload.customerId,
        branchId: payload.branchId,
        salesRepresentativeId: payload.salesRepresentativeId ?? null,
        notes: payload.notes ?? null,
        taxRate: taxRate.toFixed(2),
        subtotal: money(totals.subtotal),
        discountAmount: money(totals.discountAmount),
        taxAmount: money(totals.taxAmount),
        grandTotal: money(totals.grandTotal),
        totalCost: money(replacementCogs),
        revisionNumber: nextRevision,
        lastRevisedAt: new Date(),
        lastRevisedBy: actor.id,
        arAccountId: accounts.arAccountId,
        revenueAccountId: accounts.revenueAccountId,
        taxAccountId: accounts.vatOutputAccountId,
        cogsAccountId: replacementCogs.gt(0) ? accounts.cogsAccountId : null,
        inventoryAccountId: replacementCogs.gt(0) ? accounts.inventoryAccountId : null,
        // journalEntryId / cogsJournalEntryId / customerTxId keep pointing at
        // the ORIGINAL posting. It is history, not a mutable field; the
        // currently effective entries live on the newest revision row.
      },
    });

    // ── 10. the revision record ───────────────────────────────────────────
    const delta = {
      totalDelta: money(totals.grandTotal.minus(D(invoice.grandTotal))),
      cogsDelta: money(replacementCogs.minus(reversalCogs)),
      stockDelta: calc.preview.branchQuantityDelta,
      partyDelta: {
        before: calc.preview.partyImpactBefore,
        after: calc.preview.partyImpactAfter,
      },
      lineDiffs: calc.preview.lineDiffs,
      valuation: { ...calc.preview.valuation, applied: valuationEvidence },
      linkedReturns: calc.preview.linkedReturns,
      linkedVouchers: calc.preview.linkedVouchers,
      replacementLineIds,
      acknowledgedWarnings: body.acknowledgedWarnings ?? [],
    };

    const revision = await tx.salesInvoiceRevision.create({
      data: {
        salesInvoiceId: invoice.id,
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
        reversalCogsJournalEntryId,
        replacementJournalEntryId: replacement.journalEntryId,
        replacementCogsJournalEntryId,
        valuationJournalEntryIds: [] as unknown as Prisma.InputJsonValue,
        reversalMovementIds: reversalMovementIds as unknown as Prisma.InputJsonValue,
        replacementMovementIds: replacementMovementIds as unknown as Prisma.InputJsonValue,
        reversalPartyTxIds: reversalPartyTxIds as unknown as Prisma.InputJsonValue,
        replacementPartyTxIds: replacementPartyTxIds as unknown as Prisma.InputJsonValue,
        revisedBy: actor.id,
      },
      include: { actor: { select: { id: true, name: true } } },
    });

    await this.audit.write({
      tx,
      actorId: actor.id,
      action: "UPDATE",
      entityType: "sales_invoice_revision",
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
        journalEntryIds: [reversalJournalEntryId, reversalCogsJournalEntryId, replacement.journalEntryId, replacementCogsJournalEntryId].filter(Boolean),
        movementIds: [...reversalMovementIds, ...replacementMovementIds],
      },
      summaryAr: `${actor.name} عدّل فاتورة المبيعات المؤكدة رقم ${invoiceNumber} — النسخة ${nextRevision}: ${body.reason}`,
      summaryEn: `${actor.name} revised confirmed sales invoice ${invoiceNumber} — revision ${nextRevision}: ${body.reason}`,
    });

    return this.resultFrom(tx, revision, false);
  }

  private async resultFrom(
    db: Tx | PrismaService,
    revision: Prisma.SalesInvoiceRevisionGetPayload<Record<string, never>> & { actor?: { id: string; name: string } | null },
    idempotentReplay: boolean,
  ): Promise<InvoiceRevisionResult> {
    const row = await db.salesInvoice.findUnique({
      where: { id: revision.salesInvoiceId },
      include: {
        customer: { select: { id: true, code: true, nameAr: true } },
        branch: { select: { id: true, nameAr: true } },
        lines: {
          orderBy: { id: "asc" },
          include: { productVariant: { include: { sku: { select: { code: true, colorNameAr: true } } } } },
        },
      },
    });
    // `invoiceNumber` is a BigInt; JSON cannot serialise one, so the response
    // carries it as a string exactly like the invoice controller does.
    const invoice = row && {
      id: row.id,
      invoiceNumber: row.invoiceNumber.toString(),
      invoiceDate: row.invoiceDate,
      dueDate: row.dueDate,
      status: row.status,
      revisionNumber: row.revisionNumber,
      lastRevisedAt: row.lastRevisedAt,
      lastRevisedBy: row.lastRevisedBy,
      customer: row.customer,
      branch: row.branch,
      salesRepresentativeId: row.salesRepresentativeId,
      notes: row.notes,
      subtotal: row.subtotal.toFixed(2),
      discountAmount: row.discountAmount.toFixed(2),
      taxRate: row.taxRate.toFixed(2),
      taxAmount: row.taxAmount.toFixed(2),
      grandTotal: row.grandTotal.toFixed(2),
      totalCost: row.totalCost.toFixed(2),
      lines: row.lines.map((l) => ({
        id: l.id,
        productVariantId: l.productVariantId,
        productCode: l.productVariant?.sku?.code ?? null,
        colorName: l.productVariant?.sku?.colorNameAr ?? null,
        quantity: l.quantity.toFixed(4),
        metersQuantity: l.metersQuantity != null ? l.metersQuantity.toFixed(4) : null,
        unitLabel: l.unitLabel,
        unitPrice: l.unitPrice.toFixed(2),
        discountPct: l.discountPct.toFixed(2),
        lineTotal: l.lineTotal.toFixed(2),
        lineCogsAtPosting: l.lineCogsAtPosting != null ? l.lineCogsAtPosting.toFixed(2) : null,
        note: l.note,
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
      reversalJournalEntryIds: [revision.reversalJournalEntryId, revision.reversalCogsJournalEntryId].filter(Boolean) as string[],
      replacementJournalEntryIds: [revision.replacementJournalEntryId, revision.replacementCogsJournalEntryId].filter(Boolean) as string[],
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
