/**
 * WAC edge cases + costing-lock parity (final-verification §2). Proves the
 * company-wide per-metre WAC stays consistent across purchases at different
 * costs, purchase returns at the ORIGINAL price, cancellation after intervening
 * cost-affecting transactions, multi-branch inventory, and CONCURRENT
 * cost-affecting operations (purchase confirm ↔ return, purchase return ↔ sales
 * return) — none may lose a WAC update.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

const D = (v: unknown) => new Decimal((v as { toString(): string }).toString());

describe("WAC edge cases + costing lock (§2)", () => {
  let h: TestApp;
  let token: string;
  let repId: string, customerId: string, supplierId: string, branchB: string;
  const acc: Record<string, string> = {};
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const srv = () => h.app.getHttpServer();

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(srv()).post("/api/v1/auth/login").send({ phone: h.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    branchB = (await h.prisma.branch.create({ data: { nameAr: "فرع ب", nameEn: "B", active: true } })).id;
    repId = (await h.prisma.salesRepresentative.create({ data: { code: "WR", nameAr: "مندوب" } })).id;
    customerId = (await h.prisma.customer.create({ data: { code: "WC", nameAr: "عميل" } })).id;
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "S" } })).id;
    const u = Date.now().toString().slice(-6);
    const mk = async (k: string, code: string, cat: any, t: any, role?: string) => {
      acc[k] = (await h.prisma.account.create({ data: { code: `${code}${u}`, nameAr: code, nameEn: code, category: cat, accountType: t, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } })).id;
    };
    await mk("ar", "AR", "ASSET", "CURRENT_ASSET", "AR_CONTROL"); await mk("ap", "AP", "LIABILITY", "LIABILITY", "AP_CONTROL");
    await mk("rev", "RV", "REVENUE", "REVENUE"); await mk("sret", "SR", "REVENUE", "REVENUE");
    await mk("vatO", "VO", "LIABILITY", "LIABILITY"); await mk("vatI", "VI", "ASSET", "CURRENT_ASSET");
    await mk("cogs", "CG", "COST_OF_SALES", "COST_OF_SALES"); await mk("inv", "IN", "ASSET", "CURRENT_ASSET");
    await h.prisma.postingProfile.create({ data: {
      effectiveFrom: new Date("2026-01-01"), arAccountId: acc.ar, apAccountId: acc.ap, revenueAccountId: acc.rev,
      salesReturnsAccountId: acc.sret, vatOutputAccountId: acc.vatO, vatInputAccountId: acc.vatI,
      cogsAccountId: acc.cogs, inventoryAccountId: acc.inv, createdBy: h.ownerId } });
    for (let m = 1; m <= 12; m++) await h.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });
  });
  afterAll(async () => teardownTestApp(h));

  let seq = 0;
  const newVariant = async (size = "4.0000") => {
    const sku = await h.prisma.productSku.create({ data: { code: `WV-${++seq}`, category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
    return (await h.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: size, defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" } })).id;
  };
  const buy = async (v: string, boards: string, pricePerMeter: string, branchId = h.branchId) => {
    const p = await request(srv()).post("/api/v1/purchase-invoices").set(auth()).send({
      invoiceDate: "2026-02-01", supplierId, branchId, lines: [{ productVariantId: v, boardsQuantity: boards, unitPrice: pricePerMeter, taxRate: "0" }] });
    expect((await request(srv()).post(`/api/v1/purchase-invoices/${p.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);
    return p.body.id as string;
  };
  const pRet = async (purchaseId: string, meters: string, boards: string, branchId?: string) => {
    const line = (await h.prisma.purchaseInvoiceLine.findFirst({ where: { invoiceId: purchaseId } }))!.id;
    const r = await request(srv()).post("/api/v1/purchase-returns").set(auth()).send({
      originalPurchaseInvoiceId: purchaseId, returnDate: "2026-02-15", lines: [{ originalPurchaseInvoiceLineId: line, returnedMeters: meters, returnedBoards: boards }] });
    return r.body.id as string;
  };
  const confirmPRet = (id: string) => request(srv()).post(`/api/v1/purchase-returns/${id}/confirm`).set(auth()).send({});
  const sell = async (v: string, boards: string, price: string, branchId = h.branchId) => {
    const d = await request(srv()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-03-01", customerId, branchId, taxRate: "0", salesRepresentativeId: repId,
      lines: [{ productVariantId: v, quantity: boards, unitPrice: price, costPrice: "0" }] });
    expect((await request(srv()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);
    return d.body.id as string;
  };
  const sRet = async (invoiceId: string, meters: string, boards: string) => {
    const line = (await h.prisma.salesInvoiceLine.findFirst({ where: { invoiceId } }))!.id;
    const r = await request(srv()).post("/api/v1/sales-returns").set(auth()).send({
      originalSalesInvoiceId: invoiceId, returnDate: "2026-03-15", lines: [{ originalSalesInvoiceLineId: line, returnedMeters: meters, returnedBoards: boards }] });
    return r.body.id as string;
  };
  const confirmSRet = (id: string) => request(srv()).post(`/api/v1/sales-returns/${id}/confirm`).set(auth()).send({});
  const variant = (v: string) => h.prisma.productVariant.findUnique({ where: { id: v } });
  const companyMeters = async (v: string) => D((await h.prisma.branchInventoryBalance.aggregate({ _sum: { metersOnHand: true }, where: { productVariantId: v } }))._sum.metersOnHand);
  const jLine = async (entryId: string | null, accountId: string, side: "debit" | "credit") => {
    if (!entryId) return new Decimal(0);
    const l = await h.prisma.journalLine.findFirst({ where: { journalEntryId: entryId, accountId } });
    return D(l?.[side] ?? 0);
  };

  it("purchase@300 then purchase@500 blends to 400/m; purchase-return vs the 300 invoice → 433.3333/m; journal inventory = 6000", async () => {
    const v = await newVariant();
    const p300 = await buy(v, "10", "300"); // 40m @300 → value 12000
    await buy(v, "10", "500");              // +40m @500 → value 32000, 80m → 400/m
    expect(D((await variant(v))!.avgCostPerMeter).toFixed(2)).toBe("400.00");
    const pr = (await confirmPRet(await pRet(p300, "20", "5"))).body; // return 20m @300 → value out 6000
    // (32000 − 6000) / (80 − 20) = 26000/60 = 433.3333
    expect(D((await variant(v))!.avgCostPerMeter).toFixed(4)).toBe("433.3333");
    expect((await jLine(pr.journalEntryId, acc.inv, "credit")).toFixed(2)).toBe("6000.00");
    expect((await jLine(pr.journalEntryId, acc.ap, "debit")).toFixed(2)).toBe("6000.00");
    // GL inventory value == metres × WAC.
    expect((await companyMeters(v)).mul(D((await variant(v))!.avgCostPerMeter)).toFixed(2)).toBe("26000.00");
  });

  it("cancellation after an intervening purchase restores value deterministically (persisted return value)", async () => {
    const v = await newVariant();
    const p = await buy(v, "10", "300"); // 40m @300
    const prId = (await confirmPRet(await pRet(p, "20", "5"))).body.id; // -20m/-6000 → 20m @300
    await buy(v, "10", "600"); // +40m @600 → (6000 + 24000)/(20+40)= 30000/60 = 500/m
    expect(D((await variant(v))!.avgCostPerMeter).toFixed(2)).toBe("500.00");
    // Cancel the purchase return: +20m + 6000 → (30000+6000)/(60+20)=36000/80=450/m.
    expect((await request(srv()).post(`/api/v1/purchase-returns/${prId}/cancel`).set(auth()).send({})).status).toBeLessThan(300);
    expect(D((await variant(v))!.avgCostPerMeter).toFixed(2)).toBe("450.00");
    expect((await companyMeters(v)).toFixed(4)).toBe("80.0000");
  });

  it("multi-branch: WAC is company-wide across branches; a branch-A return recomputes it globally", async () => {
    const v = await newVariant();
    await buy(v, "10", "300", h.branchId); // 40m @300 in A
    await buy(v, "10", "500", branchB);    // 40m @500 in B → company 80m, 400/m
    expect(D((await variant(v))!.avgCostPerMeter).toFixed(2)).toBe("400.00");
    const inv = await sell(v, "5", "700", h.branchId); // sell 20m from A → 60m company, avg stays 400
    expect(D((await variant(v))!.avgCostPerMeter).toFixed(2)).toBe("400.00");
    // Sales return 4m in A adds back at historical COGS (20m sold @400 → 8000; 4m → 1600).
    await confirmSRet(await sRet(inv, "4", "1"));
    // (60*400 + 1600)/(60+4) = 25600/64 = 400/m (same cost) → still 400.
    expect(D((await variant(v))!.avgCostPerMeter).toFixed(2)).toBe("400.00");
    expect((await companyMeters(v)).toFixed(4)).toBe("64.0000");
  });

  it("CONCURRENT purchase confirm + sales return on the same variant — neither WAC update is lost", async () => {
    const v = await newVariant();
    await buy(v, "10", "300");          // 40m @300
    const inv = await sell(v, "5", "700"); // sell 20m @ COGS 300 → 20m left @300; sold COGS/m 300
    // Prepare a NEW purchase draft (10 boards @600) and a sales-return draft (4m).
    const p2 = await request(srv()).post("/api/v1/purchase-invoices").set(auth()).send({
      invoiceDate: "2026-02-10", supplierId, branchId: h.branchId, lines: [{ productVariantId: v, boardsQuantity: "10", unitPrice: "600", taxRate: "0" }] });
    const srDraft = await sRet(inv, "4", "1");
    // Fire both confirmations concurrently — both mutate this variant's WAC.
    const [pc, sc] = await Promise.all([
      request(srv()).post(`/api/v1/purchase-invoices/${p2.body.id}/confirm`).set(auth()).send({}),
      confirmSRet(srDraft),
    ]);
    expect(pc.status).toBeLessThan(300);
    expect(sc.status).toBeLessThan(300);
    // Both applied: 20m@300 + 40m@600 (24000) + 4m@300-return(1200).
    // Final value = 6000 + 24000 + 1200 = 31200 over 20+40+4 = 64m → 487.5/m.
    expect(D((await variant(v))!.avgCostPerMeter).toFixed(2)).toBe("487.50");
    expect((await companyMeters(v)).toFixed(4)).toBe("64.0000");
    // GL-consistent: metres × WAC == accumulated value.
    expect((await companyMeters(v)).mul(D((await variant(v))!.avgCostPerMeter)).toFixed(2)).toBe("31200.00");
  });

  it("CONCURRENT purchase return + sales return on the same variant both apply", async () => {
    const v = await newVariant();
    const p = await buy(v, "10", "300");    // 40m @300
    const inv = await sell(v, "5", "700");  // sell 20m → 20m left
    const prDraft = await pRet(p, "8", "2"); // return 2 whole boards (8m) to supplier (value 2400)
    const srDraft = await sRet(inv, "4", "1"); // return 1 board (4m) to stock (COGS 1200)
    const [pr, sr] = await Promise.all([confirmPRet(prDraft), confirmSRet(srDraft)]);
    expect(pr.status).toBeLessThan(300);
    expect(sr.status).toBeLessThan(300);
    // 20 − 8 (pRet) + 4 (sRet) = 16m; value 6000 − 2400 + 1200 = 4800 → 300/m.
    expect((await companyMeters(v)).toFixed(4)).toBe("16.0000");
    expect(D((await variant(v))!.avgCostPerMeter).toFixed(2)).toBe("300.00");
  });

  it("purchase-return journal lines all carry the branch dimension", async () => {
    const v = await newVariant();
    const p = await buy(v, "10", "400");
    const pr = (await confirmPRet(await pRet(p, "8", "2"))).body;
    const lines = await h.prisma.journalLine.findMany({ where: { journalEntryId: pr.journalEntryId } });
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) expect(l.branchId).toBe(h.branchId);
  });
  /**
   * The legacy-return policy change must not reach here. An invoice-linked
   * return values goods at the cost recorded when they left on the invoice —
   * a different question from what the variant averages today, and one this
   * flow answers from the invoice, never from the current average.
   */
  it("an invoice-linked return still values goods at the invoice's historical cost, not today's average", async () => {
    const v = await newVariant("4.0000");
    await buy(v, "10", "500");
    const inv = await sell(v, "4", "900");

    // Move the company average well away from the cost this sale left at.
    await buy(v, "10", "1300");
    const moved = D((await variant(v))!.avgCostPerMeter);
    expect(moved.toNumber()).toBeGreaterThan(500);

    const r = await sRet(inv, "4", "1");
    expect((await confirmSRet(r)).status).toBeLessThan(300);

    const line = await h.prisma.salesReturnLine.findFirst({ where: { salesReturnId: r } });
    expect(Number(line!.originalCostPerMeterAtPosting)).toBeCloseTo(500, 2);
    expect(Number(line!.originalCostPerMeterAtPosting)).not.toBeCloseTo(moved.toNumber(), 2);
  });
});