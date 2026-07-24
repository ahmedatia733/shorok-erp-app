/**
 * Server-side branch scope for returns, invoice search and reports (§3). A
 * non-OWNER only ever accesses branches in their allowedBranches; a foreign
 * branch resource is reported as NOT FOUND (no existence leak); list/search/
 * reports exclude unauthorized branches in SQL; OWNER is unrestricted.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("returns branch security (§3)", () => {
  let h: TestApp;
  let owner: string, userA: string, userB: string;
  let branchA: string, branchB: string;
  let repId: string, customerId: string, supplierId: string;
  const acc: Record<string, string> = {};
  const A = (t: string) => ({ Authorization: `Bearer ${t}` });
  const srv = () => h.app.getHttpServer();
  const login = async (phone: string) => (await request(srv()).post("/api/v1/auth/login").send({ phone, password: "Pwd@2026!" })).body.accessToken as string;

  // A confirmed sale + confirmed return, and a confirmed purchase + purchase
  // return, all in branch A.
  let invA: string, retA: string, pInvA: string, pRetA: string;

  beforeAll(async () => {
    h = await buildTestApp();
    branchA = h.branchId;
    branchB = (await h.prisma.branch.create({ data: { nameAr: "ب", nameEn: "B", active: true } })).id;
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    owner = await login(h.ownerPhone);
    const mkUser = async (phone: string, branches: string[]) => {
      const u = await h.prisma.user.create({ data: { name: phone, phone, passwordHash: await bcrypt.hash("Pwd@2026!", 10), role: "ACCOUNTANT", status: "ACTIVE" } });
      for (const b of branches) await h.prisma.userBranchAccess.create({ data: { userId: u.id, branchId: b } });
      return login(phone);
    };
    userA = await mkUser("+201110000001", [branchA]);
    userB = await mkUser("+201110000002", [branchB]);
    repId = (await h.prisma.salesRepresentative.create({ data: { code: "BR", nameAr: "م" } })).id;
    customerId = (await h.prisma.customer.create({ data: { code: "BC", nameAr: "ع" } })).id;
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "S" } })).id;
    const u = Date.now().toString().slice(-6);
    const mk = async (k: string, code: string, cat: any, t: any, role?: string) => {
      acc[k] = (await h.prisma.account.create({ data: { code: `${code}${u}`, nameAr: code, nameEn: code, category: cat, accountType: t, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } })).id;
    };
    await mk("ar", "AR", "ASSET", "CURRENT_ASSET", "AR_CONTROL"); await mk("ap", "AP", "LIABILITY", "LIABILITY", "AP_CONTROL");
    await mk("rev", "RV", "REVENUE", "REVENUE"); await mk("sret", "SR", "REVENUE", "REVENUE");
    await mk("vatO", "VO", "LIABILITY", "LIABILITY"); await mk("cogs", "CG", "COST_OF_SALES", "COST_OF_SALES"); await mk("inv", "IN", "ASSET", "CURRENT_ASSET");
    await h.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId: acc.ar, apAccountId: acc.ap, revenueAccountId: acc.rev, salesReturnsAccountId: acc.sret, vatOutputAccountId: acc.vatO, cogsAccountId: acc.cogs, inventoryAccountId: acc.inv, createdBy: h.ownerId } });
    for (let m = 1; m <= 12; m++) await h.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });

    // Seed a confirmed sale + return in BRANCH A (as owner).
    const sku = await h.prisma.productSku.create({ data: { code: "BS-1", category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
    const v = (await h.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: "4.0000", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" } })).id;
    const p = await request(srv()).post("/api/v1/purchase-invoices").set(A(owner)).send({ invoiceDate: "2026-02-01", supplierId, branchId: branchA, lines: [{ productVariantId: v, boardsQuantity: "10", unitPrice: "300", taxRate: "0" }] });
    await request(srv()).post(`/api/v1/purchase-invoices/${p.body.id}/confirm`).set(A(owner)).send({});
    pInvA = p.body.id;
    const s = await request(srv()).post("/api/v1/sales-invoices").set(A(owner)).send({ invoiceDate: "2026-03-01", customerId, branchId: branchA, taxRate: "0", salesRepresentativeId: repId, lines: [{ productVariantId: v, quantity: "5", unitPrice: "500", costPrice: "0" }] });
    await request(srv()).post(`/api/v1/sales-invoices/${s.body.id}/confirm`).set(A(owner)).send({});
    invA = s.body.id;
    const lineId = (await h.prisma.salesInvoiceLine.findFirst({ where: { invoiceId: invA } }))!.id;
    const r = await request(srv()).post("/api/v1/sales-returns").set(A(owner)).send({ originalSalesInvoiceId: invA, returnDate: "2026-03-15", lines: [{ originalSalesInvoiceLineId: lineId, returnedMeters: "4", returnedBoards: "1" }] });
    await request(srv()).post(`/api/v1/sales-returns/${r.body.id}/confirm`).set(A(owner)).send({});
    retA = r.body.id;
    // A confirmed PURCHASE return in branch A (20 m² left in stock after the sale).
    const pl = (await h.prisma.purchaseInvoiceLine.findFirst({ where: { invoiceId: pInvA } }))!.id;
    const pr = await request(srv()).post("/api/v1/purchase-returns").set(A(owner)).send({ originalPurchaseInvoiceId: pInvA, returnDate: "2026-03-20", lines: [{ originalPurchaseInvoiceLineId: pl, returnedMeters: "4", returnedBoards: "1" }] });
    await request(srv()).post(`/api/v1/purchase-returns/${pr.body.id}/confirm`).set(A(owner)).send({});
    pRetA = pr.body.id;
  });
  afterAll(async () => teardownTestApp(h));

  it("userB (branch B) gets 404 for a branch-A return and its returnable — no existence leak", async () => {
    expect((await request(srv()).get(`/api/v1/sales-returns/${retA}`).set(A(userB))).status).toBe(404);
    expect((await request(srv()).get(`/api/v1/sales-returns/returnable/${invA}`).set(A(userB))).status).toBe(404);
    // A non-existent UUID returns the SAME 404 → forbidden vs not-found are indistinguishable.
    const fake = "00000000-0000-0000-0000-000000000000";
    expect((await request(srv()).get(`/api/v1/sales-returns/${fake}`).set(A(userB))).status).toBe(404);
    expect((await request(srv()).get(`/api/v1/sales-returns/returnable/${fake}`).set(A(userB))).status).toBe(404);
    // userA (branch A) CAN access it.
    expect((await request(srv()).get(`/api/v1/sales-returns/${retA}`).set(A(userA))).status).toBe(200);
  });

  it("userB cannot create a return against a branch-A invoice (404)", async () => {
    const lineId = (await h.prisma.salesInvoiceLine.findFirst({ where: { invoiceId: invA } }))!.id;
    const res = await request(srv()).post("/api/v1/sales-returns").set(A(userB)).send({ originalSalesInvoiceId: invA, returnDate: "2026-03-16", lines: [{ originalSalesInvoiceLineId: lineId, returnedMeters: "4", returnedBoards: "1" }] });
    expect(res.status).toBe(404);
  });

  it("returns list is SQL-scoped: userB sees none of branch A's returns; userA and owner do", async () => {
    expect((await request(srv()).get(`/api/v1/sales-returns`).set(A(userB))).body.items.length).toBe(0);
    expect((await request(srv()).get(`/api/v1/sales-returns`).set(A(userA))).body.items.some((r: any) => r.id === retA)).toBe(true);
    expect((await request(srv()).get(`/api/v1/sales-returns`).set(A(owner))).body.items.some((r: any) => r.id === retA)).toBe(true);
    // An explicit foreign branchId is 403'd by the global guard.
    expect((await request(srv()).get(`/api/v1/sales-returns?branchId=${branchA}`).set(A(userB))).status).toBe(403);
  });

  it("invoice search is SQL-scoped: userB cannot find a branch-A invoice by number", async () => {
    const invNo = (await h.prisma.salesInvoice.findUnique({ where: { id: invA } }))!.invoiceNumber.toString();
    const asB = (await request(srv()).get(`/api/v1/sales-invoices?status=CONFIRMED&q=${invNo}`).set(A(userB))).body;
    expect(asB.data.some((i: any) => i.id === invA)).toBe(false);
    const asA = (await request(srv()).get(`/api/v1/sales-invoices?status=CONFIRMED&q=${invNo}`).set(A(userA))).body;
    expect(asA.data.some((i: any) => i.id === invA)).toBe(true);
  });

  it("reports are SQL-scoped: userB's summary excludes branch A; userA and owner include it", async () => {
    const q = "preset=custom&from=2026-01-01&to=2026-12-31";
    const bTot = (await request(srv()).get(`/api/v1/reports/sales-representatives/summary?${q}`).set(A(userB))).body.totals;
    expect(bTot.netSales).toBe("0.00"); // branch B has no sales
    const aTot = (await request(srv()).get(`/api/v1/reports/sales-representatives/summary?${q}`).set(A(userA))).body.totals;
    expect(Number(aTot.netSales)).toBeGreaterThan(0); // branch A sale net of return
    const oTot = (await request(srv()).get(`/api/v1/reports/sales-representatives/summary?${q}`).set(A(owner))).body.totals;
    expect(oTot.netSales).toBe(aTot.netSales); // owner sees the same (only branch A has data)
    // Explicit foreign branchId → 403 (global guard).
    expect((await request(srv()).get(`/api/v1/reports/sales-representatives/summary?${q}&branchId=${branchA}`).set(A(userB))).status).toBe(403);
  });

  // ── §7 — parameterized branch visibility across EVERY report/list/search
  //         endpoint. Focus: visibility only (not business maths). ────────────
  describe("§7 branch visibility across all endpoints", () => {
    const q = "preset=custom&from=2026-01-01&to=2026-12-31";
    // Each: path + a predicate that is TRUE when the response contains branch-A data.
    const cases = () => [
      { name: "summary", path: `/reports/sales-representatives/summary?${q}`, hasA: (b: any) => Number(b.totals?.netSales ?? 0) !== 0 },
      { name: "net-sales", path: `/reports/sales-representatives/net-sales?${q}`, hasA: (b: any) => Number(b.totals?.netSales ?? 0) !== 0 },
      { name: "gross-profit", path: `/reports/sales-representatives/gross-profit?${q}`, hasA: (b: any) => Number(b.totals?.netSales ?? 0) !== 0 },
      { name: "products", path: `/reports/sales-representatives/products?${q}`, hasA: (b: any) => (b.rows ?? []).length > 0 },
      { name: "products/drill-down", path: `/reports/sales-representatives/products/drill-down?${q}`, hasA: (b: any) => (b.lines ?? []).length > 0 },
      { name: "time-series", path: `/reports/sales/time-series?${q}&groupDim=month`, hasA: (b: any) => (b.series ?? []).length > 0 },
      { name: "profitability", path: `/reports/sales/profitability?${q}&groupDim=representative`, hasA: (b: any) => (b.groups ?? []).length > 0 },
      { name: "statement", path: `/reports/sales-representatives/${repId}/statement?${q}`, hasA: (b: any) => (b.invoices ?? []).length > 0 },
      { name: "statement invoice-lines", path: `/reports/sales-representatives/${repId}/statement/invoices/${invA}/lines?${q}`, hasA: (b: any) => (b.lines ?? []).length > 0 },
      { name: "sales invoice search", path: `/sales-invoices?status=CONFIRMED`, hasA: (b: any) => (b.data ?? []).some((i: any) => i.id === invA) },
      { name: "purchase invoice search", path: `/purchase-invoices?status=CONFIRMED`, hasA: (b: any) => (b.data ?? []).some((i: any) => i.id === pInvA) },
      { name: "sales return list", path: `/sales-returns`, hasA: (b: any) => (b.items ?? []).some((r: any) => r.id === retA) },
      { name: "purchase return list", path: `/purchase-returns`, hasA: (b: any) => (b.items ?? []).some((r: any) => r.id === pRetA) },
    ];

    it("list/report/search endpoints EXCLUDE branch A for userB and INCLUDE it for userA + owner", async () => {
      for (const c of cases()) {
        const b = (await request(srv()).get(`/api/v1${c.path}`).set(A(userB))).body;
        const a = (await request(srv()).get(`/api/v1${c.path}`).set(A(userA))).body;
        const o = (await request(srv()).get(`/api/v1${c.path}`).set(A(owner))).body;
        expect({ ep: c.name, userB: c.hasA(b) }).toEqual({ ep: c.name, userB: false });
        expect({ ep: c.name, userA: c.hasA(a) }).toEqual({ ep: c.name, userA: true });
        expect({ ep: c.name, owner: c.hasA(o) }).toEqual({ ep: c.name, owner: true });
      }
    });

    it("direct foreign RESOURCE by id → 404 (sales+purchase return get/returnable); OWNER 200", async () => {
      const forbidden = [
        `/sales-returns/${retA}`, `/sales-returns/returnable/${invA}`,
        `/purchase-returns/${pRetA}`, `/purchase-returns/returnable/${pInvA}`,
      ];
      for (const p of forbidden) {
        expect((await request(srv()).get(`/api/v1${p}`).set(A(userB))).status).toBe(404);
        expect((await request(srv()).get(`/api/v1${p}`).set(A(owner))).status).toBe(200);
      }
    });

    it("explicit foreign branchId → 403 across reports, search and return lists", async () => {
      const withBranch = [
        `/reports/sales-representatives/summary?${q}&branchId=${branchA}`,
        `/reports/sales/time-series?${q}&groupDim=month&branchId=${branchA}`,
        `/sales-invoices?status=CONFIRMED&branchId=${branchA}`,
        `/purchase-invoices?status=CONFIRMED&branchId=${branchA}`,
        `/sales-returns?branchId=${branchA}`,
        `/purchase-returns?branchId=${branchA}`,
      ];
      for (const p of withBranch) {
        expect((await request(srv()).get(`/api/v1${p}`).set(A(userB))).status).toBe(403);
      }
    });
  });
});
