/**
 * Removes exactly two test documents — LRN-3 and LRN-4 — created against the
 * customer «Omar test» while trying the returns screen.
 *
 * This is a deletion of real rows from a live ledger, so it is written to be
 * paranoid rather than convenient:
 *
 *   - it targets two hard-coded document ids and nothing else. There is no
 *     pattern match on a customer name, because a LIKE '%Omar%' would happily
 *     take a real customer with a similar name;
 *   - it re-proves every safety property at run time against the database it is
 *     actually pointed at, and aborts the whole transaction if any of them
 *     fails. Proving it on a copy is not the same as proving it here;
 *   - it refuses to delete anything whose economic effect is not exactly zero.
 *
 * LRN-4 is a draft: no journal, no customer transaction, no stock. Deleting it
 * removes a document that never happened.
 *
 * LRN-3 was confirmed and then cancelled, so its chain exists but nets to zero
 * on every axis — stock applied then reversed, four journal entries that pair
 * off, and a customer credit that was taken back. Deleting it removes a
 * matched set, which is why balances cannot move.
 *
 * One consequence is deliberately NOT hidden: journal entry numbers 251–254
 * disappear from the sequence. The ledger stays balanced and every report is
 * unaffected, but the numbering will show a gap where the test lived.
 *
 *   pnpm --filter @shorok/api omar-test:purge -- [--execute]
 */
import { PrismaClient } from "@prisma/client";

const LRN3 = "b0faffd4-5e30-4a22-8b76-07c9b5bf938a"; // CANCELLED — confirmed then reversed
const LRN4 = "19e008ad-cca5-4de3-96ee-4bff90e3414a"; // DRAFT — never posted
const CUSTOMER_CODE = "C-0087";                       // Omar test

const execute = process.argv.includes("--execute");
const prisma = new PrismaClient();

async function main() {
  const log: string[] = [];

  await prisma.$transaction(async (tx) => {
    const fail = (m: string) => { throw new Error(`PRECONDITION FAILED: ${m}`); };

    const docs = await tx.legacySalesReturn.findMany({
      where: { id: { in: [LRN3, LRN4] } },
      include: { customer: { select: { code: true, nameAr: true } } },
    });
    if (docs.length === 0) { log.push("both documents are already absent — nothing to do"); return; }

    for (const d of docs) {
      if (d.customer.code !== CUSTOMER_CODE) fail(`${d.id} belongs to ${d.customer.code}, not the test customer`);
    }

    const three = docs.find((d) => d.id === LRN3);
    const four = docs.find((d) => d.id === LRN4);

    // ── LRN-4: a draft must be exactly that ────────────────────────────────
    if (four) {
      if (four.status !== "DRAFT") fail(`LRN-4 is ${four.status}, expected DRAFT`);
      if (four.journalEntryId || four.cogsJournalEntryId || four.customerTransactionId) fail("LRN-4 carries postings");
      const mv = await tx.inventoryMovement.count({ where: { referenceId: LRN4 } });
      if (mv > 0) fail(`LRN-4 has ${mv} inventory movements`);
    }

    // ── LRN-3: the whole chain must net to zero ────────────────────────────
    let threeEntryIds: string[] = [];
    if (three) {
      if (three.status !== "CANCELLED") fail(`LRN-3 is ${three.status}, expected CANCELLED`);

      const movements = await tx.inventoryMovement.findMany({ where: { referenceId: LRN3 } });
      const boards = movements.reduce((a, m) => a + Number(m.boardsQuantity), 0);
      const meters = movements.reduce((a, m) => a + Number(m.metersQuantity), 0);
      if (boards !== 0 || meters !== 0) fail(`LRN-3 stock does not net to zero (boards ${boards}, metres ${meters})`);

      const originals = await tx.journalEntry.findMany({ where: { sourceId: LRN3 }, select: { id: true, entryNumber: true } });
      const reversals = await tx.journalEntry.findMany({
        where: { reversalOfId: { in: originals.map((o) => o.id) } },
        select: { id: true, entryNumber: true },
      });
      // A reversal carries the same sourceId as its original, so the two queries
      // overlap. Deduplicate, or the chain looks bigger than it is.
      const chain = [...originals, ...reversals].filter(
        (e, i, all) => all.findIndex((o) => o.id === e.id) === i,
      );
      threeEntryIds = chain.map((e) => e.id);

      const lines = await tx.journalLine.findMany({ where: { journalEntryId: { in: threeEntryIds } } });
      const dr = lines.reduce((a, l) => a + Number(l.debit), 0);
      const cr = lines.reduce((a, l) => a + Number(l.credit), 0);
      if (Math.abs(dr - cr) > 0.005) fail(`LRN-3 journals do not balance (${dr} vs ${cr})`);
      const perAccount = new Map<string, number>();
      for (const l of lines) perAccount.set(l.accountId, (perAccount.get(l.accountId) ?? 0) + Number(l.debit) - Number(l.credit));
      for (const [acc, net] of perAccount) if (Math.abs(net) > 0.005) fail(`LRN-3 leaves ${net} on account ${acc}`);

      const cash = await tx.journalLine.count({
        where: { journalEntryId: { in: threeEntryIds }, account: { isCashOrBank: true } },
      });
      if (cash > 0) fail("LRN-3 touches a cash/bank account");

      // Nothing outside this chain may point at these entries.
      const foreign =
        (await tx.salesInvoice.count({ where: { OR: [{ journalEntryId: { in: threeEntryIds } }, { cogsJournalEntryId: { in: threeEntryIds } }] } })) +
        (await tx.salesReturn.count({ where: { journalEntryId: { in: threeEntryIds } } })) +
        (await tx.receiptVoucher.count({ where: { journalEntryId: { in: threeEntryIds } } })) +
        (await tx.purchaseInvoice.count({ where: { journalEntryId: { in: threeEntryIds } } }));
      if (foreign > 0) fail(`${foreign} other documents reference LRN-3's journals`);

      const ctx = await tx.customerTransaction.findMany({ where: { reference: { in: ["LRN-3", "LRN-3-CANCEL"] } } });
      const net = ctx.reduce((a, t) => a + (t.direction === "DR" ? Number(t.amount) : -Number(t.amount)), 0);
      if (Math.abs(net) > 0.005) fail(`LRN-3 customer effect does not net to zero (${net})`);

      const numbers = chain.map((e) => Number(e.entryNumber)).sort((a, b) => a - b).join(",");
      log.push(`LRN-3: ${movements.length} movements (net 0), ${threeEntryIds.length} journal entries #${numbers}, ${lines.length} journal lines (Dr ${dr} = Cr ${cr}), ${ctx.length} customer transactions (net 0)`);
    }
    if (four) log.push("LRN-4: draft only — 1 line, no postings, no stock");

    if (!execute) { log.push("DRY RUN — nothing was deleted"); return; }

    // ── delete, children first ─────────────────────────────────────────────
    if (three) {
      const ctxDeleted = await tx.customerTransaction.deleteMany({ where: { reference: { in: ["LRN-3", "LRN-3-CANCEL"] } } });
      const mvDeleted = await tx.inventoryMovement.deleteMany({ where: { referenceId: LRN3 } });
      const jlDeleted = await tx.journalLine.deleteMany({ where: { journalEntryId: { in: threeEntryIds } } });
      // Detach the document before its journals go, so no FK is left dangling.
      await tx.legacySalesReturn.update({
        where: { id: LRN3 },
        data: { journalEntryId: null, cogsJournalEntryId: null, customerTransactionId: null },
      });
      // Reversal rows point at their original, so they must go first.
      const revDeleted = await tx.journalEntry.deleteMany({ where: { id: { in: threeEntryIds }, reversalOfId: { not: null } } });
      const jeDeleted = await tx.journalEntry.deleteMany({ where: { id: { in: threeEntryIds } } });
      const lnDeleted = await tx.legacySalesReturnLine.deleteMany({ where: { legacySalesReturnId: LRN3 } });
      await tx.legacySalesReturn.delete({ where: { id: LRN3 } });
      log.push(`LRN-3 removed: ${lnDeleted.count} lines, ${mvDeleted.count} movements, ${jlDeleted.count} journal lines, ${revDeleted.count + jeDeleted.count} journal entries, ${ctxDeleted.count} customer transactions`);
    }
    if (four) {
      const lnDeleted = await tx.legacySalesReturnLine.deleteMany({ where: { legacySalesReturnId: LRN4 } });
      await tx.legacySalesReturn.delete({ where: { id: LRN4 } });
      log.push(`LRN-4 removed: ${lnDeleted.count} lines`);
    }
  }, { timeout: 120_000 });

  for (const l of log) console.log("  " + l);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); })
  .finally(() => void prisma.$disconnect());
