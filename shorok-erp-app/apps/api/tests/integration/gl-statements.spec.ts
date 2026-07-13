/**
 * Increment A — customer / supplier / treasury(+GL account) statements derived
 * from the General Ledger (journal_lines), never legacy tables.
 *
 * Verifies: sales invoice → customer debit + AR account; receipt voucher →
 * customer credit + treasury debit; manual journal → expense debit + treasury
 * credit; purchase invoice → supplier credit + AP account; reversal rows kept
 * with correct net; date-range opening/period/ending; empty customer zeros;
 * no double counting with legacy customer_transactions; and permission gating.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("GL-derived statements (Increment A)", () => {
  let handle: TestApp;
  let ownerToken: string, accToken: string, bmToken: string, whToken: string;
  let arId: string, apId: string, cashId: string, revenueId: string, expenseId: string, inventoryId: string, cogsId: string, vatOutId: string, vatInId: string;

  const server = () => handle.app.getHttpServer();
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  const mkCustomer = (nameAr = "عميل") => handle.prisma.customer.create({ data: { code: `C-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, nameAr } });
  const mkSupplier = () => handle.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "Sup" } });
  const freshVariant = async (avgCost: string, stock: string) => {
    const sku = await handle.prisma.productSku.create({ data: { code: `GL-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, category: "NORMAL", colorNameAr: "ل", colorNameEn: "c" } });
    const v = await handle.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: "1", defaultSalePricePerMeter: "1000", defaultPurchasePricePerMeter: "560", avgCost } });
    await handle.prisma.branchInventoryBalance.create({ data: { branchId: handle.branchId, productVariantId: v.id, boardsOnHand: stock, metersOnHand: stock } });
    return v.id;
  };

  const postSales = async (customerId: string, variantId: string, qty: string, price: string, date: string) => {
    const d = await request(server()).post("/api/v1/sales-invoices").set(H(ownerToken)).send({ invoiceDate: date, customerId, branchId: handle.branchId, taxRate: "0", lines: [{ productVariantId: variantId, quantity: qty, unitPrice: price, costPrice: "0" }] });
    expect(d.status).toBeLessThan(300);
    const c = await request(server()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(H(ownerToken)).send({});
    expect(c.status).toBeLessThan(300);
    return d.body.id as string;
  };
  const postReceipt = async (customerId: string, amount: string, date: string) => {
    const d = await request(server()).post("/api/v1/receipt-vouchers").set(H(ownerToken)).send({ voucherDate: date, branchId: handle.branchId, customerId, treasuryAccountId: cashId, amount });
    expect(d.status).toBeLessThan(300);
    const p = await request(server()).post(`/api/v1/receipt-vouchers/${d.body.id}/post`).set(H(ownerToken)).send({});
    expect(p.status).toBeLessThan(300);
    return d.body.id as string;
  };
  const postPurchase = async (supplierId: string, variantId: string, boards: string, unitPrice: string, date: string) => {
    const d = await request(server()).post("/api/v1/purchase-invoices").set(H(ownerToken)).send({ invoiceDate: date, supplierId, branchId: handle.branchId, lines: [{ productVariantId: variantId, boardsQuantity: boards, lengthM: "1", unitPrice, taxRate: "0" }] });
    expect(d.status).toBeLessThan(300);
    const c = await request(server()).post(`/api/v1/purchase-invoices/${d.body.id}/confirm`).set(H(ownerToken)).send({});
    expect(c.status).toBeLessThan(300);
    return d.body.id as string;
  };
  const manualJournal = (lines: Array<{ accountId: string; debit: string; credit: string }>, date: string, description = "قيد يدوي") =>
    request(server()).post("/api/v1/journal").set(H(ownerToken)).send({ entryDate: date, description, lines });

  const custStmt = (id: string, from?: string, to?: string) => request(server()).get(`/api/v1/customers/statement/${id}${from ? `?from=${from}${to ? `&to=${to}` : ""}` : ""}`).set(H(ownerToken));
  const acctStmt = (id: string) => request(server()).get(`/api/v1/statements/account/${id}`).set(H(ownerToken));
  const supStmt = (id: string) => request(server()).get(`/api/v1/statements/supplier/${id}`).set(H(ownerToken));

  beforeAll(async () => {
    handle = await buildTestApp();
    const pw = "Pwd@2026!";
    const passwordHash = await bcrypt.hash(pw, 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    const mkUser = (name: string, phone: string, role: string) => handle.prisma.user.create({ data: { name, phone, passwordHash, role: role as never, status: "ACTIVE", branchAccesses: { create: { branchId: handle.branchId } } } });
    await mkUser("Acc", "+201800000001", "ACCOUNTANT");
    await mkUser("BM", "+201800000002", "BRANCH_MANAGER");
    await mkUser("WH", "+201800000003", "WAREHOUSE");
    const login = async (phone: string) => (await request(server()).post("/api/v1/auth/login").send({ phone, password: pw })).body.accessToken;
    ownerToken = await login(handle.ownerPhone);
    accToken = await login("+201800000001");
    bmToken = await login("+201800000002");
    whToken = await login("+201800000003");

    const u = Date.now().toString().slice(-6);
    const acc = (code: string, nameAr: string, cat: string, t: string, role?: string, cash?: boolean) =>
      handle.prisma.account.create({ data: { code, nameAr, nameEn: nameAr, category: cat as never, accountType: t as never, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}), ...(cash ? { isCashOrBank: true, treasuryType: "CASH" } : {}) } });
    arId = (await acc(`AR${u}`, "عملاء", "ASSET", "CURRENT_ASSET", "AR_CONTROL")).id;
    apId = (await acc(`AP${u}`, "موردون", "LIABILITY", "LIABILITY", "AP_CONTROL")).id;
    cashId = (await acc(`CASH${u}`, "خزينة", "ASSET", "CURRENT_ASSET", undefined, true)).id;
    revenueId = (await acc(`REV${u}`, "مبيعات", "REVENUE", "REVENUE")).id;
    expenseId = (await acc(`EXP${u}`, "مصروف", "EXPENSE", "EXPENSE")).id;
    inventoryId = (await acc(`INV${u}`, "مخزون", "ASSET", "CURRENT_ASSET")).id;
    cogsId = (await acc(`COGS${u}`, "تكلفة", "COST_OF_SALES", "COST_OF_SALES")).id;
    vatOutId = (await acc(`VOUT${u}`, "ض.مخرجات", "LIABILITY", "LIABILITY")).id;
    vatInId = (await acc(`VIN${u}`, "ض.مدخلات", "ASSET", "CURRENT_ASSET")).id;
    await handle.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId: arId, apAccountId: apId, revenueAccountId: revenueId, cogsAccountId: cogsId, inventoryAccountId: inventoryId, vatOutputAccountId: vatOutId, vatInputAccountId: vatInId, createdBy: handle.ownerId } });
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
  });

  afterAll(async () => teardownTestApp(handle));

  it("sales invoice → customer statement debit + AR account statement, with source fields", async () => {
    const cust = await mkCustomer();
    const variant = await freshVariant("560", "10");
    const siId = await postSales(cust.id, variant, "2", "1000", "2026-07-15"); // AR debit 2000

    const s = await custStmt(cust.id);
    expect(s.status).toBe(200);
    expect(s.body.rows).toHaveLength(1);
    const row = s.body.rows[0];
    expect(row.debit).toBe("2000.00");
    expect(row.credit).toBe("0.00");
    expect(s.body.endingBalance).toBe("2000.00");
    expect(row.sourceType).toBe("SALES_INVOICE");
    expect(row.sourceId).toBe(siId);
    expect(row.journalEntryId).toBeTruthy();
    expect(row.isReversal).toBe(false);

    const ar = await acctStmt(arId);
    expect(ar.body.rows.some((r: any) => r.debit === "2000.00" && r.sourceId === siId)).toBe(true);
    expect(ar.body.entity.normalSide).toBe("DEBIT");
  });

  it("receipt voucher → customer credit + treasury debit; no legacy double count", async () => {
    const cust = await mkCustomer();
    const variant = await freshVariant("560", "10");
    await postSales(cust.id, variant, "2", "1000", "2026-07-15"); // debit 2000 (also writes a legacy customer_transaction)
    await postReceipt(cust.id, "500", "2026-07-20"); // credit 500

    const s = await custStmt(cust.id);
    expect(s.body.rows).toHaveLength(2); // GL only — the legacy customer_transaction is NOT added
    expect(s.body.endingBalance).toBe("1500.00");
    const credit = s.body.rows.find((r: any) => r.credit === "500.00");
    expect(credit.sourceType).toBe("RECEIPT_VOUCHER");

    // No double counting: statement row count === GL AR lines for this customer.
    const glCount = await handle.prisma.journalLine.count({ where: { accountId: arId, partyType: "CUSTOMER", partyId: cust.id } });
    expect(s.body.rows).toHaveLength(glCount);

    const treasury = await acctStmt(cashId);
    expect(treasury.body.rows.some((r: any) => r.debit === "500.00")).toBe(true); // receipt is a treasury inflow (debit)
  });

  it("manual journal (Dr expense / Cr treasury) → expense debit + treasury credit", async () => {
    const mj = await manualJournal([{ accountId: expenseId, debit: "300", credit: "0" }, { accountId: cashId, debit: "0", credit: "300" }], "2026-07-21");
    expect(mj.status).toBeLessThan(300);
    const exp = await acctStmt(expenseId);
    expect(exp.body.rows.some((r: any) => r.debit === "300.00")).toBe(true);
    expect(exp.body.entity.normalSide).toBe("DEBIT");
    const treasury = await acctStmt(cashId);
    expect(treasury.body.rows.some((r: any) => r.credit === "300.00")).toBe(true); // outflow
  });

  it("purchase invoice → supplier statement credit + AP account statement", async () => {
    const sup = await mkSupplier();
    const variant = await freshVariant("0", "0");
    const piId = await postPurchase(sup.id, variant, "4", "560", "2026-07-15"); // AP credit 2240

    const s = await supStmt(sup.id);
    expect(s.status).toBe(200);
    const row = s.body.rows.find((r: any) => r.credit === "2240.00");
    expect(row).toBeTruthy();
    expect(row.sourceType).toBe("PURCHASE_INVOICE");
    expect(row.sourceId).toBe(piId);
    expect(s.body.endingBalance).toBe("2240.00"); // payable increased by credit

    const ap = await acctStmt(apId);
    expect(ap.body.rows.some((r: any) => r.credit === "2240.00")).toBe(true);
    expect(ap.body.entity.normalSide).toBe("CREDIT");
  });

  it("reversal keeps the original row, shows the reversal row, and nets the ending balance", async () => {
    const cust = await mkCustomer();
    const variant = await freshVariant("560", "10");
    await postSales(cust.id, variant, "2", "1000", "2026-07-15"); // debit 2000
    const rvId = await postReceipt(cust.id, "500", "2026-07-20"); // credit 500 → ending 1500
    const rev = await request(server()).post(`/api/v1/receipt-vouchers/${rvId}/reverse`).set(H(ownerToken)).send({ reason: "تصحيح" });
    expect(rev.status).toBeLessThan(300);

    const s = await custStmt(cust.id);
    expect(s.body.rows).toHaveLength(3); // invoice debit, receipt credit, reversal debit
    expect(s.body.endingBalance).toBe("2000.00"); // receipt reversed → back to invoice amount
    const reversalRow = s.body.rows.find((r: any) => r.isReversal === true);
    expect(reversalRow).toBeTruthy();
    expect(reversalRow.debit).toBe("500.00"); // opposite of the original credit
    expect(reversalRow.reversalOfId).toBeTruthy();
  });

  it("date range: pre-range movement is opening only; in-range contributes to period", async () => {
    const cust = await mkCustomer();
    const variant = await freshVariant("560", "10");
    await postSales(cust.id, variant, "2", "1000", "2026-07-15"); // debit 2000 @ 07-15
    await postReceipt(cust.id, "500", "2026-07-20"); // credit 500 @ 07-20

    const s = await custStmt(cust.id, "2026-07-18", "2026-07-31");
    expect(s.body.openingBalance).toBe("2000.00"); // the 07-15 invoice falls before the window
    expect(s.body.periodDebit).toBe("0.00");
    expect(s.body.periodCredit).toBe("500.00");
    expect(s.body.endingBalance).toBe("1500.00");
    expect(s.body.rows).toHaveLength(1); // only the in-range receipt
  });

  it("empty customer shows zero opening / movement / ending", async () => {
    const cust = await mkCustomer("عميل فارغ");
    const s = await custStmt(cust.id);
    expect(s.status).toBe(200);
    expect(s.body.openingBalance).toBe("0.00");
    expect(s.body.periodDebit).toBe("0.00");
    expect(s.body.periodCredit).toBe("0.00");
    expect(s.body.endingBalance).toBe("0.00");
    expect(s.body.rows).toHaveLength(0);
  });

  it("permissions: BRANCH_MANAGER & WAREHOUSE get 403, unauthenticated gets 401", async () => {
    const cust = await mkCustomer();
    expect((await request(server()).get(`/api/v1/customers/statement/${cust.id}`).set(H(bmToken))).status).toBe(403);
    expect((await request(server()).get(`/api/v1/customers/statement/${cust.id}`).set(H(whToken))).status).toBe(403);
    expect((await request(server()).get(`/api/v1/customers/statement/${cust.id}`)).status).toBe(401);
    // accountant retains access
    expect((await request(server()).get(`/api/v1/customers/statement/${cust.id}`).set(H(accToken))).status).toBe(200);
  });
});
