/**
 * Authoritative opening-dataset import — 2026-07-18 (OPENING_DATASET_20260718_V1).
 *
 * Replaces the current TEST operational data with the authoritative opening
 * position (27 products / 41 variants, branch opening stock, 19 customers with
 * opening balances, two balanced opening journals). Preserves users, branches,
 * chart of accounts, posting profiles, periods, suppliers, sales representatives.
 *
 * Usage:
 *   ts-node scripts/import-opening-data-20260718.ts                         # dry-run (default)
 *   ts-node scripts/import-opening-data-20260718.ts --execute               # LOCAL execute
 *   CONFIRM_PRODUCTION_OPENING_RESET=YES ts-node ... --execute --prod       # PRODUCTION execute
 *
 * Idempotent: a rerun detects the opening journals and makes no changes.
 */
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PostingEngine } from "../src/modules/posting/posting.engine";
import { InventoryEngine } from "../src/modules/inventory/inventory.engine";
import { CUSTOMERS, EXPECT, MARKER, PRODUCTS, VARIANTS, validateDataset } from "./opening-dataset";
import { alreadyApplied, importOpening, resolveContext, type Ctx } from "./opening-import";

function log(...a: unknown[]) { console.log(...a); }

async function report(ctx: Ctx, mode: string, prisma: PrismaService) {
  log(`\n═══════════ ${mode} — OPENING DATASET 2026-07-18 ═══════════`);
  log(`Branches:  الوراق=${ctx.waraqId} (${ctx.waraqName}) | سوهاج=${ctx.sohagId} (${ctx.sohagName})`);
  log(`Accounts:  AR=${ctx.arLabel} | INVENTORY=${ctx.invLabel} | OPENING_EQUITY=${ctx.oeLabel}`);
  const period = await prisma.financialPeriod.findFirst({ where: { year: 2026, month: 7 } });
  log(`Period 2026/07: ${period?.status ?? "MISSING"}`);
  log(`Import: products=${PRODUCTS.length} variants=${VARIANTS.length} customers=${CUSTOMERS.length}`);
  log(`الوراق: ${EXPECT.waraq.boards} boards / ${EXPECT.waraq.meters} m / ${EXPECT.waraq.value} EGP`);
  log(`سوهاج: ${EXPECT.sohag.boards} boards / ${EXPECT.sohag.meters} m / ${EXPECT.sohag.value} EGP`);
  log(`Combined: ${EXPECT.combined.boards} boards / ${EXPECT.combined.meters} m / ${EXPECT.combined.value} EGP`);
  log(`Customers: debit ${EXPECT.debitTotal} (15) / credit ${EXPECT.creditTotal} (4) / net ${EXPECT.netAr} Debit`);
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const isProd = args.includes("--prod");
  if (isProd && process.env.CONFIRM_PRODUCTION_OPENING_RESET !== "YES") {
    throw new Error("Production execution requires CONFIRM_PRODUCTION_OPENING_RESET=YES");
  }

  validateDataset();
  log("✓ Dataset validation passed (27 products / 41 variants / 19 customers; totals match).");

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const prisma = app.get(PrismaService);
    const ctx = await resolveContext(prisma, app.get(PostingEngine), app.get(InventoryEngine));

    const period = await prisma.financialPeriod.findFirst({ where: { year: 2026, month: 7 } });
    if (!period || period.status !== "OPEN") throw new Error(`Financial period 2026/07 must be OPEN (is ${period?.status ?? "MISSING"}).`);

    if (await alreadyApplied(prisma)) {
      log(`\nⓘ ALREADY APPLIED — ${MARKER} opening journals exist. No changes made.`);
      await report(ctx, "ALREADY-APPLIED", prisma);
      return;
    }

    await report(ctx, execute ? "EXECUTE" : "DRY-RUN", prisma);
    const before = {
      customers: await prisma.customer.count(), skus: await prisma.productSku.count(),
      variants: await prisma.productVariant.count(), journals: await prisma.journalEntry.count(),
      invMoves: await prisma.inventoryMovement.count(), balances: await prisma.branchInventoryBalance.count(),
    };
    log(`\nWill DELETE (operational): customers=${before.customers} skus=${before.skus} variants=${before.variants} journals=${before.journals} invMoves=${before.invMoves} balances=${before.balances}`);
    log(`Will PRESERVE: users, branches, chart of accounts, posting profiles, periods, suppliers, sales representatives, audit.`);

    if (!execute) {
      log("\nDRY-RUN — no changes made. Re-run with --execute to apply.");
      return;
    }
    log("\n⏳ Executing atomic reset + import…");
    await importOpening(ctx);
    log("✓ Import committed and reconciled.");
    await report(ctx, "POST-IMPORT VERIFIED", prisma);
  } finally {
    await app.close();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n✗ IMPORT FAILED:\n", e?.message ?? e); process.exit(1); });
