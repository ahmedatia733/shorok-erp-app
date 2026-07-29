/**
 * Closure: supplier-payment branch propagation + treasury-aware validation, and
 * opening-balance reversal correctness (reverse after a later outflow, list shows
 * originals only with reversal metadata + counterpart, idempotent re-reverse).
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("treasuries — supplier-payment branch + opening reversal (closure)", () => {
  let h: TestApp;
  let owner: string, accountantA: string;
  let branchA: string, branchB: string;
  const acc: Record<string, string> = {};
  const srv = () => h.app.getHttpServer();
  const A = (t: string) => ({ Authorization: `Bearer ${t}` });
  const login = async (phone: string) => (await request(srv()).post("/api/v1/auth/login").send({ phone, password: "Pwd@2026!" })).body.accessToken as string;

  const glBalance = async (glAccountId: string) => {
    const r = await h.prisma.journalLine.aggregate({ _sum: { debit: true, credit: true }, where: { accountId: glAccountId } });
    return new Decimal(r._sum.debit?.toString() ?? "0").sub(r._sum.credit?.toString() ?? "0");
  };
  const mkTreasury = (nameAr: string, branchId: string, opts: Record<string, unknown> = {}) => request(srv()).post("/api/v1/treasuries").set(A(owner)).send({ nameAr, branchId, ...opts });
  const opening = (id: string, amount: string, date = "2026-02-01") => request(srv()).post(`/api/v1/treasuries/${id}/opening-balance`).set(A(owner)).send({ entryDate: date, amount });
  let supplierId: string;

  beforeAll(async () => {
    h = await buildTestApp();
    branchA = h.branchId;
    branchB = (await h.prisma.branch.create({ data: { nameAr: "فرع ب", nameEn: "Branch B", active: true } })).id;
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash } });
    owner = await login(h.ownerPhone);
    const u = await h.prisma.user.create({ data: { name: "acct A", phone: "+201820000001", passwordHash, role: "ACCOUNTANT", status: "ACTIVE" } });
    await h.prisma.userBranchAccess.create({ data: { userId: u.id, branchId: branchA } });
    accountantA = await login("+201820000001");

    const uq = Date.now().toString().slice(-6);
    const mk = async (k: string, code: string, cat: string, t: string, role?: string) => {
      acc[k] = (await h.prisma.account.create({ data: { code: `${code}${uq}`, nameAr: code, nameEn: code, category: cat as never, accountType: t as never, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } })).id;
    };
    await mk("ap", "AP", "LIABILITY", "LIABILITY", "AP_CONTROL");
    await mk("oeq", "OEQ", "EQUITY", "EQUITY");
    await mk("exp", "EXP", "EXPENSE", "EXPENSE");
    await h.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), apAccountId: acc.ap, openingEquityAccountId: acc.oeq, createdBy: h.ownerId } });
    for (let m = 1; m <= 12; m++) await h.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "S" } })).id;
  });
  afterAll(async () => teardownTestApp(h));

  // ── §3 supplier-payment branch dimension ─────────────────────────────
  it("§3.1,6: a supplier payment via treasuryId posts BOTH journal lines with the treasury branch and lowers exactly that treasury", async () => {
    const tA = (await mkTreasury("خزنة أ", branchA)).body; await opening(tA.id, "1000.00");
    const res = await request(srv()).post("/api/v1/supplier-payments").set(A(owner)).send({ supplierId, apAccountId: acc.ap, bankAccountId: tA.glAccountId, treasuryId: tA.id, amount: "300.00", paymentDate: "2026-03-01" });
    expect(res.status).toBeLessThan(300);
    const lines = await h.prisma.journalLine.findMany({ where: { journalEntryId: res.body.journalEntryId } });
    expect(lines.length).toBe(2);
    expect(lines.every((l) => l.branchId === branchA)).toBe(true); // §3.1 both lines carry branchId
    expect((await glBalance(tA.glAccountId)).toFixed(2)).toBe("700.00"); // §3.6 exact treasury lowered
  });

  it("§3.2,5: a foreign-branch treasury is rejected (no leak); OWNER cannot post a branch-A payment from a branch-B treasury", async () => {
    const tB = (await mkTreasury("خزنة ب", branchB)).body;
    // branch-A accountant citing a branch-B treasury → 404 no-leak
    const foreign = await request(srv()).post("/api/v1/supplier-payments").set(A(accountantA)).send({ supplierId, apAccountId: acc.ap, bankAccountId: tB.glAccountId, treasuryId: tB.id, amount: "10.00", paymentDate: "2026-03-01" });
    expect(foreign.status).toBe(404);
    // OWNER: branchId=A but treasuryId=B → branch mismatch (cannot silently cross branches)
    const mism = await request(srv()).post("/api/v1/supplier-payments").set(A(owner)).send({ supplierId, apAccountId: acc.ap, bankAccountId: tB.glAccountId, treasuryId: tB.id, branchId: branchA, amount: "10.00", paymentDate: "2026-03-01" });
    expect(mism.status).toBe(409);
    expect(mism.body.details?.reason).toBe("treasury_branch_mismatch");
  });

  it("§3.3: an inactive treasury is rejected on supplier payment", async () => {
    const t = (await mkTreasury("خزنة موقوفة", branchA)).body;
    await request(srv()).post(`/api/v1/treasuries/${t.id}/deactivate`).set(A(owner)).send({});
    const res = await request(srv()).post("/api/v1/supplier-payments").set(A(owner)).send({ supplierId, apAccountId: acc.ap, bankAccountId: t.glAccountId, treasuryId: t.id, amount: "10.00", paymentDate: "2026-03-01" });
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("treasury_inactive");
  });

  // ── §4 opening-balance reversal correctness ──────────────────────────
  it("§4: reverse an opening balance AFTER a later outflow → treasury goes negative; list shows original only + reversal metadata + counterpart; idempotent", async () => {
    const t = (await mkTreasury("خزنة العكس", branchA)).body; // allowNegativeBalance=false by default
    const ob = await opening(t.id, "700.00", "2026-02-02");
    // later outflow -500 via an expense
    const exp = await request(srv()).post("/api/v1/expenses").set(A(owner)).send({ branchId: branchA, expenseDate: "2026-02-10", description: "م", amount: "500.00", paidFromAccount: "خزنة", glAccountId: acc.exp, paymentGlAccountId: t.glAccountId });
    expect(exp.status).toBeLessThan(300);
    expect((await glBalance(t.glAccountId)).toFixed(2)).toBe("200.00");

    // reverse the ORIGINAL opening → must succeed despite no-negative, balance = -500
    const rev = await request(srv()).post(`/api/v1/treasuries/${t.id}/opening-balances/${ob.body.journalEntryId}/reverse`).set(A(owner)).send({ reason: "تصحيح رصيد افتتاحي" });
    expect(rev.status).toBeLessThan(300);
    expect((await glBalance(t.glAccountId)).toFixed(2)).toBe("-500.00");

    // list: exactly ONE original (not the reversal), with reversal metadata + counterpart code/name
    const list = (await request(srv()).get(`/api/v1/treasuries/${t.id}/opening-balances`).set(A(owner))).body.items;
    expect(list.length).toBe(1);
    expect(list[0].status).toBe("REVERSED");
    expect(list[0].reversalEntryNumber).toBeTruthy();
    expect(list[0].reversedAt).toBeTruthy();
    expect(list[0].counterpartAccountCode).toContain("OEQ");
    expect(list[0].counterpartAccountNameAr).toBeTruthy();

    // idempotent re-reverse: no second reversal journal, balance unchanged
    const again = await request(srv()).post(`/api/v1/treasuries/${t.id}/opening-balances/${ob.body.journalEntryId}/reverse`).set(A(owner)).send({ reason: "تصحيح رصيد افتتاحي" });
    expect(again.status).toBeLessThan(300);
    expect(again.body.idempotent).toBe(true);
    expect((await glBalance(t.glAccountId)).toFixed(2)).toBe("-500.00");
    const list2 = (await request(srv()).get(`/api/v1/treasuries/${t.id}/opening-balances`).set(A(owner))).body.items;
    expect(list2.length).toBe(1); // still one original; reversal not double-counted
  });
});
