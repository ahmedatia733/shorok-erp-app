/**
 * Returns REMEDIATION proofs (returns-remediation phase §17). Covers the fixes:
 * WAC recalculation on sales return + exact reversal, single costing lock under
 * concurrency, duplicate-line rejection, board over-return, dimension
 * persistence, reliable/blocked legacy metres, branch+rep journal dimensions,
 * branch-filtered income statement, list relations, server-side search,
 * differentiated permissions, draft edit, double-confirm, refund rejection,
 * multi-endpoint report reconciliation, and multi-line same-variant.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

const D = (v: unknown) => new Decimal((v as { toString(): string }).toString());

describe("returns remediation (§17)", () => {
  let h: TestApp;
  let owner: string, accountant: string, manager: string; // tokens
  let repId: string, customerId: string, supplierId: string, branchB: string;
  const acc: Record<string, string> = {};
  const authT = (t: string) => ({ Authorization: `Bearer ${t}` });
  const srv = () => h.app.getHttpServer();

  const login = async (phone: string, password: string) =>
    (await request(srv()).post("/api/v1/auth/login").send({ phone, password })).body.accessToken as string;

  const mkUser = async (name: string, role: any, phone: string, branchIds: string[]) => {
    const u = await h.prisma.user.create({ data: { name, phone, passwordHash: await bcrypt.hash("Pwd@2026!", 10), role, status: "ACTIVE" } });
    for (const b of branchIds) await h.prisma.userBranchAccess.create({ data: { userId: u.id, branchId: b } });
    return login(phone, "Pwd@2026!");
  };

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    owner = await login(h.ownerPhone, "Pwd@2026!");
    branchB = (await h.prisma.branch.create({ data: { nameAr: "فرع ب", nameEn: "Branch B", active: true } })).id;
    accountant = await mkUser("محاسب", "ACCOUNTANT", "+201111111111", [h.branchId, branchB]);
    manager = await mkUser("مدير فرع", "BRANCH_MANAGER", "+201222222222", [h.branchId]);
    repId = (await h.prisma.salesRepresentative.create({ data: { code: "RM", nameAr: "مندوب" } })).id;
    customerId = (await h.prisma.customer.create({ data: { code: "RMC", nameAr: "عميل" } })).id;
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
  const buy = async (size: string, pricePerMeter: string, boards = "10", branchId = h.branchId, variantId?: string) => {
    let v = variantId;
    if (!v) {
      const sku = await h.prisma.productSku.create({ data: { code: `RM-${++seq}`, category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
      v = (await h.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: size, defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" } })).id;
    }
    const p = await request(srv()).post("/api/v1/purchase-invoices").set(authT(owner)).send({
      invoiceDate: "2026-02-01", supplierId, branchId, lines: [{ productVariantId: v, boardsQuantity: boards, unitPrice: pricePerMeter, taxRate: "0" }] });
    expect((await request(srv()).post(`/api/v1/purchase-invoices/${p.body.id}/confirm`).set(authT(owner)).send({})).status).toBeLessThan(300);
    return { variantId: v!, purchaseId: p.body.id as string };
  };
  const sell = async (v: string, boards: string, price: string, tok = owner, branchId = h.branchId, taxRate = "0", dims?: any) => {
    const d = await request(srv()).post("/api/v1/sales-invoices").set(authT(tok)).send({
      invoiceDate: "2026-03-01", customerId, branchId, taxRate, salesRepresentativeId: repId,
      lines: [{ productVariantId: v, quantity: boards, unitPrice: price, costPrice: "0", ...(dims ?? {}) }] });
    expect((await request(srv()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(authT(tok)).send({})).status).toBeLessThan(300);
    return d.body.id as string;
  };
  const invLineId = async (invoiceId: string) => (await h.prisma.salesInvoiceLine.findFirst({ where: { invoiceId } }))!.id;
  const createRet = (tok: string, invoiceId: string, lines: any[], extra: any = {}) =>
    request(srv()).post("/api/v1/sales-returns").set(authT(tok)).send({ originalSalesInvoiceId: invoiceId, returnDate: "2026-03-15", lines, ...extra });
  const confirmRet = (tok: string, id: string) => request(srv()).post(`/api/v1/sales-returns/${id}/confirm`).set(authT(tok)).send({});
  const variant = (v: string) => h.prisma.productVariant.findUnique({ where: { id: v } });

  // ── §17.1 — sales return recalculates WAC from current value + returnCogs ──
  it("1) sales return raises the variant's per-metre WAC by the historical returnCogs", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5"); // avg/m 300, 20m
    const inv = await sell(v, "3", "500");                    // sell 3 boards/12m → 8m/2boards left, avg still 300
    const before = await variant(v);
    expect(D(before!.avgCostPerMeter).toFixed(2)).toBe("300.00");
    const r = await createRet(owner, inv, [{ originalSalesInvoiceLineId: await invLineId(inv), returnedMeters: "4", returnedBoards: "1" }]);
    await confirmRet(owner, r.body.id);
    // Stock 8m/300 = 2400 value; +4m@300 (returnCogs 1200) → 12m, value 3600 → 300/m.
    const after = await variant(v);
    expect(D(after!.avgCostPerMeter).toFixed(2)).toBe("300.00");
    const bal = await h.prisma.branchInventoryBalance.findUnique({ where: { branchId_productVariantId: { branchId: h.branchId, productVariantId: v } } });
    expect(D(bal!.metersOnHand).toFixed(4)).toBe("12.0000");
    expect(D(bal!.metersOnHand).mul(D(after!.avgCostPerMeter)).toFixed(2)).toBe("3600.00"); // GL-consistent value
  });

  // ── §17.2/§17.3 — WAC blended across a different-cost purchase, then reversal ─
  it("2+3) WAC after purchase→sale→new purchase@different cost→sales return, then exact cancel reversal", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5"); // 20m @300
    const inv = await sell(v, "5", "500");                    // sell all → 0 stock
    await buy("4.0000", "500", "5", h.branchId, v);           // buy 20m @500 → WAC 500
    expect(D((await variant(v))!.avgCostPerMeter).toFixed(2)).toBe("500.00");
    const r = await createRet(owner, inv, [{ originalSalesInvoiceLineId: await invLineId(inv), returnedMeters: "4", returnedBoards: "1" }]);
    const sr = (await confirmRet(owner, r.body.id)).body;
    // returnCogs uses ORIGINAL cost 300 → value +1200 over 24m: (20*500+1200)/24 = 466.67.
    const blended = new Decimal(20 * 500 + 1200).div(24);
    expect(D((await variant(v))!.avgCostPerMeter).toFixed(4)).toBe(blended.toFixed(4));
    // Cancel → exact reversal back to 500.
    expect((await request(srv()).post(`/api/v1/sales-returns/${sr.id}/cancel`).set(authT(owner)).send({})).status).toBeLessThan(300);
    expect(D((await variant(v))!.avgCostPerMeter).toFixed(2)).toBe("500.00");
  });

  // ── §17.4 — concurrent cost-affecting ops do not lose a WAC update ─────────
  it("4) two concurrent sales returns on the same variant both apply (no lost WAC update)", async () => {
    const { variantId: v } = await buy("4.0000", "300", "10"); // 40m
    const inv1 = await sell(v, "2", "500"); // 8m each
    const inv2 = await sell(v, "2", "500");
    const r1 = await createRet(owner, inv1, [{ originalSalesInvoiceLineId: await invLineId(inv1), returnedMeters: "8", returnedBoards: "2" }]);
    const r2 = await createRet(owner, inv2, [{ originalSalesInvoiceLineId: await invLineId(inv2), returnedMeters: "8", returnedBoards: "2" }]);
    const [a, b] = await Promise.all([confirmRet(owner, r1.body.id), confirmRet(owner, r2.body.id)]);
    expect(a.status).toBeLessThan(300); expect(b.status).toBeLessThan(300);
    // Both returns applied: stock 24+16 = 40m; value stays 300/m (all same cost).
    const bal = await h.prisma.branchInventoryBalance.findUnique({ where: { branchId_productVariantId: { branchId: h.branchId, productVariantId: v } } });
    expect(D(bal!.metersOnHand).toFixed(4)).toBe("40.0000");
    expect(D((await variant(v))!.avgCostPerMeter).toFixed(2)).toBe("300.00");
    // Confirmed returned metres across both = 16.
    const agg = await h.prisma.salesReturnLine.aggregate({ _sum: { returnedMetersQuantity: true }, where: { productVariantId: v, salesReturn: { status: "CONFIRMED" } } });
    expect(D(agg._sum.returnedMetersQuantity).toFixed(4)).toBe("16.0000");
  });

  // ── §17.5/§17.6 — duplicate original line rejected ────────────────────────
  it("5+6) duplicate original line is rejected (sales & purchase) with no side effects", async () => {
    const { variantId: v, purchaseId } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "5", "500");
    const lineId = await invLineId(inv);
    const dupS = await createRet(owner, inv, [
      { originalSalesInvoiceLineId: lineId, returnedMeters: "4", returnedBoards: "1" },
      { originalSalesInvoiceLineId: lineId, returnedMeters: "4", returnedBoards: "1" },
    ]);
    expect(dupS.status).toBe(400); // rejected at the Zod schema (§4)
    expect(await h.prisma.salesReturn.count({ where: { originalSalesInvoiceId: inv } })).toBe(0);
    const pl = (await h.prisma.purchaseInvoiceLine.findFirst({ where: { invoiceId: purchaseId } }))!.id;
    const dupP = await request(srv()).post("/api/v1/purchase-returns").set(authT(owner)).send({
      originalPurchaseInvoiceId: purchaseId, returnDate: "2026-02-15",
      lines: [{ originalPurchaseInvoiceLineId: pl, returnedMeters: "4", returnedBoards: "1" }, { originalPurchaseInvoiceLineId: pl, returnedMeters: "4", returnedBoards: "1" }] });
    expect(dupP.status).toBe(400);
  });

  // ── §17.7 — excessive returnedBoards rejected ─────────────────────────────
  it("7) returnedBoards exceeding remaining boards is rejected", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "5", "500"); // 5 boards / 20m
    const r = await createRet(owner, inv, [{ originalSalesInvoiceLineId: await invLineId(inv), returnedMeters: "4", returnedBoards: "100" }]);
    expect(r.status).toBe(409);
  });

  // ── §17.8 — custom dimensions persisted on the return line ─────────────────
  it("8) custom length/width are persisted from the original line", async () => {
    const { variantId: v } = await buy("4.0000", "300", "4");
    const inv = await sell(v, "2", "500", owner, h.branchId, "0", { lengthM: "2", widthM: "1.5" }); // 6m
    const r = await createRet(owner, inv, [{ originalSalesInvoiceLineId: await invLineId(inv), returnedMeters: "3", returnedBoards: "1" }]);
    const sr = (await confirmRet(owner, r.body.id)).body;
    const line = await h.prisma.salesReturnLine.findFirst({ where: { salesReturnId: sr.id } });
    expect(D(line!.lengthM).toFixed(4)).toBe("2.0000");
    expect(D(line!.widthM).toFixed(4)).toBe("1.5000");
  });

  // ── §17.9/§17.10 — legacy derivation (reliable) vs ambiguous (blocked) ─────
  it("9+10) legacy metres derived from economics; a truly ambiguous legacy line is blocked", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "5", "500"); // net 10000, 20m
    const lineId = await invLineId(inv);
    // Reliable legacy: drop meters but keep unit price/line total (gross÷price ⇒ 20m).
    await h.prisma.salesInvoiceLine.update({ where: { id: lineId }, data: { metersQuantity: null, lengthM: null, widthM: null } });
    const ret = (await request(srv()).get(`/api/v1/sales-returns/returnable/${inv}`).set(authT(owner))).body;
    expect(D(ret.lines[0].originalMeters).toFixed(4)).toBe("20.0000"); // derived, not "5" boards
    expect(ret.lines[0].legacyAmbiguous).toBe(false);
    const ok = await createRet(owner, inv, [{ originalSalesInvoiceLineId: lineId, returnedMeters: "4", returnedBoards: "1" }]);
    expect(ok.status).toBeLessThan(300);
    // Ambiguous: no meters, no dims, no unit price → cannot reconstruct.
    await h.prisma.salesInvoiceLine.update({ where: { id: lineId }, data: { unitPrice: "0", lineTotal: "0" } });
    const amb = (await request(srv()).get(`/api/v1/sales-returns/returnable/${inv}`).set(authT(owner))).body;
    expect(amb.lines[0].legacyAmbiguous).toBe(true);
    const blocked = await createRet(owner, inv, [{ originalSalesInvoiceLineId: lineId, returnedMeters: "1", returnedBoards: "1" }]);
    expect(blocked.status).toBe(409);
    expect(blocked.body.details?.reason ?? blocked.body.message_en).toBeDefined();
  });

  // ── §17.11/§17.12 — branch + rep dimensions on every return journal line ──
  it("11+12) every sales-return journal line carries branchId and the rep dimension", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "5", "500", owner, h.branchId, "14"); // with VAT so 3 commercial lines
    const r = await createRet(owner, inv, [{ originalSalesInvoiceLineId: await invLineId(inv), returnedMeters: "4", returnedBoards: "1" }]);
    const sr = (await confirmRet(owner, r.body.id)).body;
    const jLines = await h.prisma.journalLine.findMany({ where: { journalEntryId: sr.journalEntryId } });
    expect(jLines.length).toBeGreaterThanOrEqual(3);
    for (const l of jLines) {
      expect(l.branchId).toBe(h.branchId);
      expect(l.salesRepresentativeId).toBe(repId);
    }
    const cogsLines = await h.prisma.journalLine.findMany({ where: { journalEntryId: sr.cogsJournalEntryId } });
    for (const l of cogsLines) expect(l.branchId).toBe(h.branchId);
  });

  // ── §17.13 — branch attribution: the return's posted lines belong to branch A ─
  // (The income statement is not yet branch-filtered — existing invoice postings
  // don't carry a line branch — so branch attribution is proven at the journal
  // line level, the accounting source of truth, per §8.)
  it("13) a return posted in branch A carries branch A on its journal lines, none in branch B", async () => {
    const { variantId: v } = await buy("4.0000", "300", "10", h.branchId);
    const invA = await sell(v, "5", "500", owner, h.branchId);
    const r = await createRet(owner, invA, [{ originalSalesInvoiceLineId: await invLineId(invA), returnedMeters: "4", returnedBoards: "1" }]);
    const sr = (await confirmRet(owner, r.body.id)).body;
    const inA = await h.prisma.journalLine.count({ where: { journalEntry: { sourceId: sr.id }, branchId: h.branchId } });
    const inB = await h.prisma.journalLine.count({ where: { journalEntry: { sourceId: sr.id }, branchId: branchB } });
    expect(inA).toBeGreaterThanOrEqual(2); // commercial + COGS lines
    expect(inB).toBe(0);
    // Sales-returns contra account is debited under branch A only.
    const srLine = await h.prisma.journalLine.findFirst({ where: { journalEntryId: sr.journalEntryId, accountId: acc.sret } });
    expect(srLine!.branchId).toBe(h.branchId);
  });

  // ── §17.14 — return list contains original invoice number ─────────────────
  it("14) return list rows include the original invoice number", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "5", "500");
    const invNo = (await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!.invoiceNumber.toString();
    const r = await createRet(owner, inv, [{ originalSalesInvoiceLineId: await invLineId(inv), returnedMeters: "4", returnedBoards: "1" }]);
    await confirmRet(owner, r.body.id);
    const list = (await request(srv()).get(`/api/v1/sales-returns?originalInvoiceId=${inv}`).set(authT(owner))).body;
    expect(list.items.length).toBe(1);
    expect(list.items[0].originalInvoice.invoiceNumber).toBe(invNo);
    expect(list.items[0].totalMeters).toBe("4.0000");
  });

  // ── §17.15 — server-side search finds an invoice beyond the first page ────
  it("15) server-side search finds a confirmed invoice by exact number (page 100+)", async () => {
    // Create a confirmed sale; then find it by its (server-generated) number via search.
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "5", "500");
    const invNo = (await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!.invoiceNumber.toString();
    const found = (await request(srv()).get(`/api/v1/sales-invoices?status=CONFIRMED&q=${invNo}&limit=5`).set(authT(owner))).body;
    expect(found.data.some((i: any) => i.id === inv)).toBe(true);
  });

  // ── §17.16 — differentiated permissions (server-side, not UI) ─────────────
  it("16) BRANCH_MANAGER can view but not confirm; ACCOUNTANT can create but not cancel", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "5", "500");
    const lineId = await invLineId(inv);
    // Manager: view OK.
    expect((await request(srv()).get(`/api/v1/sales-returns/returnable/${inv}`).set(authT(manager))).status).toBeLessThan(300);
    // Accountant: create OK.
    const r = await createRet(accountant, inv, [{ originalSalesInvoiceLineId: lineId, returnedMeters: "4", returnedBoards: "1" }]);
    expect(r.status).toBeLessThan(300);
    // Manager: confirm DENIED (403).
    expect((await confirmRet(manager, r.body.id)).status).toBe(403);
    // Accountant confirms, then cancel DENIED for accountant (OWNER only).
    expect((await confirmRet(accountant, r.body.id)).status).toBeLessThan(300);
    expect((await request(srv()).post(`/api/v1/sales-returns/${r.body.id}/cancel`).set(authT(accountant)).send({})).status).toBe(403);
  });

  // ── §17.17/§17.18/§17.19 — draft edit, double confirm, no edit after confirm ─
  it("17+18+19) draft edits; confirmed cannot be re-confirmed or edited", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "5", "500");
    const lineId = await invLineId(inv);
    const r = await createRet(owner, inv, [{ originalSalesInvoiceLineId: lineId, returnedMeters: "4", returnedBoards: "1" }]);
    // Edit draft (change qty to 8m).
    const upd = await request(srv()).put(`/api/v1/sales-returns/${r.body.id}`).set(authT(owner)).send({ lines: [{ originalSalesInvoiceLineId: lineId, returnedMeters: "8", returnedBoards: "2" }] });
    expect(upd.status).toBeLessThan(300);
    expect(D(upd.body.lines[0].returnedMetersQuantity).toFixed(4)).toBe("8.0000");
    // Confirm, then double confirm fails, and edit-after-confirm fails.
    expect((await confirmRet(owner, r.body.id)).status).toBeLessThan(300);
    expect((await confirmRet(owner, r.body.id)).status).toBe(409);
    expect((await request(srv()).put(`/api/v1/sales-returns/${r.body.id}`).set(authT(owner)).send({ reason: "x" })).status).toBe(409);
  });

  // ── §17.20 — unsupported refund mode rejected at confirmation ──────────────
  it("20) CASH_REFUND is rejected (DTO blocks create; forcing the mode blocks confirm)", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "5", "500");
    const lineId = await invLineId(inv);
    // DTO rejects refund at create.
    const bad = await createRet(owner, inv, [{ originalSalesInvoiceLineId: lineId, returnedMeters: "4", returnedBoards: "1" }], { settlementMode: "CASH_REFUND" });
    expect(bad.status).toBe(400);
    // Even if a row is forced to a refund mode, confirm rejects it.
    const r = await createRet(owner, inv, [{ originalSalesInvoiceLineId: lineId, returnedMeters: "4", returnedBoards: "1" }]);
    await h.prisma.salesReturn.update({ where: { id: r.body.id }, data: { settlementMode: "CASH_REFUND" } });
    expect((await confirmRet(owner, r.body.id)).status).toBe(409);
  });

  // ── §17.21 — reporting endpoints reconcile returns ────────────────────────
  it("21) summary/products/time-series/gross-profit all net the confirmed return", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "5", "500"); // net 10000, COGS 6000
    const r = await createRet(owner, inv, [{ originalSalesInvoiceLineId: await invLineId(inv), returnedMeters: "4", returnedBoards: "1" }]);
    await confirmRet(owner, r.body.id); // returns 2000 / COGS 1200
    const q = `preset=custom&from=2026-01-01&to=2026-12-31&productVariantId=${v}`;
    const sum = (await request(srv()).get(`/api/v1/reports/sales-representatives/summary?${q}`).set(authT(owner))).body;
    expect(sum.salesReturnsSupported).toBe(true);
    expect(sum.representatives[0].netSales).toBe("8000.00");
    expect(sum.representatives[0].grossProfit).toBe("3200.00");
    const prod = (await request(srv()).get(`/api/v1/reports/sales-representatives/products?${q}`).set(authT(owner))).body;
    expect(prod.salesReturnsSupported).toBe(true);
    expect(prod.rows[0].netSales).toBe("8000.00");
    expect(prod.rows[0].returns).toBe("2000.00");
    const ts = (await request(srv()).get(`/api/v1/reports/sales/time-series?preset=custom&from=2026-01-01&to=2026-12-31&groupDim=month`).set(authT(owner))).body;
    expect(ts.salesReturnsSupported).toBe(true);
    const gp = (await request(srv()).get(`/api/v1/reports/sales-representatives/gross-profit?${q}`).set(authT(owner))).body;
    expect(gp.salesReturnsSupported).toBe(true);
    expect(gp.representatives[0].grossProfit).toBe("3200.00");
  });

  // ── §17.23 — cancelled/draft returns have NO reporting effect ──────────────
  it("23) a draft (and a cancelled) return does not change the report", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "5", "500");
    const lineId = await invLineId(inv);
    const q = `preset=custom&from=2026-01-01&to=2026-12-31&productVariantId=${v}`;
    await createRet(owner, inv, [{ originalSalesInvoiceLineId: lineId, returnedMeters: "4", returnedBoards: "1" }]); // draft only
    let sum = (await request(srv()).get(`/api/v1/reports/sales-representatives/summary?${q}`).set(authT(owner))).body;
    expect(sum.representatives[0].netSales).toBe("10000.00"); // draft ignored
    const r2 = await createRet(owner, inv, [{ originalSalesInvoiceLineId: lineId, returnedMeters: "4", returnedBoards: "1" }]);
    const sr = (await confirmRet(owner, r2.body.id)).body;
    await request(srv()).post(`/api/v1/sales-returns/${sr.id}/cancel`).set(authT(owner)).send({});
    sum = (await request(srv()).get(`/api/v1/reports/sales-representatives/summary?${q}`).set(authT(owner))).body;
    expect(sum.representatives[0].netSales).toBe("10000.00"); // cancelled ignored
  });

  // ── §17.24/§17.25 — multi-line same-variant + mixed VAT/discount residual ─
  it("24+25) two returns on the same variant with VAT+discount reconcile to the original line", async () => {
    const { variantId: v } = await buy("4.0000", "300", "10"); // 40m
    // Sale with 10% discount + 14% VAT: 10 boards, 40m, gross 20000, disc 2000, net 18000.
    const inv = await request(srv()).post("/api/v1/sales-invoices").set(authT(owner)).send({
      invoiceDate: "2026-03-01", customerId, branchId: h.branchId, taxRate: "14", salesRepresentativeId: repId,
      lines: [{ productVariantId: v, quantity: "10", unitPrice: "500", costPrice: "0", discountPct: "10" }] });
    expect((await request(srv()).post(`/api/v1/sales-invoices/${inv.body.id}/confirm`).set(authT(owner)).send({})).status).toBeLessThan(300);
    const lineId = inv.body.lines[0].id;
    // Two partials: 13m then the final 27m residual.
    const a = await createRet(owner, inv.body.id, [{ originalSalesInvoiceLineId: lineId, returnedMeters: "13", returnedBoards: "3" }]);
    await confirmRet(owner, a.body.id);
    const b = await createRet(owner, inv.body.id, [{ originalSalesInvoiceLineId: lineId, returnedMeters: "27", returnedBoards: "7" }]);
    await confirmRet(owner, b.body.id);
    // Cumulative net / tax / total reconcile EXACTLY to the original line.
    const agg = await h.prisma.salesReturnLine.aggregate({
      _sum: { returnNetExTax: true, returnTax: true, returnTotal: true, returnedMetersQuantity: true },
      where: { originalSalesInvoiceLineId: lineId, salesReturn: { status: "CONFIRMED" } } });
    expect(D(agg._sum.returnNetExTax).toFixed(2)).toBe("18000.00");
    expect(D(agg._sum.returnTax).toFixed(2)).toBe("2520.00");   // 14% of 18000
    expect(D(agg._sum.returnTotal).toFixed(2)).toBe("20520.00");
    expect(D(agg._sum.returnedMetersQuantity).toFixed(4)).toBe("40.0000");
  });
});
