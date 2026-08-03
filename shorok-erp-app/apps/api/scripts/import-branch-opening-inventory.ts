/**
 * Loads a branch's opening stock that was omitted from the cutover.
 *
 * This is opening inventory, not trade. It must not invent a purchase, a
 * supplier balance, a payment, or revenue — the goods were already in the
 * warehouse before the system went live, and the only honest counterparty is
 * the same opening-equity account the cutover itself used. So the accounting is
 *
 *   Dr  inventory control        total value
 *   Cr  opening/cutover equity   total value
 *
 * and nothing else moves.
 *
 * Quantities go through InventoryEngine, exactly as the cutover did, using
 * COUNT_CORRECTION movements dated to the ERP opening date. The engine handles
 * only quantity — it writes no journal and touches no cost — so valuation is an
 * explicit, separate decision here rather than a side effect.
 *
 * VALUATION. `avgCostPerMeter` lives on the variant, not the branch, so stock
 * added at one branch changes the cost basis the other branch's stock is sold
 * at. Three treatments are possible and they are NOT interchangeable, so the
 * caller must choose:
 *   pooled    — weighted average of existing and incoming. Total pool value
 *               becomes exactly old + imported, so the GL reconciles by
 *               construction. This is the accounting default.
 *   keep      — leave the existing cost untouched. The imported stock is later
 *               sold at the old rate, leaving the cost difference permanently
 *               unrelieved from the inventory account.
 *   overwrite — force the source cost, restating the OTHER branch's existing
 *               stock. What the original cutover did, correct only when the
 *               variant had no prior stock.
 *
 * Idempotency is the document key, carried as the journal's unique
 * idempotencyKey and on every movement reference, so a repeat run finds the
 * existing document and writes nothing.
 *
 *   pnpm --filter @shorok/api opening-inventory:import -- \
 *     --dataset <path> --branch-id <uuid> --branch-name-ar <name> \
 *     --actor-id <uuid> --actor-phone <e164> \
 *     --equity-account-code CUTOVER-TEMP-EQUITY --wac-mode pooled [--execute]
 *
 * Without --execute the whole import runs inside a transaction that is then
 * rolled back, and the script reports what it would have done.
 */
import { readFileSync } from "node:fs";
import { NestFactory } from "@nestjs/core";
import { Decimal } from "decimal.js";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { InventoryEngine } from "../src/modules/inventory/inventory.engine";
import { PostingEngine } from "../src/modules/posting/posting.engine";
import type { AuthenticatedUser } from "../src/common/types/request-user";

interface SourceLine {
  lineKey: string;
  code: string;
  nameAr: string;
  size: string;
  boards: string;
  metres: string;
  costPerMetre: string;
  /** The variant's cost before this import — required by --repair-wac. */
  priorAvgCostPerMetre?: string;
  value: string;
  variantId: string;
  skuId: string;
}

interface Dataset {
  documentKey: string;
  documentTitle: string;
  countDate: string;
  effectiveDate: string;
  branchId: string;
  branchNameAr: string;
  descriptionAr: string;
  descriptionEn: string;
  reference: string;
  lines: SourceLine[];
  zeroControls: Array<{ code: string; size: string }>;
  totals: { lines: number; boards: string; metres: string; value: string };
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  }
  return process.argv[i + 1];
}

/** Thrown to unwind the dry run. Never escapes main(). */
class RollbackPreview extends Error {}

/** Kept to 40 chars — the column limit on inventory_movements.reference_type. */
const MOVEMENT_REFERENCE_TYPE = "BRANCH_OPENING_INVENTORY";

const EXECUTE = process.argv.includes("--execute");
const REPAIR_WAC = process.argv.includes("--repair-wac");

async function main(): Promise<void> {
  const datasetPath = arg("dataset");
  const branchId = arg("branch-id");
  const branchNameAr = arg("branch-name-ar");
  const actorId = arg("actor-id");
  const actorPhone = arg("actor-phone");
  const equityCode = arg("equity-account-code");
  const wacMode = arg("wac-mode", "pooled");
  if (!["pooled", "keep", "overwrite"].includes(wacMode)) {
    throw new Error(`--wac-mode must be pooled | keep | overwrite`);
  }

  const ds = JSON.parse(readFileSync(datasetPath, "utf8")) as Dataset;

  console.log(`  document      : ${ds.documentKey}`);
  console.log(`  title         : ${ds.documentTitle}`);
  console.log(`  count date    : ${ds.countDate}   effective: ${ds.effectiveDate}`);
  console.log(`  branch        : ${branchId}`);
  console.log(`  wac mode      : ${wacMode}`);
  console.log(`  mode          : ${EXECUTE ? "EXECUTE" : "DRY RUN (rolled back)"}`);

  // ── the dataset must prove its own arithmetic before anything else ────────
  let boards = new Decimal(0);
  let metres = new Decimal(0);
  let value = new Decimal(0);
  for (const l of ds.lines) {
    const b = new Decimal(l.boards);
    const m = new Decimal(l.metres);
    const c = new Decimal(l.costPerMetre);
    const v = new Decimal(l.value);
    if (b.lte(0)) throw new Error(`${l.lineKey}: boards must be positive — a zero line must not be imported`);
    if (!b.times(new Decimal(l.size)).equals(m)) {
      throw new Error(`${l.lineKey}: ${l.boards} x ${l.size} != ${l.metres}`);
    }
    if (!m.times(c).equals(v)) throw new Error(`${l.lineKey}: ${l.metres} x ${l.costPerMetre} != ${l.value}`);
    boards = boards.plus(b);
    metres = metres.plus(m);
    value = value.plus(v);
  }
  if (ds.lines.length !== ds.totals.lines) throw new Error("line count != declared total");
  if (!boards.equals(new Decimal(ds.totals.boards))) throw new Error(`boards ${boards} != ${ds.totals.boards}`);
  if (!metres.equals(new Decimal(ds.totals.metres))) throw new Error(`metres ${metres} != ${ds.totals.metres}`);
  if (!value.equals(new Decimal(ds.totals.value))) throw new Error(`value ${value} != ${ds.totals.value}`);
  console.log(`  arithmetic    : ${ds.lines.length} lines, ${boards} boards, ${metres} m, ${value} value — verified`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const prisma = app.get(PrismaService);
    const inventory = app.get(InventoryEngine);
    const posting = app.get(PostingEngine);

    // ── actor bound by id AND phone ───────────────────────────────────────
    const owner = await prisma.user.findFirst({
      where: { id: actorId, phone: actorPhone, status: "ACTIVE" },
      select: { id: true, name: true, phone: true, role: true },
    });
    if (!owner) throw new Error("ACTOR_IDENTITY_MISMATCH: actor id + phone did not resolve to one active user");
    const actor: AuthenticatedUser = {
      id: owner.id, name: owner.name, phone: owner.phone, email: null,
      role: owner.role as AuthenticatedUser["role"], status: "ACTIVE", allowedBranches: [branchId],
    };
    console.log(`  actor         : bound by id + phone (${owner.role})`);

    // ── branch bound by id AND name ───────────────────────────────────────
    const branch = await prisma.branch.findFirst({
      where: { id: branchId, nameAr: branchNameAr, active: true },
      select: { id: true, nameAr: true, nameEn: true },
    });
    if (!branch) throw new Error("BRANCH_IDENTITY_MISMATCH: branch id + Arabic name did not resolve to one active branch");
    console.log(`  branch        : ${branch.nameAr} / ${branch.nameEn}`);

    // ── accounts: inventory by SYSTEM ROLE, equity by the cutover's own evidence ──
    const inventoryAccount = await prisma.account.findFirst({
      where: { systemRole: "INVENTORY", active: true, isLeaf: true },
      select: { id: true, code: true, nameAr: true },
    });
    if (!inventoryAccount) throw new Error("no active leaf account carries systemRole INVENTORY");

    const equityAccount = await prisma.account.findFirst({
      where: { code: equityCode, active: true, isLeaf: true, category: "EQUITY" },
      select: { id: true, code: true, nameAr: true },
    });
    if (!equityAccount) throw new Error(`equity account ${equityCode} is not an active leaf EQUITY account`);
    // Name alone proves nothing. Require that this account is the one the
    // existing opening journal actually credited — otherwise a differently
    // named equity account could silently absorb the entry.
    const usedByOpening = await prisma.journalLine.count({
      where: { accountId: equityAccount.id, journalEntry: { entryType: "OPENING" } },
    });
    if (usedByOpening === 0) {
      throw new Error(`${equityCode} was never used by the existing opening journal — refusing to assume it is the cutover equity account`);
    }
    console.log(`  Dr account    : ${inventoryAccount.code} ${inventoryAccount.nameAr} (systemRole INVENTORY)`);
    console.log(`  Cr account    : ${equityAccount.code} ${equityAccount.nameAr} (used by ${usedByOpening} opening line(s))`);

    // ── zero controls must genuinely be zero ──────────────────────────────
    for (const z of ds.zeroControls) {
      const v = await prisma.productVariant.findFirst({
        where: { sku: { code: z.code }, sizeMetersPerBoard: new Decimal(z.size) },
        select: { id: true },
      });
      if (!v) continue; // a variant that does not exist cannot hold stock
      const bal = await prisma.branchInventoryBalance.findUnique({
        where: { branchId_productVariantId: { branchId, productVariantId: v.id } },
        select: { boardsOnHand: true, metersOnHand: true },
      });
      if (bal && (!new Decimal(bal.boardsOnHand.toString()).isZero() || !new Decimal(bal.metersOnHand.toString()).isZero())) {
        throw new Error(`BLOCKED_SOHAG_BASELINE_NOT_EMPTY: ${z.code}/${z.size} holds ${bal.boardsOnHand}/${bal.metersOnHand}`);
      }
    }
    console.log(`  zero controls : ${ds.zeroControls.length} checked, all zero`);

    // ── repair mode: recompute valuation only, quantities untouched ───────
    if (REPAIR_WAC) {
      console.log("\n  REPAIR MODE — recomputing avgCostPerMeter only. No quantity, movement or journal is touched.");
      const changes: string[] = [];
      try {
        await prisma.$transaction(async (tx) => {
          for (const l of ds.lines) {
            if (l.priorAvgCostPerMetre === undefined) {
            throw new Error(`${l.lineKey}: repair needs priorAvgCostPerMetre in the dataset`);
          }
          const agg = await tx.branchInventoryBalance.aggregate({
            where: { productVariantId: l.variantId }, _sum: { metersOnHand: true },
          });
          const total = new Decimal((agg._sum.metersOnHand ?? 0).toString());
          const imported = new Decimal(l.metres);
          const prior = new Decimal(l.priorAvgCostPerMetre);
          const pooled = total.lte(0)
            ? prior
            : total.minus(imported).times(prior).plus(imported.times(new Decimal(l.costPerMetre))).dividedBy(total);
          const value = pooled.toDecimalPlaces(4).toString();
          const current = await tx.productVariant.findUniqueOrThrow({
            where: { id: l.variantId }, select: { avgCostPerMeter: true },
          });
          await tx.productVariant.update({
            where: { id: l.variantId },
            data: { avgCostPerMeter: value, costUpdatedAt: new Date(`${ds.effectiveDate}T00:00:00.000Z`) },
          });
          changes.push(`    ${l.code}/${l.size}: ${current.avgCostPerMeter} -> ${value}`);
        }
          if (!EXECUTE) throw new RollbackPreview();
        }, { timeout: 120_000 });
      } catch (err) {
        // The dry run unwinds by throwing, so it must be caught here or it
        // surfaces as an unexplained failure.
        if (!(err instanceof RollbackPreview)) throw err;
      }
      changes.forEach((c) => console.log(c));
      console.log(EXECUTE ? "\n  WAC REPAIRED" : "\n  DRY RUN — rolled back, nothing written.");
      return;
    }

    // ── idempotency: has this document already been imported? ─────────────
    const priorJournal = await prisma.journalEntry.findUnique({
      where: { idempotencyKey: ds.documentKey },
      select: { id: true, entryNumber: true, entryDate: true },
    });
    // inventory_movements.reference_id is a UUID column, so it cannot carry the
    // text document key. The movements are identified by their reference type
    // scoped to this branch, and each line's own key is kept in the note.
    const priorMovements = await prisma.inventoryMovement.count({
      where: { referenceType: MOVEMENT_REFERENCE_TYPE, branchId },
    });
    if (priorJournal || priorMovements) {
      const lineCount = priorJournal
        ? await prisma.journalLine.count({ where: { journalEntryId: priorJournal.id } })
        : 0;
      const complete = priorJournal && priorMovements === ds.lines.length && lineCount === 2;
      if (!complete) {
        throw new Error(
          `BLOCKED_CONFLICTING_SOHAG_OPENING_IMPORT: journal=${priorJournal ? "yes" : "no"} ` +
          `movements=${priorMovements}/${ds.lines.length} journalLines=${lineCount}`,
        );
      }
      console.log(`\n  ALREADY_IMPORTED_AND_RECONCILED`);
      console.log(`    journal ${priorJournal!.entryNumber} (${priorJournal!.id}), ${priorMovements} movements`);
      console.log(JSON.stringify({ result: "ALREADY_IMPORTED_AND_RECONCILED", journalEntryId: priorJournal!.id }));
      return;
    }

    // ── snapshot everything the import must not disturb ────────────────────
    const before = await snapshot(prisma, branchId);

    try {
      await prisma.$transaction(async (tx) => {
        const movementIds: string[] = [];

        for (const l of ds.lines) {
          const variant = await tx.productVariant.findFirst({
            where: { id: l.variantId, sku: { code: l.code }, sizeMetersPerBoard: new Decimal(l.size), active: true },
            select: { id: true, avgCostPerMeter: true },
          });
          if (!variant) throw new Error(`${l.lineKey}: variant id + code + size did not resolve to one active variant`);

          const res = await inventory.apply({
            tx,
            branchId,
            productVariantId: l.variantId,
            movementType: "COUNT_CORRECTION",
            boardsDelta: l.boards,
            // The exact canonical metres from the approved count — never
            // recomputed downstream from a rounded display column.
            metersDelta: l.metres,
            actor,
            reference: { type: MOVEMENT_REFERENCE_TYPE, id: null },
            summaryAr: `مخزون افتتاحي — ${branch.nameAr} — ${l.code} (${l.size} م)`,
            summaryEn: `Opening inventory — ${branch.nameEn} — ${l.code} (${l.size} m)`,
            humanReadableNote: l.lineKey,
            createdAt: new Date(`${ds.effectiveDate}T00:00:00.000Z`),
          });
          movementIds.push(res.movementId);

          if (wacMode !== "keep") {
            // avgCostPerMeter is a property of the VARIANT, not of a branch, so
            // pooling must weigh the whole on-hand quantity across every branch.
            // Using only this branch's balance silently degrades to "overwrite"
            // whenever the branch started empty — which restates the other
            // branch's cost basis instead of blending it.
            const globalAfter = await tx.branchInventoryBalance.aggregate({
              where: { productVariantId: l.variantId },
              _sum: { metersOnHand: true },
            });
            const totalMetres = new Decimal((globalAfter._sum.metersOnHand ?? 0).toString());
            const existingMetres = totalMetres.minus(new Decimal(l.metres));
            const existingCost = new Decimal(variant.avgCostPerMeter.toString());
            const incoming = new Decimal(l.costPerMetre);
            // Pooled: value-weighted so total pool value = old + imported, which
            // is what keeps the GL and the perpetual valuation consistent.
            const next =
              wacMode === "overwrite" || existingMetres.lte(0) || totalMetres.lte(0)
                ? incoming
                : existingMetres.times(existingCost).plus(new Decimal(l.metres).times(incoming))
                    .dividedBy(totalMetres);
            await tx.productVariant.update({
              where: { id: l.variantId },
              data: {
                avgCostPerMeter: next.toDecimalPlaces(4).toString(),
                costUpdatedAt: new Date(`${ds.effectiveDate}T00:00:00.000Z`),
              },
            });
          }
        }

        const posted = await posting.post({
          tx,
          actor,
          sourceType: "OPENING",
          entryType: "OPENING",
          entryDate: ds.effectiveDate,
          description: ds.descriptionAr,
          reference: ds.reference,
          idempotencyKey: ds.documentKey,
          lines: [
            { accountId: inventoryAccount.id, debit: ds.totals.value, credit: "0", branchId, note: ds.documentKey },
            { accountId: equityAccount.id, debit: "0", credit: ds.totals.value, branchId, note: ds.documentKey },
          ],
        });

        console.log(`\n    journal ${posted.entryNumber} (${posted.journalEntryId})`);
        console.log(`    movements: ${movementIds.length}`);

        if (!EXECUTE) throw new RollbackPreview();
      }, { timeout: 120_000 });
    } catch (err) {
      if (!(err instanceof RollbackPreview)) throw err;
      console.log("\n  DRY RUN — transaction rolled back, nothing written.");
    }

    const after = await snapshot(prisma, branchId);
    report(before, after, ds, EXECUTE);
  } finally {
    await app.close();
  }
}

interface Snap {
  branchBoards: string;
  branchMetres: string;
  otherBoards: string;
  otherMetres: string;
  movements: number;
  journalEntries: number;
  journalLines: number;
  ledgerDr: string;
  ledgerCr: string;
  salesInvoices: number;
  purchaseInvoices: number;
  customerTx: number;
  expenses: number;
}

async function snapshot(prisma: PrismaService, branchId: string): Promise<Snap> {
  const here = await prisma.branchInventoryBalance.aggregate({
    where: { branchId }, _sum: { boardsOnHand: true, metersOnHand: true },
  });
  const elsewhere = await prisma.branchInventoryBalance.aggregate({
    where: { NOT: { branchId } }, _sum: { boardsOnHand: true, metersOnHand: true },
  });
  const ledger = await prisma.journalLine.aggregate({ _sum: { debit: true, credit: true } });
  return {
    branchBoards: String(here._sum.boardsOnHand ?? 0),
    branchMetres: String(here._sum.metersOnHand ?? 0),
    otherBoards: String(elsewhere._sum.boardsOnHand ?? 0),
    otherMetres: String(elsewhere._sum.metersOnHand ?? 0),
    movements: await prisma.inventoryMovement.count(),
    journalEntries: await prisma.journalEntry.count(),
    journalLines: await prisma.journalLine.count(),
    ledgerDr: String(ledger._sum.debit ?? 0),
    ledgerCr: String(ledger._sum.credit ?? 0),
    salesInvoices: await prisma.salesInvoice.count(),
    purchaseInvoices: await prisma.purchaseInvoice.count(),
    customerTx: await prisma.customerTransaction.count(),
    expenses: await prisma.expense.count(),
  };
}

function report(before: Snap, after: Snap, ds: Dataset, executed: boolean): void {
  const d = (a: string, b: string) => new Decimal(b).minus(new Decimal(a));
  const eq = (delta: Decimal, expected: string) => delta.equals(new Decimal(expected));
  console.log("\n  === effect ===");
  console.log(`    branch boards      ${before.branchBoards} -> ${after.branchBoards}   delta ${d(before.branchBoards, after.branchBoards)}`);
  console.log(`    branch metres      ${before.branchMetres} -> ${after.branchMetres}   delta ${d(before.branchMetres, after.branchMetres)}`);
  console.log(`    OTHER branch boards ${before.otherBoards} -> ${after.otherBoards}   delta ${d(before.otherBoards, after.otherBoards)}`);
  console.log(`    OTHER branch metres ${before.otherMetres} -> ${after.otherMetres}   delta ${d(before.otherMetres, after.otherMetres)}`);
  console.log(`    movements          ${before.movements} -> ${after.movements}`);
  console.log(`    journal entries    ${before.journalEntries} -> ${after.journalEntries}`);
  console.log(`    journal lines      ${before.journalLines} -> ${after.journalLines}`);
  console.log(`    ledger Dr          ${before.ledgerDr} -> ${after.ledgerDr}`);
  console.log(`    ledger Cr          ${before.ledgerCr} -> ${after.ledgerCr}`);

  const failures: string[] = [];
  if (before.otherBoards !== after.otherBoards || before.otherMetres !== after.otherMetres) {
    failures.push("another branch's quantities changed");
  }
  for (const k of ["salesInvoices", "purchaseInvoices", "customerTx", "expenses"] as const) {
    if (before[k] !== after[k]) failures.push(`${k} changed`);
  }
  if (executed) {
    if (!eq(d(before.branchBoards, after.branchBoards), ds.totals.boards)) failures.push("branch boards delta != approved total");
    if (!eq(d(before.branchMetres, after.branchMetres), ds.totals.metres)) failures.push("branch metres delta != approved total");
    if (!eq(d(before.ledgerDr, after.ledgerDr), ds.totals.value)) failures.push("ledger debit delta != approved value");
    if (!eq(d(before.ledgerCr, after.ledgerCr), ds.totals.value)) failures.push("ledger credit delta != approved value");
    if (after.journalEntries - before.journalEntries !== 1) failures.push("expected exactly one new journal entry");
    if (after.movements - before.movements !== ds.lines.length) failures.push("movement count != line count");
  } else {
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    if (!unchanged) failures.push("DRY RUN WROTE DATA");
  }
  if (failures.length) throw new Error(`RECONCILIATION FAILED: ${failures.join("; ")}`);
  console.log(executed ? "\n  RECONCILED" : "\n  DRY RUN VERIFIED — zero committed changes");
}

main().catch((e) => {
  console.error(`  FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
