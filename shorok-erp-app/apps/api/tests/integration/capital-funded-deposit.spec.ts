/**
 * A capital-funded refundable deposit is booked as an ASSET against CAPITAL —
 * never as an expense. Getting that wrong understates both assets and equity and
 * misstates the period's profit, so the shape of the entry and its invisibility
 * to the P&L are asserted here rather than assumed.
 *
 * The second half is the accountant's view. The whole point of posting the entry
 * is that the accountant can see it, so this proves an ACCOUNTANT can read the
 * journal, the chart of accounts, the trial balance and both affected account
 * statements — and that they cannot delete or edit what has been posted.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

/** Only the fields these assertions read back. */
interface Line { accountId: string; debit: string; credit: string; partyId?: string | null }
interface Entry { id: string }
type Category = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "COST_OF_SALES" | "EXPENSE";
type AccType = "FIXED_ASSET" | "CURRENT_ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "COST_OF_SALES" | "EXPENSE";

describe("capital-funded refundable deposit", () => {
  let h: TestApp;
  let owner: string;
  let accountant: string;
  let assetId: string;
  let capitalId: string;
  let entryId: string;

  const A = (t: string) => ({ Authorization: `Bearer ${t}` });
  const srv = () => h.app.getHttpServer();
  const login = async (phone: string) =>
    (await request(srv()).post("/api/v1/auth/login").send({ phone, password: "Pwd@2026!" }))
      .body.accessToken as string;

  const REFERENCE = "TEST:REFUNDABLE-DEPOSIT:ROW7#abcdef123456";
  const AMOUNT = "60000.00";

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({
      where: { id: h.ownerId },
      data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) },
    });
    owner = await login(h.ownerPhone);

    const u = Date.now().toString().slice(-6);
    const acct = await h.prisma.user.create({
      data: {
        name: "accountant", phone: `+20119${u}`,
        passwordHash: await bcrypt.hash("Pwd@2026!", 10),
        role: "ACCOUNTANT", status: "ACTIVE",
      },
    });
    await h.prisma.userBranchAccess.create({ data: { userId: acct.id, branchId: h.branchId } });
    accountant = await login(acct.phone);
    // A silently failed login turns every later assertion into a meaningless
    // 401, so fail here instead where the cause is obvious.
    if (!accountant) throw new Error(`accountant login failed for ${acct.phone}`);

    const mk = async (code: string, nameAr: string, cat: Category, type: AccType) =>
      (await h.prisma.account.create({
        data: { code: `${code}${u}`, nameAr, nameEn: code, category: cat, accountType: type, isLeaf: true, active: true },
      })).id;

    assetId = await mk("DEP", "تأمينات لدى الغير", "ASSET", "CURRENT_ASSET");
    capitalId = await mk("CAP", "رأس المال", "EQUITY", "EQUITY");
    // An expense account exists in the fixture so "touches no expense account"
    // is a real assertion about choice, not an accident of an empty chart.
    await mk("EXP", "مصروفات", "EXPENSE", "EXPENSE");

    for (let m = 1; m <= 12; m += 1) {
      await h.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });
    }
  });

  afterAll(async () => {
    await teardownTestApp(h);
  });

  const post = (tok: string, body: unknown) =>
    request(srv()).post("/api/v1/journal").set(A(tok)).send(body);

  const deposit = (over: Record<string, unknown> = {}) => ({
    entryType: "JOURNAL",
    entryDate: "2026-08-01",
    description: "إثبات تأمين مسترد لمدة شهرين ممول من رأس المال",
    reference: REFERENCE,
    idempotencyKey: REFERENCE,
    lines: [
      { accountId: assetId, debit: AMOUNT, credit: "0" },
      { accountId: capitalId, debit: "0", credit: AMOUNT },
    ],
    ...over,
  });

  it("posts as Dr asset / Cr capital with exactly two balanced lines", async () => {
    const res = await post(owner, deposit());
    expect(res.status).toBe(201);
    entryId = res.body.id;

    const detail = await request(srv()).get(`/api/v1/journal/${entryId}`).set(A(owner));
    expect(detail.status).toBe(200);
    expect(detail.body.lines).toHaveLength(2);

    const dr = detail.body.lines.reduce((sum: number, l: Line) => sum + Number(l.debit), 0);
    const cr = detail.body.lines.reduce((sum: number, l: Line) => sum + Number(l.credit), 0);
    expect(dr).toBeCloseTo(60000, 2);
    expect(cr).toBeCloseTo(60000, 2);
    expect(dr - cr).toBeCloseTo(0, 2);

    expect(detail.body.lines.some((l: Line) => l.accountId === assetId && Number(l.debit) === 60000)).toBe(true);
    expect(detail.body.lines.some((l: Line) => l.accountId === capitalId && Number(l.credit) === 60000)).toBe(true);
    // A deposit belongs to no customer or supplier; a party dimension here would
    // wrongly attach it to someone's ledger.
    expect(detail.body.lines.every((l: Line) => !l.partyId)).toBe(true);
  });

  it("touches no expense or cost account", async () => {
    const lines = await h.prisma.journalLine.findMany({
      where: { journalEntryId: entryId },
      select: { account: { select: { category: true } } },
    });
    const categories = lines.map((l) => l.account.category);
    expect(categories).not.toContain("EXPENSE");
    expect(categories).not.toContain("COST_OF_SALES");
    expect(new Set(categories)).toEqual(new Set(["ASSET", "EQUITY"]));
  });

  it("creates no document, movement or party transaction", async () => {
    for (const count of [
      h.prisma.expense.count(),
      h.prisma.inventoryMovement.count(),
      h.prisma.customerTransaction.count(),
      h.prisma.salesInvoice.count(),
      h.prisma.receiptVoucher.count(),
      h.prisma.paymentVoucher.count(),
      h.prisma.treasuryTransfer.count(),
    ]) {
      expect(await count).toBe(0);
    }
  });

  it("refuses a repeat post with the same idempotency key", async () => {
    const before = await h.prisma.journalEntry.count();
    const again = await post(owner, deposit());
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(entryId);
    expect(await h.prisma.journalEntry.count()).toBe(before);
    expect(await h.prisma.journalLine.count({ where: { journalEntryId: entryId } })).toBe(2);
  });

  it("rejects an unbalanced deposit entry", async () => {
    const res = await post(owner, deposit({
      reference: `${REFERENCE}-unbalanced`,
      idempotencyKey: `${REFERENCE}-unbalanced`,
      lines: [
        { accountId: assetId, debit: AMOUNT, credit: "0" },
        { accountId: capitalId, debit: "0", credit: "59999.00" },
      ],
    }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // ── the accountant's view ────────────────────────────────────────────────
  describe("ACCOUNTANT visibility", () => {
    it("can read the posted entry in the general journal", async () => {
      const one = await request(srv()).get(`/api/v1/journal/${entryId}`).set(A(accountant));
      expect(one.status).toBe(200);
      expect(one.body.lines).toHaveLength(2);
      expect(one.body.description).toContain("تأمين مسترد");

      const list = await request(srv()).get("/api/v1/journal?limit=100").set(A(accountant));
      expect(list.status).toBe(200);
      expect(list.body.data.some((e: Entry) => e.id === entryId)).toBe(true);
    });

    it("can read the chart of accounts and both affected balances", async () => {
      const chart = await request(srv()).get("/api/v1/accounts").set(A(accountant));
      expect(chart.status).toBe(200);

      const asset = await request(srv()).get(`/api/v1/accounts/${assetId}/balance`).set(A(accountant));
      expect(asset.status).toBe(200);
      expect(Number(asset.body.debit)).toBeCloseTo(60000, 2);

      const capital = await request(srv()).get(`/api/v1/accounts/${capitalId}/balance`).set(A(accountant));
      expect(capital.status).toBe(200);
      expect(Number(capital.body.credit)).toBeCloseTo(60000, 2);
    });

    it("can read the trial balance and the account statement", async () => {
      const tb = await request(srv())
        .get("/api/v1/reports/trial-balance?from=2026-01-01&to=2026-12-31").set(A(accountant));
      expect(tb.status).toBe(200);

      const stmt = await request(srv())
        .get("/api/v1/statements/consolidated?category=all&from=2026-01-01&to=2026-12-31").set(A(accountant));
      expect(stmt.status).toBe(200);
    });

    it("cannot delete the posted entry", async () => {
      const res = await request(srv()).delete(`/api/v1/journal/${entryId}`).set(A(accountant));
      expect(res.status).toBe(403);
      expect(await h.prisma.journalEntry.findUnique({ where: { id: entryId } })).not.toBeNull();
    });

    it("cannot create or rename an account", async () => {
      const create = await request(srv()).post("/api/v1/accounts").set(A(accountant)).send({
        code: "9999", nameAr: "x", nameEn: "x", category: "ASSET", accountType: "CURRENT_ASSET",
      });
      expect(create.status).toBe(403);

      const patch = await request(srv()).patch(`/api/v1/accounts/${assetId}`).set(A(accountant))
        .send({ nameAr: "renamed" });
      expect(patch.status).toBe(403);
    });

    it("cannot edit a posted entry — no update route exists, and delete is refused even for OWNER", async () => {
      const put = await request(srv()).put(`/api/v1/journal/${entryId}`).set(A(owner)).send({});
      expect(put.status).toBe(404);

      // OWNER is allowed through the guard and still refused: corrections are
      // reversals, so history is never rewritten.
      const del = await request(srv()).delete(`/api/v1/journal/${entryId}`).set(A(owner));
      expect(del.status).toBe(409);
      expect(await h.prisma.journalEntry.findUnique({ where: { id: entryId } })).not.toBeNull();
    });
  });
});
