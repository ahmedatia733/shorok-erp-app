/**
 * Sales-representative + sales reporting API. Synthetic local data only.
 * Proves the source-of-truth rules: CONFIRMED only (draft/cancelled excluded),
 * per-rep + per-branch isolation, PERSISTED metersQuantity, HISTORICAL COGS
 * (unit_cost_at_posting, not the mutable current avg_cost), correct gross
 * profit, day/month/quarter/year grouping, and totals == detail reconciliation.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

const D = (v: unknown) => new Decimal((v as { toString(): string }).toString());

describe("sales-rep reports", () => {
  let handle: TestApp;
  let token: string, viewerToken: string;
  let waraq: string, sohag: string, repA: string, repB: string, customerId: string;
  let vSmall: string, vLarge: string; // size 4.00 (avg 400), size 5.25 (avg 525)
  let ar: string, rev: string, vatOut: string, cogs: string, invAcc: string;

  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });
  const server = () => handle.app.getHttpServer();

  const seedStock = async (variantId: string, branchId: string, boards: string, size: string) =>
    handle.prisma.branchInventoryBalance.create({
      data: { branchId, productVariantId: variantId, boardsOnHand: boards, metersOnHand: new Decimal(boards).mul(size).toFixed(4) },
    });

  // Create a sale, optionally confirm it, on a given rep/branch/date with dims.
  const sale = async (opts: {
    repId?: string; branchId: string; date: string; confirm?: boolean;
    variantId: string; boards: string; price: string; discountPct?: string;
    lengthM?: string; widthM?: string;
  }) => {
    const body: any = {
      invoiceDate: opts.date, customerId, branchId: opts.branchId, taxRate: "0",
      salesRepresentativeId: opts.repId ?? null,
      lines: [{ productVariantId: opts.variantId, quantity: opts.boards, unitPrice: opts.price, costPrice: "0", discountPct: opts.discountPct ?? "0", ...(opts.lengthM ? { lengthM: opts.lengthM } : {}), ...(opts.widthM ? { widthM: opts.widthM } : {}) }],
    };
    const d = await request(server()).post("/api/v1/sales-invoices").set(auth()).send(body);
    expect(d.status).toBeLessThan(300);
    if (opts.confirm) {
      const c = await request(server()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(auth()).send({});
      expect(c.status).toBeLessThan(300);
    }
    return d.body;
  };

  const summary = (qs: string, t = token) => request(server()).get(`/api/v1/reports/sales-representatives/summary?${qs}`).set(auth(t));

  beforeAll(async () => {
    handle = await buildTestApp();
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    const viewer = await handle.prisma.user.create({ data: { name: "V", phone: "+201507070707", passwordHash: await bcrypt.hash("Pwd@2026!", 10), role: "VIEWER", status: "ACTIVE" } });
    void viewer;
    viewerToken = (await request(server()).post("/api/v1/auth/login").send({ phone: "+201507070707", password: "Pwd@2026!" })).body.accessToken;

    waraq = handle.branchId;
    sohag = (await handle.prisma.branch.create({ data: { nameAr: "فرع سوهاج", nameEn: "Sohag", active: true } })).id;
    repA = (await handle.prisma.salesRepresentative.create({ data: { code: "R-A", nameAr: "مندوب أ" } })).id;
    repB = (await handle.prisma.salesRepresentative.create({ data: { code: "R-B", nameAr: "مندوب ب" } })).id;
    customerId = (await handle.prisma.customer.create({ data: { code: "RC-1", nameAr: "عميل التقارير" } })).id;

    const u = Date.now().toString().slice(-6);
    const mk = (c: string, n: string, cat: any, t: any, role?: string) =>
      handle.prisma.account.create({ data: { code: c, nameAr: n, nameEn: n, category: cat, accountType: t, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } });
    ar = (await mk(`AR${u}`, "عملاء", "ASSET", "CURRENT_ASSET", "AR_CONTROL")).id;
    rev = (await mk(`RV${u}`, "مبيعات", "REVENUE", "REVENUE")).id;
    vatOut = (await mk(`VO${u}`, "ض", "LIABILITY", "LIABILITY")).id;
    cogs = (await mk(`CG${u}`, "تكلفة", "COST_OF_SALES", "COST_OF_SALES")).id;
    invAcc = (await mk(`IN${u}`, "مخزون", "ASSET", "CURRENT_ASSET")).id;
    await handle.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId: ar, revenueAccountId: rev, vatOutputAccountId: vatOut, cogsAccountId: cogs, inventoryAccountId: invAcc, createdBy: handle.ownerId } });
    // All 12 months OPEN — the cancel's reversal posts to TODAY's period.
    for (let m = 1; m <= 12; m++) await handle.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });

    const skuS = await handle.prisma.productSku.create({ data: { code: "SKU-SMALL", category: "NORMAL", colorNameAr: "صغير", colorNameEn: "s" } });
    const skuL = await handle.prisma.productSku.create({ data: { code: "SKU-LARGE", category: "NORMAL", colorNameAr: "كبير", colorNameEn: "l" } });
    // Canonical cost is PER METER (100/m); legacy per-board kept for compat.
    vSmall = (await handle.prisma.productVariant.create({ data: { skuId: skuS.id, sizeMetersPerBoard: "4.0000", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "400", avgCostPerMeter: "100" } })).id;
    vLarge = (await handle.prisma.productVariant.create({ data: { skuId: skuL.id, sizeMetersPerBoard: "5.2500", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "525", avgCostPerMeter: "100" } })).id;

    // Plenty of stock in both branches.
    await seedStock(vSmall, waraq, "200", "4.0000");
    await seedStock(vLarge, waraq, "200", "5.2500");
    await seedStock(vSmall, sohag, "200", "4.0000");

    // ── Scenario ──────────────────────────────────────────────────────────
    // Rep A, Waraq, small(4m): 2 boards @500, صغير. net 8×500=4000, COGS 2×400=800, GP 3200.
    await sale({ repId: repA, branchId: waraq, date: "2026-03-05", confirm: true, variantId: vSmall, boards: "2", price: "500", lengthM: "4" });
    // Rep A, Waraq, large(5.25): 4 boards @600. net 21×600=12600, COGS 4×525=2100, GP 10500.
    await sale({ repId: repA, branchId: waraq, date: "2026-03-20", confirm: true, variantId: vLarge, boards: "4", price: "600", lengthM: "5.25" });
    // Rep A, Waraq, custom 2×1.5=3.0: 2 boards @1000, 10% disc. meters 6, gross 6000, disc 600, net 5400, COGS 2×400=800, GP 4600.
    await sale({ repId: repA, branchId: waraq, date: "2026-04-10", confirm: true, variantId: vSmall, boards: "2", price: "1000", discountPct: "10", lengthM: "2", widthM: "1.5" });
    // Rep B, Sohag, small: 3 boards @500. meters 12, net 6000, COGS 3×400=1200, GP 4800.
    await sale({ repId: repB, branchId: sohag, date: "2026-03-15", confirm: true, variantId: vSmall, boards: "3", price: "500", lengthM: "4" });
    // NOISE (must be excluded): a DRAFT (rep A) and a CANCELLED (rep A).
    await sale({ repId: repA, branchId: waraq, date: "2026-03-25", confirm: false, variantId: vSmall, boards: "9", price: "999", lengthM: "4" }); // draft
    const toCancel = await sale({ repId: repA, branchId: waraq, date: "2026-03-26", confirm: true, variantId: vSmall, boards: "7", price: "888", lengthM: "4" });
    const cancelRes = await request(server()).post(`/api/v1/sales-invoices/${toCancel.id}/cancel`).set(auth()).send({});
    expect(cancelRes.status).toBeLessThan(300);

    // Historical-COGS trap: bump the CURRENT avg_cost AFTER posting. Reports must
    // still use the posting snapshot (400/525), never 9999.
    await handle.prisma.productVariant.update({ where: { id: vSmall }, data: { avgCost: "9999" } });
    await handle.prisma.productVariant.update({ where: { id: vLarge }, data: { avgCost: "9999" } });
  });
  afterAll(async () => teardownTestApp(handle));

  it("summary: per-rep totals exclude draft+cancelled, use historical COGS, isolate reps", async () => {
    const res = await summary("preset=custom&from=2026-01-01&to=2026-12-31");
    expect(res.status).toBe(200);
    const byId: Record<string, any> = Object.fromEntries(res.body.representatives.map((r: any) => [r.salesRepresentativeId, r]));
    const A = byId[repA], B = byId[repB];
    // Rep A = 3 confirmed invoices (draft + cancelled excluded).
    expect(A.invoiceCount).toBe(3);
    expect(D(A.boards).toFixed(0)).toBe("8");                 // 2+4+2
    expect(D(A.metersSold).toFixed(2)).toBe("35.00");         // 8 + 21 + 6
    expect(D(A.netSales).toFixed(2)).toBe("22000.00");        // 4000 + 12600 + 5400
    expect(D(A.discounts).toFixed(2)).toBe("600.00");
    expect(D(A.cogs).toFixed(2)).toBe("3500.00");             // 8×100 + 21×100 + 6×100 (meter-based; NOT 9999)
    expect(D(A.grossProfit).toFixed(2)).toBe("18500.00");     // 22000 - 3500
    // Rep B isolated.
    expect(B.invoiceCount).toBe(1);
    expect(D(B.netSales).toFixed(2)).toBe("6000.00");
    expect(D(B.grossProfit).toFixed(2)).toBe("4800.00");
  });

  it("branch filter isolates branches", async () => {
    const sohagOnly = await summary(`preset=custom&from=2026-01-01&to=2026-12-31&branchId=${sohag}`);
    const reps = sohagOnly.body.representatives;
    expect(reps).toHaveLength(1);
    expect(reps[0].salesRepresentativeId).toBe(repB);
    expect(D(reps[0].netSales).toFixed(2)).toBe("6000.00");
    // Waraq only → rep A only.
    const waraqOnly = await summary(`preset=custom&from=2026-01-01&to=2026-12-31&branchId=${waraq}`);
    expect(waraqOnly.body.representatives.every((r: any) => r.salesRepresentativeId === repA)).toBe(true);
  });

  it("statement: cards == detail totals; only confirmed invoices listed", async () => {
    const res = await request(server()).get(`/api/v1/reports/sales-representatives/${repA}/statement?preset=custom&from=2026-01-01&to=2026-12-31`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.totalInvoices).toBe(3);
    expect(res.body.invoices.every((i: any) => i.status === "CONFIRMED")).toBe(true);
    const sumNet = res.body.invoices.reduce((a: Decimal, i: any) => a.plus(i.netInvoice), new Decimal(0));
    const sumGp = res.body.invoices.reduce((a: Decimal, i: any) => a.plus(i.grossProfit), new Decimal(0));
    expect(sumNet.toFixed(2)).toBe(res.body.summary.netSales);        // detail == card
    expect(sumGp.toFixed(2)).toBe(res.body.summary.grossProfit);
  });

  it("products: rep×product rows sum back to the rep summary (drill-down reconciles)", async () => {
    const res = await request(server()).get(`/api/v1/reports/sales-representatives/products?preset=custom&from=2026-01-01&to=2026-12-31&salesRepresentativeId=${repA}`).set(auth());
    expect(res.status).toBe(200);
    const rows = res.body.rows;
    expect(rows.map((r: any) => r.productCode).sort()).toEqual(["SKU-LARGE", "SKU-SMALL"]);
    const net = rows.reduce((a: Decimal, r: any) => a.plus(r.netSales), new Decimal(0));
    const gp = rows.reduce((a: Decimal, r: any) => a.plus(r.grossProfit), new Decimal(0));
    expect(net.toFixed(2)).toBe("22000.00");
    expect(gp.toFixed(2)).toBe("18500.00");
    const small = rows.find((r: any) => r.productCode === "SKU-SMALL");
    expect(small.productName).toBe("صغير");
  });

  it("time-series: month + quarter + year reconcile to the same totals", async () => {
    const q = "preset=custom&from=2026-01-01&to=2026-12-31";
    const ts = async (g: string) => (await request(server()).get(`/api/v1/reports/sales/time-series?${q}&groupBy=${g}`).set(auth())).body;
    const month = await ts("month"), quarter = await ts("quarter"), year = await ts("year");
    // All confirmed sales net = 22000 (A) + 6000 (B) = 28000; GP 18300 + 4800 = 23100.
    for (const r of [month, quarter, year]) {
      expect(D(r.totals.netSales).toFixed(2)).toBe("28000.00");
      expect(D(r.totals.grossProfit).toFixed(2)).toBe("23300.00");
    }
    expect(month.series.map((s: any) => s.period)).toEqual(["2026-03", "2026-04"]);
    expect(quarter.series.map((s: any) => s.period)).toEqual(["2026-Q1", "2026-Q2"]);
    expect(year.series.map((s: any) => s.period)).toEqual(["2026"]);
    // 2026-Q1 net = 4000+12600 (A) + 6000 (B) = 22600.
    expect(D(quarter.series.find((s: any) => s.period === "2026-Q1").netSales).toFixed(2)).toBe("22600.00");
  });

  it("date range narrows results (April only)", async () => {
    const apr = await summary("preset=custom&from=2026-04-01&to=2026-04-30");
    const reps = apr.body.representatives;
    expect(reps).toHaveLength(1);
    expect(reps[0].salesRepresentativeId).toBe(repA);
    expect(D(reps[0].netSales).toFixed(2)).toBe("5400.00"); // only the custom-dim April sale
    expect(D(reps[0].metersSold).toFixed(2)).toBe("6.00");   // persisted custom meters
  });

  it("rejects a non-authorized role (VIEWER → 403)", async () => {
    const res = await summary("preset=this_month", viewerToken);
    expect(res.status).toBe(403);
  });

  it("§6 invoice-line details: sizeMode + historical values + canonical route", async () => {
    const st = await request(server()).get(`/api/v1/reports/sales-representatives/${repA}/statement?preset=custom&from=2026-04-01&to=2026-04-30`).set(auth());
    const inv = st.body.invoices[0]; // the April custom-dim sale
    const res = await request(server()).get(`/api/v1/reports/sales-representatives/${repA}/statement/invoices/${inv.id}/lines?preset=custom&from=2026-04-01&to=2026-04-30`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.invoiceWebRoute).toContain(inv.id); // opens the canonical sales invoice
    const l = res.body.lines[0];
    expect(l.sizeMode).toBe("CUSTOM");
    expect(l.lengthM).toBe("2.0000"); expect(l.widthM).toBe("1.5000");
    expect(l.metersQuantity).toBe("6.0000");           // persisted
    expect(D(l.lineNet).toFixed(2)).toBe("5400.00");
    expect(D(l.lineGrossProfit).toFixed(2)).toBe("4800.00"); // 5400 - 600 (6 m × 100/m)
  });

  it("§7 products drill-down: contributing lines reconcile to the aggregate", async () => {
    const filter = `preset=custom&from=2026-01-01&to=2026-12-31&salesRepresentativeId=${repA}&productCode=SKU-SMALL`;
    const agg = (await request(server()).get(`/api/v1/reports/sales-representatives/products?${filter}`).set(auth())).body.rows[0];
    const drill = (await request(server()).get(`/api/v1/reports/sales-representatives/products/drill-down?${filter}`).set(auth())).body;
    const net = drill.lines.reduce((a: Decimal, r: any) => a.plus(r.lineNet), new Decimal(0));
    expect(net.toFixed(2)).toBe(agg.netSales);
    expect(drill.lines.every((r: any) => r.invoiceWebRoute.includes(r.invoiceId))).toBe(true);
  });

  it("§8 profitability grouped by branch reconciles to the branch net sales", async () => {
    const res = await request(server()).get(`/api/v1/reports/sales/profitability?preset=custom&from=2026-01-01&to=2026-12-31&groupDim=branch`).set(auth());
    expect(res.status).toBe(200);
    const total = res.body.groups.reduce((a: Decimal, g: any) => a.plus(g.netSales), new Decimal(0));
    expect(total.toFixed(2)).toBe("28000.00"); // 22000 (Waraq/A) + 6000 (Sohag/B)
  });

  it("§9/§10 income statement (posted only) + net profit reconcile; cancelled excluded", async () => {
    const q = "from=2026-01-01&to=2026-12-31";
    const is = (await request(server()).get(`/api/v1/reports/income-statement?${q}`).set(auth())).body;
    // Revenue = Σ confirmed subtotal (28000); COGS = historical (4900); cancelled reversed → excluded.
    expect(D(is.revenue).toFixed(2)).toBe("28000.00");
    expect(D(is.costOfSales).toFixed(2)).toBe("4700.00");
    expect(D(is.grossProfit).toFixed(2)).toBe("23300.00");
    const np = (await request(server()).get(`/api/v1/reports/financial/net-profit?${q}`).set(auth())).body;
    expect(np.netRevenue).toBe(is.revenue);
    expect(np.costOfSales).toBe(is.costOfSales);
    expect(np.grossProfit).toBe(is.grossProfit);
    expect(np.netProfit).toBe(is.netProfit); // reconciles exactly
  });
});
