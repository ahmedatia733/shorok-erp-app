/**
 * Increment C — negative treasury/bank balance protection (WARN-ONLY).
 *
 * A posting that would drive a CASH/BANK account below zero returns a typed
 * 409 `treasury_negative_balance_warning` on the first (unacknowledged) attempt
 * and creates NO journal; re-sending with acknowledgeNegativeBalance=true posts
 * (balances may go negative) and writes an audit row. Enforced server-side from
 * the GL, inside the posting transaction, with account-level locking.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("negative treasury balance warning (Increment C)", () => {
  let handle: TestApp;
  let ownerToken: string, bmToken: string, whToken: string;
  let cashId: string, bankId: string, bankAId: string, bankBId: string, expenseId: string, revenueId: string, arId: string;

  const server = () => handle.app.getHttpServer();
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  const mj = (lines: Array<{ accountId: string; debit: string; credit: string }>, opts: { ack?: boolean; reason?: string; token?: string } = {}) =>
    request(server()).post("/api/v1/journal").set(H(opts.token ?? ownerToken)).send({
      entryDate: "2026-07-15", description: "عملية خزينة", lines,
      ...(opts.ack ? { acknowledgeNegativeBalance: true } : {}),
      ...(opts.reason ? { negativeBalanceReason: opts.reason } : {}),
    });
  const fund = (accountId: string, amount: string) => mj([{ accountId, debit: amount, credit: "0" }, { accountId: revenueId, debit: "0", credit: amount }]);
  const withdraw = (accountId: string, amount: string, opts: { ack?: boolean; reason?: string; token?: string } = {}) =>
    mj([{ accountId: expenseId, debit: amount, credit: "0" }, { accountId, debit: "0", credit: amount }], opts);

  const glBalance = async (accountId: string) => {
    const r = await handle.prisma.journalLine.aggregate({ _sum: { debit: true, credit: true }, where: { accountId } });
    return new Decimal(r._sum.debit?.toString() ?? "0").sub(r._sum.credit?.toString() ?? "0");
  };
  const jeCount = () => handle.prisma.journalEntry.count();

  beforeAll(async () => {
    handle = await buildTestApp();
    const pw = "Pwd@2026!";
    const passwordHash = await bcrypt.hash(pw, 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    const mkUser = (name: string, phone: string, role: string) => handle.prisma.user.create({ data: { name, phone, passwordHash, role: role as never, status: "ACTIVE", branchAccesses: { create: { branchId: handle.branchId } } } });
    await mkUser("BM", "+201600000001", "BRANCH_MANAGER");
    await mkUser("WH", "+201600000002", "WAREHOUSE");
    const login = async (phone: string) => (await request(server()).post("/api/v1/auth/login").send({ phone, password: pw })).body.accessToken;
    ownerToken = await login(handle.ownerPhone);
    bmToken = await login("+201600000001");
    whToken = await login("+201600000002");

    const u = Date.now().toString().slice(-6);
    const acc = (code: string, nameAr: string, cat: string, t: string, treasury?: "CASH" | "BANK", role?: string) =>
      handle.prisma.account.create({ data: { code, nameAr, nameEn: nameAr, category: cat as never, accountType: t as never, isLeaf: true, active: true, ...(treasury ? { isCashOrBank: true, treasuryType: treasury } : {}), ...(role ? { systemRole: role as never } : {}) } });
    cashId = (await acc(`CASH${u}`, "خزينة", "ASSET", "CURRENT_ASSET", "CASH")).id;
    bankId = (await acc(`BANK${u}`, "بنك", "ASSET", "CURRENT_ASSET", "BANK")).id;
    bankAId = (await acc(`BKA${u}`, "بنك أ", "ASSET", "CURRENT_ASSET", "BANK")).id;
    bankBId = (await acc(`BKB${u}`, "بنك ب", "ASSET", "CURRENT_ASSET", "BANK")).id;
    expenseId = (await acc(`EXP${u}`, "مصروف", "EXPENSE", "EXPENSE")).id;
    revenueId = (await acc(`REV${u}`, "إيراد", "REVENUE", "REVENUE")).id;
    arId = (await acc(`AR${u}`, "عملاء", "ASSET", "CURRENT_ASSET", undefined, "AR_CONTROL")).id;
    await handle.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId: arId, createdBy: handle.ownerId } });
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
  });

  afterAll(async () => teardownTestApp(handle));

  it("1) sufficient balance posts without warning", async () => {
    await fund(cashId, "1000");
    const r = await withdraw(cashId, "500");
    expect(r.status).toBeLessThan(300);
  });

  it("2) exact available balance posts and ends at zero", async () => {
    await fund(bankId, "1000");
    const r = await withdraw(bankId, "1000");
    expect(r.status).toBeLessThan(300);
    expect((await glBalance(bankId)).toString()).toBe("0");
  });

  it("3+5) negative CASH projection warns first and creates no journal", async () => {
    const c = (await acc2("CASH")); // isolated cash account
    await fund(c, "1000");
    const before = await jeCount();
    const r = await withdraw(c, "1500");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("treasury_negative_balance_warning");
    expect(r.body.details.projectedBalance).toBe("-500.00");
    expect(r.body.details.currentBalance).toBe("1000.00");
    expect(r.body.details.acknowledgementRequired).toBe(true);
    expect(await jeCount()).toBe(before); // nothing posted
    expect((await glBalance(c)).toString()).toBe("1000"); // unchanged
  });

  it("4) negative BANK projection warns first", async () => {
    const b = await acc2("BANK");
    await fund(b, "500");
    const r = await withdraw(b, "800");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("treasury_negative_balance_warning");
    expect(r.body.details.treasuryType).toBe("BANK");
  });

  it("6+7+20) confirmed CASH retry posts negative and writes an audit row", async () => {
    const c = await acc2("CASH");
    await fund(c, "1000");
    expect((await withdraw(c, "1500")).status).toBe(409);
    const auditBefore = await handle.prisma.auditLog.count({ where: { entityType: "treasury_negative_balance", entityId: c } });
    const ok = await withdraw(c, "1500", { ack: true, reason: "سلفة عاجلة" });
    expect(ok.status).toBeLessThan(300);
    expect((await glBalance(c)).toString()).toBe("-500");
    const auditAfter = await handle.prisma.auditLog.count({ where: { entityType: "treasury_negative_balance", entityId: c, action: "APPROVE" } });
    expect(auditAfter).toBe(auditBefore + 1);
  });

  it("8) confirmed BANK posting can end negative", async () => {
    const b = await acc2("BANK");
    await fund(b, "500");
    const ok = await withdraw(b, "800", { ack: true });
    expect(ok.status).toBeLessThan(300);
    expect((await glBalance(b)).toString()).toBe("-300");
  });

  it("9+10) an unauthorized role cannot post (with or without acknowledgement)", async () => {
    const c = await acc2("CASH");
    await fund(c, "100");
    expect((await withdraw(c, "500", { token: whToken })).status).toBe(403);
    expect((await withdraw(c, "500", { ack: true, token: whToken })).status).toBe(403);
    expect((await withdraw(c, "500", { ack: true, token: bmToken })).status).toBe(403);
  });

  it("11) a fake client-supplied balance is ignored; the server uses the GL", async () => {
    const c = await acc2("CASH");
    await fund(c, "100");
    const r = await request(server()).post("/api/v1/journal").set(H(ownerToken)).send({
      entryDate: "2026-07-15", description: "محاولة", currentBalance: "999999", // bogus, must be ignored
      lines: [{ accountId: expenseId, debit: "500", credit: "0" }, { accountId: c, debit: "0", credit: "500" }],
    });
    expect(r.status).toBe(409);
    expect(r.body.details.currentBalance).toBe("100.00"); // real GL balance, not the client value
  });

  it("13+14+15+12) concurrent withdrawals use the latest committed balance", async () => {
    const c = await acc2("CASH");
    await fund(c, "1000");
    const [r1, r2] = await Promise.all([withdraw(c, "800"), withdraw(c, "800")]); // 800+800 > 1000
    const oks = [r1, r2].filter((r) => r.status < 300);
    const warns = [r1, r2].filter((r) => r.status === 409);
    expect(oks).toHaveLength(1);
    expect(warns).toHaveLength(1);
    expect((await glBalance(c)).toString()).toBe("200"); // only one 800 outflow committed
    expect(warns[0].body.details.currentBalance).toBe("200.00"); // saw the committed balance, not 1000
    // after acknowledgement the second may still post negative
    const ack = await withdraw(c, "800", { ack: true });
    expect(ack.status).toBeLessThan(300);
    expect((await glBalance(c)).toString()).toBe("-600");
  });

  it("16) a multi-line journal uses the NET treasury effect (net increase never warns)", async () => {
    const c = await acc2("CASH");
    await fund(c, "500");
    // Dr cash 1000 / Cr cash 300 / Cr revenue 700 → net cash +700 (inflow) → no warning
    const r = await mj([{ accountId: c, debit: "1000", credit: "0" }, { accountId: c, debit: "0", credit: "300" }, { accountId: revenueId, debit: "0", credit: "700" }]);
    expect(r.status).toBeLessThan(300);
    expect((await glBalance(c)).toString()).toBe("1200"); // 500 + 700
  });

  it("17) a bank transfer checks only the source (outflow) account", async () => {
    await fund(bankAId, "1000");
    // Dr bankB 2000 / Cr bankA 2000 → only bankA (outflow) is checked; bankB is an inflow
    const r = await mj([{ accountId: bankBId, debit: "2000", credit: "0" }, { accountId: bankAId, debit: "0", credit: "2000" }]);
    expect(r.status).toBe(409);
    expect(r.body.details.treasuryAccountId).toBe(bankAId);
    expect(r.body.details.projectedBalance).toBe("-1000.00");
  });

  it("18+19) a reversal that would make treasury negative warns, and posts after acknowledgement", async () => {
    const c = await acc2("CASH");
    const customerId = (await handle.prisma.customer.create({ data: { code: `RC-${Date.now()}`, nameAr: "عميل" } })).id;
    // Receipt voucher: Dr cash / Cr AR 1000 → cash 1000
    const rv = (await request(server()).post("/api/v1/receipt-vouchers").set(H(ownerToken)).send({ voucherDate: "2026-07-15", branchId: handle.branchId, customerId, treasuryAccountId: c, amount: "1000" })).body;
    await request(server()).post(`/api/v1/receipt-vouchers/${rv.id}/post`).set(H(ownerToken)).send({});
    await withdraw(c, "600"); // cash 400
    const rev = await request(server()).post(`/api/v1/receipt-vouchers/${rv.id}/reverse`).set(H(ownerToken)).send({ reason: "عكس السند" });
    expect(rev.status).toBe(409); // reversing credits cash 1000 → 400-1000 = -600
    expect(rev.body.code).toBe("treasury_negative_balance_warning");
    const revOk = await request(server()).post(`/api/v1/receipt-vouchers/${rv.id}/reverse`).set(H(ownerToken)).send({ reason: "عكس السند", acknowledgeNegativeBalance: true });
    expect(revOk.status).toBeLessThan(300);
    expect((await glBalance(c)).toString()).toBe("-600");
  });

  it("21) a normal positive posting creates no negative-warning audit row", async () => {
    const c = await acc2("CASH");
    await fund(c, "1000");
    const before = await handle.prisma.auditLog.count({ where: { entityType: "treasury_negative_balance" } });
    await withdraw(c, "300");
    expect(await handle.prisma.auditLog.count({ where: { entityType: "treasury_negative_balance" } })).toBe(before);
  });

  it("22) the treasury statement immediately reflects a successful negative movement", async () => {
    const c = await acc2("CASH");
    await fund(c, "200");
    await withdraw(c, "500", { ack: true }); // → -300
    const st = await request(server()).get(`/api/v1/statements/account/${c}`).set(H(ownerToken));
    expect(st.status).toBe(200);
    expect(st.body.endingBalance).toBe("-300.00");
  });

  // helper: create an isolated treasury account so per-test balances don't interfere
  let seq = 0;
  async function acc2(type: "CASH" | "BANK"): Promise<string> {
    seq += 1;
    const a = await handle.prisma.account.create({ data: { code: `T${type}${Date.now()}${seq}`, nameAr: `خزينة ${seq}`, nameEn: "t", category: "ASSET", accountType: "CURRENT_ASSET", isLeaf: true, active: true, isCashOrBank: true, treasuryType: type } });
    return a.id;
  }
});
