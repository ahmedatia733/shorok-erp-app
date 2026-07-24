/**
 * Reporting reconciliation across period boundaries (§5). Date policy: SALES use
 * invoiceDate; RETURNS use returnDate. A March sale + an April confirmed return
 * must land in the right period; draft/cancelled returns never affect reports;
 * the products drill-down carries SALE and SALES_RETURN detail rows that
 * reconcile to the netted aggregate.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("returns reporting periods (§5)", () => {
  let h: TestApp;
  let token: string;
  let repId: string, customerId: string, supplierId: string;
  const acc: Record<string, string> = {};
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const srv = () => h.app.getHttpServer();

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(srv()).post("/api/v1/auth/login").send({ phone: h.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    repId = (await h.prisma.salesRepresentative.create({ data: { code: "TR", nameAr: "م" } })).id;
    customerId = (await h.prisma.customer.create({ data: { code: "TC", nameAr: "ع" } })).id;
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
  });
  afterAll(async () => teardownTestApp(h));

  let seq = 0;
  const setup = async () => {
    const sku = await h.prisma.productSku.create({ data: { code: `TP-${++seq}`, category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
    const v = (await h.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: "4.0000", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" } })).id;
    const p = await request(srv()).post("/api/v1/purchase-invoices").set(auth()).send({ invoiceDate: "2026-02-01", supplierId, branchId: h.branchId, lines: [{ productVariantId: v, boardsQuantity: "10", unitPrice: "300", taxRate: "0" }] });
    await request(srv()).post(`/api/v1/purchase-invoices/${p.body.id}/confirm`).set(auth()).send({});
    return v;
  };
  const sellOn = async (v: string, date: string, boards = "5", price = "500") => {
    const d = await request(srv()).post("/api/v1/sales-invoices").set(auth()).send({ invoiceDate: date, customerId, branchId: h.branchId, taxRate: "0", salesRepresentativeId: repId, lines: [{ productVariantId: v, quantity: boards, unitPrice: price, costPrice: "0" }] });
    await request(srv()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(auth()).send({});
    return d.body.id as string;
  };
  const returnOn = async (invoiceId: string, date: string, meters: string, boards: string, confirm = true) => {
    const line = (await h.prisma.salesInvoiceLine.findFirst({ where: { invoiceId } }))!.id;
    const r = await request(srv()).post("/api/v1/sales-returns").set(auth()).send({ originalSalesInvoiceId: invoiceId, returnDate: date, lines: [{ originalSalesInvoiceLineId: line, returnedMeters: meters, returnedBoards: boards }] });
    if (confirm) await request(srv()).post(`/api/v1/sales-returns/${r.body.id}/confirm`).set(auth()).send({});
    return r.body.id as string;
  };
  const summary = async (v: string, from: string, to: string) =>
    (await request(srv()).get(`/api/v1/reports/sales-representatives/summary?preset=custom&from=${from}&to=${to}&productVariantId=${v}`).set(auth())).body.representatives[0] ?? { netSales: "0.00", returns: "0.00" };

  it("March sale + April return: return lands in April (returnDate), not March", async () => {
    const v = await setup();
    const inv = await sellOn(v, "2026-03-10");  // net 10000 in March
    await returnOn(inv, "2026-04-05", "4", "1"); // return 2000 in April (returnDate)
    const march = await summary(v, "2026-03-01", "2026-03-31");
    expect(march.netSales).toBe("10000.00"); // sale only; April return not yet
    expect(march.returns).toBe("0.00");
    const april = await summary(v, "2026-04-01", "2026-04-30");
    expect(april.returns).toBe("2000.00");    // return attributed to April
    const combined = await summary(v, "2026-03-01", "2026-04-30");
    expect(combined.netSales).toBe("8000.00"); // 10000 − 2000
    expect(combined.returns).toBe("2000.00");
  });

  it("draft and cancelled returns have zero reporting effect", async () => {
    const v = await setup();
    const inv = await sellOn(v, "2026-05-10");
    await returnOn(inv, "2026-05-15", "4", "1", false); // DRAFT
    let s = await summary(v, "2026-05-01", "2026-05-31");
    expect(s.netSales).toBe("10000.00");
    const rid = await returnOn(inv, "2026-05-20", "4", "1", true); // CONFIRMED then cancel
    await request(srv()).post(`/api/v1/sales-returns/${rid}/cancel`).set(auth()).send({});
    s = await summary(v, "2026-05-01", "2026-05-31");
    expect(s.netSales).toBe("10000.00"); // cancelled excluded
    expect(s.returns).toBe("0.00");
  });

  it("products drill-down carries SALE + SALES_RETURN rows that reconcile to the netted totals", async () => {
    const v = await setup();
    const inv = await sellOn(v, "2026-06-10");
    await returnOn(inv, "2026-06-12", "4", "1");
    const dd = (await request(srv()).get(`/api/v1/reports/sales-representatives/products/drill-down?preset=custom&from=2026-06-01&to=2026-06-30&productVariantId=${v}`).set(auth())).body;
    expect(dd.salesReturnsSupported).toBe(true);
    const kinds = dd.lines.map((l: any) => l.kind).sort();
    expect(kinds).toEqual(["SALES_RETURN", "SALE"].sort());
    // The netted totals equal Σ SALE − Σ RETURN = 10000 − 2000 = 8000; COGS 6000 − 1200 = 4800.
    expect(dd.totals.netSales).toBe("8000.00");
    expect(dd.totals.netCogs).toBe("4800.00");
    expect(dd.totals.netGrossProfit).toBe("3200.00");
    // Sum of the rows reconciles to the totals.
    const rowNet = dd.lines.reduce((a: Decimal, l: any) => a.plus(l.lineNet), new Decimal(0));
    expect(rowNet.toFixed(2)).toBe(dd.totals.netSales);
  });

  it("income statement exposes branchAttributionComplete:false (all-branches, honest)", async () => {
    const is = (await request(srv()).get(`/api/v1/reports/income-statement?from=2026-01-01&to=2026-12-31`).set(auth())).body;
    expect(is.branchAttributionComplete).toBe(false);
  });
});
