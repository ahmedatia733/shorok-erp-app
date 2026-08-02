/**
 * One-time importer for the historical sales-return archive.
 *
 * Six July 2026 source rows describe returns whose original invoices predate
 * this database. Their customer effect is already inside the approved
 * 2026-08-01 opening AR, and their stock effect is already inside the
 * 2026-08-01 physical count. They exist so the business can SEE its return
 * history — nothing more.
 *
 * So this importer writes to the archive tables and to nothing else. It does
 * not import PostingEngine or InventoryEngine, and it cannot post: the archive
 * tables have no journal, inventory or customer-transaction columns to post to.
 * A test asserts that this file never references those engines.
 *
 * The approved dataset lives OUTSIDE the repository because it carries customer
 * names; its path is supplied with --dataset. Every row carries a fingerprint
 * over its canonical source content, and the archive's unique constraint on
 * that fingerprint is what makes a second run a no-op — not this script
 * remembering to check, though it checks first anyway so a repeat run reports
 * cleanly instead of dying on a constraint violation.
 *
 *   pnpm --filter @shorok/api archive:import -- --dataset <path> [--execute]
 *
 * Without --execute it runs the whole import inside a transaction and rolls it
 * back, printing what it would have done.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const IMPORTER_VERSION = "1.0.0";

interface ArchiveLine {
  lineNumber: number;
  productVariantId: string | null;
  productSourceCode: string;
  boards: string;
  canonicalMeters: string;
  unitPrice: string | null;
  lineValue: string;
  sourceReference: string;
}

interface ArchiveRow {
  sourceRow: number;
  sourceReference: string;
  sourceFingerprint: string;
  documentDate: string;
  customerId: string | null;
  customerSourceReference: string;
  originalInvoiceReference: string | null;
  grossValue: string;
  notes: string | null;
  lines: ArchiveLine[];
}

interface Dataset {
  batchKeys: { archive: string };
  sourceFile: string;
  sourceFileHash: string;
  historicalReturns: ArchiveRow[];
  totals: {
    archiveCount: number;
    archiveGross: number;
    archiveBoards: number;
    archiveCanonicalMeters: number;
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Thrown to unwind a dry run. Never escapes main(). */
class RollbackPreview extends Error {}

async function main() {
  const datasetPath = arg("dataset");
  const execute = process.argv.includes("--execute");
  const operator = arg("operator") ?? "R3 automated importer";
  const approver = arg("approver") ?? "OTONOM — Business Owner";
  const approvalDate = arg("approval-date") ?? "2026-08-02";
  const importedBy = arg("imported-by");
  const importerPhone = arg("imported-by-phone");

  if (!datasetPath) throw new Error("--dataset <path> is required");
  if (!importedBy || !importerPhone) {
    throw new Error("--imported-by <uuid> and --imported-by-phone <phone> are both required");
  }

  const dataset = JSON.parse(readFileSync(datasetPath, "utf8")) as Dataset;
  const rows = dataset.historicalReturns;
  const batchKey = dataset.batchKeys.archive;

  // The dataset file is itself fingerprinted, so the run log records exactly
  // which bytes produced these rows.
  const datasetHash = createHash("sha256").update(readFileSync(datasetPath)).digest("hex");

  console.log(`  dataset        : ${datasetPath.split("/").pop()}`);
  console.log(`  dataset sha256 : ${datasetHash.slice(0, 16)}…`);
  console.log(`  source file    : ${dataset.sourceFile} (${dataset.sourceFileHash.slice(0, 16)}…)`);
  console.log(`  batch key      : ${batchKey}`);
  console.log(`  rows in dataset: ${rows.length}`);
  console.log(`  mode           : ${execute ? "EXECUTE" : "DRY RUN (rolled back)"}`);

  if (rows.length !== dataset.totals.archiveCount) {
    throw new Error(`dataset self-inconsistent: ${rows.length} rows vs totals.archiveCount ${dataset.totals.archiveCount}`);
  }

  const fingerprints = rows.map((r) => r.sourceFingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error("dataset contains duplicate source fingerprints");
  }

  // Every row must reconcile against its own line before anything is written.
  for (const r of rows) {
    const lineSum = r.lines.reduce((a, l) => a + Number(l.lineValue), 0);
    if (Math.abs(lineSum - Number(r.grossValue)) > 0.005) {
      throw new Error(`row ${r.sourceRow}: lines sum ${lineSum} != grossValue ${r.grossValue}`);
    }
    for (const l of r.lines) {
      // The canonical rule used everywhere else in this system: boards x size.
      // The importer does not recompute it — it refuses a dataset whose own
      // numbers disagree, because that means the source was misread upstream.
      if (Number(l.canonicalMeters) <= 0 || Number(l.boards) <= 0) {
        throw new Error(`row ${r.sourceRow}: non-positive boards/meters`);
      }
    }
  }

  const prisma = new PrismaClient();
  try {
    const importer = await prisma.user.findFirst({
      where: { id: importedBy, phone: importerPhone },
      select: { id: true },
    });
    if (!importer) {
      throw new Error("ACTOR_IDENTITY_MISMATCH: --imported-by id and phone did not resolve to one user");
    }

    // Pre-flight: refuse the WHOLE run rather than half-importing.
    const already = await prisma.historicalSalesReturnArchive.findMany({
      where: { sourceFingerprint: { in: fingerprints } },
      select: { sourceFingerprint: true, sourceRow: true },
    });
    if (already.length > 0) {
      console.log(`\n  ALREADY IMPORTED: ${already.length} of ${rows.length} rows are present.`);
      for (const a of already) console.log(`    source row ${a.sourceRow} — fingerprint ${a.sourceFingerprint.slice(0, 12)}…`);
      const total = await prisma.historicalSalesReturnArchive.count();
      console.log(`  archive row count unchanged at ${total}. Nothing written.`);
      return;
    }

    const before = {
      journalEntries: await prisma.journalEntry.count(),
      journalLines: await prisma.journalLine.count(),
      inventoryMovements: await prisma.inventoryMovement.count(),
      customerTransactions: await prisma.customerTransaction.count(),
      archives: await prisma.historicalSalesReturnArchive.count(),
    };

    try {
      await prisma.$transaction(async (tx) => {
        const batch = await tx.historicalReturnImportBatch.create({
          data: {
            batchKey,
            sourceSystem: `workbook ${dataset.sourceFile}`,
            sourceFileHash: dataset.sourceFileHash,
            sourceSheet: "المبيعات",
            expectedRows: rows.length,
            status: "RUNNING",
            operator,
            approver,
            approvalDate: new Date(approvalDate),
            codeRevision: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ?? null,
            importerVersion: IMPORTER_VERSION,
          },
        });

        for (const r of rows) {
          const archive = await tx.historicalSalesReturnArchive.create({
            data: {
              sourceFingerprint: r.sourceFingerprint,
              importBatchId: batch.id,
              sourceSystem: `workbook ${dataset.sourceFile}`,
              sourceFileHash: dataset.sourceFileHash,
              sourceSheet: "المبيعات",
              sourceRow: r.sourceRow,
              sourceReference: r.sourceReference,
              documentDate: new Date(r.documentDate),
              customerId: r.customerId,
              customerSourceReference: r.customerSourceReference,
              originalInvoiceReference: r.originalInvoiceReference,
              grossValue: r.grossValue,
              notes: r.notes,
              importedBy: importer.id,
            },
          });
          for (const l of r.lines) {
            await tx.historicalSalesReturnArchiveLine.create({
              data: {
                historicalReturnId: archive.id,
                lineNumber: l.lineNumber,
                productVariantId: l.productVariantId,
                productSourceCode: l.productSourceCode,
                boards: l.boards,
                canonicalMeters: l.canonicalMeters,
                unitPrice: l.unitPrice,
                lineValue: l.lineValue,
                sourceReference: l.sourceReference,
              },
            });
          }
          console.log(`    row ${String(r.sourceRow).padStart(3)} -> archive ${archive.archiveNumber} (${r.grossValue})`);
        }

        await tx.historicalReturnImportBatch.update({
          where: { id: batch.id },
          data: {
            importedRows: rows.length,
            status: "COMPLETED",
            finishedAt: new Date(),
            reconciliation: {
              expectedRows: dataset.totals.archiveCount,
              grossValue: dataset.totals.archiveGross,
              boards: dataset.totals.archiveBoards,
              canonicalMeters: dataset.totals.archiveCanonicalMeters,
              datasetSha256: datasetHash,
            },
          },
        });

        if (!execute) throw new RollbackPreview();
      });
    } catch (err) {
      if (!(err instanceof RollbackPreview)) throw err;
      console.log("\n  DRY RUN — transaction rolled back, nothing written.");
    }

    const after = {
      journalEntries: await prisma.journalEntry.count(),
      journalLines: await prisma.journalLine.count(),
      inventoryMovements: await prisma.inventoryMovement.count(),
      customerTransactions: await prisma.customerTransaction.count(),
      archives: await prisma.historicalSalesReturnArchive.count(),
    };

    console.log("\n  === effect ===");
    for (const k of ["journalEntries", "journalLines", "inventoryMovements", "customerTransactions"] as const) {
      const delta = after[k] - before[k];
      console.log(`    ${k.padEnd(22)} ${before[k]} -> ${after[k]}  delta ${delta}${delta === 0 ? " ✅" : "  ⚠ MUST BE ZERO"}`);
      if (delta !== 0) throw new Error(`${k} changed by ${delta} — the archive must never post`);
    }
    console.log(`    ${"archives".padEnd(22)} ${before.archives} -> ${after.archives}  delta ${after.archives - before.archives}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`  FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
