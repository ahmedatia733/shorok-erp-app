/**
 * WHOLE-BOARD returns — the boards-only quantity policy (this task).
 *
 * Boards are the ONE quantity authority: the user enters whole boards; the
 * server derives metres = boards × board size, prices from the ORIGINAL invoice
 * line, reverses VAT proportionally, and posts the customer/supplier party line.
 * A board cut below its full size cannot be returned. Everything runs against a
 * dedicated LOCAL test schema (TEST_DATABASE_URL) — never production.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

const D = (v: unknown) => new Decimal((v as { toString(): string }).toString());

describe("whole-board returns", () => {
  let h: TestApp;
  let token: string;
  let customerId: string, supplierId: string;
  const acc: Record<string, string> = {};
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const srv = () => h.app.getHttpServer();

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(srv()).post("/api/v1/auth/login").send({ phone: h.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    customerId = (await h.prisma.customer.create({ data: { code: "WBC", nameAr: "عميل الألواح" } })).id;
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: "مورد الألواح", nameEn: "WB Supplier" } })).id;
    const u = Date.now().toString().slice(-6);
    const mk = async (k: string, code: string, cat: any, t: any, role?: string) => {
      acc[k] = (await h.prisma.account.create({ data: { code: `${code}${u}`, nameAr: code, nameEn: code, category: cat, accountType: t, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } })).id;
    };
    await mk("ar", "AR", "ASSET", "CURRENT_ASSET", "AR_CONTROL");
    await mk("ap", "AP", "LIABILITY", "LIABILITY", "AP_CONTROL");
    await mk("rev", "RV", "REVENUE", "REVENUE");
    await mk("sret", "SR", "REVENUE", "REVENUE");
    await mk("vatO", "VO", "LIABILITY", "LIABILITY");
    await mk("vatI", "VI", "ASSET", "CURRENT_ASSET");
    await mk("cogs", "CG", "COST_OF_SALES", "COST_OF_SALES");
    await mk("inv", "IN", "ASSET", "CURRENT_ASSET");
    await h.prisma.postingProfile.create({ data: {
      effectiveFrom: new Date("2026-01-01"), arAccountId: acc.ar, apAccountId: acc.ap, revenueAccountId: acc.rev,
      salesReturnsAccountId: acc.sret, vatOutputAccountId: acc.vatO, vatInputAccountId: acc.vatI,
      cogsAccountId: acc.cogs, inventoryAccountId: acc.inv, createdBy: h.ownerId,
    } });
    for (let m = 1; m <= 12; m++) await h.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });
  });
  afterAll(async () => teardownTestApp(h));

  let seq = 0;
  const buy = async (size: string, pricePerMeter: string, boards = "10") => {
    const sku = await h.prisma.productSku.create({ data: { code: `WB-${++seq}`, category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
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
      invoiceDate: "2026-03-01", customerId, branchId: h.branchId, taxRate,
      lines: [{ productVariantId: v, quantity: boards, unitPrice: price, costPrice: "0", ...(dims ?? {}) }],
    });
    expect((await request(srv()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);
    return d.body.id as string;
  };
  const invLineId = async (invoiceId: string) => (await h.prisma.salesInvoiceLine.findFirst({ where: { invoiceId } }))!.id;
  const pInvLineId = async (invoiceId: string) => (await h.prisma.purchaseInvoiceLine.findFirst({ where: { invoiceId } }))!.id;
  const salesReturnable = async (inv: string) => (await request(srv()).get(`/api/v1/sales-returns/returnable/${inv}`).set(auth())).body;

  const createSaleRet = (invoiceId: string, lineId: string, body: Record<string, unknown>, taxHint = "0") =>
    request(srv()).post("/api/v1/sales-returns").set(auth()).send({
      originalSalesInvoiceId: invoiceId, returnDate: "2026-03-15",
      lines: [{ originalSalesInvoiceLineId: lineId, ...body }],
    });
  const confirmSale = (id: string) => request(srv()).post(`/api/v1/sales-returns/${id}/confirm`).set(auth()).send({});
  const createPurchaseRet = (invoiceId: string, lineId: string, body: Record<string, unknown>) =>
    request(srv()).post("/api/v1/purchase-returns").set(auth()).send({
      originalPurchaseInvoiceId: invoiceId, returnDate: "2026-02-15",
      lines: [{ originalPurchaseInvoiceLineId: lineId, ...body }],
    });
  const confirmPurchase = (id: string) => request(srv()).post(`/api/v1/purchase-returns/${id}/confirm`).set(auth()).send({});
  const jline = async (entryId: string, accountId: string) =>
    h.prisma.journalLine.findFirst({ where: { journalEntryId: entryId, accountId } });

  // 1) One full sales board → returnedMeters = board size, derived server-side.
  it("returns one whole board and derives metres = board size (example 1/2)", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "2", "750", "14"); // price/board = 750×4 = 3000; VAT 14%
    const lineId = await invLineId(inv);

    const ret = await salesReturnable(inv);
    expect(ret.lines[0].metersPerBoard).toBe("4.0000");
    expect(ret.lines[0].boardSizeSource).toBe("variant");
    expect(ret.lines[0].eligibleWholeBoards).toBe("2");
    expect(ret.lines[0].maximumReturnableBoards).toBe("2");

    const sr = (await confirmSale((await createSaleRet(inv, lineId, { returnedBoards: "1" })).body.id)).body;
    expect(D(sr.lines[0].returnedBoards).toFixed(0)).toBe("1");
    expect(D(sr.lines[0].returnedMetersQuantity).toFixed(4)).toBe("4.0000"); // 1 × 4, derived
    expect(D(sr.lines[0].returnNetExTax).toFixed(2)).toBe("3000.00");        // 4 × 750
    expect(D(sr.lines[0].returnTax).toFixed(2)).toBe("420.00");              // 14% of 3000
    expect(D(sr.grandTotal).toFixed(2)).toBe("3420.00");                     // customer credit
  });

  // 2) Multiple boards → total metres = boards × size.
  it("returns multiple whole boards and totals the derived metres", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "5", "500");
    const lineId = await invLineId(inv);
    const sr = (await confirmSale((await createSaleRet(inv, lineId, { returnedBoards: "3" })).body.id)).body;
    expect(D(sr.lines[0].returnedMetersQuantity).toFixed(4)).toBe("12.0000"); // 3 × 4
  });

  // 5) Fractional boards are rejected at the DTO (400).
  it("rejects fractional returnedBoards (0.5 / 1.25 / 2.1)", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "5", "500");
    const lineId = await invLineId(inv);
    for (const b of ["0.5", "1.25", "2.1"]) {
      expect((await createSaleRet(inv, lineId, { returnedBoards: b })).status).toBe(400);
    }
  });

  // 6) A client-supplied returnedMeters is IGNORED — the server derives from boards.
  it("ignores a client-supplied returnedMeters and derives from boards", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "5", "500");
    const lineId = await invLineId(inv);
    // Lie: claim 999 metres while returning 1 board. Server must use 1×4 = 4.
    const sr = (await confirmSale((await createSaleRet(inv, lineId, { returnedBoards: "1", returnedMeters: "999" })).body.id)).body;
    expect(D(sr.lines[0].returnedMetersQuantity).toFixed(4)).toBe("4.0000");
    expect(D(sr.grandTotal).toFixed(2)).toBe("2000.00"); // 4 × 500, not 999-based
  });

  // 7/8) Boards above the eligible count are rejected; posted returns reduce it.
  it("rejects boards above the remaining eligible count and decrements it per posted return", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "3", "500");
    const lineId = await invLineId(inv);
    // Over the whole count.
    const over = await createSaleRet(inv, lineId, { returnedBoards: "4" });
    expect(over.status).toBe(409);
    expect(over.body.details.reason).toBe("returned_boards_exceed_remaining");
    // Post 2, then only 1 remains.
    expect((await confirmSale((await createSaleRet(inv, lineId, { returnedBoards: "2" })).body.id)).status).toBeLessThan(300);
    expect((await salesReturnable(inv)).lines[0].maximumReturnableBoards).toBe("1");
    expect((await createSaleRet(inv, lineId, { returnedBoards: "2" })).status).toBe(409); // only 1 left
  });

  // 11/12) A cut board (legacy aggregate data) is not returnable — only full boards.
  it("excludes a cut board: 3 boards recorded as 11 m² of a 4 m board → only 2 returnable", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "3", "500"); // metersQuantity persisted as 12
    const lineId = await invLineId(inv);
    // Simulate legacy aggregate data: one of the three boards was cut to 3 m² → 11 total.
    await h.prisma.salesInvoiceLine.update({ where: { id: lineId }, data: { metersQuantity: "11", lineTotal: "5500", lineCogsAtPosting: "3300", unitCostPerMeterAtPosting: "300" } });

    const ret = await salesReturnable(inv);
    expect(ret.lines[0].metersPerBoard).toBe("4.0000");         // full board size (variant)
    expect(ret.lines[0].eligibleWholeBoards).toBe("2");         // floor(11/4) = 2
    expect(ret.lines[0].maximumReturnableBoards).toBe("2");
    // The cut (3rd) board cannot be returned.
    expect((await createSaleRet(inv, lineId, { returnedBoards: "3" })).status).toBe(409);
    // The two full boards can.
    expect((await confirmSale((await createSaleRet(inv, lineId, { returnedBoards: "2" })).body.id)).status).toBeLessThan(300);
    expect((await salesReturnable(inv)).lines[0].maximumReturnableBoards).toBe("0");
    expect((await createSaleRet(inv, lineId, { returnedBoards: "1" })).body.details.reason).toBe("no_full_boards_available_for_return");
  });

  // 13) No reliable board size → structured error, no guess.
  it("blocks a line whose board size cannot be determined (return_board_size_unavailable)", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "2", "500");
    const lineId = await invLineId(inv);
    // Remove the only board-size sources: no dimensions and a zeroed variant size.
    await h.prisma.productVariant.update({ where: { id: v }, data: { sizeMetersPerBoard: "0" } });
    const r = await createSaleRet(inv, lineId, { returnedBoards: "1" });
    expect(r.status).toBe(409);
    expect(r.body.details.reason).toBe("return_board_size_unavailable");
  });

  // 14/16/17) Sales price from the ORIGINAL line (not current), discount kept, VAT reversed.
  it("prices a sales return from the original line (discount + VAT), never the current price", async () => {
    const { variantId: v } = await buy("4.0000", "300", "4");
    // 4 boards × 4 m = 16 m; price/m 500 → gross 8000; 10% line discount → net 7200; VAT 14%.
    const d = await request(srv()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-03-01", customerId, branchId: h.branchId, taxRate: "14",
      lines: [{ productVariantId: v, quantity: "4", unitPrice: "500", costPrice: "0", discountPct: "10" }],
    });
    expect((await request(srv()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);
    const inv = d.body.id, lineId = d.body.lines[0].id;
    // Change the master price AFTER the sale — must not affect the return.
    await h.prisma.productVariant.update({ where: { id: v }, data: { defaultSalePricePerMeter: "9999" } });

    // Return 1 of 4 boards → 1/4 of each amount: gross 2000, discount 200, net 1800, VAT 252.
    const sr = (await confirmSale((await createSaleRet(inv, lineId, { returnedBoards: "1" })).body.id)).body;
    expect(D(sr.lines[0].returnSubtotal).toFixed(2)).toBe("2000.00");
    expect(D(sr.lines[0].returnDiscount).toFixed(2)).toBe("200.00");
    expect(D(sr.lines[0].returnNetExTax).toFixed(2)).toBe("1800.00");
    expect(D(sr.lines[0].returnTax).toFixed(2)).toBe("252.00");
    expect(D(sr.grandTotal).toFixed(2)).toBe("2052.00");
  });

  // 21/23/25) Sales return AR line carries CUSTOMER party → appears once in the GL customer statement.
  it("posts the AR line with CUSTOMER partyType/partyId (customer subledger)", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "2", "500", "14");
    const lineId = await invLineId(inv);
    const sr = (await confirmSale((await createSaleRet(inv, lineId, { returnedBoards: "1" })).body.id)).body;
    const ar = await jline(sr.journalEntryId, acc.ar);
    expect(ar!.partyType).toBe("CUSTOMER");
    expect(ar!.partyId).toBe(customerId);
    expect(D(ar!.credit).gt(0)).toBe(true); // reduces the receivable
    // Exactly ONE AR party line for this return source.
    const count = await h.prisma.journalLine.count({ where: { accountId: acc.ar, partyId: customerId, journalEntry: { sourceId: sr.id } } });
    expect(count).toBe(1);
  });

  // 18/19/22/24/26) Purchase return: VAT input reversed, AP carries SUPPLIER party; zero-VAT reverses no VAT.
  it("purchase return reverses input VAT and posts the AP line with SUPPLIER partyType/partyId", async () => {
    // Buy with 14% VAT so there is input VAT to reverse.
    const sku = await h.prisma.productSku.create({ data: { code: `WBP-${++seq}`, category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
    const v = (await h.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: "4", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" } })).id;
    const p = await request(srv()).post("/api/v1/purchase-invoices").set(auth()).send({
      invoiceDate: "2026-02-01", supplierId, branchId: h.branchId,
      lines: [{ productVariantId: v, boardsQuantity: "10", unitPrice: "250", taxRate: "14" }], // 40 m × 250 = 10000, VAT 1400
    });
    expect((await request(srv()).post(`/api/v1/purchase-invoices/${p.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);
    const lineId = await pInvLineId(p.body.id);

    const pr = (await confirmPurchase((await createPurchaseRet(p.body.id, lineId, { returnedBoards: "1" })).body.id)).body;
    // 1 board = 4 m × 250 = 1000 net; VAT 140; supplier debit 1140.
    expect(D(pr.lines[0].returnedMetersQuantity).toFixed(4)).toBe("4.0000");
    expect(D(pr.subtotal).toFixed(2)).toBe("1000.00");
    expect(D(pr.taxTotal).toFixed(2)).toBe("140.00");
    expect(D(pr.grandTotal).toFixed(2)).toBe("1140.00");
    const ap = await jline(pr.journalEntryId, acc.ap);
    expect(ap!.partyType).toBe("SUPPLIER");
    expect(ap!.partyId).toBe(supplierId);
    expect(D(ap!.debit).gt(0)).toBe(true); // reduces the payable
    const vat = await jline(pr.journalEntryId, acc.vatI);
    expect(D(vat!.credit).toFixed(2)).toBe("140.00"); // input VAT reversed
    // Exactly one AP party line.
    expect(await h.prisma.journalLine.count({ where: { accountId: acc.ap, partyId: supplierId, journalEntry: { sourceId: pr.id } } })).toBe(1);
  });

  // 19) A zero-VAT sales line reverses zero VAT.
  it("a zero-VAT line returns zero VAT", async () => {
    const { variantId: v } = await buy("4.0000", "300", "5");
    const inv = await sell(v, "2", "500", "0"); // no tax
    const lineId = await invLineId(inv);
    const sr = (await confirmSale((await createSaleRet(inv, lineId, { returnedBoards: "1" })).body.id)).body;
    expect(D(sr.taxTotal).toFixed(2)).toBe("0.00");
    expect(await jline(sr.journalEntryId, acc.vatO)).toBeNull(); // no VAT line posted
  });
});
