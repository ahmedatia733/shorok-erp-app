/**
 * The historical sales-return archive is EVIDENCE, never a document.
 *
 * The archived July 2026 paper returns are already inside the approved
 * 2026-08-01 opening AR balances and the 2026-08-01 physical count, so writing
 * one must move NOTHING: no journal entry, no journal line, no inventory
 * movement, no customer transaction, and not a single byte of the branch
 * inventory balances. Posting them again would double-count a live ledger.
 *
 * The suite therefore builds a REAL populated ledger first (confirmed purchase
 * + sales invoices), proves the snapshot probe actually notices ledger movement,
 * and only then writes archive rows and demands the snapshot come back
 * identical. Without the sensitivity test the equality assertion could pass on
 * an empty database while seeing nothing.
 */
import * as bcrypt from "bcrypt";
import { createHash } from "node:crypto";
import request from "supertest";
import type { AccountCategory, AccountSystemRole, AccountType } from "@prisma/client";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

/** Dates and Decimals serialise deterministically so "identical" means bytes. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v instanceof Date ? v.toISOString() : typeof v === "bigint" ? v.toString() : v,
  );

interface LedgerSnapshot {
  counts: {
    journalEntries: number;
    journalLines: number;
    inventoryMovements: number;
    customerTransactions: number;
  };
  journal: string;
  inventory: string;
}

describe("historical sales-return archive never posts", () => {
  let h: TestApp;
  let token: string;
  let repId: string, customerId: string, supplierId: string, variantId: string;
  let batchId: string;
  const acc: Record<string, string> = {};
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const srv = () => h.app.getHttpServer();

  const snapshot = async (): Promise<LedgerSnapshot> => ({
    counts: {
      journalEntries: await h.prisma.journalEntry.count(),
      journalLines: await h.prisma.journalLine.count(),
      inventoryMovements: await h.prisma.inventoryMovement.count(),
      customerTransactions: await h.prisma.customerTransaction.count(),
    },
    journal: stable(
      await h.prisma.journalEntry.findMany({
        include: { lines: { orderBy: { id: "asc" } } },
        orderBy: { entryNumber: "asc" },
      }),
    ),
    // Every column, including updatedAt — a mere touch is also a failure.
    inventory: stable(
      await h.prisma.branchInventoryBalance.findMany({
        orderBy: [{ branchId: "asc" }, { productVariantId: "asc" }],
      }),
    ),
  });

  let archiveSeq = 0;
  /** Writes one archive row exactly the way the one-time importer writes it. */
  const writeArchiveRow = async (over: { sourceFingerprint?: string } = {}) => {
    const n = ++archiveSeq;
    return h.prisma.historicalSalesReturnArchive.create({
      data: {
        sourceFingerprint:
          over.sourceFingerprint ?? createHash("sha256").update(`archive-row-${n}`).digest("hex"),
        importBatchId: batchId,
        sourceSystem: "workbook تقرير المبيعات.xlsx",
        sourceFileHash: createHash("sha256").update("workbook").digest("hex"),
        sourceSheet: "المبيعات",
        sourceRow: 100 + n,
        sourceReference: `ARC-${n}`,
        documentDate: new Date("2026-07-14"),
        customerId,
        customerSourceReference: "عميل كما ورد في المستند الورقي",
        originalInvoiceReference: `PAPER-${n}`,
        grossValue: "1600.00",
        notes: "مردود تاريخي — محسوب ضمن الرصيد الافتتاحي",
        importedBy: h.ownerId,
        lines: {
          create: [
            {
              lineNumber: 1,
              productVariantId: variantId,
              productSourceCode: "ARC-CODE-1",
              boards: "2.0000",
              canonicalMeters: "8.0000",
              unitPrice: "200.00",
              lineValue: "1600.00",
              sourceReference: `ARC-${n}`,
            },
          ],
        },
      },
    });
  };

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(srv()).post("/api/v1/auth/login").send({ phone: h.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    repId = (await h.prisma.salesRepresentative.create({ data: { code: "AR", nameAr: "م" } })).id;
    customerId = (await h.prisma.customer.create({ data: { code: "AC", nameAr: "عميل" } })).id;
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "S" } })).id;
    const u = Date.now().toString().slice(-6);
    const mk = async (k: string, code: string, cat: AccountCategory, t: AccountType, role?: AccountSystemRole) => {
      acc[k] = (await h.prisma.account.create({ data: { code: `${code}${u}`, nameAr: code, nameEn: code, category: cat, accountType: t, isLeaf: true, active: true, ...(role ? { systemRole: role } : {}) } })).id;
    };
    await mk("ar", "AR", "ASSET", "CURRENT_ASSET", "AR_CONTROL"); await mk("ap", "AP", "LIABILITY", "LIABILITY", "AP_CONTROL");
    await mk("rev", "RV", "REVENUE", "REVENUE"); await mk("sret", "SR", "REVENUE", "REVENUE");
    await mk("vatO", "VO", "LIABILITY", "LIABILITY"); await mk("cogs", "CG", "COST_OF_SALES", "COST_OF_SALES"); await mk("inv", "IN", "ASSET", "CURRENT_ASSET");
    await h.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId: acc.ar, apAccountId: acc.ap, revenueAccountId: acc.rev, salesReturnsAccountId: acc.sret, vatOutputAccountId: acc.vatO, cogsAccountId: acc.cogs, inventoryAccountId: acc.inv, createdBy: h.ownerId } });
    for (let m = 1; m <= 12; m++) await h.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });

    const sku = await h.prisma.productSku.create({ data: { code: "ARC-1", category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
    variantId = (await h.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: "4.0000", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" } })).id;

    // A real, populated ledger: stock in, stock out, AR moved.
    const p = await request(srv()).post("/api/v1/purchase-invoices").set(auth()).send({ invoiceDate: "2026-02-01", supplierId, branchId: h.branchId, lines: [{ productVariantId: variantId, boardsQuantity: "40", unitPrice: "300", taxRate: "0" }] });
    await request(srv()).post(`/api/v1/purchase-invoices/${p.body.id}/confirm`).set(auth()).send({});
    const s = await request(srv()).post("/api/v1/sales-invoices").set(auth()).send({ invoiceDate: "2026-03-01", customerId, branchId: h.branchId, taxRate: "0", salesRepresentativeId: repId, lines: [{ productVariantId: variantId, quantity: "5", unitPrice: "500", costPrice: "0" }] });
    await request(srv()).post(`/api/v1/sales-invoices/${s.body.id}/confirm`).set(auth()).send({});

    batchId = (await h.prisma.historicalReturnImportBatch.create({
      data: {
        batchKey: `archive-test-${u}`,
        sourceSystem: "workbook تقرير المبيعات.xlsx",
        sourceFileHash: createHash("sha256").update("workbook").digest("hex"),
        sourceSheet: "المبيعات",
        expectedRows: 6,
        status: "RUNNING",
        operator: "integration test",
        approver: "OTONOM — Business Owner",
        approvalDate: new Date("2026-08-02"),
        importerVersion: "1.0.0",
      },
    })).id;
  });
  afterAll(async () => teardownTestApp(h));

  it("the snapshot probe DOES see an operational document move the ledger", async () => {
    // Proves the equality assertions below are not passing blind.
    const before = await snapshot();
    expect(before.counts.journalEntries).toBeGreaterThan(0);
    expect(before.counts.journalLines).toBeGreaterThan(0);
    expect(before.counts.inventoryMovements).toBeGreaterThan(0);
    expect(before.counts.customerTransactions).toBeGreaterThan(0);

    const s = await request(srv()).post("/api/v1/sales-invoices").set(auth()).send({ invoiceDate: "2026-03-05", customerId, branchId: h.branchId, taxRate: "0", salesRepresentativeId: repId, lines: [{ productVariantId: variantId, quantity: "1", unitPrice: "500", costPrice: "0" }] });
    expect((await request(srv()).post(`/api/v1/sales-invoices/${s.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);

    const after = await snapshot();
    expect(after.counts.journalEntries).toBeGreaterThan(before.counts.journalEntries);
    expect(after.counts.journalLines).toBeGreaterThan(before.counts.journalLines);
    expect(after.counts.inventoryMovements).toBeGreaterThan(before.counts.inventoryMovements);
    expect(after.counts.customerTransactions).toBeGreaterThan(before.counts.customerTransactions);
    expect(after.journal).not.toBe(before.journal);
    expect(after.inventory).not.toBe(before.inventory); // boards on hand fell
  });

  it("writing archive rows posts nothing and leaves branch inventory byte-identical", async () => {
    const before = await snapshot();
    const archivesBefore = await h.prisma.historicalSalesReturnArchive.count();

    await writeArchiveRow();
    await writeArchiveRow();

    const after = await snapshot();
    // The rows really were written — otherwise "no effect" would be trivial.
    expect(await h.prisma.historicalSalesReturnArchive.count()).toBe(archivesBefore + 2);
    expect(await h.prisma.historicalSalesReturnArchiveLine.count()).toBeGreaterThan(0);

    expect(after.counts).toEqual(before.counts);
    expect(after.counts.journalEntries - before.counts.journalEntries).toBe(0);
    expect(after.counts.journalLines - before.counts.journalLines).toBe(0);
    expect(after.counts.inventoryMovements - before.counts.inventoryMovements).toBe(0);
    expect(after.counts.customerTransactions - before.counts.customerTransactions).toBe(0);
    expect(after.journal).toBe(before.journal);
    expect(after.inventory).toBe(before.inventory);
  });

  it("the archived quantities never reach the branch inventory balance", async () => {
    // 2 archive rows x 2 boards / 8 metres each are visible in the archive and
    // absent from the stock, because the physical count already contains them.
    const archived = await h.prisma.historicalSalesReturnArchiveLine.aggregate({ _sum: { boards: true, canonicalMeters: true } });
    expect(archived._sum.boards?.toString()).toBe("4");
    expect(archived._sum.canonicalMeters?.toString()).toBe("16");

    const balance = await h.prisma.branchInventoryBalance.findUnique({
      where: { branchId_productVariantId: { branchId: h.branchId, productVariantId: variantId } },
    });
    // 40 purchased − 5 − 1 sold = 34 boards. No archive board was added back.
    expect(balance!.boardsOnHand.toString()).toBe("34");
    expect(balance!.metersOnHand.toString()).toBe("136");
  });

  it("reading the archive through the API posts nothing either", async () => {
    const before = await snapshot();
    const list = await request(srv()).get("/api/v1/historical-sales-returns?limit=100").set(auth());
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    const detail = await request(srv()).get(`/api/v1/historical-sales-returns/${list.body.items[0].id}`).set(auth());
    expect(detail.status).toBe(200);
    expect(detail.body.immutable).toBe(true);

    const after = await snapshot();
    expect(after.counts).toEqual(before.counts);
    expect(after.journal).toBe(before.journal);
    expect(after.inventory).toBe(before.inventory);
  });

  it("an archive row carries no link to any posted artefact", async () => {
    // The contract is the ABSENCE of the columns: nothing can post what it has
    // no column to reference.
    const row = (await h.prisma.historicalSalesReturnArchive.findFirst({ include: { lines: true } }))!;
    const columns = new Set([...Object.keys(row), ...Object.keys(row.lines[0]!)]);
    for (const forbidden of ["journalEntryId", "customerTransactionId", "inventoryMovementId", "branchId", "status"]) {
      expect(columns.has(forbidden)).toBe(false);
    }
    expect(row.immutable).toBe(true);
  });

  it("a duplicate sourceFingerprint is refused by the database constraint", async () => {
    const first = await writeArchiveRow();
    const countAfterFirst = await h.prisma.historicalSalesReturnArchive.count();

    // Same source row imported twice — the unique index refuses it, so a repeat
    // run cannot silently double the archive.
    await expect(writeArchiveRow({ sourceFingerprint: first.sourceFingerprint })).rejects.toMatchObject({
      code: "P2002",
    });
    await expect(
      h.prisma.$executeRawUnsafe(
        `INSERT INTO "historical_sales_return_archives"
           ("id","source_fingerprint","import_batch_id","source_system","source_file_hash","source_sheet",
            "source_row","source_reference","document_date","customer_source_reference","gross_value","imported_by")
         VALUES (gen_random_uuid(), $1, $2::uuid, 's', 'h', 'sheet', 999, 'DUP', DATE '2026-07-14', 'c', 0, $3::uuid)`,
        first.sourceFingerprint,
        batchId,
        h.ownerId,
      ),
    ).rejects.toThrow(/source_fingerprint/);

    expect(await h.prisma.historicalSalesReturnArchive.count()).toBe(countAfterFirst);
    // A genuinely different source row still imports — the gate is the
    // fingerprint, not a blanket refusal to write.
    await writeArchiveRow();
    expect(await h.prisma.historicalSalesReturnArchive.count()).toBe(countAfterFirst + 1);
  });
});
