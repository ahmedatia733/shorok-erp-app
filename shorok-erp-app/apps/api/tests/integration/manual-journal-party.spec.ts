/**
 * BUGFIX — manual journals go through the PostingEngine and synchronize GL
 * account + customer/supplier statements.
 *
 * POST /journal now: posts via the engine (balanced, OPEN period, POSTED,
 * sequence numbering, treasury guard, audit), carries partyType/partyId onto
 * lines, and REQUIRES a CUSTOMER party on AR_CONTROL lines / a SUPPLIER party on
 * AP_CONTROL lines. Any active leaf GL account is postable. No legacy writes.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("manual journal party + GL synchronization", () => {
  let handle: TestApp;
  let ownerToken: string, bmToken: string;
  let cashId: string, bankId: string, opExpId: string, transExpId: string, rentExpId: string, revenueId: string, inventoryId: string, vatId: string, arId: string, apId: string;
  let parentId: string, inactiveId: string;

  const server = () => handle.app.getHttpServer();
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const jrnl = (lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}, token = ownerToken) =>
    request(server()).post("/api/v1/journal").set(H(token)).send({ entryDate: "2026-07-15", description: "قيد يدوي", lines, ...extra });
  const custStmt = (id: string, q = "") => request(server()).get(`/api/v1/customers/statement/${id}${q}`).set(H(ownerToken));
  const supStmt = (id: string) => request(server()).get(`/api/v1/statements/supplier/${id}`).set(H(ownerToken));
  const acctStmt = (id: string) => request(server()).get(`/api/v1/statements/account/${id}`).set(H(ownerToken));

  let mkC: () => Promise<string>;
  let mkS: () => Promise<string>;

  beforeAll(async () => {
    handle = await buildTestApp();
    const pw = "Pwd@2026!";
    const passwordHash = await bcrypt.hash(pw, 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    await handle.prisma.user.create({ data: { name: "BM", phone: "+201500000001", passwordHash, role: "BRANCH_MANAGER" as never, status: "ACTIVE", branchAccesses: { create: { branchId: handle.branchId } } } });
    const login = async (phone: string) => (await request(server()).post("/api/v1/auth/login").send({ phone, password: pw })).body.accessToken;
    ownerToken = await login(handle.ownerPhone);
    bmToken = await login("+201500000001");

    const u = Date.now().toString().slice(-6);
    const acc = (code: string, nameAr: string, cat: string, t: string, opts: { role?: string; cash?: "CASH" | "BANK"; leaf?: boolean; active?: boolean } = {}) =>
      handle.prisma.account.create({ data: { code, nameAr, nameEn: nameAr, category: cat as never, accountType: t as never, isLeaf: opts.leaf ?? true, active: opts.active ?? true, ...(opts.role ? { systemRole: opts.role as never } : {}), ...(opts.cash ? { isCashOrBank: true, treasuryType: opts.cash } : {}) } });
    cashId = (await acc(`CASH${u}`, "الخزنة الرئيسية", "ASSET", "CURRENT_ASSET", { cash: "CASH" })).id;
    bankId = (await acc(`BANK${u}`, "بنك مصر", "ASSET", "CURRENT_ASSET", { cash: "BANK" })).id;
    opExpId = (await acc(`OPEX${u}`, "مصاريف التشغيل", "EXPENSE", "EXPENSE")).id;
    transExpId = (await acc(`TRAN${u}`, "مصاريف النقل", "EXPENSE", "EXPENSE")).id;
    rentExpId = (await acc(`RENT${u}`, "مصروف الإيجار", "EXPENSE", "EXPENSE")).id;
    revenueId = (await acc(`REV${u}`, "إيرادات", "REVENUE", "REVENUE")).id;
    inventoryId = (await acc(`INV${u}`, "مخزون", "ASSET", "CURRENT_ASSET")).id;
    vatId = (await acc(`VAT${u}`, "ضريبة", "LIABILITY", "LIABILITY")).id;
    arId = (await acc(`AR${u}`, "عملاء", "ASSET", "CURRENT_ASSET", { role: "AR_CONTROL" })).id;
    apId = (await acc(`AP${u}`, "موردون", "LIABILITY", "LIABILITY", { role: "AP_CONTROL" })).id;
    parentId = (await acc(`PAR${u}`, "حساب رئيسي", "EXPENSE", "EXPENSE", { leaf: false })).id;
    inactiveId = (await acc(`INA${u}`, "غير نشط", "EXPENSE", "EXPENSE", { active: false })).id;
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });

    let cseq = 0, sseq = 0;
    mkC = async () => (await handle.prisma.customer.create({ data: { code: `C-${u}-${++cseq}`, nameAr: `عميل ${cseq}` } })).id;
    mkS = async () => (await handle.prisma.supplier.create({ data: { nameAr: `مورد ${u}-${++sseq}`, nameEn: `sup-${u}-${sseq}` } })).id;
  });

  afterAll(async () => teardownTestApp(handle));

  it("1) Dr Cash / Cr Revenue → cash up, revenue up on its credit side", async () => {
    const r = await jrnl([{ accountId: cashId, debit: "1000", credit: "0" }, { accountId: revenueId, debit: "0", credit: "1000" }]);
    expect(r.status).toBeLessThan(300);
    expect((await acctStmt(cashId)).body.endingBalance).toBe("1000.00");    // asset: debit increases
    expect((await acctStmt(revenueId)).body.endingBalance).toBe("1000.00"); // revenue: credit increases
  });

  it("2) Dr Expense / Cr Cash → expense up, cash down (uses the engine)", async () => {
    const c = cashId; const before = new Decimal((await acctStmt(c)).body.endingBalance);
    const r = await jrnl([{ accountId: opExpId, debit: "300", credit: "0" }, { accountId: c, debit: "0", credit: "300" }]);
    expect(r.status).toBeLessThan(300);
    expect((await acctStmt(opExpId)).body.endingBalance).toBe("300.00");
    expect((await acctStmt(c)).body.endingBalance).toBe(before.sub(300).toFixed(2));
  });

  it("3) Dr AR [CUSTOMER] / Cr Revenue → that customer up, another unchanged, AR account up", async () => {
    const cust = await mkC(); const other = await mkC();
    const r = await jrnl([{ accountId: arId, debit: "1000", credit: "0", partyType: "CUSTOMER", partyId: cust }, { accountId: revenueId, debit: "0", credit: "1000" }]);
    expect(r.status).toBeLessThan(300);
    expect((await custStmt(cust)).body.endingBalance).toBe("1000.00");
    expect((await custStmt(other)).body.endingBalance).toBe("0.00");
    expect(new Decimal((await acctStmt(arId)).body.endingBalance).gte(1000)).toBe(true);
  });

  it("4) Dr Cash / Cr AR [CUSTOMER] → customer balance down, cash up", async () => {
    const cust = await mkC();
    await jrnl([{ accountId: arId, debit: "800", credit: "0", partyType: "CUSTOMER", partyId: cust }, { accountId: revenueId, debit: "0", credit: "800" }]);
    await jrnl([{ accountId: cashId, debit: "500", credit: "0" }, { accountId: arId, debit: "0", credit: "500", partyType: "CUSTOMER", partyId: cust }]);
    expect((await custStmt(cust)).body.endingBalance).toBe("300.00"); // 800 debit - 500 credit
  });

  it("5) AR line without CUSTOMER party → rejected, no journal", async () => {
    const before = await handle.prisma.journalEntry.count();
    const r = await jrnl([{ accountId: arId, debit: "100", credit: "0" }, { accountId: revenueId, debit: "0", credit: "100" }]);
    expect(r.status).toBe(409);
    expect(r.body.details?.reason).toBe("customer_party_required");
    expect(await handle.prisma.journalEntry.count()).toBe(before);
  });

  it("6) AP line without SUPPLIER party → rejected, no journal", async () => {
    const before = await handle.prisma.journalEntry.count();
    const r = await jrnl([{ accountId: rentExpId, debit: "100", credit: "0" }, { accountId: apId, debit: "0", credit: "100" }]);
    expect(r.status).toBe(409);
    expect(r.body.details?.reason).toBe("supplier_party_required");
    expect(await handle.prisma.journalEntry.count()).toBe(before);
  });

  it("6b) AR party pointing at a non-existent customer → rejected", async () => {
    const r = await jrnl([{ accountId: arId, debit: "100", credit: "0", partyType: "CUSTOMER", partyId: "99999999-9999-9999-9999-999999999999" }, { accountId: revenueId, debit: "0", credit: "100" }]);
    expect(r.status).toBe(404);
    expect(r.body.details?.reason).toBe("customer_not_found");
  });

  it("7) Dr AP [SUPPLIER] / Cr Cash → supplier payable down, cash down", async () => {
    const sup = await mkS();
    await jrnl([{ accountId: rentExpId, debit: "2000", credit: "0" }, { accountId: apId, debit: "0", credit: "2000", partyType: "SUPPLIER", partyId: sup }]); // accrue payable
    expect((await supStmt(sup)).body.endingBalance).toBe("2000.00"); // AP credit increases payable
    await jrnl([{ accountId: apId, debit: "700", credit: "0", partyType: "SUPPLIER", partyId: sup }, { accountId: cashId, debit: "0", credit: "700" }]); // pay
    expect((await supStmt(sup)).body.endingBalance).toBe("1300.00"); // 2000 credit - 700 debit
  });

  it("8) multiple lines on the same account net correctly in the running balance", async () => {
    const rev = revenueId; const before = new Decimal((await acctStmt(rev)).body.endingBalance);
    const r = await jrnl([{ accountId: rev, debit: "0", credit: "400" }, { accountId: rev, debit: "150", credit: "0" }, { accountId: cashId, debit: "250", credit: "0" }]);
    expect(r.status).toBeLessThan(300);
    expect((await acctStmt(rev)).body.endingBalance).toBe(before.add(400).sub(150).toFixed(2)); // +250 net credit
  });

  it("9) reversal keeps both rows and returns the ending balance", async () => {
    const rev = revenueId; const before = new Decimal((await acctStmt(rev)).body.endingBalance);
    const posted = (await jrnl([{ accountId: cashId, debit: "600", credit: "0" }, { accountId: rev, debit: "0", credit: "600" }])).body;
    const rowsBefore = (await acctStmt(rev)).body.rows.length;
    const revd = await request(server()).post(`/api/v1/journal/${posted.id}/reverse`).set(H(ownerToken)).send({ reason: "تصحيح" });
    expect(revd.status).toBeLessThan(300);
    const st = await acctStmt(rev);
    expect(st.body.rows.length).toBe(rowsBefore + 1); // original + reversal
    expect(st.body.endingBalance).toBe(before.toFixed(2)); // net back to before
  });

  it("10) date range: earlier line is opening, in-range line is movement", async () => {
    const acc = transExpId;
    await jrnl([{ accountId: acc, debit: "100", credit: "0" }, { accountId: cashId, debit: "0", credit: "100" }], { entryDate: "2026-07-10" });
    await jrnl([{ accountId: acc, debit: "50", credit: "0" }, { accountId: cashId, debit: "0", credit: "50" }], { entryDate: "2026-07-20" });
    const st = await request(server()).get(`/api/v1/statements/account/${acc}?from=2026-07-15&to=2026-07-31`).set(H(ownerToken));
    expect(st.body.openingBalance).toBe("100.00");
    expect(st.body.periodDebit).toBe("50.00");
    expect(st.body.endingBalance).toBe("150.00");
  });

  it("11) statements are gated (BRANCH_MANAGER 403, unauthenticated 401)", async () => {
    const cust = await mkC();
    expect((await request(server()).get(`/api/v1/customers/statement/${cust}`).set(H(bmToken))).status).toBe(403);
    expect((await request(server()).get(`/api/v1/customers/statement/${cust}`)).status).toBe(401);
  });

  it("12) idempotency: same key posts once", async () => {
    const key = `MANUAL-TEST-${Date.now()}`;
    const before = await handle.prisma.journalEntry.count();
    const a = await jrnl([{ accountId: cashId, debit: "10", credit: "0" }, { accountId: revenueId, debit: "0", credit: "10" }], { idempotencyKey: key });
    const b = await jrnl([{ accountId: cashId, debit: "10", credit: "0" }, { accountId: revenueId, debit: "0", credit: "10" }], { idempotencyKey: key });
    expect(a.status).toBeLessThan(300);
    expect(b.status).toBeLessThan(300);
    expect(await handle.prisma.journalEntry.count()).toBe(before + 1); // only one created
  });

  it("13) a newly posted manual journal is returned immediately by GET /journal", async () => {
    const posted = (await jrnl([{ accountId: bankId, debit: "77", credit: "0" }, { accountId: revenueId, debit: "0", credit: "77" }])).body;
    const list = await request(server()).get("/api/v1/journal?limit=100").set(H(ownerToken));
    expect(list.body.data.some((e: { id: string }) => e.id === posted.id)).toBe(true);
  });

  it("14) manual journals create NO legacy rows", async () => {
    const ctBefore = await handle.prisma.customerTransaction.count();
    const ocBefore = await handle.prisma.orderCollection.count();
    await jrnl([{ accountId: opExpId, debit: "5", credit: "0" }, { accountId: cashId, debit: "0", credit: "5" }]);
    expect(await handle.prisma.customerTransaction.count()).toBe(ctBefore);
    expect(await handle.prisma.orderCollection.count()).toBe(ocBefore);
  });

  it("general accounts: op/transport/rent/revenue/cash/bank/inventory all post and move both statements", async () => {
    for (const [dr, cr] of [[opExpId, cashId], [transExpId, bankId], [rentExpId, cashId], [inventoryId, cashId], [bankId, revenueId]] as const) {
      const r = await jrnl([{ accountId: dr, debit: "20", credit: "0" }, { accountId: cr, debit: "0", credit: "20" }]);
      expect(r.status).toBeLessThan(300);
      expect((await acctStmt(dr)).status).toBe(200);
    }
    // VAT + equity-style leaf also postable
    expect((await jrnl([{ accountId: vatId, debit: "0", credit: "30" }, { accountId: cashId, debit: "30", credit: "0" }])).status).toBeLessThan(300);
  });

  it("parent (non-leaf), inactive, and unknown accounts are rejected", async () => {
    expect((await jrnl([{ accountId: parentId, debit: "10", credit: "0" }, { accountId: cashId, debit: "0", credit: "10" }])).body.details?.reason).toBe("account_not_leaf_or_inactive");
    expect((await jrnl([{ accountId: inactiveId, debit: "10", credit: "0" }, { accountId: cashId, debit: "0", credit: "10" }])).body.details?.reason).toBe("account_not_leaf_or_inactive");
    const unknown = await jrnl([{ accountId: "88888888-8888-8888-8888-888888888888", debit: "10", credit: "0" }, { accountId: cashId, debit: "0", credit: "10" }]);
    expect(unknown.status).toBe(404);
  });

  it("D) Rent accrued to a supplier: rent account up + supplier statement up + AP account up", async () => {
    const sup = await mkS();
    const r = await jrnl([{ accountId: rentExpId, debit: "2500", credit: "0" }, { accountId: apId, debit: "0", credit: "2500", partyType: "SUPPLIER", partyId: sup }]);
    expect(r.status).toBeLessThan(300);
    expect((await supStmt(sup)).body.endingBalance).toBe("2500.00");
    expect(new Decimal((await acctStmt(apId)).body.endingBalance).gte(2500)).toBe(true);
  });
});
