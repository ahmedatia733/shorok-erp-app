/**
 * Supplier statement (GET /reports/supplier-statement/:id) is GL-derived
 * (AP_CONTROL + SUPPLIER party) and reflects purchase invoices (credit) and
 * supplier payments (debit) for the exact supplier — never factory_ledger or
 * legacy payments. A supplier with no movement returns 200 + empty statement.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("supplier statement — GL-derived (reports endpoint)", () => {
  let handle: TestApp;
  let ownerToken: string, bmToken: string;
  let apId: string, inventoryId: string, cashId: string, vatId: string;

  const server = () => handle.app.getHttpServer();
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const stmt = (id: string, q = "") => request(server()).get(`/api/v1/reports/supplier-statement/${id}${q}`).set(H(ownerToken));

  let seq = 0;
  const mkSupplier = async () => { seq += 1; return (await handle.prisma.supplier.create({ data: { nameAr: `مورد-${seq}`, nameEn: `sup-${seq}` } })).id; };
  const freshVariant = async () => {
    seq += 1;
    const sku = await handle.prisma.productSku.create({ data: { code: `SS-${seq}`, category: "NORMAL", colorNameAr: "ل", colorNameEn: "c" } });
    return (await handle.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: "1", defaultSalePricePerMeter: "1000", defaultPurchasePricePerMeter: "560" } })).id;
  };
  const postPurchase = async (supplierId: string, variantId: string, unitPrice: string) => {
    const d = await request(server()).post("/api/v1/purchase-invoices").set(H(ownerToken)).send({ invoiceDate: "2026-07-15", supplierId, branchId: handle.branchId, lines: [{ productVariantId: variantId, boardsQuantity: "4", lengthM: "1", unitPrice, taxRate: "0" }] });
    expect(d.status).toBeLessThan(300);
    const c = await request(server()).post(`/api/v1/purchase-invoices/${d.body.id}/confirm`).set(H(ownerToken)).send({});
    expect(c.status).toBeLessThan(300);
    return d.body.id as string;
  };
  const paySupplier = (supplierId: string, amount: string) =>
    // acknowledge the warn-only negative-treasury check (cash isn't funded in this statement-focused test)
    request(server()).post("/api/v1/supplier-payments").set(H(ownerToken)).send({ supplierId, apAccountId: apId, bankAccountId: cashId, amount, paymentDate: "2026-07-20", acknowledgeNegativeBalance: true });

  beforeAll(async () => {
    handle = await buildTestApp();
    const pw = "Pwd@2026!";
    const passwordHash = await bcrypt.hash(pw, 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    await handle.prisma.user.create({ data: { name: "BM", phone: "+201400000001", passwordHash, role: "BRANCH_MANAGER" as never, status: "ACTIVE", branchAccesses: { create: { branchId: handle.branchId } } } });
    const login = async (phone: string) => (await request(server()).post("/api/v1/auth/login").send({ phone, password: pw })).body.accessToken;
    ownerToken = await login(handle.ownerPhone);
    bmToken = await login("+201400000001");

    const u = Date.now().toString().slice(-6);
    const acc = (code: string, nameAr: string, cat: string, t: string, role?: string, cash?: boolean) =>
      handle.prisma.account.create({ data: { code, nameAr, nameEn: nameAr, category: cat as never, accountType: t as never, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}), ...(cash ? { isCashOrBank: true, treasuryType: "CASH" } : {}) } });
    apId = (await acc(`AP${u}`, "موردون", "LIABILITY", "LIABILITY", "AP_CONTROL")).id;
    inventoryId = (await acc(`INV${u}`, "مخزون", "ASSET", "CURRENT_ASSET")).id;
    cashId = (await acc(`CASH${u}`, "خزينة", "ASSET", "CURRENT_ASSET", undefined, true)).id;
    vatId = (await acc(`VAT${u}`, "ضريبة", "ASSET", "CURRENT_ASSET")).id;
    await handle.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), apAccountId: apId, inventoryAccountId: inventoryId, vatInputAccountId: vatId, createdBy: handle.ownerId } });
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
  });

  afterAll(async () => teardownTestApp(handle));

  it("1+2+3) confirmed purchase invoice appears as AP credit for the exact supplier only", async () => {
    const sup = await mkSupplier(); const other = await mkSupplier();
    const piId = await postPurchase(sup, await freshVariant(), "560"); // AP credit 2240
    const s = await stmt(sup);
    expect(s.status).toBe(200);
    const row = s.body.rows.find((r: any) => r.credit === "2240.00");
    expect(row).toBeTruthy();
    expect(row.sourceType).toBe("PURCHASE_INVOICE");
    expect(row.sourceId).toBe(piId);
    expect(s.body.endingBalance).toBe("2240.00"); // payable up
    expect((await stmt(other)).body.endingBalance).toBe("0.00"); // another supplier unchanged
  });

  it("4) supplier payment appears as AP debit and reduces the payable", async () => {
    const sup = await mkSupplier();
    await postPurchase(sup, await freshVariant(), "560"); // payable 2240
    const pay = await paySupplier(sup, "700");
    expect(pay.status).toBeLessThan(300);
    const s = await stmt(sup);
    expect(s.body.rows.some((r: any) => r.debit === "700.00")).toBe(true);
    expect(s.body.endingBalance).toBe("1540.00"); // 2240 credit - 700 debit
  });

  it("5) reversing a purchase invoice keeps the party and returns the balance", async () => {
    const sup = await mkSupplier();
    await postPurchase(sup, await freshVariant(), "560");
    const inv = await handle.prisma.purchaseInvoice.findFirst({ where: { supplierId: sup }, orderBy: { createdAt: "desc" } });
    const je = await handle.prisma.journalEntry.findFirst({ where: { sourceType: "PURCHASE_INVOICE", sourceId: inv!.id } });
    const rev = await request(server()).post(`/api/v1/journal/${je!.id}/reverse`).set(H(ownerToken)).send({ reason: "تصحيح" });
    expect(rev.status).toBeLessThan(300);
    const s = await stmt(sup);
    expect(s.body.rows.filter((r: any) => r.isReversal).length).toBeGreaterThan(0); // reversal row visible
    expect(s.body.endingBalance).toBe("0.00"); // net back to zero
  });

  it("6) date range: prior movement is opening, in-range is period", async () => {
    const sup = await mkSupplier();
    // purchase on 07-15, payment on 07-20
    await postPurchase(sup, await freshVariant(), "560"); // 07-15 credit 2240
    await paySupplier(sup, "500"); // 07-20 debit 500
    const s = await stmt(sup, "?from=2026-07-18&to=2026-07-31");
    expect(s.body.openingBalance).toBe("2240.00");
    expect(s.body.periodDebit).toBe("500.00");
    expect(s.body.periodCredit).toBe("0.00");
    expect(s.body.endingBalance).toBe("1740.00");
  });

  it("7) a supplier with no movements returns 200 and an empty statement", async () => {
    const sup = await mkSupplier();
    const s = await stmt(sup);
    expect(s.status).toBe(200);
    expect(s.body.rows).toHaveLength(0);
    expect(s.body.openingBalance).toBe("0.00");
    expect(s.body.endingBalance).toBe("0.00");
  });

  it("8) an unknown supplier returns a typed 404", async () => {
    const s = await stmt("99999999-9999-9999-9999-999999999999");
    expect(s.status).toBe(404);
    expect(s.body.details?.reason).toBe("supplier_not_found");
  });

  it("9) statement is gated (BRANCH_MANAGER 403, unauthenticated 401)", async () => {
    const sup = await mkSupplier();
    expect((await request(server()).get(`/api/v1/reports/supplier-statement/${sup}`).set(H(bmToken))).status).toBe(403);
    expect((await request(server()).get(`/api/v1/reports/supplier-statement/${sup}`)).status).toBe(401);
  });

  it("10) no legacy double count: statement rows == GL AP lines for the supplier", async () => {
    const sup = await mkSupplier();
    await postPurchase(sup, await freshVariant(), "560");
    await paySupplier(sup, "300");
    const glCount = await handle.prisma.journalLine.count({ where: { accountId: apId, partyType: "SUPPLIER", partyId: sup } });
    const s = await stmt(sup);
    expect(s.body.rows).toHaveLength(glCount);
    // and no factory_ledger / customer_transaction created by these flows for the supplier statement
    expect(new Decimal(s.body.endingBalance).toString()).toBe("1940"); // 2240 - 300
  });
});
