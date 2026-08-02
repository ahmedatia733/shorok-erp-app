import { Injectable } from "@nestjs/common";
import { MovementType, Prisma } from "@prisma/client";
// Value imports, NOT `import type`: Nest reads these classes from the emitted
// decorator metadata to resolve the constructor, and a type-only import is
// erased at compile time — the code would compile and then fail to inject.
// The rule is disabled here so `eslint --fix` cannot silently reintroduce it.
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { PrismaService } from "../../prisma/prisma.service";
import { InventoryEngine } from "../inventory/inventory.engine";
import { PostingEngine } from "../posting/posting.engine";
/* eslint-enable @typescript-eslint/consistent-type-imports */
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
  /** SHA-256 of every source file, as ACTUALLY verified on disk this run. */
  verifiedSourceHashes: Record<string, string>;
  codeRevision?: string;
  timeoutMs?: number;
}

export interface ExecuteResult {
  batchId: string | null;
  branchId: string;
  actorUserId: string;
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
    private readonly posting: PostingEngine,
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
    const { plan, mode } = options;
    const branchId = plan.approvedBranchId;

    // ── period guard: never posted into a missing or closed period ─────────
    if (plan.journalMustPost) {
      const [year, month] = plan.cutoverDate.split("-").map(Number);
      const period = await tx.financialPeriod.findFirst({ where: { year, month } });
      if (!period) throw new CutoverRefusal(CUTOVER_ERROR.PERIOD_MISSING, { year, month });
      if (period.status !== "OPEN") {
        throw new CutoverRefusal(CUTOVER_ERROR.PERIOD_CLOSED, { year, month });
      }
    }

    // ── Section 2: bind to the EXACT approved branch and actor ────────────
    // findFirst() is deliberately not used anywhere here: importing into
    // "whichever branch happens to exist" is precisely the silent choice this
    // phase removes.
    const branch = await tx.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new CutoverRefusal(CUTOVER_ERROR.BRANCH_MISSING, { branchId });
    if (branch.nameAr !== plan.branchKey && branch.nameEn !== plan.branchKey) {
      throw new CutoverRefusal(CUTOVER_ERROR.BRANCH_MISMATCH, {
        branchId,
        expectedKey: plan.branchKey,
      });
    }

    const actorRow = await tx.user.findUnique({
      where: { id: plan.approvedActorUserId },
      select: { id: true, name: true, phone: true, role: true, status: true },
    });
    if (!actorRow) {
      throw new CutoverRefusal(CUTOVER_ERROR.ACTOR_MISSING, { userId: plan.approvedActorUserId });
    }
    if (actorRow.phone !== plan.approvedActorPhone) {
      // The id alone could be reused by a restored database; the phone is the
      // second factor that ties the id to the person the approver named.
      throw new CutoverRefusal(CUTOVER_ERROR.ACTOR_IDENTITY_MISMATCH, { userId: actorRow.id });
    }
    if (actorRow.status !== "ACTIVE") {
      throw new CutoverRefusal(CUTOVER_ERROR.ACTOR_NOT_ACTIVE, { userId: actorRow.id });
    }
    if (actorRow.role !== "OWNER") {
      throw new CutoverRefusal(CUTOVER_ERROR.ACTOR_NOT_OWNER, { userId: actorRow.id });
    }
    const access = await tx.userBranchAccess.findUnique({
      where: { userId_branchId: { userId: actorRow.id, branchId } },
    });
    if (!access) {
      throw new CutoverRefusal(CUTOVER_ERROR.ACTOR_NOT_AUTHORIZED_FOR_BRANCH, {
        userId: actorRow.id,
        branchId,
      });
    }
    const actor: AuthenticatedUser = {
      id: actorRow.id,
      name: actorRow.name,
      phone: actorRow.phone,
      email: null,
      role: "OWNER",
      status: "ACTIVE",
      allowedBranches: [branchId],
    };

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
        sourceHashes: options.verifiedSourceHashes,
        mode: mode === "execute" ? "EXECUTE" : "DRY_RUN",
        scope: plan.scope,
        status: "RUNNING",
        operator: plan.operator,
        approver: plan.approver,
        approvalDate: new Date(`${plan.approvalDate}T00:00:00.000Z`),
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

    // ── 4. opening journal, through PostingEngine on the SAME tx ─────────
    // There is no raw journalEntry.create anywhere in this file: the engine
    // owns period validation, party dimensions, balance and audit.
    let journalEntryId: string | null = null;
    if (plan.journalMustPost) {
      if (plan.journalLines.length === 0) {
        throw new CutoverRefusal(CUTOVER_ERROR.JOURNAL_UNBALANCED, { reason: "no_lines" });
      }

      // Resolve every account by its APPROVED CODE. A code that does not exist
      // refuses — the importer never picks a "closest" or "likely" account.
      const codes = [...new Set(plan.journalLines.map((l) => l.accountCode))];
      const accounts = await tx.account.findMany({
        where: { code: { in: codes } },
        select: { id: true, code: true },
      });
      const accountIdByCode = new Map(accounts.map((a) => [a.code, a.id]));
      for (const code of codes) {
        if (!accountIdByCode.has(code)) {
          throw new CutoverRefusal(CUTOVER_ERROR.ACCOUNT_MISSING, { accountCode: code });
        }
      }

      const lines = plan.journalLines.map((l) => {
        const accountId = accountIdByCode.get(l.accountCode)!;
        if (!l.partyRef) {
          return {
            accountId,
            debit: l.debit.toFixed(2),
            credit: l.credit.toFixed(2),
            branchId,
          };
        }
        const partyId = customerIdByKey.get(l.partyRef);
        if (!partyId) {
          throw new CutoverRefusal(CUTOVER_ERROR.AR_PARTY_DIMENSION_MISSING, {
            approvedKey: l.partyRef,
          });
        }
        // Every AR line carries its own customer, so each customer's statement
        // shows that customer's own opening balance.
        return {
          accountId,
          debit: l.debit.toFixed(2),
          credit: l.credit.toFixed(2),
          branchId,
          partyType: "CUSTOMER" as const,
          partyId,
        };
      });

      const posted = await this.posting.post({
        tx,
        actor,
        entryDate: plan.cutoverDate,
        entryType: "OPENING",
        sourceType: "MANUAL",
        description: `رصيد افتتاحي — ${plan.manifestId}`,
        reference: plan.manifestId.slice(0, 100),
        idempotencyKey: `cutover-opening:${plan.manifestHash}`,
        lines,
      });
      journalEntryId = posted.journalEntryId;

      provenance.push({
        batchId: batch.id,
        sourceKey: `${plan.manifestId}#opening-journal`,
        decisionId: "OPENING_JOURNAL",
        entityType: "JOURNAL_ENTRY",
        entityId: journalEntryId,
        action: "CREATED",
        sourceReference: plan.manifestId,
        approvedKey: plan.manifestHash.slice(0, 32),
      });
    }

    await tx.cutoverImportRow.createMany({ data: provenance });

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
      branchId,
      actorUserId: actor.id,
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
