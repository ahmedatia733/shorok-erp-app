/**
 * Multi-treasury OPERATIONAL integration (closure phase): treasury-aware
 * validation on receipts / supplier payments / expenses, active/inactive
 * enforcement, unified negative-balance policy, transfer branch visibility +
 * cross-branch rejection, opening-balance reversal, and statement pagination.
 * All balances derive from journal_lines.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("treasuries operational integration (closure)", () => {
  let h: TestApp;
  let owner: string, accountantA: string, userB: string;
  let branchA: string, branchB: string;
  const acc: Record<string, string> = {};
  const srv = () => h.app.getHttpServer();
  const A = (t: string) => ({ Authorization: `Bearer ${t}` });
  const login = async (phone: string) => (await request(srv()).post("/api/v1/auth/login").send({ phone, password: "Pwd@2026!" })).body.accessToken as string;

  const glBalance = async (glAccountId: string) => {
    const r = await h.prisma.journalLine.aggregate({ _sum: { debit: true, credit: true }, where: { accountId: glAccountId } });
    return new Decimal(r._sum.debit?.toString() ?? "0").sub(r._sum.credit?.toString() ?? "0");
  };
  const mkTreasury = (body: Record<string, unknown>, token = owner) => request(srv()).post("/api/v1/treasuries").set(A(token)).send(body);
  const openingBalance = (id: string, amount: string, date = "2026-02-01") => request(srv()).post(`/api/v1/treasuries/${id}/opening-balance`).set(A(owner)).send({ entryDate: date, amount });

  // treasuries in branch A
  let tA1: string, tA1Gl: string, tA2: string, tA2Gl: string, tInactive: string, tInactiveGl: string;
  let tB1: string, tB1Gl: string;
  let customerId: string, supplierId: string;

  beforeAll(async () => {
    h = await buildTestApp();
    branchA = h.branchId;
    branchB = (await h.prisma.branch.create({ data: { nameAr: "فرع ب", nameEn: "Branch B", active: true } })).id;
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash } });
    const mkUser = async (phone: string, role: string, branches: string[]) => {
      const u = await h.prisma.user.create({ data: { name: phone, phone, passwordHash, role: role as never, status: "ACTIVE" } });
      for (const b of branches) await h.prisma.userBranchAccess.create({ data: { userId: u.id, branchId: b } });
      return login(phone);
    };
    owner = await login(h.ownerPhone);
    accountantA = await mkUser("+201810000001", "ACCOUNTANT", [branchA]);
    userB = await mkUser("+201810000002", "ACCOUNTANT", [branchB]);

    const u = Date.now().toString().slice(-6);
    const mk = async (key: string, code: string, cat: string, t: string, role?: string) => {
      acc[key] = (await h.prisma.account.create({ data: { code: `${code}${u}`, nameAr: code, nameEn: code, category: cat as never, accountType: t as never, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } })).id;
    };
    await mk("ar", "AR", "ASSET", "CURRENT_ASSET", "AR_CONTROL");
    await mk("ap", "AP", "LIABILITY", "LIABILITY", "AP_CONTROL");
    await mk("oeq", "OEQ", "EQUITY", "EQUITY");
    await mk("exp", "EXP", "EXPENSE", "EXPENSE");
    await h.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId: acc.ar, apAccountId: acc.ap, openingEquityAccountId: acc.oeq, createdBy: h.ownerId } });
    for (let m = 1; m <= 12; m++) await h.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });
    customerId = (await h.prisma.customer.create({ data: { code: "OPC", nameAr: "عميل" } })).id;
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "S" } })).id;

    const c1 = await mkTreasury({ nameAr: "خزنة أ-1", branchId: branchA }); tA1 = c1.body.id; tA1Gl = c1.body.glAccountId;
    const c2 = await mkTreasury({ nameAr: "خزنة أ-2", branchId: branchA }); tA2 = c2.body.id; tA2Gl = c2.body.glAccountId;
    const ci = await mkTreasury({ nameAr: "خزنة موقوفة", branchId: branchA }); tInactive = ci.body.id; tInactiveGl = ci.body.glAccountId;
    const cb = await mkTreasury({ nameAr: "خزنة ب-1", branchId: branchB }); tB1 = cb.body.id; tB1Gl = cb.body.glAccountId;
    await openingBalance(tA1, "1000.00");
    await request(srv()).post(`/api/v1/treasuries/${tInactive}/deactivate`).set(A(owner)).send({});
  });
  afterAll(async () => teardownTestApp(h));

  // ── selectors + active/inactive (§12.1-5) ────────────────────────────
  it("1-4. active treasuries appear in the selector; inactive ones do not", async () => {
    const sel = (await request(srv()).get("/api/v1/treasuries/selector").set(A(owner))).body.items;
    expect(sel.some((t: any) => t.id === tA1)).toBe(true);
    expect(sel.some((t: any) => t.id === tInactive)).toBe(false);
  });

  it("5. an inactive treasury is rejected by receipt / supplier-payment / expense APIs", async () => {
    const receipt = await request(srv()).post("/api/v1/receipt-vouchers").set(A(owner)).send({ voucherDate: "2026-03-01", branchId: branchA, customerId, treasuryAccountId: tInactiveGl, amount: "50.00" });
    expect(receipt.status).toBe(409);
    expect(receipt.body.details?.reason).toBe("treasury_inactive");
    const pay = await request(srv()).post("/api/v1/supplier-payments").set(A(owner)).send({ supplierId, apAccountId: acc.ap, bankAccountId: tInactiveGl, amount: "50.00", paymentDate: "2026-03-01" });
    expect(pay.status).toBe(409);
    expect(pay.body.details?.reason).toBe("treasury_inactive");
    const exp = await request(srv()).post("/api/v1/expenses").set(A(owner)).send({ branchId: branchA, expenseDate: "2026-03-01", description: "م", amount: "50.00", paidFromAccount: "خزنة", glAccountId: acc.exp, paymentGlAccountId: tInactiveGl });
    expect(exp.status).toBe(409);
    expect(exp.body.details?.reason).toBe("treasury_inactive");
  });

  it("6-7. a foreign-branch treasury / branch mismatch is rejected by the three APIs", async () => {
    // receipt in branch A citing a branch-B treasury → branch mismatch
    const receipt = await request(srv()).post("/api/v1/receipt-vouchers").set(A(owner)).send({ voucherDate: "2026-03-01", branchId: branchA, customerId, treasuryAccountId: tB1Gl, amount: "50.00" });
    expect(receipt.status).toBe(409);
    expect(receipt.body.details?.reason).toBe("treasury_branch_mismatch");
    // branch-A accountant citing a branch-B treasury on a payment → 404 no-leak
    const pay = await request(srv()).post("/api/v1/supplier-payments").set(A(accountantA)).send({ supplierId, apAccountId: acc.ap, bankAccountId: tB1Gl, amount: "50.00", paymentDate: "2026-03-01" });
    expect(pay.status).toBe(404);
  });

  // ── negative-balance policy (§12.8-9) ────────────────────────────────
  it("8. allowNegativeBalance=false hard-rejects an expense/payment outflow even with acknowledge", async () => {
    // tA2 has zero balance and disallows negatives.
    const exp = await request(srv()).post("/api/v1/expenses").set(A(owner)).send({ branchId: branchA, expenseDate: "2026-03-01", description: "م", amount: "500.00", paidFromAccount: "خزنة", glAccountId: acc.exp, paymentGlAccountId: tA2Gl });
    expect(exp.status).toBe(409);
    expect(exp.body.details?.reason).toBe("insufficient_treasury_balance");
    const pay = await request(srv()).post("/api/v1/supplier-payments").set(A(owner)).send({ supplierId, apAccountId: acc.ap, bankAccountId: tA2Gl, amount: "500.00", paymentDate: "2026-03-01", acknowledgeNegativeBalance: true, negativeBalanceReason: "force" });
    expect(pay.status).toBe(409);
    expect(pay.body.details?.reason).toBe("insufficient_treasury_balance"); // acknowledge cannot override
  });

  it("9. allowNegativeBalance=true lets the outflow proceed (audited)", async () => {
    const neg = await mkTreasury({ nameAr: "خزنة سالبة", branchId: branchA, allowNegativeBalance: true });
    const exp = await request(srv()).post("/api/v1/expenses").set(A(owner)).send({ branchId: branchA, expenseDate: "2026-03-01", description: "م", amount: "120.00", paidFromAccount: "خزنة", glAccountId: acc.exp, paymentGlAccountId: neg.body.glAccountId, acknowledgeNegativeBalance: true, negativeBalanceReason: "allowed" });
    expect(exp.status).toBeLessThan(300);
    expect((await glBalance(neg.body.glAccountId)).toFixed(2)).toBe("-120.00");
  });

  it("16,receipt. a receipt into an active same-branch treasury posts a debit that raises its balance", async () => {
    const r = await request(srv()).post("/api/v1/receipt-vouchers").set(A(owner)).send({ voucherDate: "2026-03-02", branchId: branchA, customerId, treasuryAccountId: tA1Gl, amount: "200.00" });
    expect(r.status).toBeLessThan(300);
    await request(srv()).post(`/api/v1/receipt-vouchers/${r.body.id}/post`).set(A(owner)).send({});
    expect((await glBalance(tA1Gl)).toFixed(2)).toBe("1200.00"); // 1000 opening + 200 receipt
  });

  // ── transfer visibility + cross-branch (§12.10-12) ───────────────────
  it("10-11. cross-branch transfer is rejected; same-branch transfer is allowed", async () => {
    const cross = await request(srv()).post("/api/v1/treasuries/transfers").set(A(owner)).send({ transferDate: "2026-03-03", sourceTreasuryId: tA1, destinationTreasuryId: tB1, amount: "10.00" });
    expect(cross.status).toBe(409);
    expect(cross.body.details?.reason).toBe("cross_branch_transfer_not_allowed");
    const same = await request(srv()).post("/api/v1/treasuries/transfers").set(A(owner)).send({ transferDate: "2026-03-03", sourceTreasuryId: tA1, destinationTreasuryId: tA2, amount: "100.00" });
    expect(same.status).toBeLessThan(300);
  });

  it("10b,12. transfer list requires BOTH branches; explicit foreign branch filter on the treasury list is forbidden", async () => {
    // userB (branch B) must not see a branch-A transfer (both sides in A).
    const asB = (await request(srv()).get("/api/v1/treasuries/transfers").set(A(userB))).body.items;
    expect(asB.length).toBe(0);
    // explicit foreign branchId on the treasury list → 403 (global branch guard)
    expect((await request(srv()).get(`/api/v1/treasuries?branchId=${branchA}`).set(A(userB))).status).toBe(403);
  });

  // ── opening-balance reversal (§12.13-14) ─────────────────────────────
  it("13. opening balance cannot be booked into a foreign branch", async () => {
    const res = await request(srv()).post(`/api/v1/treasuries/${tA2}/opening-balance`).set(A(owner)).send({ entryDate: "2026-02-05", amount: "10.00", branchId: branchB });
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("opening_balance_branch_mismatch");
  });

  it("14. an opening balance can be listed, reversed exactly, and re-reversing is idempotent", async () => {
    const c = await mkTreasury({ nameAr: "خزنة عكس", branchId: branchA });
    const ob = await openingBalance(c.body.id, "700.00", "2026-02-06");
    expect((await glBalance(c.body.glAccountId)).toFixed(2)).toBe("700.00");
    const list = (await request(srv()).get(`/api/v1/treasuries/${c.body.id}/opening-balances`).set(A(owner))).body.items;
    expect(list.length).toBe(1);
    expect(list[0].amount).toBe("700.00");
    const rev = await request(srv()).post(`/api/v1/treasuries/${c.body.id}/opening-balances/${ob.body.journalEntryId}/reverse`).set(A(owner)).send({ reason: "خطأ" });
    expect(rev.status).toBeLessThan(300);
    expect((await glBalance(c.body.glAccountId)).toFixed(2)).toBe("0.00"); // exact reversal
    const again = await request(srv()).post(`/api/v1/treasuries/${c.body.id}/opening-balances/${ob.body.journalEntryId}/reverse`).set(A(owner)).send({ reason: "خطأ" });
    expect(again.status).toBeLessThan(300);
    expect(again.body.idempotent).toBe(true);
    expect((await glBalance(c.body.glAccountId)).toFixed(2)).toBe("0.00"); // still zero, no double reversal
  });

  // ── statement pagination (§12.15) ────────────────────────────────────
  it("15. statement pagination returns stable pages with correct running balances", async () => {
    const c = await mkTreasury({ nameAr: "خزنة كشف", branchId: branchA });
    // 5 opening-balance postings of 100 each (distinct dates → distinct entries)
    for (let d = 1; d <= 5; d++) await openingBalance(c.body.id, "100.00", `2026-04-0${d}`);
    const page1 = (await request(srv()).get(`/api/v1/treasuries/${c.body.id}/statement?limit=2`).set(A(owner))).body;
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.items[1].runningBalance).toBe("200.00");
    const page2 = (await request(srv()).get(`/api/v1/treasuries/${c.body.id}/statement?limit=2&cursor=${page1.nextCursor}`).set(A(owner))).body;
    expect(page2.items.length).toBe(2);
    expect(page2.items[0].runningBalance).toBe("300.00"); // continues from page 1
    expect(page2.items[1].runningBalance).toBe("400.00");
    expect(page2.currentBalance).toBe("500.00"); // authoritative whole-account balance
  });

  // ── per-branch default (§12.16) ──────────────────────────────────────
  it("16. default treasury is scoped PER BRANCH (each branch keeps its own default)", async () => {
    const defaults = await h.prisma.treasury.findMany({ where: { isDefault: true }, select: { branchId: true } });
    const branchesWithDefault = defaults.map((d) => d.branchId);
    expect(branchesWithDefault).toContain(branchA);
    expect(branchesWithDefault).toContain(branchB);
    // exactly one default per branch
    expect(new Set(branchesWithDefault).size).toBe(branchesWithDefault.length);
  });
});
