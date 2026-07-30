/**
 * Sales-return posting depends on the effective PostingProfile carrying a
 * Sales-Returns (contra-revenue) account. This proves:
 *   1. a valid return CANNOT confirm while that account is unset (409, structured
 *      reason, nothing posted, draft preserved),
 *   2. once the account is appended THROUGH THE API it confirms and posts to
 *      exactly that account with the party/VAT/COGS legs intact and balanced,
 *   3. an invalid account (inactive / non-leaf / wrong category) is rejected by
 *      the posting-profile API,
 *   4. purchase returns are unaffected.
 * LOCAL test schema only (TEST_DATABASE_URL).
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

const D = (v: unknown) => new Decimal((v as { toString(): string }).toString());

describe("posting profile — sales returns account", () => {
  let h: TestApp;
  let token: string;
  let customerId: string, supplierId: string;
  const acc: Record<string, string> = {};
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const srv = () => h.app.getHttpServer();

  const mkAccount = async (code: string, nameAr: string, cat: any, t: any, opts: { active?: boolean; isLeaf?: boolean } = {}) =>
    (await h.prisma.account.create({ data: { code, nameAr, nameEn: code, category: cat, accountType: t, active: opts.active ?? true, isLeaf: opts.isLeaf ?? true } })).id;

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(srv()).post("/api/v1/auth/login").send({ phone: h.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    customerId = (await h.prisma.customer.create({ data: { code: "PPC", nameAr: "عميل" } })).id;
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "S" } })).id;
    const u = Date.now().toString().slice(-6);
    acc.ar = await mkAccount(`AR${u}`, "ذمم", "ASSET", "CURRENT_ASSET");
    acc.ap = await mkAccount(`AP${u}`, "دائنون", "LIABILITY", "LIABILITY");
    acc.rev = await mkAccount(`RV${u}`, "إيراد", "REVENUE", "REVENUE");
    acc.sret = await mkAccount(`SR${u}`, "مردودات المبيعات", "REVENUE", "REVENUE"); // valid contra-revenue
    acc.vatO = await mkAccount(`VO${u}`, "ض مخرجات", "LIABILITY", "LIABILITY");
    acc.vatI = await mkAccount(`VI${u}`, "ض مدخلات", "ASSET", "CURRENT_ASSET");
    acc.cogs = await mkAccount(`CG${u}`, "تكلفة", "COST_OF_SALES", "COST_OF_SALES");
    acc.inv = await mkAccount(`IN${u}`, "مخزون", "ASSET", "CURRENT_ASSET");
    acc.revParent = await mkAccount(`RVP${u}`, "إيرادات (أب)", "REVENUE", "REVENUE", { isLeaf: false });
    acc.revInactive = await mkAccount(`RVX${u}`, "إيراد موقوف", "REVENUE", "REVENUE", { active: false });

    // The effective profile INITIALLY has NO sales-returns account (the bug).
    await h.prisma.postingProfile.create({ data: {
      effectiveFrom: new Date("2026-01-01"), arAccountId: acc.ar, apAccountId: acc.ap, revenueAccountId: acc.rev,
      vatOutputAccountId: acc.vatO, vatInputAccountId: acc.vatI, cogsAccountId: acc.cogs, inventoryAccountId: acc.inv,
      createdBy: h.ownerId,
    } });
    for (let m = 1; m <= 12; m++) await h.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });
  });
  afterAll(async () => teardownTestApp(h));

  let seq = 0;
  const buy = async (size: string, pricePerMeter: string, boards = "10") => {
    const sku = await h.prisma.productSku.create({ data: { code: `PP-${++seq}`, category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
    const v = (await h.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: size, defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" } })).id;
    const p = await request(srv()).post("/api/v1/purchase-invoices").set(auth()).send({
      invoiceDate: "2026-02-01", supplierId, branchId: h.branchId,
      lines: [{ productVariantId: v, boardsQuantity: boards, unitPrice: pricePerMeter, taxRate: "0" }],
    });
    expect((await request(srv()).post(`/api/v1/purchase-invoices/${p.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);
    return { variantId: v, purchaseId: p.body.id as string };
  };
  const sell = async (v: string, boards: string, price: string, taxRate = "14") => {
    const d = await request(srv()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-03-01", customerId, branchId: h.branchId, taxRate,
      lines: [{ productVariantId: v, quantity: boards, unitPrice: price, costPrice: "0" }],
    });
    expect((await request(srv()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);
    return d.body.id as string;
  };
  const saleLineId = async (invoiceId: string) => (await h.prisma.salesInvoiceLine.findFirst({ where: { invoiceId } }))!.id;
  const draftSaleReturn = async (invoiceId: string, lineId: string, boards: string) =>
    request(srv()).post("/api/v1/sales-returns").set(auth()).send({
      originalSalesInvoiceId: invoiceId, returnDate: "2026-03-15",
      lines: [{ originalSalesInvoiceLineId: lineId, returnedBoards: boards }],
    });
  const confirmSale = (id: string) => request(srv()).post(`/api/v1/sales-returns/${id}/confirm`).set(auth()).send({});
  const jline = (entryId: string, accountId: string) => h.prisma.journalLine.findFirst({ where: { journalEntryId: entryId, accountId } });

  // Full posting-profile body (all legs), so appending a version doesn't drop
  // the other accounts the confirm also needs.
  const fullProfile = (extra: Record<string, unknown>) => ({
    effectiveFrom: "2026-01-01",
    arAccountId: acc.ar, apAccountId: acc.ap, revenueAccountId: acc.rev,
    vatOutputAccountId: acc.vatO, vatInputAccountId: acc.vatI, cogsAccountId: acc.cogs, inventoryAccountId: acc.inv,
    ...extra,
  });

  it("1) a valid sales return cannot confirm while salesReturnsAccountId is NULL", async () => {
    const { variantId: v } = await buy("5.25", "500", "10");
    const inv = await sell(v, "7", "1000");
    const lineId = await saleLineId(inv);
    const draft = await draftSaleReturn(inv, lineId, "7");
    expect(draft.status).toBeLessThan(300);
    const before = await h.prisma.journalEntry.count();

    const res = await confirmSale(draft.body.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("validation_failed");
    expect(res.body.details.reason).toBe("sales_returns_account_required");

    // Nothing posted; the draft is preserved.
    expect(await h.prisma.journalEntry.count()).toBe(before);
    const still = await h.prisma.salesReturn.findUnique({ where: { id: draft.body.id } });
    expect(still!.status).toBe("DRAFT");
    expect(still!.journalEntryId).toBeNull();
  });

  it("3) an invalid account is rejected as salesReturnsAccountId (inactive / non-leaf / wrong category)", async () => {
    for (const bad of [acc.revInactive, acc.revParent, acc.ar /* ASSET */]) {
      const r = await request(srv()).post("/api/v1/settings/posting-profiles").set(auth()).send(fullProfile({ salesReturnsAccountId: bad }));
      expect(r.status).toBe(409);
      expect(r.body.details.reason).toBe("invalid_sales_returns_account");
    }
  });

  it("2) after appending a valid sales-returns account via the API, the return confirms and posts to it", async () => {
    // Append a NEW profile version (same effective date) carrying the account —
    // the resolver's createdAt tiebreaker makes this the one in force.
    const created = await request(srv()).post("/api/v1/settings/posting-profiles").set(auth()).send(fullProfile({ salesReturnsAccountId: acc.sret }));
    expect(created.status).toBeLessThan(300);
    expect(created.body.salesReturnsAccountId).toBe(acc.sret);

    const { variantId: v } = await buy("5.25", "500", "10");
    const inv = await sell(v, "7", "1000"); // 7 boards × 5.25 = 36.75 m; net 36750; VAT 14% = 5145; COGS 7×5.25×500 = 18375
    const lineId = await saleLineId(inv);
    const draft = await draftSaleReturn(inv, lineId, "7");
    const sr = (await confirmSale(draft.body.id)).body;
    expect(D(sr.grandTotal).toFixed(2)).toBe("41895.00");

    // Commercial entry: Dr Sales-Returns (net), Dr VAT-output (tax), Cr AR (gross, CUSTOMER party).
    const sretLine = await jline(sr.journalEntryId, acc.sret);
    expect(D(sretLine!.debit).toFixed(2)).toBe("36750.00");
    const vatLine = await jline(sr.journalEntryId, acc.vatO);
    expect(D(vatLine!.debit).toFixed(2)).toBe("5145.00");
    const arLine = await jline(sr.journalEntryId, acc.ar);
    expect(D(arLine!.credit).toFixed(2)).toBe("41895.00");
    expect(arLine!.partyType).toBe("CUSTOMER");
    expect(arLine!.partyId).toBe(customerId);
    // Balanced commercial entry.
    const agg = await h.prisma.journalLine.aggregate({ _sum: { debit: true, credit: true }, where: { journalEntryId: sr.journalEntryId } });
    expect(D(agg._sum.debit).toFixed(2)).toBe(D(agg._sum.credit).toFixed(2));
    // COGS reversal entry unchanged: Dr Inventory / Cr COGS 18375.
    expect(D((await jline(sr.cogsJournalEntryId, acc.inv))!.debit).toFixed(2)).toBe("18375.00");
    expect(D((await jline(sr.cogsJournalEntryId, acc.cogs))!.credit).toFixed(2)).toBe("18375.00");
  });

  it("4) purchase returns are unaffected by the sales-returns account", async () => {
    const { variantId: v, purchaseId } = await buy("5.25", "500", "10");
    const lineId = (await h.prisma.purchaseInvoiceLine.findFirst({ where: { invoiceId: purchaseId } }))!.id;
    const draft = await request(srv()).post("/api/v1/purchase-returns").set(auth()).send({
      originalPurchaseInvoiceId: purchaseId, returnDate: "2026-02-15",
      lines: [{ originalPurchaseInvoiceLineId: lineId, returnedBoards: "1" }],
    });
    const pr = await request(srv()).post(`/api/v1/purchase-returns/${draft.body.id}/confirm`).set(auth()).send({});
    expect(pr.status).toBeLessThan(300);
    expect(D(pr.body.grandTotal).toFixed(2)).toBe("2625.00"); // 1 × 5.25 × 500
  });
});
