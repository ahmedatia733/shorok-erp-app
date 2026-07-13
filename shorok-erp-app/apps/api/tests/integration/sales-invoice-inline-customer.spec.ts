/**
 * BUGFIX 2 — inline customer creation from the Sales Invoice screen reuses the
 * canonical POST /customers (no invoice-only customer, no legacy/GL side effects).
 *
 * Covers the accounting-critical + permission scenarios of the inline flow:
 * canonical persistence, zero GL/legacy activity on creation, zero-balance
 * statement, use in a posted invoice with a CUSTOMER-party AR line, statement
 * after posting, role gating, and validation. (Auto-select / form-intact are
 * pure client state in the sales page and covered by the web implementation.)
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("inline customer creation from sales invoice (Bugfix 2)", () => {
  let handle: TestApp;
  let ownerToken: string, accToken: string, bmToken: string, whToken: string;
  let arAccountId: string, revenueAccountId: string, inventoryAccountId: string, cogsAccountId: string;

  const server = () => handle.app.getHttpServer();
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const createCustomer = (tok: string, body: Record<string, unknown>) =>
    request(server()).post("/api/v1/customers").set(H(tok)).send(body);

  beforeAll(async () => {
    handle = await buildTestApp();
    const pw = "Pwd@2026!";
    const passwordHash = await bcrypt.hash(pw, 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    const mk = (name: string, phone: string, role: string) =>
      handle.prisma.user.create({ data: { name, phone, passwordHash, role: role as never, status: "ACTIVE", branchAccesses: { create: { branchId: handle.branchId } } } });
    await mk("Acc", "+201900000001", "ACCOUNTANT");
    await mk("BM", "+201900000002", "BRANCH_MANAGER");
    await mk("WH", "+201900000003", "WAREHOUSE");
    const login = async (phone: string) => (await request(server()).post("/api/v1/auth/login").send({ phone, password: pw })).body.accessToken;
    ownerToken = await login(handle.ownerPhone);
    accToken = await login("+201900000001");
    bmToken = await login("+201900000002");
    whToken = await login("+201900000003");

    const uniq = Date.now().toString().slice(-6);
    const acc = (code: string, nameAr: string, category: string, accountType: string, role?: string) =>
      handle.prisma.account.create({ data: { code, nameAr, nameEn: nameAr, category: category as never, accountType: accountType as never, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } });
    arAccountId = (await acc(`AR${uniq}`, "عملاء", "ASSET", "CURRENT_ASSET", "AR_CONTROL")).id;
    revenueAccountId = (await acc(`REV${uniq}`, "مبيعات", "REVENUE", "REVENUE")).id;
    inventoryAccountId = (await acc(`INV${uniq}`, "مخزون", "ASSET", "CURRENT_ASSET")).id;
    cogsAccountId = (await acc(`COGS${uniq}`, "تكلفة", "COST_OF_SALES", "COST_OF_SALES")).id;
    await handle.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId, revenueAccountId, inventoryAccountId, cogsAccountId, createdBy: handle.ownerId } });
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
  });

  afterAll(async () => teardownTestApp(handle));

  it("OWNER/ACCOUNTANT create a canonical customer that the customers API returns", async () => {
    const res = await createCustomer(ownerToken, { nameAr: "عميل إنلاين", phone: "01000000001" });
    expect(res.status).toBeLessThan(300);
    expect(res.body.code).toMatch(/^C-\d+$/);
    expect(res.body.nameAr).toBe("عميل إنلاين");

    const list = await request(server()).get("/api/v1/customers").set(H(ownerToken));
    expect(list.body.some((c: { id: string }) => c.id === res.body.id)).toBe(true);

    const asAcc = await createCustomer(accToken, { nameAr: "عميل المحاسب" });
    expect(asAcc.status).toBeLessThan(300);
  });

  it("creating a customer writes NO journal entry and NO customer_transaction (zero GL/legacy)", async () => {
    const jeBefore = await handle.prisma.journalEntry.count();
    const ctBefore = await handle.prisma.customerTransaction.count();
    const ocBefore = await handle.prisma.orderCollection.count();
    const res = await createCustomer(ownerToken, { nameAr: "عميل بدون حركة" });
    expect(res.status).toBeLessThan(300);
    expect(await handle.prisma.journalEntry.count()).toBe(jeBefore);
    expect(await handle.prisma.customerTransaction.count()).toBe(ctBefore);
    expect(await handle.prisma.orderCollection.count()).toBe(ocBefore);
    // and the customer itself carries no transactions
    expect(await handle.prisma.customerTransaction.count({ where: { customerId: res.body.id } })).toBe(0);
  });

  it("new customer's statement shows a zero balance before any posting", async () => {
    const c = (await createCustomer(ownerToken, { nameAr: "عميل كشف حساب" })).body;
    const st = await request(server()).get(`/api/v1/customers/statement/${c.id}`).set(H(ownerToken));
    expect(st.status).toBe(200);
    expect(st.body.openingBalance).toBe("0.00");
    expect(st.body.totalDR).toBe("0.00");
    expect(st.body.entries).toHaveLength(0);
  });

  it("BRANCH_MANAGER and WAREHOUSE are denied customer creation (403)", async () => {
    expect((await createCustomer(bmToken, { nameAr: "غير مصرح" })).status).toBe(403);
    expect((await createCustomer(whToken, { nameAr: "غير مصرح" })).status).toBe(403);
  });

  it("rejects invalid data (empty name) without creating a partial customer", async () => {
    const before = await handle.prisma.customer.count();
    const res = await createCustomer(ownerToken, { nameAr: "" });
    expect(res.status).toBe(400);
    expect(await handle.prisma.customer.count()).toBe(before);
  });

  it("allows two legitimate customers with the same name (distinct auto codes)", async () => {
    const a = await createCustomer(ownerToken, { nameAr: "عميل مكرر" });
    const b = await createCustomer(ownerToken, { nameAr: "عميل مكرر" });
    expect(a.status).toBeLessThan(300);
    expect(b.status).toBeLessThan(300);
    expect(a.body.code).not.toBe(b.body.code);
  });

  it("new customer can be used to post an invoice: AR line has CUSTOMER party = new customer, statement reflects it", async () => {
    const c = (await createCustomer(ownerToken, { nameAr: "عميل الفاتورة" })).body;

    // A sellable variant with cost + stock.
    const sku = await handle.prisma.productSku.create({ data: { code: `IC-${Date.now()}`, category: "NORMAL", colorNameAr: "ل", colorNameEn: "c" } });
    const variant = await handle.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: "1", defaultSalePricePerMeter: "1000", defaultPurchasePricePerMeter: "560", avgCost: "560" } });
    await handle.prisma.branchInventoryBalance.create({ data: { branchId: handle.branchId, productVariantId: variant.id, boardsOnHand: "10", metersOnHand: "10" } });

    const draft = await request(server()).post("/api/v1/sales-invoices").set(H(ownerToken)).send({
      invoiceDate: "2026-07-15", customerId: c.id, branchId: handle.branchId, taxRate: "0",
      lines: [{ productVariantId: variant.id, quantity: "2", unitPrice: "1000", costPrice: "0" }],
    });
    expect(draft.status).toBeLessThan(300);
    const confirm = await request(server()).post(`/api/v1/sales-invoices/${draft.body.id}/confirm`).set(H(ownerToken)).send({});
    expect(confirm.status).toBeLessThan(300);

    const inv = await handle.prisma.salesInvoice.findUnique({ where: { id: draft.body.id } });
    const arLine = await handle.prisma.journalLine.findFirst({ where: { journalEntryId: inv!.journalEntryId!, accountId: arAccountId } });
    expect(arLine!.partyType).toBe("CUSTOMER");
    expect(arLine!.partyId).toBe(c.id);
    expect(new Decimal(arLine!.debit.toString()).toString()).toBe("2000");

    const st = await request(server()).get(`/api/v1/customers/statement/${c.id}`).set(H(ownerToken));
    expect(st.body.entries.length).toBeGreaterThan(0);
    expect(new Decimal(st.body.totalDR).gt(0)).toBe(true);
  });
});
