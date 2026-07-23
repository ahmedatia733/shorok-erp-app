/**
 * §7 — CANONICAL meter-based costing, proven end-to-end via the REAL
 * purchase→WAC→sale→journal flow. Accountant rule: purchase/sell/value/profit
 * by SQUARE METER. lineCogs = metersQuantity × avgCostPerMeter (exact metres),
 * so a partial/custom cut is NOT charged a full board. For every sale, invoice
 * totalCost == line_cogs_at_posting == COGS journal debit == inventory credit ==
 * rep report COGS == profitability COGS, and the income statement reconciles.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

const D = (v: unknown) => new Decimal((v as { toString(): string }).toString());

describe("meter-based costing (§7)", () => {
  let handle: TestApp;
  let token: string;
  let repId: string, customerId: string, supplierId: string, cogsAcc: string, invAcc: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => handle.app.getHttpServer();

  beforeAll(async () => {
    handle = await buildTestApp();
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    repId = (await handle.prisma.salesRepresentative.create({ data: { code: "MR", nameAr: "مندوب" } })).id;
    customerId = (await handle.prisma.customer.create({ data: { code: "MC", nameAr: "عميل" } })).id;
    supplierId = (await handle.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "S" } })).id;
    const u = Date.now().toString().slice(-6);
    const mk = (c: string, cat: any, t: any, role?: string) =>
      handle.prisma.account.create({ data: { code: c, nameAr: c, nameEn: c, category: cat, accountType: t, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } });
    const ar = (await mk(`AR${u}`, "ASSET", "CURRENT_ASSET", "AR_CONTROL")).id;
    const ap = (await mk(`AP${u}`, "LIABILITY", "LIABILITY", "AP_CONTROL")).id;
    const rev = (await mk(`RV${u}`, "REVENUE", "REVENUE")).id;
    const vatO = (await mk(`VO${u}`, "LIABILITY", "LIABILITY")).id;
    const vatI = (await mk(`VI${u}`, "ASSET", "CURRENT_ASSET")).id;
    cogsAcc = (await mk(`CG${u}`, "COST_OF_SALES", "COST_OF_SALES")).id;
    invAcc = (await mk(`IN${u}`, "ASSET", "CURRENT_ASSET")).id;
    await handle.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId: ar, apAccountId: ap, revenueAccountId: rev, vatOutputAccountId: vatO, vatInputAccountId: vatI, cogsAccountId: cogsAcc, inventoryAccountId: invAcc, createdBy: handle.ownerId } });
    for (let m = 1; m <= 12; m++) await handle.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });
  });
  afterAll(async () => teardownTestApp(handle));

  let seq = 0;
  const variantAt = async (size: string, pricePerMeter: string, buyBoards = "10") => {
    const sku = await handle.prisma.productSku.create({ data: { code: `MC-${++seq}`, category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
    const v = (await handle.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: size, defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" } })).id;
    const p = await request(server()).post("/api/v1/purchase-invoices").set(auth()).send({
      invoiceDate: "2026-02-01", supplierId, branchId: handle.branchId,
      lines: [{ productVariantId: v, boardsQuantity: buyBoards, unitPrice: pricePerMeter, taxRate: "0" }],
    });
    expect((await request(server()).post(`/api/v1/purchase-invoices/${p.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);
    return v;
  };
  const sellConfirmed = async (v: string, boards: string, price: string, dims?: { lengthM?: string; widthM?: string }) => {
    const d = await request(server()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-03-01", customerId, branchId: handle.branchId, taxRate: "0", salesRepresentativeId: repId,
      lines: [{ productVariantId: v, quantity: boards, unitPrice: price, costPrice: "0", ...(dims ?? {}) }],
    });
    expect((await request(server()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);
    return d.body.id as string;
  };
  const cogsJournalDebit = async (invoiceId: string) => {
    const inv = await handle.prisma.salesInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv?.cogsJournalEntryId) return { cogs: new Decimal(0), invCredit: new Decimal(0) };
    const dr = await handle.prisma.journalLine.findFirst({ where: { journalEntryId: inv.cogsJournalEntryId, accountId: cogsAcc } });
    const cr = await handle.prisma.journalLine.findFirst({ where: { journalEntryId: inv.cogsJournalEntryId, accountId: invAcc } });
    return { cogs: D(dr!.debit), invCredit: D(cr!.credit) };
  };
  const repCogs = async (v: string) => {
    const reps = (await request(server()).get(`/api/v1/reports/sales-representatives/summary?preset=custom&from=2026-01-01&to=2026-12-31&productVariantId=${v}`).set(auth())).body.representatives;
    return D(reps[0]?.cogs ?? "0"); // empty when no confirmed sales remain (e.g. after cancel)
  };

  // Full reconciliation harness for one sale.
  const assertReconciles = async (v: string, invoiceId: string, expectedCogs: string) => {
    const inv = await handle.prisma.salesInvoice.findUnique({ where: { id: invoiceId }, include: { lines: true } });
    const line = inv!.lines[0]!;
    expect(D(line.lineCogsAtPosting).toFixed(2)).toBe(expectedCogs);          // stored line COGS
    expect(D(inv!.totalCost).toFixed(2)).toBe(expectedCogs);                   // invoice.totalCost
    const j = await cogsJournalDebit(invoiceId);
    expect(j.cogs.toFixed(2)).toBe(expectedCogs);                             // COGS journal debit
    expect(j.invCredit.toFixed(2)).toBe(expectedCogs);                        // inventory credit
    expect((await repCogs(v)).toFixed(2)).toBe(expectedCogs);                 // rep report
    const prof = await request(server()).get(`/api/v1/reports/sales/profitability?preset=custom&from=2026-01-01&to=2026-12-31&groupDim=product&productVariantId=${v}`).set(auth());
    expect(D(prof.body.groups[0].cogs).toFixed(2)).toBe(expectedCogs);        // profitability
  };

  it("PURCHASE: WAC is maintained PER METER (400/m; legacy per-board 1600 kept)", async () => {
    const v = await variantAt("4.0000", "400");
    const variant = await handle.prisma.productVariant.findUnique({ where: { id: v } });
    expect(D(variant!.avgCostPerMeter).toFixed(2)).toBe("400.00"); // canonical
    expect(D(variant!.avgCost).toFixed(2)).toBe("1600.00");        // legacy per-board preserved
  });

  it("SALE A: 2 boards native (8 m) @ cost 400/m → COGS 3,200.00 (all layers reconcile)", async () => {
    const v = await variantAt("4.0000", "400");
    const id = await sellConfirmed(v, "2", "999", { lengthM: "4" });
    const line = (await handle.prisma.salesInvoice.findUnique({ where: { id }, include: { lines: true } }))!.lines[0]!;
    expect(D(line.metersQuantity!).toFixed(4)).toBe("8.0000");
    expect(D(line.unitCostPerMeterAtPosting!).toFixed(4)).toBe("400.0000");
    await assertReconciles(v, id, "3200.00");
  });

  it("SALE B CUSTOM: 2 boards, 2.0×1.5 (6 m) @ 400/m → COGS 2,400.00", async () => {
    const v = await variantAt("4.0000", "400");
    const id = await sellConfirmed(v, "2", "999", { lengthM: "2", widthM: "1.5" });
    const line = (await handle.prisma.salesInvoice.findUnique({ where: { id }, include: { lines: true } }))!.lines[0]!;
    expect(D(line.metersQuantity!).toFixed(4)).toBe("6.0000");
    await assertReconciles(v, id, "2400.00");
  });

  it("PARTIAL: 1 piece cut to 2 m of a 4 m² board @ 400/m → COGS 800.00, NOT a full 1,600 board", async () => {
    const v = await variantAt("4.0000", "400");
    const id = await sellConfirmed(v, "1", "999", { lengthM: "2", widthM: "1" }); // area 2 → meters 2
    const line = (await handle.prisma.salesInvoice.findUnique({ where: { id }, include: { lines: true } }))!.lines[0]!;
    expect(D(line.metersQuantity!).toFixed(4)).toBe("2.0000");
    await assertReconciles(v, id, "800.00");
    // The legacy per-board basis (1 board × 1600) would WRONGLY charge 1600.
    expect(D(line.quantity).mul(line.unitCostAtPosting!).toFixed(2)).toBe("1600.00");
    expect(D(line.lineCogsAtPosting!).toFixed(2)).toBe("800.00"); // canonical charges only metres sold
  });

  it("LARGE: 3 boards of 5.25 m² (15.75 m) @ 200/m → COGS 3,150.00", async () => {
    const v = await variantAt("5.2500", "200", "8");
    const id = await sellConfirmed(v, "3", "999", { lengthM: "5.25" });
    const line = (await handle.prisma.salesInvoice.findUnique({ where: { id }, include: { lines: true } }))!.lines[0]!;
    expect(D(line.metersQuantity!).toFixed(4)).toBe("15.7500");
    await assertReconciles(v, id, "3150.00");
  });

  it("cancellation reverses the EXACT original COGS; a later avgCost bump does not change it", async () => {
    const v = await variantAt("4.0000", "400");
    const id = await sellConfirmed(v, "2", "999", { lengthM: "4" }); // COGS 3200
    // Bump current cost AFTER posting — must not affect the stored/posted COGS.
    await handle.prisma.productVariant.update({ where: { id: v }, data: { avgCostPerMeter: "9999", avgCost: "9999" } });
    const before = await cogsJournalDebit(id);
    expect(before.cogs.toFixed(2)).toBe("3200.00");
    expect((await request(server()).post(`/api/v1/sales-invoices/${id}/cancel`).set(auth()).send({})).status).toBeLessThan(300);
    // Reversal mirror negates the exact 3200 COGS journal → net COGS on the account is 0.
    const inv = await handle.prisma.salesInvoice.findUnique({ where: { id } });
    const net = await handle.prisma.journalLine.aggregate({ _sum: { debit: true, credit: true }, where: { accountId: cogsAcc, journalEntry: { sourceId: id } } });
    expect(D(net._sum.debit).minus(D(net._sum.credit)).toFixed(2)).toBe("0.00"); // fully reversed
    expect(inv!.status).toBe("CANCELLED");
    // Cancelled → excluded from the rep report.
    expect((await repCogs(v)).toFixed(2)).toBe("0.00");
  });

  it("income statement (posted only) COGS == Σ line_cogs_at_posting of confirmed sales", async () => {
    const is = (await request(server()).get(`/api/v1/reports/income-statement?from=2026-01-01&to=2026-12-31`).set(auth())).body;
    const agg = await handle.prisma.salesInvoiceLine.aggregate({
      _sum: { lineCogsAtPosting: true },
      where: { invoice: { status: "CONFIRMED" } },
    });
    expect(D(is.costOfSales).toFixed(2)).toBe(D(agg._sum.lineCogsAtPosting).toFixed(2));
  });
});
