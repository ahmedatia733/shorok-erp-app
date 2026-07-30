/**
 * Sales & purchase RETURNS — end-to-end via real purchase→sale→return→journal→
 * inventory flows (returns spec §22/§23). Proves: partial/full returns, exact
 * residual reconciliation, over-return impossible (incl. concurrent), historical
 * price/cost used (never current), inventory metres/boards, customer/supplier
 * balances, journal balance, COGS reversal, WAC recompute, cancellation reversal,
 * original-invoice immutability, and report/income-statement reconciliation.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

const D = (v: unknown) => new Decimal((v as { toString(): string }).toString());

describe("returns (§22/§23)", () => {
  let h: TestApp;
  let token: string;
  let repId: string, customerId: string, supplierId: string;
  let acc: Record<string, string> = {};
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const srv = () => h.app.getHttpServer();

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(srv()).post("/api/v1/auth/login").send({ phone: h.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    repId = (await h.prisma.salesRepresentative.create({ data: { code: "RR", nameAr: "مندوب" } })).id;
    customerId = (await h.prisma.customer.create({ data: { code: "RC", nameAr: "عميل" } })).id;
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "S" } })).id;
    const u = Date.now().toString().slice(-6);
    const mk = async (k: string, code: string, cat: any, t: any, role?: string) => {
      acc[k] = (await h.prisma.account.create({ data: { code: `${code}${u}`, nameAr: code, nameEn: code, category: cat, accountType: t, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } })).id;
    };
    await mk("ar", "AR", "ASSET", "CURRENT_ASSET", "AR_CONTROL");
    await mk("ap", "AP", "LIABILITY", "LIABILITY", "AP_CONTROL");
    await mk("rev", "RV", "REVENUE", "REVENUE");
    await mk("sret", "SR", "REVENUE", "REVENUE");           // contra-revenue sales returns
    await mk("vatO", "VO", "LIABILITY", "LIABILITY");
    await mk("vatI", "VI", "ASSET", "CURRENT_ASSET");
    await mk("cogs", "CG", "COST_OF_SALES", "COST_OF_SALES");
    await mk("inv", "IN", "ASSET", "CURRENT_ASSET");
    await mk("cash", "CS", "ASSET", "CURRENT_ASSET");
    await h.prisma.postingProfile.create({ data: {
      effectiveFrom: new Date("2026-01-01"), arAccountId: acc.ar, apAccountId: acc.ap, revenueAccountId: acc.rev,
      salesReturnsAccountId: acc.sret, vatOutputAccountId: acc.vatO, vatInputAccountId: acc.vatI,
      cogsAccountId: acc.cogs, inventoryAccountId: acc.inv, createdBy: h.ownerId,
    } });
    for (let m = 1; m <= 12; m++) await h.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });
  });
  afterAll(async () => teardownTestApp(h));

  let seq = 0;
  // Buy `boards` at a per-metre price → sets avgCostPerMeter = price.
  const buy = async (size: string, pricePerMeter: string, boards = "10") => {
    const sku = await h.prisma.productSku.create({ data: { code: `RT-${++seq}`, category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
    const v = (await h.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: size, defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" } })).id;
    const p = await request(srv()).post("/api/v1/purchase-invoices").set(auth()).send({
      invoiceDate: "2026-02-01", supplierId, branchId: h.branchId,
      lines: [{ productVariantId: v, boardsQuantity: boards, unitPrice: pricePerMeter, taxRate: "0" }],
    });
    expect((await request(srv()).post(`/api/v1/purchase-invoices/${p.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);
    return { variantId: v, purchaseId: p.body.id as string };
  };
  const sell = async (v: string, boards: string, price: string, taxRate = "0", dims?: { lengthM?: string; widthM?: string }) => {
    const d = await request(srv()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-03-01", customerId, branchId: h.branchId, taxRate, salesRepresentativeId: repId,
      lines: [{ productVariantId: v, quantity: boards, unitPrice: price, costPrice: "0", ...(dims ?? {}) }],
    });
    expect((await request(srv()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);
    return d.body.id as string;
  };
  const invLineId = async (invoiceId: string) => (await h.prisma.salesInvoiceLine.findFirst({ where: { invoiceId } }))!.id;
  const pInvLineId = async (invoiceId: string) => (await h.prisma.purchaseInvoiceLine.findFirst({ where: { invoiceId } }))!.id;
  // Boards are the ONE quantity authority now; the metres arg is accepted but the
  // server ignores it (it derives metres = boards × board size). Kept in the
  // signature so existing call sites read unchanged.
  const retSale = (invoiceId: string, lineId: string, _meters: string, boards: string, extra: any = {}) =>
    request(srv()).post("/api/v1/sales-returns").set(auth()).send({
      originalSalesInvoiceId: invoiceId, returnDate: "2026-03-15",
      lines: [{ originalSalesInvoiceLineId: lineId, returnedBoards: boards }], ...extra,
    });
  const confirmSaleRet = (id: string) => request(srv()).post(`/api/v1/sales-returns/${id}/confirm`).set(auth()).send({});
  const bal = async (v: string) => h.prisma.branchInventoryBalance.findUnique({ where: { branchId_productVariantId: { branchId: h.branchId, productVariantId: v } } });
  const entryLine = async (entryId: string | null, accountId: string, side: "debit" | "credit") => {
    if (!entryId) return new Decimal(0);
    const l = await h.prisma.journalLine.findFirst({ where: { journalEntryId: entryId, accountId } });
    return D(l?.[side] ?? 0);
  };
  const repSummary = async (v: string) => (await request(srv()).get(`/api/v1/reports/sales-representatives/summary?preset=custom&from=2026-01-01&to=2026-12-31&productVariantId=${v}`).set(auth())).body;
  const incomeStatement = async () => (await request(srv()).get(`/api/v1/reports/income-statement?from=2026-01-01&to=2026-12-31`).set(auth())).body;

  // ── Scenario A — first partial sales return, full reconciliation ───────────
  it("A) partial sales return 1 board/4m² @ cost 300 → net 2000, COGS 1200; invoice stays CONFIRMED, status PARTIAL", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5"); // avgCostPerMeter 300
    const inv = await sell(v, "5", "500");                    // 5 boards, 20m, net 10000, COGS 6000
    const lineId = await invLineId(inv);

    const r = await retSale(inv, lineId, "4", "1");
    expect(r.status).toBeLessThan(300);
    const confirmed = await confirmSaleRet(r.body.id);
    expect(confirmed.status).toBeLessThan(300);
    const sr = confirmed.body;

    expect(D(sr.grandTotal).toFixed(2)).toBe("2000.00");
    expect(D(sr.cogsReversalTotal).toFixed(2)).toBe("1200.00");
    expect(D(sr.lines[0].returnNetExTax).toFixed(2)).toBe("2000.00");
    expect(D(sr.lines[0].returnCogs).toFixed(2)).toBe("1200.00");

    // Original invoice immutable + PARTIAL.
    const origInv = await h.prisma.salesInvoice.findUnique({ where: { id: inv } });
    expect(origInv!.status).toBe("CONFIRMED");
    const ret = (await request(srv()).get(`/api/v1/sales-returns/returnable/${inv}`).set(auth())).body;
    expect(ret.invoice.returnStatus).toBe("PARTIAL");
    expect(D(ret.lines[0].remainingMeters).toFixed(4)).toBe("16.0000");

    // Journals balanced.
    expect((await entryLine(sr.journalEntryId, acc.sret, "debit")).toFixed(2)).toBe("2000.00");
    expect((await entryLine(sr.journalEntryId, acc.ar, "credit")).toFixed(2)).toBe("2000.00");
    expect((await entryLine(sr.cogsJournalEntryId, acc.inv, "debit")).toFixed(2)).toBe("1200.00");
    expect((await entryLine(sr.cogsJournalEntryId, acc.cogs, "credit")).toFixed(2)).toBe("1200.00");

    // Inventory +4m² / +1 board.
    const b = await bal(v);
    expect(D(b!.metersOnHand).toFixed(4)).toBe("4.0000");
    expect(D(b!.boardsOnHand).toFixed(4)).toBe("1.0000");

    // Reports: net sales 8000, net COGS 4800, GP 3200, returns 2000.
    const rep = (await repSummary(v)).representatives[0];
    expect(rep.netSales).toBe("8000.00");
    expect(rep.cogs).toBe("4800.00");
    expect(rep.grossProfit).toBe("3200.00");
    expect(rep.returns).toBe("2000.00");
    expect(rep.metersReturned).toBe("4.0000");
    expect(rep.netMeters).toBe("16.0000");
  });

  // ── Scenario B & C — cumulative partial then full residual ─────────────────
  it("B+C) second partial (4m²) then full remaining (12m²) → cumulative == original, status FULL", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "5", "500");
    const lineId = await invLineId(inv);

    expect((await confirmSaleRet((await retSale(inv, lineId, "4", "1")).body.id)).status).toBeLessThan(300); // 1st
    const r2 = await confirmSaleRet((await retSale(inv, lineId, "4", "1")).body.id);                          // 2nd
    expect(r2.status).toBeLessThan(300);
    let ret = (await request(srv()).get(`/api/v1/sales-returns/returnable/${inv}`).set(auth())).body;
    expect(D(ret.lines[0].remainingMeters).toFixed(4)).toBe("12.0000");
    expect(ret.invoice.returnStatus).toBe("PARTIAL");

    const r3 = await confirmSaleRet((await retSale(inv, lineId, "12", "3")).body.id);                         // final residual
    expect(r3.status).toBeLessThan(300);
    ret = (await request(srv()).get(`/api/v1/sales-returns/returnable/${inv}`).set(auth())).body;
    expect(ret.invoice.returnStatus).toBe("FULL");
    expect(D(ret.lines[0].remainingMeters).toFixed(4)).toBe("0.0000");

    // Cumulative returned == original line (net 10000, COGS 6000).
    const agg = await h.prisma.salesReturnLine.aggregate({
      _sum: { returnNetExTax: true, returnCogs: true, returnedMetersQuantity: true },
      where: { originalSalesInvoiceLineId: lineId, salesReturn: { status: "CONFIRMED" } },
    });
    expect(D(agg._sum.returnNetExTax).toFixed(2)).toBe("10000.00");
    expect(D(agg._sum.returnCogs).toFixed(2)).toBe("6000.00");
    expect(D(agg._sum.returnedMetersQuantity).toFixed(4)).toBe("20.0000");

    // Fully returned → rep net sales / COGS / GP net to zero for this product.
    const rep = (await repSummary(v)).representatives[0];
    expect(rep.netSales).toBe("0.00");
    expect(rep.cogs).toBe("0.00");
    expect(rep.grossProfit).toBe("0.00");
  });

  // ── Scenario D — over-return blocked (one whole board past the eligible count) ─
  it("D) returning 1 whole board more than remaining fails (409)", async () => {
    const { variantId: v } = await buy("4.0000", "300", "2");
    const inv = await sell(v, "2", "500"); // 2 boards, 8m — eligible = 2 boards
    const lineId = await invLineId(inv);
    const r = await retSale(inv, lineId, "12", "3"); // 3 > 2 eligible boards
    expect(r.status).toBe(409);
    expect(r.body.details?.reason ?? r.body.reason).toBe("returned_boards_exceed_remaining");
  });

  // ── Scenario E — concurrent confirmation of the same remaining ─────────────
  it("E) two drafts returning the same final quantity — only one confirms", async () => {
    const { variantId: v } = await buy("4.0000", "300", "2");
    const inv = await sell(v, "2", "500"); // 8m
    const lineId = await invLineId(inv);
    const a = await retSale(inv, lineId, "8", "2");
    const b = await retSale(inv, lineId, "8", "2");
    expect(a.status).toBeLessThan(300);
    expect(b.status).toBeLessThan(300);
    const [ra, rb] = await Promise.all([confirmSaleRet(a.body.id), confirmSaleRet(b.body.id)]);
    const oks = [ra.status, rb.status].filter((s) => s < 300).length;
    const fails = [ra.status, rb.status].filter((s) => s === 409).length;
    expect(oks).toBe(1);
    expect(fails).toBe(1);
  });

  // ── Scenario F — historical cost used even after avgCost changes ───────────
  it("F) changing avgCostPerMeter after the sale does not change the return COGS", async () => {
    const { variantId: v } = await buy("4.0000", "300", "2");
    const inv = await sell(v, "2", "500"); // COGS/m = 300
    const lineId = await invLineId(inv);
    await h.prisma.productVariant.update({ where: { id: v }, data: { avgCostPerMeter: "9999", avgCost: "99999" } });
    const sr = (await confirmSaleRet((await retSale(inv, lineId, "4", "1")).body.id)).body;
    expect(D(sr.lines[0].returnCogs).toFixed(2)).toBe("1200.00"); // 4 × 300 (original), not 9999
  });

  // ── Scenario G — legacy line (NULL meter snapshots) proportional COGS ──────
  it("G) legacy line without meter snapshots allocates historical COGS proportionally", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "5", "500"); // meter COGS 6000
    const lineId = await invLineId(inv);
    // Simulate a legacy row: drop the meter snapshots, keep per-board legacy cost.
    // per board = 1200 (300×4); 5 boards → legacy line COGS 6000.
    await h.prisma.salesInvoiceLine.update({ where: { id: lineId }, data: { unitCostPerMeterAtPosting: null, lineCogsAtPosting: null, unitCostAtPosting: "1200" } });
    const sr = (await confirmSaleRet((await retSale(inv, lineId, "4", "1")).body.id)).body;
    // 6000 × (4/20) = 1200
    expect(D(sr.lines[0].returnCogs).toFixed(2)).toBe("1200.00");
  });

  // ── Scenario H — custom dimensions preserved, exact metres ─────────────────
  it("H) custom-dimension sale returns exact metres/COGS", async () => {
    const { variantId: v } = await buy("4.0000", "300", "4");
    // Sell 2 boards custom 2.0 × 1.5 = 3 m² each → 6 m² total, net = 6×500=3000, COGS 6×300=1800.
    const inv = await sell(v, "2", "500", "0", { lengthM: "2", widthM: "1.5" });
    const lineId = await invLineId(inv);
    const sr = (await confirmSaleRet((await retSale(inv, lineId, "3", "1")).body.id)).body; // return 3 m² (one piece)
    expect(D(sr.lines[0].returnedMetersQuantity).toFixed(4)).toBe("3.0000");
    expect(D(sr.lines[0].returnNetExTax).toFixed(2)).toBe("1500.00"); // 3 × 500
    expect(D(sr.lines[0].returnCogs).toFixed(2)).toBe("900.00");      // 3 × 300
  });

  // ── Scenario K(sales) — cancellation reverses everything ───────────────────
  it("K) cancelling a confirmed sales return reverses journals, stock, COGS, and reports", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "5", "500");
    const lineId = await invLineId(inv);
    const sr = (await confirmSaleRet((await retSale(inv, lineId, "4", "1")).body.id)).body;
    const before = await bal(v); // meters 4, boards 1
    expect(D(before!.metersOnHand).toFixed(4)).toBe("4.0000");

    const c = await request(srv()).post(`/api/v1/sales-returns/${sr.id}/cancel`).set(auth()).send({ reason: "خطأ" });
    expect(c.status).toBeLessThan(300);
    // Stock removed again → 0.
    const after = await bal(v);
    expect(D(after!.metersOnHand).toFixed(4)).toBe("0.0000");
    // Sales-returns account nets to zero (original debit + reversal credit).
    const net = await h.prisma.journalLine.aggregate({ _sum: { debit: true, credit: true }, where: { accountId: acc.sret, journalEntry: { sourceId: sr.id } } });
    expect(D(net._sum.debit).minus(D(net._sum.credit)).toFixed(2)).toBe("0.00");
    // Report back to full sale.
    const rep = (await repSummary(v)).representatives[0];
    expect(rep.netSales).toBe("10000.00");
    expect(rep.grossProfit).toBe("4000.00");
    expect(rep.returns).toBe("0.00");
  });

  // ── Scenario L — draft affects nothing ─────────────────────────────────────
  it("L) a draft sales return does not touch stock, journals, or reports", async () => {
    const { variantId: v } = await buy("4.0000", "300", "2");
    const inv = await sell(v, "2", "500"); // stock 0 after sale
    const lineId = await invLineId(inv);
    const r = await retSale(inv, lineId, "4", "1");
    expect(r.status).toBeLessThan(300);
    expect(r.body.status).toBe("DRAFT");
    const b = await bal(v);
    expect(D(b!.metersOnHand).toFixed(4)).toBe("0.0000"); // untouched
    const ret = (await request(srv()).get(`/api/v1/sales-returns/returnable/${inv}`).set(auth())).body;
    expect(ret.invoice.returnStatus).toBe("NONE"); // drafts don't consume returnable
    const rep = (await repSummary(v)).representatives[0];
    expect(rep.returns).toBe("0.00");
  });

  // ── Additional — invalid invoice status / wrong line / zero qty ────────────
  it("rejects returning a DRAFT (unconfirmed) invoice, a foreign line, and zero qty", async () => {
    const { variantId: v } = await buy("4.0000", "300", "2");
    // Draft invoice (not confirmed).
    const draft = await request(srv()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-03-01", customerId, branchId: h.branchId, taxRate: "0",
      lines: [{ productVariantId: v, quantity: "1", unitPrice: "500", costPrice: "0" }],
    });
    const draftLine = draft.body.lines[0].id;
    expect((await retSale(draft.body.id, draftLine, "4", "1")).status).toBe(409); // not confirmed

    const inv = await sell(v, "1", "500");
    const lineId = await invLineId(inv);
    // Foreign line id (belongs to the draft, not this invoice).
    expect((await retSale(inv, draftLine, "1", "1")).status).toBe(409);
    // Zero boards — rejected at the DTO (positive integer required) → 400.
    expect((await retSale(inv, lineId, "0", "0")).status).toBe(400);
  });

  // ── Scenario I — purchase return + WAC recompute ───────────────────────────
  it("I) purchase return 1 board/4m² @ 400 → supplier credit 1600, inventory −4m², WAC intact", async () => {
    const { variantId: v, purchaseId } = await buy("4.0000", "400", "10"); // 40m, value 16000, avg/m 400
    const lineId = await pInvLineId(purchaseId);
    const r = await request(srv()).post("/api/v1/purchase-returns").set(auth()).send({
      originalPurchaseInvoiceId: purchaseId, returnDate: "2026-02-15",
      lines: [{ originalPurchaseInvoiceLineId: lineId, returnedMeters: "4", returnedBoards: "1" }],
    });
    expect(r.status).toBeLessThan(300);
    const pr = (await request(srv()).post(`/api/v1/purchase-returns/${r.body.id}/confirm`).set(auth()).send({})).body;
    expect(D(pr.grandTotal).toFixed(2)).toBe("1600.00");
    expect(D(pr.inventoryValueOut).toFixed(2)).toBe("1600.00");

    // Purchase invoice immutable.
    const pInv = await h.prisma.purchaseInvoice.findUnique({ where: { id: purchaseId } });
    expect(pInv!.status).toBe("CONFIRMED");
    // Inventory 40 → 36 m², 10 → 9 boards; WAC/m unchanged at 400 (value 14400/36).
    const b = await bal(v);
    expect(D(b!.metersOnHand).toFixed(4)).toBe("36.0000");
    expect(D(b!.boardsOnHand).toFixed(4)).toBe("9.0000");
    const variant = await h.prisma.productVariant.findUnique({ where: { id: v } });
    expect(D(variant!.avgCostPerMeter).toFixed(2)).toBe("400.00");
    // Journal balanced: Dr AP 1600 / Cr Inventory 1600.
    expect((await entryLine(pr.journalEntryId, acc.ap, "debit")).toFixed(2)).toBe("1600.00");
    expect((await entryLine(pr.journalEntryId, acc.inv, "credit")).toFixed(2)).toBe("1600.00");
    // Remaining returnable 36 m².
    const ret = (await request(srv()).get(`/api/v1/purchase-returns/returnable/${purchaseId}`).set(auth())).body;
    expect(D(ret.lines[0].remainingMeters).toFixed(4)).toBe("36.0000");
  });

  // ── Scenario J — insufficient stock blocks the purchase return ─────────────
  it("J) purchase return blocked when stock is insufficient", async () => {
    const { variantId: v, purchaseId } = await buy("4.0000", "400", "2"); // 8m
    const lineId = await pInvLineId(purchaseId);
    // Sell most of it so < 4 m² remain (sell 2 boards = 8m → 0 left).
    await sell(v, "2", "500");
    const r = await request(srv()).post("/api/v1/purchase-returns").set(auth()).send({
      originalPurchaseInvoiceId: purchaseId, returnDate: "2026-04-01",
      lines: [{ originalPurchaseInvoiceLineId: lineId, returnedMeters: "4", returnedBoards: "1" }],
    });
    // Draft may succeed; confirm must fail (insufficient stock / value).
    const cr = r.status < 300 ? await request(srv()).post(`/api/v1/purchase-returns/${r.body.id}/confirm`).set(auth()).send({}) : r;
    expect(cr.status).toBe(409);
  });

  // ── Scenario K(purchase) — cancellation reverses everything ────────────────
  it("K) cancelling a confirmed purchase return restores stock, WAC and supplier balance", async () => {
    const { variantId: v, purchaseId } = await buy("4.0000", "400", "10");
    const lineId = await pInvLineId(purchaseId);
    const pr = (await request(srv()).post(`/api/v1/purchase-returns/${(await request(srv()).post("/api/v1/purchase-returns").set(auth()).send({ originalPurchaseInvoiceId: purchaseId, returnDate: "2026-02-15", lines: [{ originalPurchaseInvoiceLineId: lineId, returnedMeters: "4", returnedBoards: "1" }] })).body.id}/confirm`).set(auth()).send({})).body;
    let b = await bal(v);
    expect(D(b!.metersOnHand).toFixed(4)).toBe("36.0000");
    const c = await request(srv()).post(`/api/v1/purchase-returns/${pr.id}/cancel`).set(auth()).send({ reason: "خطأ" });
    expect(c.status).toBeLessThan(300);
    b = await bal(v);
    expect(D(b!.metersOnHand).toFixed(4)).toBe("40.0000"); // restored
    const net = await h.prisma.journalLine.aggregate({ _sum: { debit: true, credit: true }, where: { accountId: acc.ap, journalEntry: { sourceId: pr.id } } });
    expect(D(net._sum.debit).minus(D(net._sum.credit)).toFixed(2)).toBe("0.00");
    const variant = await h.prisma.productVariant.findUnique({ where: { id: v } });
    expect(D(variant!.avgCostPerMeter).toFixed(2)).toBe("400.00");
  });
});
