/**
 * The GL-derived statement must expose enough metadata for the web to label and
 * link a return document (sourceType + sourceId + reference + party), WITHOUT
 * changing any money. Proves a sales return appears exactly once in the customer
 * statement (as SALES_RETURN, CUSTOMER party, GL amount) and a purchase return
 * exactly once in the supplier statement (PURCHASE_RETURN, SUPPLIER party), and
 * that statement totals are the GL math (invoice − return). LOCAL test schema.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

const D = (v: unknown) => new Decimal((v as { toString(): string }).toString());

describe("statement — return document links", () => {
  let h: TestApp;
  let token: string;
  let customerId: string, supplierId: string;
  const acc: Record<string, string> = {};
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const srv = () => h.app.getHttpServer();

  const mk = async (code: string, nameAr: string, cat: any, t: any, role?: string) =>
    (await h.prisma.account.create({ data: { code, nameAr, nameEn: code, category: cat, accountType: t, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } })).id;

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(srv()).post("/api/v1/auth/login").send({ phone: h.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    customerId = (await h.prisma.customer.create({ data: { code: "SLC", nameAr: "عميل الكشف" } })).id;
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: "مورد الكشف", nameEn: "Stmt Supplier" } })).id;
    const u = Date.now().toString().slice(-6);
    acc.ar = await mk(`AR${u}`, "ذمم مدينة", "ASSET", "CURRENT_ASSET", "AR_CONTROL");
    acc.ap = await mk(`AP${u}`, "ذمم دائنة", "LIABILITY", "LIABILITY", "AP_CONTROL");
    acc.rev = await mk(`RV${u}`, "إيراد", "REVENUE", "REVENUE");
    acc.sret = await mk(`SR${u}`, "مردودات المبيعات", "REVENUE", "REVENUE");
    acc.vatO = await mk(`VO${u}`, "ض مخرجات", "LIABILITY", "LIABILITY");
    acc.vatI = await mk(`VI${u}`, "ض مدخلات", "ASSET", "CURRENT_ASSET");
    acc.cogs = await mk(`CG${u}`, "تكلفة", "COST_OF_SALES", "COST_OF_SALES");
    acc.inv = await mk(`IN${u}`, "مخزون", "ASSET", "CURRENT_ASSET");
    await h.prisma.postingProfile.create({ data: {
      effectiveFrom: new Date("2026-01-01"), arAccountId: acc.ar, apAccountId: acc.ap, revenueAccountId: acc.rev,
      salesReturnsAccountId: acc.sret, vatOutputAccountId: acc.vatO, vatInputAccountId: acc.vatI,
      cogsAccountId: acc.cogs, inventoryAccountId: acc.inv, createdBy: h.ownerId,
    } });
    for (let m = 1; m <= 12; m++) await h.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });
  });
  afterAll(async () => teardownTestApp(h));

  let seq = 0;
  const buy = async (size: string, price: string, boards = "10", fromSupplier = supplierId) => {
    const sku = await h.prisma.productSku.create({ data: { code: `ST-${++seq}`, category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
    const v = (await h.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: size, defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" } })).id;
    const p = await request(srv()).post("/api/v1/purchase-invoices").set(auth()).send({
      invoiceDate: "2026-02-01", supplierId: fromSupplier, branchId: h.branchId,
      lines: [{ productVariantId: v, boardsQuantity: boards, unitPrice: price, taxRate: "0" }],
    });
    expect((await request(srv()).post(`/api/v1/purchase-invoices/${p.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);
    return { variantId: v, purchaseId: p.body.id as string };
  };
  const stmt = (category: string, entityId: string) =>
    request(srv()).get(`/api/v1/statements/consolidated?category=${category}&entityId=${entityId}`).set(auth());

  it("a sales return appears once in the customer statement with SALES_RETURN metadata and the GL amount", async () => {
    const { variantId: v } = await buy("4", "300", "10");
    // Sell 5 boards @ 500, no tax → AR debit 10,000; COGS 4×5×300 = 6000.
    const inv = (await request(srv()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-03-01", customerId, branchId: h.branchId, taxRate: "0",
      lines: [{ productVariantId: v, quantity: "5", unitPrice: "500", costPrice: "0" }],
    })).body;
    await request(srv()).post(`/api/v1/sales-invoices/${inv.id}/confirm`).set(auth()).send({});
    const lineId = (await h.prisma.salesInvoiceLine.findFirst({ where: { invoiceId: inv.id } }))!.id;
    // Return 1 board (4 m × 500 = 2000).
    const draft = (await request(srv()).post("/api/v1/sales-returns").set(auth()).send({
      originalSalesInvoiceId: inv.id, returnDate: "2026-03-15",
      lines: [{ originalSalesInvoiceLineId: lineId, returnedBoards: "1" }],
    })).body;
    const sr = (await request(srv()).post(`/api/v1/sales-returns/${draft.id}/confirm`).set(auth()).send({})).body;

    const body = (await stmt("customers", customerId)).body;
    const returnRows = body.rows.filter((r: any) => r.sourceType === "SALES_RETURN");
    expect(returnRows).toHaveLength(1); // exactly once
    const row = returnRows[0];
    expect(row.sourceId).toBe(sr.id);                 // links to the return document itself
    expect(row.partyType).toBe("CUSTOMER");
    expect(row.partyId).toBe(customerId);
    expect(String(row.reference)).toMatch(/^SR-\d+/);  // real return code, resolvable to the number
    expect(D(row.credit).toFixed(2)).toBe("2000.00");  // GL credit, unchanged
    // Money is GL-derived: AR net = 10,000 − 2,000 = 8,000.
    expect(D(body.endingBalance).toFixed(2)).toBe("8000.00");
  });

  it("a purchase return appears once in the supplier statement with PURCHASE_RETURN metadata", async () => {
    // A dedicated supplier so its AP reflects only this test's purchase.
    const supplier2 = (await h.prisma.supplier.create({ data: { nameAr: "مورد الكشف ٢", nameEn: "Stmt Supplier 2" } })).id;
    const { variantId: v, purchaseId } = await buy("4", "400", "10", supplier2); // AP credit 16,000
    const lineId = (await h.prisma.purchaseInvoiceLine.findFirst({ where: { invoiceId: purchaseId } }))!.id;
    const draft = (await request(srv()).post("/api/v1/purchase-returns").set(auth()).send({
      originalPurchaseInvoiceId: purchaseId, returnDate: "2026-02-15",
      lines: [{ originalPurchaseInvoiceLineId: lineId, returnedBoards: "1" }], // 4 m × 400 = 1600
    })).body;
    const pr = (await request(srv()).post(`/api/v1/purchase-returns/${draft.id}/confirm`).set(auth()).send({})).body;

    const body = (await stmt("suppliers", supplier2)).body;
    const returnRows = body.rows.filter((r: any) => r.sourceType === "PURCHASE_RETURN");
    expect(returnRows).toHaveLength(1);
    const row = returnRows[0];
    expect(row.sourceId).toBe(pr.id);
    expect(row.partyType).toBe("SUPPLIER");
    expect(row.partyId).toBe(supplier2);
    expect(String(row.reference)).toMatch(/^PR-\d+/);
    expect(D(row.debit).toFixed(2)).toBe("1600.00");
    // AP net = 16,000 − 1,600 = 14,400 (credit-normal).
    expect(D(body.endingBalance).toFixed(2)).toBe("14400.00");
  });
});
