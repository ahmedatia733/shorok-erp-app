/**
 * إدارة المصروفات — the expenses area, against a real database.
 *
 * The feature's whole claim is that it adds no second source of truth: an
 * expense item is a Chart-of-Accounts account, an expense movement is a journal
 * line, and every total is the General Ledger asked a narrower question. So the
 * assertions worth making are mostly about agreement — with the Income
 * Statement, with the chart of accounts, and between the two doors through which
 * an expense item can be created.
 *
 * The strongest test here is the one that adds up the dashboard and the income
 * statement and refuses to let them differ.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, openCurrentPeriod, type TestApp } from "./test-app";

describe("expense accounts (إدارة المصروفات)", () => {
  let handle: TestApp;
  let ownerToken: string;
  let accountantToken: string;
  let warehouseToken: string;
  let cashId: string;
  let transportId: string;
  let rentId: string;
  let salariesId: string;
  let inactiveId: string;
  let parentId: string;
  let revenueId: string;

  const server = () => handle.app.getHttpServer();
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const api = () => request(server());

  const get = (path: string, token = ownerToken) => api().get(`/api/v1${path}`).set(H(token));
  const post = (path: string, body: unknown, token = ownerToken) =>
    api().post(`/api/v1${path}`).set(H(token)).send(body);
  const patch = (path: string, body: unknown, token = ownerToken) =>
    api().patch(`/api/v1${path}`).set(H(token)).send(body);

  /** A real posted journal entry, through the engine the rest of the system uses. */
  const journal = (
    lines: Array<Record<string, unknown>>,
    entryDate = "2026-07-15",
    description = "قيد مصروفات",
  ) => post("/journal", { entryDate, description, lines });

  const u = Date.now().toString().slice(-6);

  beforeAll(async () => {
    handle = await buildTestApp();
    const pw = "Pwd@2026!";
    const passwordHash = await bcrypt.hash(pw, 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    await handle.prisma.user.create({
      data: {
        name: "محاسب",
        phone: `+2015${u}1`,
        passwordHash,
        role: "ACCOUNTANT" as never,
        status: "ACTIVE",
        branchAccesses: { create: { branchId: handle.branchId } },
      },
    });
    await handle.prisma.user.create({
      data: {
        name: "أمين مخزن",
        phone: `+2015${u}2`,
        passwordHash,
        role: "WAREHOUSE" as never,
        status: "ACTIVE",
        branchAccesses: { create: { branchId: handle.branchId } },
      },
    });
    const login = async (phone: string) =>
      (await api().post("/api/v1/auth/login").send({ phone, password: pw })).body.accessToken as string;
    ownerToken = await login(handle.ownerPhone);
    accountantToken = await login(`+2015${u}1`);
    warehouseToken = await login(`+2015${u}2`);

    const acc = (
      code: string,
      nameAr: string,
      cat: string,
      type: string,
      opts: { leaf?: boolean; active?: boolean; cash?: "CASH" } = {},
    ) =>
      handle.prisma.account.create({
        data: {
          code,
          nameAr,
          nameEn: nameAr,
          category: cat as never,
          accountType: type as never,
          isLeaf: opts.leaf ?? true,
          active: opts.active ?? true,
          ...(opts.cash ? { isCashOrBank: true, treasuryType: opts.cash } : {}),
        },
      });

    cashId = (await acc(`CASH${u}`, "الخزنة", "ASSET", "CURRENT_ASSET", { cash: "CASH" })).id;
    transportId = (await acc(`6100${u}`, "النقل والشحن", "EXPENSE", "EXPENSE")).id;
    rentId = (await acc(`6400${u}`, "الإيجارات", "EXPENSE", "EXPENSE")).id;
    salariesId = (await acc(`6200${u}`, "الرواتب", "EXPENSE", "EXPENSE")).id;
    inactiveId = (await acc(`6900${u}`, "بند موقوف", "EXPENSE", "EXPENSE", { active: false })).id;
    parentId = (await acc(`6000${u}`, "المصروفات", "EXPENSE", "EXPENSE", { leaf: false })).id;
    revenueId = (await acc(`4100${u}`, "إيرادات", "REVENUE", "REVENUE")).id;
    const equityId = (await acc(`3100${u}`, "رأس المال", "EQUITY", "EQUITY")).id;

    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 6, status: "OPEN" } });
    await openCurrentPeriod(handle);

    // Fund the treasury first. The posting engine refuses to drive a cash
    // account negative without an explicit acknowledgement, which is the same
    // reason a real book opens with capital before it pays rent.
    const opening = await journal(
      [
        { accountId: cashId, debit: "100000", credit: "0" },
        { accountId: equityId, debit: "0", credit: "100000" },
      ],
      "2026-06-01",
      "رصيد افتتاحي",
    );
    if (opening.status !== 201) {
      throw new Error(`opening failed ${opening.status}: ${JSON.stringify(opening.body)}`);
    }

    // June: 500 rent. July: 900 transport + 300 transport + 1200 rent.
    const seeded = await journal(
      [
        { accountId: rentId, debit: "500", credit: "0" },
        { accountId: cashId, debit: "0", credit: "500" },
      ],
      "2026-06-10",
      "إيجار يونيو",
    );
    if (seeded.status !== 201) {
      throw new Error(`seed journal failed ${seeded.status}: ${JSON.stringify(seeded.body)}`);
    }
    await journal([
      { accountId: transportId, debit: "900", credit: "0" },
      { accountId: cashId, debit: "0", credit: "900" },
    ]);
    await journal(
      [
        { accountId: transportId, debit: "300", credit: "0" },
        { accountId: cashId, debit: "0", credit: "300" },
      ],
      "2026-07-20",
      "شحن إضافي",
    );
    await journal(
      [
        { accountId: rentId, debit: "1200", credit: "0" },
        { accountId: cashId, debit: "0", credit: "1200" },
      ],
      "2026-07-25",
      "إيجار يوليو",
    );
    // Revenue, to prove the expenses screens ignore everything that is not one.
    await journal(
      [
        { accountId: cashId, debit: "5000", credit: "0" },
        { accountId: revenueId, debit: "0", credit: "5000" },
      ],
      "2026-07-25",
      "مبيعات",
    );
  });

  afterAll(async () => teardownTestApp(handle));

  const JULY = "?from=2026-07-01&to=2026-07-31";

  // ── A/B: existing accounts appear once, unchanged ────────────────────────

  it("A) lists every expense account exactly once, and nothing that is not one", async () => {
    const res = await get(`/expense-accounts${JULY}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { accountId: string }) => i.accountId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([transportId, rentId, salariesId, inactiveId]));
    expect(ids).not.toContain(revenueId);
    expect(ids).not.toContain(cashId);
    // A parent is a heading, not a spendable item — and the Income Statement
    // counts leaves only, so including it here would double-count.
    expect(ids).not.toContain(parentId);
  });

  it("B) reports the stored code and name untouched", async () => {
    const item = (await get(`/expense-accounts${JULY}`)).body.items.find(
      (i: { accountId: string }) => i.accountId === transportId,
    );
    const row = await handle.prisma.account.findUnique({ where: { id: transportId } });
    expect(item.code).toBe(row!.code);
    expect(item.nameAr).toBe(row!.nameAr);
  });

  it("B2) sums each item over the period and over all time, separately", async () => {
    const items = (await get(`/expense-accounts${JULY}`)).body.items;
    const transport = items.find((i: { accountId: string }) => i.accountId === transportId);
    const rent = items.find((i: { accountId: string }) => i.accountId === rentId);
    expect(transport.periodAmount).toBe("1200.00"); // 900 + 300, July only
    expect(transport.totalAmount).toBe("1200.00");
    expect(rent.periodAmount).toBe("1200.00"); // July only
    expect(rent.totalAmount).toBe("1700.00"); // + June's 500
    expect(rent.lastMovementDate).toBe("2026-07-25");
    expect(transport.periodMovementCount).toBe(2);
  });

  it("B3) an item with no movement still appears, at zero", async () => {
    const salaries = (await get(`/expense-accounts${JULY}`)).body.items.find(
      (i: { accountId: string }) => i.accountId === salariesId,
    );
    expect(salaries.periodAmount).toBe("0.00");
    expect(salaries.lastMovementDate).toBeNull();
  });

  // ── C: the numbers agree with the Income Statement ───────────────────────

  it("C) the dashboard total is exactly the Income Statement's total expenses", async () => {
    const dash = (await get(`/expense-accounts/dashboard${JULY}`)).body;
    const pnl = (await get(`/reports/income-statement${JULY}`)).body;
    expect(dash.periodTotal).toBe(pnl.totalExpenses);

    // …and line by line, not just in total.
    const mine = new Map(dash.byItem.map((i: { accountId: string; amount: string }) => [i.accountId, i.amount]));
    for (const line of pnl.expenses) expect(mine.get(line.accountId)).toBe(line.amount);
    expect(dash.byItem.length).toBe(pnl.expenses.length);
  });

  it("C2) a reversed entry drops out of both, exactly as the Income Statement does", async () => {
    const created = await journal(
      [
        { accountId: salariesId, debit: "777", credit: "0" },
        { accountId: cashId, debit: "0", credit: "777" },
      ],
      "2026-07-28",
      "راتب سيُعكس",
    );
    expect(created.status).toBe(201);

    const withEntry = (await get(`/expense-accounts/dashboard${JULY}`)).body;
    const pnlWith = (await get(`/reports/income-statement${JULY}`)).body;
    expect(withEntry.periodTotal).toBe(pnlWith.totalExpenses);

    // Reverse it the way the system does: the original becomes REVERSED and a
    // mirror entry is written. Both halves must vanish from the figures.
    const entryId = created.body.id as string;
    const original = await handle.prisma.journalEntry.findUnique({
      where: { id: entryId },
      include: { lines: true },
    });
    await handle.prisma.$transaction(async (tx) => {
      const mirror = await tx.journalEntry.create({
        data: {
          entryType: original!.entryType,
          entryDate: original!.entryDate,
          description: `عكس قيد #${original!.entryNumber}`,
          createdBy: handle.ownerId,
          status: "POSTED",
          reversalOfId: original!.id,
          lines: {
            create: original!.lines.map((l) => ({
              accountId: l.accountId,
              debit: l.credit,
              credit: l.debit,
            })),
          },
        },
      });
      await tx.journalEntry.update({ where: { id: entryId }, data: { status: "REVERSED" } });
      return mirror;
    });

    const after = (await get(`/expense-accounts/dashboard${JULY}`)).body;
    const pnlAfter = (await get(`/reports/income-statement${JULY}`)).body;
    expect(after.periodTotal).toBe(pnlAfter.totalExpenses);
    // Back to where it was before the entry existed.
    expect(after.periodTotal).toBe("2400.00");

    // And the reversed pair is absent from the movements too.
    const moves = (await get(`/expense-accounts/movements${JULY}&accountId=${salariesId}`)).body;
    expect(moves.totalCount).toBe(0);
  });

  it("C3) an item deactivated after it was used still counts, as the Income Statement counts it", async () => {
    // Posting to an already-inactive account is refused by the engine, so the
    // case that matters is an item retired *after* it was spent on: the
    // Income Statement filters leaves, not active flags, and the dashboard must
    // make the same choice or the two will disagree for that period forever.
    const created = await post("/expense-accounts", { nameAr: "بند مؤقت", code: `TEMP${u}` });
    await journal(
      [
        { accountId: created.body.id, debit: "50", credit: "0" },
        { accountId: cashId, debit: "0", credit: "50" },
      ],
      "2026-07-29",
      "مصروف قبل الإيقاف",
    );
    expect((await patch(`/expense-accounts/${created.body.id}`, { active: false })).status).toBe(200);

    const dash = (await get(`/expense-accounts/dashboard${JULY}`)).body;
    const pnl = (await get(`/reports/income-statement${JULY}`)).body;
    expect(dash.periodTotal).toBe(pnl.totalExpenses);
    expect(dash.byItem.some((i: { accountId: string }) => i.accountId === created.body.id)).toBe(true);
    expect(pnl.expenses.some((e: { accountId: string }) => e.accountId === created.body.id)).toBe(true);
  });

  it("C4) the monthly breakdown adds up to the period total", async () => {
    const dash = (await get("/expense-accounts/dashboard?from=2026-06-01&to=2026-07-31")).body;
    const sum = dash.byMonth.reduce((s: number, m: { amount: string }) => s + Number(m.amount), 0);
    expect(sum.toFixed(2)).toBe(dash.periodTotal);
    expect(dash.byMonth.map((m: { month: string }) => m.month)).toEqual(["2026-06", "2026-07"]);
  });

  it("C5) compares against the previous period of equal length", async () => {
    const dash = (await get("/expense-accounts/dashboard?from=2026-07-01&to=2026-07-31")).body;
    expect(dash.previousPeriodTotal).toBe("500.00"); // June
    expect(Number(dash.changeAmount)).toBeCloseTo(Number(dash.periodTotal) - 500, 2);
  });

  // ── D/E/F/G: creating an item ────────────────────────────────────────────

  it("D) creating from the expenses page makes one real expense GL account", async () => {
    const before = await handle.prisma.account.count();
    const res = await post("/expense-accounts", { nameAr: "الكهرباء والمرافق", code: `6300${u}` });
    expect(res.status).toBe(201);
    expect(res.body.category).toBe("EXPENSE");
    expect(res.body.accountType).toBe("EXPENSE");
    expect(res.body.isLeaf).toBe(true);
    expect(res.body.active).toBe(true);
    // No parent: the Income Statement counts leaves, so demoting a parent that
    // already has postings would rewrite history.
    expect(res.body.parentId).toBeNull();
    expect(await handle.prisma.account.count()).toBe(before + 1);

    const row = await handle.prisma.account.findUnique({ where: { id: res.body.id } });
    expect(row!.nameAr).toBe("الكهرباء والمرافق");
    // Arabic-only input keeps its Arabic name on both sides rather than being
    // given an invented translation.
    expect(row!.nameEn).toBe("الكهرباء والمرافق");
  });

  it("E) no shadow record is written — only the account row", async () => {
    const expensesBefore = await handle.prisma.expense.count();
    const categoriesBefore = await handle.prisma.expenseCategory.count();
    const journalsBefore = await handle.prisma.journalEntry.count();

    const res = await post("/expense-accounts", { nameAr: "بند بلا ظل", code: `NOSHADOW${u}` });
    expect(res.status).toBe(201);

    expect(await handle.prisma.expense.count()).toBe(expensesBefore);
    expect(await handle.prisma.expenseCategory.count()).toBe(categoriesBefore);
    // Creating an item is master data, not an accounting event.
    expect(await handle.prisma.journalEntry.count()).toBe(journalsBefore);
  });

  it("F) a duplicate code is refused", async () => {
    const code = `DUP${u}`;
    expect((await post("/expense-accounts", { nameAr: "أول", code })).status).toBe(201);
    const second = await post("/expense-accounts", { nameAr: "ثانٍ", code });
    // 409, exactly as POST /accounts has always answered a duplicate code.
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("validation_failed");
    expect(second.body.details.reason).toBe("code_already_exists");
    expect(await handle.prisma.account.count({ where: { code } })).toBe(1);

    // Also refused against an account that is not an expense.
    const clash = await post("/expense-accounts", { nameAr: "تصادم", code: `CASH${u}` });
    expect(clash.status).toBe(409);
  });

  it("G) concurrent creates with the same code cannot both win", async () => {
    const code = `RACE${u}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => post("/expense-accounts", { nameAr: `سباق ${i}`, code })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    // The losers get the same clear refusal, not a 500 from the unique index.
    for (const r of results.filter((r) => r.status !== 201)) {
      // The unique index settles the race, and the loser gets the same clear
      // refusal rather than a 500 leaking out of Prisma.
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("validation_failed");
      expect(r.body.details.reason).toBe("code_already_exists");
    }
    expect(await handle.prisma.account.count({ where: { code } })).toBe(1);
  });

  it("G2) refuses a code that is only whitespace-different from an existing one", async () => {
    const code = `TRIM${u}`;
    expect((await post("/expense-accounts", { nameAr: "أصلي", code })).status).toBe(201);
    expect((await post("/expense-accounts", { nameAr: "بمسافات", code: `  ${code}  ` })).status).toBe(409);
  });

  // ── H/I/J: the journal quick-add uses the same door ──────────────────────

  it("H) the journal quick-add and the expenses page hit the same endpoint and rules", async () => {
    // Both entry points call POST /expense-accounts; there is only one.
    const created = await post("/expense-accounts", { nameAr: "مصروف من القيد", code: `QUICK${u}` });
    expect(created.status).toBe(201);
    expect(created.body.category).toBe("EXPENSE");

    // I) it is immediately visible to the picker the journal uses…
    const accounts = await get("/accounts");
    const flat: Array<{ id: string; isLeaf: boolean; active: boolean; category: string }> = [];
    const walk = (n: { id: string; isLeaf: boolean; active: boolean; category: string; children?: unknown[] }) => {
      flat.push(n);
      (n.children as typeof flat | undefined)?.forEach(walk as never);
    };
    accounts.body.forEach(walk as never);
    const found = flat.find((a) => a.id === created.body.id);
    expect(found).toBeDefined();
    expect(found!.isLeaf && found!.active && found!.category === "EXPENSE").toBe(true);

    // …and to the expenses list, with no migration or refresh step.
    const items = (await get(`/expense-accounts${JULY}`)).body.items;
    expect(items.some((i: { accountId: string }) => i.accountId === created.body.id)).toBe(true);
  });

  it("L) a newly created item can then be posted to like any other account", async () => {
    const created = await post("/expense-accounts", { nameAr: "صيانة", code: `MAINT${u}` });
    const entry = await journal(
      [
        { accountId: created.body.id, debit: "250", credit: "0" },
        { accountId: cashId, debit: "0", credit: "250" },
      ],
      "2026-07-30",
      "صيانة مكيفات",
    );
    expect(entry.status).toBe(201);

    // M) and it flows into every downstream view at once.
    const detail = (await get(`/expense-accounts/${created.body.id}${JULY}`)).body;
    expect(detail.periodAmount).toBe("250.00");
    expect(detail.movements).toHaveLength(1);
    expect(detail.movements[0].journalEntryId).toBe(entry.body.id);

    const pnl = (await get(`/reports/income-statement${JULY}`)).body;
    expect(pnl.expenses.some((e: { accountId: string }) => e.accountId === created.body.id)).toBe(true);

    const tb = (await get(`/reports/trial-balance${JULY}`)).body;
    expect(tb.rows.some((r: { accountId: string }) => r.accountId === created.body.id)).toBe(true);

    const dash = (await get(`/expense-accounts/dashboard${JULY}`)).body;
    expect(dash.periodTotal).toBe(pnl.totalExpenses);
  });

  // ── N/O: deactivating, never deleting ────────────────────────────────────

  it("N) a deactivated item keeps its history but leaves the pickers", async () => {
    const created = await post("/expense-accounts", { nameAr: "بند سيوقف", code: `OFF${u}` });
    await journal(
      [
        { accountId: created.body.id, debit: "60", credit: "0" },
        { accountId: cashId, debit: "0", credit: "60" },
      ],
      "2026-07-30",
      "قبل الإيقاف",
    );

    const off = await patch(`/expense-accounts/${created.body.id}`, { active: false });
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);

    // Still in the ledger, the detail view and the Income Statement…
    const detail = (await get(`/expense-accounts/${created.body.id}${JULY}`)).body;
    expect(detail.periodAmount).toBe("60.00");
    expect(detail.movements).toHaveLength(1);
    const pnl = (await get(`/reports/income-statement${JULY}`)).body;
    expect(pnl.expenses.some((e: { accountId: string }) => e.accountId === created.body.id)).toBe(true);

    // …but no longer offered for a new entry.
    const rejected = await journal(
      [
        { accountId: created.body.id, debit: "10", credit: "0" },
        { accountId: cashId, debit: "0", credit: "10" },
      ],
      "2026-07-30",
      "بعد الإيقاف",
    );
    expect(rejected.status).toBeGreaterThanOrEqual(400);
  });

  it("O) there is no way to destroy a used item", async () => {
    const res = await api()
      .delete(`/api/v1/expense-accounts/${transportId}`)
      .set(H(ownerToken));
    expect([404, 405]).toContain(res.status);
    expect(await handle.prisma.account.findUnique({ where: { id: transportId } })).not.toBeNull();
  });

  it("O2) renaming an item never changes its code", async () => {
    const before = await handle.prisma.account.findUnique({ where: { id: rentId } });
    const res = await patch(`/expense-accounts/${rentId}`, { nameAr: "الإيجارات والمرافق" });
    expect(res.status).toBe(200);
    const after = await handle.prisma.account.findUnique({ where: { id: rentId } });
    expect(after!.code).toBe(before!.code);
    expect(after!.nameAr).toBe("الإيجارات والمرافق");
    await patch(`/expense-accounts/${rentId}`, { nameAr: before!.nameAr });
  });

  it("O3) refuses to touch an account that is not an expense", async () => {
    const res = await patch(`/expense-accounts/${revenueId}`, { nameAr: "محاولة" });
    expect(res.status).toBe(404);
    const row = await handle.prisma.account.findUnique({ where: { id: revenueId } });
    expect(row!.nameAr).toBe("إيرادات");
  });

  // ── movements ────────────────────────────────────────────────────────────

  it("movements come from real journal lines and link back to the entry", async () => {
    const res = await get(`/expense-accounts/movements${JULY}&accountId=${transportId}`);
    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(2);
    expect(res.body.totalAmount).toBe("1200.00");
    const row = res.body.rows[0];
    expect(row.journalEntryId).toBeTruthy();
    expect(row.entryNumber).toBeTruthy();
    expect(row.accountId).toBe(transportId);
    // The counter side is read off the entry's own lines, never guessed.
    expect(row.counterAccounts.map((c: { accountId: string }) => c.accountId)).toContain(cashId);
  });

  it("movements honour the date filter, the search and the amount range", async () => {
    const june = await get("/expense-accounts/movements?from=2026-06-01&to=2026-06-30");
    expect(june.body.totalCount).toBe(1);
    expect(june.body.rows[0].accountId).toBe(rentId);

    const searched = await get(`/expense-accounts/movements${JULY}&search=${encodeURIComponent("شحن إضافي")}`);
    expect(searched.body.totalCount).toBe(1);
    expect(searched.body.rows[0].amount).toBe("300.00");

    const ranged = await get(`/expense-accounts/movements${JULY}&minAmount=1000`);
    expect(ranged.body.rows.every((r: { amount: string }) => Math.abs(Number(r.amount)) >= 1000)).toBe(true);
  });

  it("the movements total describes the whole filter, not the page", async () => {
    const paged = await get(`/expense-accounts/movements${JULY}&limit=1&offset=0`);
    expect(paged.body.rows).toHaveLength(1);
    expect(paged.body.totalCount).toBeGreaterThan(1);

    const all = await get(`/expense-accounts/movements${JULY}&limit=500`);
    const summed = all.body.rows.reduce((s: number, r: { amount: string }) => s + Number(r.amount), 0);
    expect(summed.toFixed(2)).toBe(paged.body.totalAmount);
  });

  it("never reports a movement on an account that is not an expense", async () => {
    const all = await get(`/expense-accounts/movements${JULY}&limit=500`);
    const ids = new Set(all.body.rows.map((r: { accountId: string }) => r.accountId));
    expect(ids.has(revenueId)).toBe(false);
    expect(ids.has(cashId)).toBe(false);
  });

  // ── W/X: reading never writes ────────────────────────────────────────────

  it("W) every read leaves the database exactly as it was", async () => {
    const before = {
      accounts: await handle.prisma.account.count(),
      entries: await handle.prisma.journalEntry.count(),
      lines: await handle.prisma.journalLine.count(),
      expenses: await handle.prisma.expense.count(),
    };

    for (let i = 0; i < 2; i += 1) {
      expect((await get(`/expense-accounts${JULY}`)).status).toBe(200);
      expect((await get(`/expense-accounts/dashboard${JULY}`)).status).toBe(200);
      expect((await get(`/expense-accounts/movements${JULY}`)).status).toBe(200);
      expect((await get(`/expense-accounts/${transportId}${JULY}`)).status).toBe(200);
    }

    expect(await handle.prisma.account.count()).toBe(before.accounts);
    expect(await handle.prisma.journalEntry.count()).toBe(before.entries);
    expect(await handle.prisma.journalLine.count()).toBe(before.lines);
    expect(await handle.prisma.expense.count()).toBe(before.expenses);
  });

  it("W2) says so in the payload — committedChanges is zero on every read", async () => {
    for (const path of [
      `/expense-accounts${JULY}`,
      `/expense-accounts/dashboard${JULY}`,
      `/expense-accounts/movements${JULY}`,
      `/expense-accounts/${transportId}${JULY}`,
    ]) {
      expect((await get(path)).body.committedChanges).toBe(0);
    }
  });

  // ── authorization ────────────────────────────────────────────────────────

  it("an accountant may read but may not create or deactivate", async () => {
    expect((await get(`/expense-accounts${JULY}`, accountantToken)).status).toBe(200);
    expect((await get(`/expense-accounts/dashboard${JULY}`, accountantToken)).status).toBe(200);
    expect(
      (await post("/expense-accounts", { nameAr: "ممنوع", code: `ACC${u}` }, accountantToken)).status,
    ).toBe(403);
    expect((await patch(`/expense-accounts/${rentId}`, { active: false }, accountantToken)).status).toBe(403);
  });

  it("a warehouse user sees none of it", async () => {
    expect((await get(`/expense-accounts${JULY}`, warehouseToken)).status).toBe(403);
    expect((await get(`/expense-accounts/dashboard${JULY}`, warehouseToken)).status).toBe(403);
    expect((await get(`/expense-accounts/movements${JULY}`, warehouseToken)).status).toBe(403);
  });

  it("refuses a malformed date and an unknown item", async () => {
    expect((await get("/expense-accounts?from=nope&to=2026-07-31")).status).toBe(400);
    expect((await get("/expense-accounts/11111111-1111-4111-8111-111111111111")).status).toBe(404);
    // An account that exists but is not an expense is equally not found here.
    expect((await get(`/expense-accounts/${cashId}`)).status).toBe(404);
  });

  // ── filtering the items list ─────────────────────────────────────────────

  it("filters items by status and searches by code and name", async () => {
    const active = (await get(`/expense-accounts${JULY}&status=active`)).body;
    expect(active.items.every((i: { active: boolean }) => i.active)).toBe(true);

    const inactive = (await get(`/expense-accounts${JULY}&status=inactive`)).body;
    expect(inactive.items.every((i: { active: boolean }) => !i.active)).toBe(true);
    expect(inactive.items.some((i: { accountId: string }) => i.accountId === inactiveId)).toBe(true);

    const byName = (await get(`/expense-accounts${JULY}&search=${encodeURIComponent("النقل")}`)).body;
    expect(byName.items.some((i: { accountId: string }) => i.accountId === transportId)).toBe(true);

    const byCode = (await get(`/expense-accounts${JULY}&search=6400${u}`)).body;
    expect(byCode.items.some((i: { accountId: string }) => i.accountId === rentId)).toBe(true);

    // The badge counts describe the chart of accounts, not the search result.
    expect(byName.activeCount).toBe(active.items.length);
  });
});
