import { Injectable } from "@nestjs/common";
import { MovementType, Prisma } from "@prisma/client";
// Value imports, not `import type`: Nest reads these classes from the emitted
// decorator metadata to resolve the constructor, and a type-only import is
// erased at compile time.
import { PrismaService } from "../../prisma/prisma.service";
import { InventoryEngine } from "../inventory/inventory.engine";
import type { AuthenticatedUser } from "../../common/types/request-user";
import {
  CUTOVER_ERROR,
  CutoverRefusal,
  DryRunRollback,
  IMPORTER_VERSION,
  type CutoverMode,
} from "./cutover.types";
import type { CutoverPlan } from "./cutover-planner";
import { redact, truncateReason } from "./redaction";

/**
 * Executes a planned cutover import.
 *
 * dry-run and execute run the SAME method and therefore the same writes; the
 * only difference is the final act. dry-run throws DryRunRollback as its last
 * statement, which aborts the transaction — so a dry-run cannot "pass" via a
 * code path that execute would not take.
 *
 * Financial and inventory effects go through the domain engines with the outer
 * transaction threaded in. Direct Prisma writes are confined to non-financial
 * master data (Customer, ProductSku, ProductVariant) for which no transactional
 * domain service exists.
 */

export interface ExecuteOptions {
  mode: Exclude<CutoverMode, "audit">;
  plan: CutoverPlan;
  branchId: string;
  actor: AuthenticatedUser;
  manifestSourceHashes: Record<string, string>;
  operator: string;
  approver: string;
  approvalDate: string;
  codeRevision?: string;
  timeoutMs?: number;
}

export interface ExecuteResult {
  batchId: string | null;
  createdCustomers: number;
  createdSkus: number;
  createdVariants: number;
  stockMovements: number;
  zeroQuantitySkipped: number;
  journalEntryId: string | null;
  rolledBack: boolean;
}

@Injectable()
export class CutoverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryEngine,
  ) {}

  async run(options: ExecuteOptions): Promise<ExecuteResult> {
    const { mode } = options;

    try {
      return await this.prisma.runInTransaction(
        async (tx) => {
          const result = await this.runInTx(tx, options);
          if (mode === "dry-run") {
            // Deliberate abort: everything above is discarded.
            throw new DryRunRollback(result);
          }
          return result;
        },
        { timeoutMs: options.timeoutMs ?? 120_000 },
      );
    } catch (error) {
      if (error instanceof DryRunRollback) {
        return { ...(error.plan as ExecuteResult), rolledBack: true };
      }
      throw error;
    }
  }

  private async runInTx(
    tx: Prisma.TransactionClient,
    options: ExecuteOptions,
  ): Promise<ExecuteResult> {
    const { plan, branchId, actor, mode } = options;

    // ── period guard: never posted into a missing or closed period ─────────
    if (plan.journalMustPost) {
      const [year, month] = plan.cutoverDate.split("-").map(Number);
      const period = await tx.financialPeriod.findFirst({ where: { year, month } });
      if (!period) throw new CutoverRefusal(CUTOVER_ERROR.PERIOD_MISSING, { year, month });
      if (period.status !== "OPEN") {
        throw new CutoverRefusal(CUTOVER_ERROR.PERIOD_CLOSED, { year, month });
      }
    }

    const branch = await tx.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new CutoverRefusal(CUTOVER_ERROR.BRANCH_MISSING, { branchId });

    // ── duplicate-execute protection ──────────────────────────────────────
    if (mode === "execute") {
      const existing = await tx.cutoverImportBatch.findFirst({
        where: { manifestHash: plan.manifestHash, scope: plan.scope, mode: "EXECUTE" },
        select: { id: true },
      });
      if (existing) {
        throw new CutoverRefusal(CUTOVER_ERROR.DUPLICATE_BATCH, { batchId: existing.id });
      }
    }

    const batch = await tx.cutoverImportBatch.create({
      data: {
        manifestId: plan.manifestId,
        manifestHash: plan.manifestHash,
        sourceHashes: options.manifestSourceHashes,
        mode: mode === "execute" ? "EXECUTE" : "DRY_RUN",
        scope: plan.scope,
        status: "RUNNING",
        operator: options.operator,
        approver: options.approver,
        approvalDate: new Date(`${options.approvalDate}T00:00:00.000Z`),
        cutoverDate: new Date(`${plan.cutoverDate}T00:00:00.000Z`),
        branchId,
        codeRevision: options.codeRevision ?? null,
        importerVersion: IMPORTER_VERSION,
      },
      select: { id: true },
    });

    const provenance: Prisma.CutoverImportRowCreateManyInput[] = [];
    let createdCustomers = 0;
    let createdSkus = 0;
    let createdVariants = 0;
    let stockMovements = 0;
    let zeroQuantitySkipped = 0;

    // ── 1. customers (non-financial master data) ──────────────────────────
    const customerIdByKey = new Map<string, string>();
    for (const c of plan.customers) {
      const existing = await tx.customer.findUnique({ where: { code: c.code } });
      const row =
        existing ??
        (await tx.customer.create({
          data: { code: c.code, nameAr: c.nameAr, active: true },
        }));
      if (!existing) createdCustomers += 1;
      customerIdByKey.set(c.approvedKey, row.id);
      provenance.push({
        batchId: batch.id,
        sourceKey: c.sourceKey,
        decisionId: c.decisionId,
        entityType: "CUSTOMER",
        entityId: row.id,
        action: existing ? "REUSED" : "CREATED",
        sourceReference: c.sourceKey,
        approvedKey: c.approvedKey,
      });
    }

    // ── 2. SKUs and variants (non-financial master data) ──────────────────
    const variantIdByKey = new Map<string, string>();
    for (const v of plan.variants) {
      let sku = await tx.productSku.findUnique({ where: { code: v.code } });
      if (!sku) {
        sku = await tx.productSku.create({
          data: {
            code: v.code,
            colorNameAr: v.colorAr,
            colorNameEn: v.colorEn,
            category: v.category,
            active: true,
          },
        });
        createdSkus += 1;
      }
      const size = new Prisma.Decimal(v.sizeMetersPerBoard);
      let variant = await tx.productVariant.findUnique({
        where: { skuId_sizeMetersPerBoard: { skuId: sku.id, sizeMetersPerBoard: size } },
      });
      if (!variant) {
        variant = await tx.productVariant.create({
          data: {
            skuId: sku.id,
            sizeMetersPerBoard: size,
            defaultSalePricePerMeter: new Prisma.Decimal(v.salePricePerMeter),
            defaultPurchasePricePerMeter: new Prisma.Decimal(v.purchasePricePerMeter),
            active: true,
          },
        });
        createdVariants += 1;
      }
      variantIdByKey.set(v.approvedKey, variant.id);
      provenance.push({
        batchId: batch.id,
        sourceKey: v.sourceKey,
        decisionId: v.decisionId,
        entityType: "PRODUCT_VARIANT",
        entityId: variant.id,
        action: "CREATED",
        sourceReference: v.sourceKey,
        approvedKey: v.approvedKey,
      });
    }

    // ── 3. opening stock, through InventoryEngine on the SAME tx ──────────
    for (const s of plan.stock) {
      const variantId = variantIdByKey.get(s.approvedKey);
      if (!variantId) {
        throw new CutoverRefusal(CUTOVER_ERROR.ROW_NOT_APPROVED, {
          decisionId: s.decisionId,
          reason: "variant_not_planned",
        });
      }

      if (s.zeroQuantity) {
        // Master record only: no movement, and no zero-value journal line.
        zeroQuantitySkipped += 1;
        provenance.push({
          batchId: batch.id,
          sourceKey: `${s.sourceKey}#stock`,
          decisionId: s.decisionId,
          entityType: "INVENTORY_OPENING",
          entityId: variantId,
          action: "SKIPPED_ZERO_QTY",
          sourceReference: s.sourceKey,
          approvedKey: s.approvedKey,
        });
        continue;
      }

      await this.inventory.apply({
        tx,
        branchId,
        productVariantId: variantId,
        movementType: MovementType.COUNT_CORRECTION,
        boardsDelta: s.boards,
        // Exact canonical meters — never boards × size recomputed downstream,
        // and never the PDF's display-rounded meters column.
        metersDelta: s.canonicalMeters,
        actor,
        reference: { type: "CUTOVER_OPENING", id: batch.id },
        summaryAr: `رصيد افتتاحي — ${s.decisionId}`,
        summaryEn: `Opening balance — ${s.decisionId}`,
        createdAt: new Date(`${plan.cutoverDate}T00:00:00.000Z`),
      });
      stockMovements += 1;

      // Opening WAC per metre comes from the approved row price.
      await tx.productVariant.update({
        where: { id: variantId },
        data: {
          avgCostPerMeter: new Prisma.Decimal(s.pricePerMeter),
          costUpdatedAt: new Date(`${plan.cutoverDate}T00:00:00.000Z`),
        },
      });

      provenance.push({
        batchId: batch.id,
        sourceKey: `${s.sourceKey}#stock`,
        decisionId: s.decisionId,
        entityType: "INVENTORY_OPENING",
        entityId: variantId,
        action: "CREATED",
        sourceReference: s.sourceKey,
        approvedKey: s.approvedKey,
      });
    }

    await tx.cutoverImportRow.createMany({ data: provenance });

    // ── 4. opening journal ────────────────────────────────────────────────
    // Posting is intentionally NOT implemented as a raw insert. When the
    // accountant supplies the missing credit balances the manifest becomes
    // balanced and this branch posts through PostingEngine with the outer tx.
    const journalEntryId: string | null = null;
    if (plan.journalMustPost) {
      if (plan.journalLines.length === 0) {
        throw new CutoverRefusal(CUTOVER_ERROR.JOURNAL_UNBALANCED, { reason: "no_lines" });
      }
      throw new CutoverRefusal(CUTOVER_ERROR.ACCOUNT_MISSING, {
        reason: "opening_journal_accounts_not_yet_approved",
      });
    }

    await tx.cutoverImportBatch.update({
      where: { id: batch.id },
      data: {
        status: "COMPLETED",
        finishedAt: new Date(),
        reconciliation: redact(plan.reconciliation) as Prisma.InputJsonValue,
      },
    });

    return {
      batchId: batch.id,
      createdCustomers,
      createdSkus,
      createdVariants,
      stockMovements,
      zeroQuantitySkipped,
      journalEntryId,
      rolledBack: false,
    };
  }

  /** Business-row counts, used to prove a dry-run left nothing behind. */
  async businessRowCounts(): Promise<Record<string, number>> {
    const [customers, skus, variants, balances, movements, journals, batches] = await Promise.all([
      this.prisma.customer.count(),
      this.prisma.productSku.count(),
      this.prisma.productVariant.count(),
      this.prisma.branchInventoryBalance.count(),
      this.prisma.inventoryMovement.count(),
      this.prisma.journalEntry.count(),
      this.prisma.cutoverImportBatch.count(),
    ]);
    return { customers, skus, variants, balances, movements, journals, batches };
  }

  static redactFailure(error: unknown): { code: string; reason: string } {
    if (error instanceof CutoverRefusal) {
      return { code: error.code, reason: truncateReason(JSON.stringify(redact(error.details))) };
    }
    return { code: "UNEXPECTED_ERROR", reason: "see operator log" };
  }
}
