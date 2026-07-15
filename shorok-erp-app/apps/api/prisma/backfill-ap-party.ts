/**
 * Idempotent, reviewable historical backfill: assign the SUPPLIER party to
 * AP_CONTROL journal lines that have no party but whose journal entry is
 * deterministically linked to a PurchaseInvoice (via purchase_invoices.journal_entry_id).
 *
 * ONLY party metadata is written (party_type, party_id). Debit, credit, account,
 * date, status and source are never touched. Rows whose supplier cannot be
 * determined with certainty are left untouched and reported.
 *
 * Usage:
 *   ts-node prisma/backfill-ap-party.ts            # dry-run (no writes) — default
 *   ts-node prisma/backfill-ap-party.ts --apply    # apply the updates
 *
 * Run only after a fresh production backup and dry-run review.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  // AP_CONTROL lines missing a party.
  const partyless = await prisma.journalLine.findMany({
    where: { partyType: null, account: { systemRole: "AP_CONTROL" } },
    select: { id: true, journalEntryId: true, journalEntry: { select: { entryType: true, sourceType: true } } },
  });

  // Deterministic supplier map: purchaseInvoice.journalEntryId → supplierId.
  const invoices = await prisma.purchaseInvoice.findMany({
    where: { journalEntryId: { not: null } },
    select: { journalEntryId: true, supplierId: true },
  });
  const supplierByEntry = new Map(invoices.map((i) => [i.journalEntryId!, i.supplierId]));

  const resolvable: Array<{ lineId: string; supplierId: string }> = [];
  const unresolvedBySource: Record<string, number> = {};
  for (const l of partyless) {
    const supplierId = supplierByEntry.get(l.journalEntryId);
    if (supplierId) resolvable.push({ lineId: l.id, supplierId });
    else {
      const key = l.journalEntry.sourceType ?? l.journalEntry.entryType ?? "UNKNOWN";
      unresolvedBySource[key] = (unresolvedBySource[key] ?? 0) + 1;
    }
  }

  console.log(`AP_CONTROL partyless lines: ${partyless.length}`);
  console.log(`Deterministically resolvable (linked PurchaseInvoice): ${resolvable.length}`);
  console.log(`Unresolved by source:`, unresolvedBySource);

  if (!APPLY) {
    console.log("\nDRY-RUN — no writes. Re-run with --apply to update party metadata.");
    return;
  }

  let updated = 0;
  for (const r of resolvable) {
    // Idempotent + safe: only flips a still-null party; never touches money/date/source.
    const res = await prisma.journalLine.updateMany({
      where: { id: r.lineId, partyType: null },
      data: { partyType: "SUPPLIER", partyId: r.supplierId },
    });
    updated += res.count;
  }
  console.log(`\nAPPLIED — party set on ${updated} line(s). Unresolved left untouched.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => void prisma.$disconnect());
