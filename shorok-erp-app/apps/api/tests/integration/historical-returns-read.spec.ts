/**
 * The archive and the operational returns are two separate ledgers of fact, and
 * the endpoints must never blend them: the archive rows are already inside the
 * 2026-08-01 opening balances, so a user who saw them listed among operational
 * مردودات would read the same return twice.
 *
 * Covers the read contract end to end — separation in BOTH directions, and
 * filtering by document date, customer and product. Every filter is asserted on
 * what it EXCLUDES as well as what it returns, and against the whole-set totals,
 * so a filter that silently degrades to "return everything" fails here.
 */
import * as bcrypt from "bcrypt";
import { createHash } from "node:crypto";
import request from "supertest";
import type { AccountCategory, AccountSystemRole, AccountType } from "@prisma/client";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

interface ArchiveFixtureLine {
  variantId: string | null;
  sourceCode: string;
  boards: string;
  meters: string;
  unitPrice: string | null;
  lineValue: string;
}

describe("historical sales-return archive read + filtering", () => {
  let h: TestApp;
  let token: string;
  let repId: string, supplierId: string;
  let customerA: string, customerB: string, operationalCustomer: string;
  let variantX: string, variantY: string;
  let batchId: string;
  let operationalReturnId: string, operationalReturnNumber: string;
  const archiveIds: Record<string, string> = {};
  const acc: Record<string, string> = {};
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const srv = () => h.app.getHttpServer();

  const listArchive = async (qs = "") =>
    (await request(srv()).get(`/api/v1/historical-sales-returns${qs}`).set(auth())).body;
  const refs = (body: { items: Array<{ sourceReference: string }> }) => body.items.map((i) => i.sourceReference);

  let sourceRow = 0;
  const addArchive = async (a: {
    ref: string;
    date: string;
    customerId: string | null;
    customerSourceReference: string;
    grossValue: string;
    lines: ArchiveFixtureLine[];
  }) => {
    sourceRow += 1;
    const row = await h.prisma.historicalSalesReturnArchive.create({
      data: {
        sourceFingerprint: createHash("sha256").update(a.ref).digest("hex"),
        importBatchId: batchId,
        sourceSystem: "workbook تقرير المبيعات.xlsx",
        sourceFileHash: createHash("sha256").update("workbook").digest("hex"),
        sourceSheet: "المبيعات",
        sourceRow,
        sourceReference: a.ref,
        documentDate: new Date(a.date),
        customerId: a.customerId,
        customerSourceReference: a.customerSourceReference,
        originalInvoiceReference: `PAPER-${a.ref}`,
        grossValue: a.grossValue,
        notes: "مردود تاريخي — محسوب ضمن الرصيد الافتتاحي",
        importedBy: h.ownerId,
        lines: {
          create: a.lines.map((l, i) => ({
            lineNumber: i + 1,
            productVariantId: l.variantId,
            productSourceCode: l.sourceCode,
            boards: l.boards,
            canonicalMeters: l.meters,
            unitPrice: l.unitPrice,
            lineValue: l.lineValue,
            sourceReference: a.ref,
          })),
        },
      },
    });
    archiveIds[a.ref] = row.id;
    return row;
  };

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(srv()).post("/api/v1/auth/login").send({ phone: h.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    repId = (await h.prisma.salesRepresentative.create({ data: { code: "HR", nameAr: "م" } })).id;
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "S" } })).id;
    customerA = (await h.prisma.customer.create({ data: { code: "HA", nameAr: "عميل أ" } })).id;
    customerB = (await h.prisma.customer.create({ data: { code: "HB", nameAr: "عميل ب" } })).id;
    operationalCustomer = (await h.prisma.customer.create({ data: { code: "HO", nameAr: "عميل تشغيلي" } })).id;
    const u = Date.now().toString().slice(-6);
    const mk = async (k: string, code: string, cat: AccountCategory, t: AccountType, role?: AccountSystemRole) => {
      acc[k] = (await h.prisma.account.create({ data: { code: `${code}${u}`, nameAr: code, nameEn: code, category: cat, accountType: t, isLeaf: true, active: true, ...(role ? { systemRole: role } : {}) } })).id;
    };
    await mk("ar", "AR", "ASSET", "CURRENT_ASSET", "AR_CONTROL"); await mk("ap", "AP", "LIABILITY", "LIABILITY", "AP_CONTROL");
    await mk("rev", "RV", "REVENUE", "REVENUE"); await mk("sret", "SR", "REVENUE", "REVENUE");
    await mk("vatO", "VO", "LIABILITY", "LIABILITY"); await mk("cogs", "CG", "COST_OF_SALES", "COST_OF_SALES"); await mk("inv", "IN", "ASSET", "CURRENT_ASSET");
    await h.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId: acc.ar, apAccountId: acc.ap, revenueAccountId: acc.rev, salesReturnsAccountId: acc.sret, vatOutputAccountId: acc.vatO, cogsAccountId: acc.cogs, inventoryAccountId: acc.inv, createdBy: h.ownerId } });
    for (let m = 1; m <= 12; m++) await h.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });

    const skuX = await h.prisma.productSku.create({ data: { code: "HX-1", category: "NORMAL", colorNameAr: "أبيض", colorNameEn: "white" } });
    const skuY = await h.prisma.productSku.create({ data: { code: "HY-1", category: "NORMAL", colorNameAr: "ذهبي", colorNameEn: "gold" } });
    variantX = (await h.prisma.productVariant.create({ data: { skuId: skuX.id, sizeMetersPerBoard: "4.0000", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" } })).id;
    variantY = (await h.prisma.productVariant.create({ data: { skuId: skuY.id, sizeMetersPerBoard: "5.2500", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" } })).id;

    // A REAL operational return, so the separation tests have something to
    // confuse the archive with.
    const p = await request(srv()).post("/api/v1/purchase-invoices").set(auth()).send({ invoiceDate: "2026-02-01", supplierId, branchId: h.branchId, lines: [{ productVariantId: variantX, boardsQuantity: "20", unitPrice: "300", taxRate: "0" }] });
    await request(srv()).post(`/api/v1/purchase-invoices/${p.body.id}/confirm`).set(auth()).send({});
    const s = await request(srv()).post("/api/v1/sales-invoices").set(auth()).send({ invoiceDate: "2026-07-10", customerId: operationalCustomer, branchId: h.branchId, taxRate: "0", salesRepresentativeId: repId, lines: [{ productVariantId: variantX, quantity: "10", unitPrice: "500", costPrice: "0" }] });
    await request(srv()).post(`/api/v1/sales-invoices/${s.body.id}/confirm`).set(auth()).send({});
    const line = (await h.prisma.salesInvoiceLine.findFirst({ where: { invoiceId: s.body.id } }))!.id;
    const ret = await request(srv()).post("/api/v1/sales-returns").set(auth()).send({ originalSalesInvoiceId: s.body.id, returnDate: "2026-07-14", lines: [{ originalSalesInvoiceLineId: line, returnedMeters: "4", returnedBoards: "1" }] });
    await request(srv()).post(`/api/v1/sales-returns/${ret.body.id}/confirm`).set(auth()).send({});
    operationalReturnId = ret.body.id;
    operationalReturnNumber = String((await h.prisma.salesReturn.findUnique({ where: { id: operationalReturnId } }))!.returnNumber);

    batchId = (await h.prisma.historicalReturnImportBatch.create({
      data: {
        batchKey: `archive-read-${u}`,
        sourceSystem: "workbook تقرير المبيعات.xlsx",
        sourceFileHash: createHash("sha256").update("workbook").digest("hex"),
        sourceSheet: "المبيعات",
        expectedRows: 4,
        status: "COMPLETED",
        operator: "integration test",
        approver: "OTONOM — Business Owner",
        approvalDate: new Date("2026-08-02"),
        importerVersion: "1.0.0",
      },
    })).id;

    // Four paper rows spread over July 2026, two customers, two products, plus
    // one row that resolved to neither — the archive must still show it.
    await addArchive({ ref: "ARC-A", date: "2026-07-05", customerId: customerA, customerSourceReference: "عميل أ", grossValue: "1600.00",
      lines: [{ variantId: variantX, sourceCode: "HX-1", boards: "2.0000", meters: "8.0000", unitPrice: "200.00", lineValue: "1600.00" }] });
    await addArchive({ ref: "ARC-B", date: "2026-07-14", customerId: customerB, customerSourceReference: "عميل ب", grossValue: "3150.00",
      lines: [{ variantId: variantY, sourceCode: "HY-1", boards: "4.0000", meters: "21.0000", unitPrice: "150.00", lineValue: "3150.00" }] });
    await addArchive({ ref: "ARC-C", date: "2026-07-28", customerId: customerA, customerSourceReference: "عميل أ", grossValue: "2375.00",
      lines: [
        { variantId: variantX, sourceCode: "HX-1", boards: "1.0000", meters: "4.0000", unitPrice: "200.00", lineValue: "800.00" },
        { variantId: variantY, sourceCode: "HY-1", boards: "2.0000", meters: "10.5000", unitPrice: "150.00", lineValue: "1575.00" },
      ] });
    await addArchive({ ref: "ARC-D", date: "2026-07-20", customerId: null, customerSourceReference: "عميل نقدي كما ورد", grossValue: "900.00",
      lines: [{ variantId: null, sourceCode: "UNRESOLVED-9", boards: "3.0000", meters: "12.0000", unitPrice: null, lineValue: "900.00" }] });
  });
  afterAll(async () => teardownTestApp(h));

  it("the archive list carries archive rows only — never an operational return", async () => {
    const archiveRowIds = new Set(Object.values(archiveIds));
    const operationalIds = new Set((await h.prisma.salesReturn.findMany({ select: { id: true } })).map((r) => r.id));
    // Both ledgers are genuinely populated, so "no overlap" means something.
    expect(archiveRowIds.size).toBe(4);
    expect(operationalIds.size).toBeGreaterThan(0);

    const body = await listArchive("?limit=100");
    expect(body.items).toHaveLength(4);
    expect(body.totals.count).toBe(4);
    for (const item of body.items) {
      expect(archiveRowIds.has(item.id)).toBe(true);
      expect(operationalIds.has(item.id)).toBe(false);
      expect(item.immutable).toBe(true);
      expect(item.archiveNumber).toBeDefined();
      expect(item.status).toBeUndefined(); // an archive row has no lifecycle
      expect(item.returnNumber).toBeUndefined();
    }
    // Not one byte of the operational return leaks into the archive payload.
    expect(JSON.stringify(body)).not.toContain(operationalReturnId);
    expect(JSON.stringify(body)).not.toContain(operationalCustomer);
    // Newest paper first.
    expect(refs(body)).toEqual(["ARC-C", "ARC-D", "ARC-B", "ARC-A"]);
  });

  it("the operational returns list carries operational rows only — never an archive row", async () => {
    const archiveRowIds = new Set(Object.values(archiveIds));
    const operational = (await request(srv()).get("/api/v1/sales-returns?limit=100").set(auth())).body;
    const operationalIds = (await h.prisma.salesReturn.findMany({ select: { id: true } })).map((r) => r.id);

    expect(operational.items).toHaveLength(operationalIds.length);
    for (const item of operational.items) {
      expect(operationalIds).toContain(item.id);
      expect(archiveRowIds.has(item.id)).toBe(false);
      expect(item.status).toBeDefined(); // an operational return has a lifecycle
      expect(item.archiveNumber).toBeUndefined();
    }
    const payload = JSON.stringify(operational);
    for (const ref of ["ARC-A", "ARC-B", "ARC-C", "ARC-D"]) expect(payload).not.toContain(ref);
    for (const id of archiveRowIds) expect(payload).not.toContain(id);
    // The operational return is the one confirmed document, unchanged.
    expect(operational.items.some((i: { id: string }) => i.id === operationalReturnId)).toBe(true);
    expect(payload).toContain(operationalReturnNumber);
  });

  it("filters by document date, and the totals follow the filter", async () => {
    const body = await listArchive("?from=2026-07-10&to=2026-07-25&limit=100");
    expect(refs(body)).toEqual(["ARC-D", "ARC-B"]); // 07-20 then 07-14
    expect(body.totals).toEqual({ count: 2, grossValue: "4050.00", boards: "7.0000", canonicalMeters: "33.0000" });

    // The bounds are inclusive on both ends, and exclude what sits outside.
    expect(refs(await listArchive("?from=2026-07-28&limit=100"))).toEqual(["ARC-C"]);
    expect(refs(await listArchive("?to=2026-07-05&limit=100"))).toEqual(["ARC-A"]);
    const empty = await listArchive("?from=2026-08-01&to=2026-08-31&limit=100");
    expect(empty.items).toEqual([]);
    expect(empty.totals).toEqual({ count: 0, grossValue: "0.00", boards: "0.0000", canonicalMeters: "0.0000" });
  });

  it("filters by customer, including the row that resolved to no customer", async () => {
    const a = await listArchive(`?customerId=${customerA}&limit=100`);
    expect(refs(a)).toEqual(["ARC-C", "ARC-A"]);
    expect(a.totals.count).toBe(2);
    expect(a.totals.grossValue).toBe("3975.00");
    for (const item of a.items) expect(item.customer.id).toBe(customerA);

    const b = await listArchive(`?customerId=${customerB}&limit=100`);
    expect(refs(b)).toEqual(["ARC-B"]);

    // ARC-D never resolved to a master customer, so it belongs to neither
    // filter — but it is still visible unfiltered, under the paper's own name.
    expect(refs(a)).not.toContain("ARC-D");
    expect(refs(b)).not.toContain("ARC-D");
    const unresolved = (await listArchive("?q=نقدي&limit=100")).items;
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].sourceReference).toBe("ARC-D");
    expect(unresolved[0].customer).toBeNull();
    expect(unresolved[0].customerSourceReference).toBe("عميل نقدي كما ورد");
  });

  it("filters by product variant, matching a row through any of its lines", async () => {
    const x = await listArchive(`?productVariantId=${variantX}&limit=100`);
    expect(refs(x)).toEqual(["ARC-C", "ARC-A"]);

    // ARC-C carries product Y on its SECOND line only — filtering on Y must
    // still find it, and must not drag in the rows that never carried Y.
    const y = await listArchive(`?productVariantId=${variantY}&limit=100`);
    expect(refs(y)).toEqual(["ARC-C", "ARC-B"]);
    expect(refs(y)).not.toContain("ARC-A");
    expect(refs(y)).not.toContain("ARC-D");
    // Totals cover every line of the matched rows, exactly as each row's own
    // totals do: ARC-B 4 boards + ARC-C 1 + 2.
    expect(y.totals).toEqual({ count: 2, grossValue: "5525.00", boards: "7.0000", canonicalMeters: "35.5000" });

    // The unresolved line is findable by the code the paper carried.
    expect(refs(await listArchive("?q=UNRESOLVED-9&limit=100"))).toEqual(["ARC-D"]);
    // Combined filters intersect rather than widen.
    expect(refs(await listArchive(`?customerId=${customerA}&productVariantId=${variantY}&limit=100`))).toEqual(["ARC-C"]);
  });

  it("pages without shrinking the whole-set totals", async () => {
    const first = await listArchive("?limit=2");
    expect(refs(first)).toEqual(["ARC-C", "ARC-D"]);
    expect(first.nextCursor).toBe(archiveIds["ARC-D"]);
    expect(first.totals.count).toBe(4);

    const second = await listArchive(`?limit=2&cursor=${first.nextCursor}`);
    expect(refs(second)).toEqual(["ARC-B", "ARC-A"]);
    expect(second.nextCursor).toBeNull();
    expect(second.totals).toEqual(first.totals); // totals span the filter, not the page
  });

  it("the detail endpoint returns the provenance and the lines in order", async () => {
    const body = (await request(srv()).get(`/api/v1/historical-sales-returns/${archiveIds["ARC-C"]}`).set(auth())).body;
    expect(body.sourceReference).toBe("ARC-C");
    expect(body.immutable).toBe(true);
    expect(body.importBatchId).toBe(batchId);
    expect(body.sourceSheet).toBe("المبيعات");
    expect(body.sourceRow).toBeGreaterThan(0);
    expect(body.lineCount).toBe(2);
    expect(body.totalBoards).toBe("3.0000");
    expect(body.totalCanonicalMeters).toBe("14.5000");
    expect(body.lines.map((l: { lineNumber: number }) => l.lineNumber)).toEqual([1, 2]);
    expect(body.lines[1].productVariant.sizeMetersPerBoard).toBe("5.2500");
    expect(body.lines[1].lineValue).toBe("1575.00");

    // An unresolved line keeps what the paper said instead of going blank.
    const d = (await request(srv()).get(`/api/v1/historical-sales-returns/${archiveIds["ARC-D"]}`).set(auth())).body;
    expect(d.lines[0].productVariant).toBeNull();
    expect(d.lines[0].productSourceCode).toBe("UNRESOLVED-9");
    expect(d.lines[0].unitPrice).toBeNull();
  });

  it("an operational return id is not addressable as an archive row", async () => {
    const res = await request(srv()).get(`/api/v1/historical-sales-returns/${operationalReturnId}`).set(auth());
    expect(res.status).toBe(404);
    expect(res.body.error?.code ?? res.body.code).toBe("not_found");
    // …and the reverse: an archive id is not an operational return.
    expect((await request(srv()).get(`/api/v1/sales-returns/${archiveIds["ARC-A"]}`).set(auth())).status).toBe(404);
  });
});
