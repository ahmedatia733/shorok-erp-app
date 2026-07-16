/**
 * Unified Account Statement — GET /statements/options and /statements/consolidated.
 *
 * Covers Section O: consolidated totals equal the sum of their members, category
 * membership comes from Chart-of-Accounts config, normal-side math per account
 * type, date-window/opening behaviour, party aggregation, reversals, and that
 * nothing is read from legacy balance tables.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("consolidated account statement", () => {
  let handle: TestApp;
  let ownerToken: string, bmToken: string;
  let bankA: string, bankB: string, cashA: string, cashB: string;
  let expOps: string, expTransport: string, revenue: string, arCtl: string, apCtl: string;
  let inactiveBank: string, parentBank: string;

  const server = () => handle.app.getHttpServer();
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  const stmt = (q: string, token = ownerToken) =>
    request(server()).get(`/api/v1/statements/consolidated?${q}`).set(H(token));

  let seq = 0;
  const uniq = () => `${Date.now().toString().slice(-5)}${++seq}`;

  const mkAccount = async (o: {
    nameAr: string; category: string; accountType: string;
    systemRole?: string; treasuryType?: string; isCashOrBank?: boolean;
    isLeaf?: boolean; active?: boolean; code?: string;
  }) =>
    (await handle.prisma.account.create({
      data: {
        code: o.code ?? `T${uniq()}`,
        nameAr: o.nameAr,
        nameEn: o.nameAr,
        category: o.category as never,
        accountType: o.accountType as never,
        isLeaf: o.isLeaf ?? true,
        active: o.active ?? true,
        ...(o.systemRole ? { systemRole: o.systemRole as never } : {}),
        ...(o.treasuryType ? { treasuryType: o.treasuryType as never, isCashOrBank: true } : {}),
        ...(o.isCashOrBank !== undefined ? { isCashOrBank: o.isCashOrBank } : {}),
      },
    })).id;

  /** Posts a balanced 2-line journal straight through the engine's HTTP path. */
  const postJournal = async (o: {
    debitAccountId: string; creditAccountId: string; amount: string; date?: string;
    debitParty?: { partyType: string; partyId: string };
    creditParty?: { partyType: string; partyId: string };
  }) => {
    const res = await request(server()).post("/api/v1/journal").set(H(ownerToken)).send({
      entryDate: o.date ?? "2026-07-15",
      entryType: "JOURNAL",
      description: "قيد اختبار",
      acknowledgeNegativeBalance: true,
      lines: [
        { accountId: o.debitAccountId, debit: o.amount, credit: "0", ...(o.debitParty ?? {}) },
        { accountId: o.creditAccountId, debit: "0", credit: o.amount, ...(o.creditParty ?? {}) },
      ],
    });
    expect(res.status).toBeLessThan(300);
    return res.body.id as string;
  };

  const find = (breakdown: any[], id: string) => breakdown.find((b: any) => b.entityId === id);

  beforeAll(async () => {
    handle = await buildTestApp();
    const pw = "Pwd@2026!";
    const passwordHash = await bcrypt.hash(pw, 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    await handle.prisma.user.create({
      data: { name: "BM", phone: "+201400000009", passwordHash, role: "BRANCH_MANAGER" as never, status: "ACTIVE",
        branchAccesses: { create: { branchId: handle.branchId } } },
    });
    const login = async (phone: string) =>
      (await request(server()).post("/api/v1/auth/login").send({ phone, password: pw })).body.accessToken;
    ownerToken = await login(handle.ownerPhone);
    bmToken = await login("+201400000009");

    bankA = await mkAccount({ nameAr: "بنك اختبار أ", category: "ASSET", accountType: "CURRENT_ASSET", treasuryType: "BANK" });
    bankB = await mkAccount({ nameAr: "بنك اختبار ب", category: "ASSET", accountType: "CURRENT_ASSET", treasuryType: "BANK" });
    cashA = await mkAccount({ nameAr: "خزنة اختبار أ", category: "ASSET", accountType: "CURRENT_ASSET", treasuryType: "CASH" });
    cashB = await mkAccount({ nameAr: "خزنة اختبار ب", category: "ASSET", accountType: "CURRENT_ASSET", treasuryType: "CASH" });
    inactiveBank = await mkAccount({ nameAr: "بنك موقوف", category: "ASSET", accountType: "CURRENT_ASSET", treasuryType: "BANK", active: false });
    parentBank = await mkAccount({ nameAr: "بنك أب", category: "ASSET", accountType: "CURRENT_ASSET", treasuryType: "BANK", isLeaf: false });
    expOps = await mkAccount({ nameAr: "مصاريف التشغيل", category: "EXPENSE", accountType: "EXPENSE" });
    expTransport = await mkAccount({ nameAr: "مصاريف النقل", category: "EXPENSE", accountType: "EXPENSE" });
    revenue = await mkAccount({ nameAr: "إيرادات اختبار", category: "REVENUE", accountType: "REVENUE" });
    arCtl = await mkAccount({ nameAr: "عملاء اختبار", category: "ASSET", accountType: "CURRENT_ASSET", systemRole: "AR_CONTROL" });
    apCtl = await mkAccount({ nameAr: "موردون اختبار", category: "LIABILITY", accountType: "LIABILITY", systemRole: "AP_CONTROL" });

    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 6, status: "OPEN" } });
  });

  afterAll(async () => teardownTestApp(handle));

  // ── options ──────────────────────────────────────────────────────────────

  it("1) options returns the shared categories plus config for active leaf accounts", async () => {
    const res = await request(server()).get("/api/v1/statements/options").set(H(ownerToken));
    expect(res.status).toBe(200);
    const ids = res.body.categories.map((c: any) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["banks", "vaults", "customers", "suppliers", "expense", "revenue", "all"]));
    expect(res.body.categories.find((c: any) => c.id === "banks").label).toBe("البنوك");
    expect(res.body.categories.find((c: any) => c.id === "customers").kind).toBe("CUSTOMERS");

    const a = res.body.accounts.find((x: any) => x.id === bankA);
    expect(a.treasuryType).toBe("BANK");
    // Config the selector needs to categorize is present.
    expect(a).toHaveProperty("systemRole");
    expect(a).toHaveProperty("isCashOrBank");
    // Parents and inactive accounts are never offered as postable options.
    expect(res.body.accounts.map((x: any) => x.id)).not.toContain(parentBank);
    expect(res.body.accounts.map((x: any) => x.id)).not.toContain(inactiveBank);
  });

  // ── banks: consolidated vs specific ──────────────────────────────────────

  it("2+3) all banks total equals the sum of every bank, and each bank appears separately", async () => {
    await postJournal({ debitAccountId: bankA, creditAccountId: revenue, amount: "1000" });
    await postJournal({ debitAccountId: bankB, creditAccountId: revenue, amount: "250" });

    const res = await stmt("category=banks");
    expect(res.status).toBe(200);
    expect(res.body.selectionType).toBe("consolidated");

    const a = find(res.body.breakdown, bankA);
    const b = find(res.body.breakdown, bankB);
    expect(a.endingBalance).toBe("1000.00");
    expect(b.endingBalance).toBe("250.00");

    // Consolidated ending is exactly the sum of the members — no double counting.
    const sum = res.body.breakdown.reduce((t: Decimal, r: any) => t.add(r.endingBalance), new Decimal(0));
    expect(sum.toFixed(2)).toBe(res.body.endingBalance);
    expect(res.body.endingBalance).toBe("1250.00");
  });

  it("4) selecting one bank excludes the other banks", async () => {
    const res = await stmt(`category=banks&entityId=${bankA}`);
    expect(res.status).toBe(200);
    expect(res.body.selectionType).toBe("specific");
    expect(res.body.endingBalance).toBe("1000.00");
    expect(res.body.rows.every((r: any) => r.accountId === bankA)).toBe(true);
    expect(res.body.breakdown.map((b: any) => b.entityId)).toEqual([bankA]);
  });

  it("5) treasuries total equals the sum of CASH accounts only (banks excluded)", async () => {
    await postJournal({ debitAccountId: cashA, creditAccountId: revenue, amount: "700" });
    await postJournal({ debitAccountId: cashB, creditAccountId: revenue, amount: "300" });

    const res = await stmt("category=vaults");
    expect(res.status).toBe(200);
    const ids = res.body.breakdown.map((b: any) => b.entityId);
    expect(ids).toEqual(expect.arrayContaining([cashA, cashB]));
    expect(ids).not.toContain(bankA);
    expect(new Decimal(res.body.endingBalance).gte(1000)).toBe(true);
  });

  it("6) inactive accounts and parent accounts are excluded from a category", async () => {
    const res = await stmt("category=banks&includeZero=true");
    const ids = res.body.breakdown.map((b: any) => b.entityId);
    expect(ids).not.toContain(inactiveBank);
    expect(ids).not.toContain(parentBank);
  });

  it("7) a parent account cannot be selected as a posting account", async () => {
    const res = await stmt(`category=banks&entityId=${parentBank}`);
    expect(res.status).toBe(404);
    expect(res.body.details?.reason ?? res.body.code).toBeTruthy();
  });

  it("8) an account outside the category cannot be selected through it", async () => {
    const res = await stmt(`category=banks&entityId=${expOps}`);
    expect(res.status).toBe(404);
  });

  // ── expenses (arbitrary GL accounts) ─────────────────────────────────────

  it("9) expense category includes every active leaf expense account and totals debit-normal", async () => {
    await postJournal({ debitAccountId: expOps, creditAccountId: cashA, amount: "1000" });
    await postJournal({ debitAccountId: expTransport, creditAccountId: bankA, amount: "500" });

    const res = await stmt("category=expense");
    const ids = res.body.breakdown.map((b: any) => b.entityId);
    expect(ids).toEqual(expect.arrayContaining([expOps, expTransport]));
    expect(find(res.body.breakdown, expOps).endingBalance).toBe("1000.00");
    expect(find(res.body.breakdown, expTransport).endingBalance).toBe("500.00");

    const one = await stmt(`category=expense&entityId=${expOps}`);
    expect(one.body.endingBalance).toBe("1000.00");
    expect(one.body.rows.every((r: any) => r.accountId === expOps)).toBe(true);
  });

  it("10) the treasury/bank funding side of an expense moves the consolidated totals", async () => {
    // The two postings above credited cashA 1000 and bankA 500.
    const vaults = await stmt("category=vaults");
    expect(find(vaults.body.breakdown, cashA).credit).toBe("1000.00");
    expect(find(vaults.body.breakdown, cashA).endingBalance).toBe("-300.00"); // 700 in − 1000 out

    const banks = await stmt("category=banks");
    expect(find(banks.body.breakdown, bankA).credit).toBe("500.00");
    expect(find(banks.body.breakdown, bankA).endingBalance).toBe("500.00"); // 1000 in − 500 out
    expect(find(banks.body.breakdown, bankB).endingBalance).toBe("250.00"); // untouched
  });

  // ── normal side ──────────────────────────────────────────────────────────

  it("11) credit-normal categories total on their own side (revenue)", async () => {
    const res = await stmt(`category=revenue&entityId=${revenue}`);
    // Revenue was credited 1000+250+700+300 = 2250 → positive on the credit side.
    expect(res.body.endingBalance).toBe("2250.00");
    expect(res.body.periodCredit).toBe("2250.00");
  });

  it("12) a mixed category totals each account on its own normal side", async () => {
    const res = await stmt("category=all");
    expect(res.status).toBe(200);
    const sum = res.body.breakdown.reduce((t: Decimal, r: any) => t.add(r.endingBalance), new Decimal(0));
    expect(sum.toFixed(2)).toBe(res.body.endingBalance);
    // Debits and credits across all accounts balance, as double entry requires.
    expect(res.body.periodDebit).toBe(res.body.periodCredit);
  });

  // ── date window ──────────────────────────────────────────────────────────

  it("13+14) pre-range lines become opening, and the To date is inclusive", async () => {
    const acc = await mkAccount({ nameAr: "بنك تواريخ", category: "ASSET", accountType: "CURRENT_ASSET", treasuryType: "BANK" });
    await postJournal({ debitAccountId: acc, creditAccountId: revenue, amount: "100", date: "2026-06-10" });
    await postJournal({ debitAccountId: acc, creditAccountId: revenue, amount: "40", date: "2026-07-15" });

    const res = await stmt(`category=banks&entityId=${acc}&from=2026-07-01&to=2026-07-15`);
    expect(res.body.openingBalance).toBe("100.00"); // June activity folded into opening
    expect(res.body.periodDebit).toBe("40.00");
    expect(res.body.endingBalance).toBe("140.00");
    expect(res.body.rows).toHaveLength(1); // the To date includes 2026-07-15

    // Excluding the To date drops that row.
    const before = await stmt(`category=banks&entityId=${acc}&from=2026-07-01&to=2026-07-14`);
    expect(before.body.rows).toHaveLength(0);
    expect(before.body.endingBalance).toBe("100.00");
  });

  it("15) consolidated opening sums the opening of every member account", async () => {
    const res = await stmt("category=banks&from=2026-07-01");
    const sum = res.body.breakdown.reduce((t: Decimal, r: any) => t.add(r.openingBalance), new Decimal(0));
    expect(sum.toFixed(2)).toBe(res.body.openingBalance);
  });

  // ── zero / movement visibility ───────────────────────────────────────────

  it("16) an account with movement but a zero ending stays visible; a never-touched one is hidden unless includeZero", async () => {
    const netZero = await mkAccount({ nameAr: "بنك متعادل", category: "ASSET", accountType: "CURRENT_ASSET", treasuryType: "BANK" });
    await postJournal({ debitAccountId: netZero, creditAccountId: revenue, amount: "80" });
    await postJournal({ debitAccountId: expOps, creditAccountId: netZero, amount: "80" });

    const untouched = await mkAccount({ nameAr: "بنك بلا حركة", category: "ASSET", accountType: "CURRENT_ASSET", treasuryType: "BANK" });

    const res = await stmt("category=banks");
    const z = find(res.body.breakdown, netZero);
    expect(z).toBeTruthy();
    expect(z.endingBalance).toBe("0.00");
    expect(z.debit).toBe("80.00"); // movement is still reported
    expect(find(res.body.breakdown, untouched)).toBeUndefined();

    const withZero = await stmt("category=banks&includeZero=true");
    expect(find(withZero.body.breakdown, untouched)).toBeTruthy();
  });

  // ── parties ──────────────────────────────────────────────────────────────

  it("17+18) customer aggregate equals the sum of exact CUSTOMER party lines", async () => {
    const c1 = (await handle.prisma.customer.create({ data: { code: `CS-${uniq()}`, nameAr: "عميل أ" } })).id;
    const c2 = (await handle.prisma.customer.create({ data: { code: `CS-${uniq()}`, nameAr: "عميل ب" } })).id;
    await postJournal({ debitAccountId: arCtl, creditAccountId: revenue, amount: "600", debitParty: { partyType: "CUSTOMER", partyId: c1 } });
    await postJournal({ debitAccountId: arCtl, creditAccountId: revenue, amount: "400", debitParty: { partyType: "CUSTOMER", partyId: c2 } });

    const all = await stmt("category=customers");
    expect(find(all.body.breakdown, c1).endingBalance).toBe("600.00");
    expect(find(all.body.breakdown, c2).endingBalance).toBe("400.00");
    const sum = all.body.breakdown.reduce((t: Decimal, r: any) => t.add(r.endingBalance), new Decimal(0));
    expect(sum.toFixed(2)).toBe(all.body.endingBalance);

    const one = await stmt(`category=customers&entityId=${c1}`);
    expect(one.body.endingBalance).toBe("600.00");
    expect(one.body.rows.every((r: any) => r.partyId === c1)).toBe(true);
  });

  it("19) supplier aggregate is credit-normal and matches exact SUPPLIER party lines", async () => {
    const s1 = (await handle.prisma.supplier.create({ data: { nameAr: `مورد أ ${uniq()}`, nameEn: `SupA ${uniq()}` } })).id;
    await postJournal({ debitAccountId: expOps, creditAccountId: apCtl, amount: "900", creditParty: { partyType: "SUPPLIER", partyId: s1 } });

    const all = await stmt("category=suppliers");
    expect(find(all.body.breakdown, s1).endingBalance).toBe("900.00"); // payable rises on credit
    const one = await stmt(`category=suppliers&entityId=${s1}`);
    expect(one.body.endingBalance).toBe("900.00");
    expect(one.body.rows.every((r: any) => r.partyId === s1)).toBe(true);
  });

  it("20) partyless control lines are never folded into a party statement", async () => {
    // A control line without a party is a data defect — it must not leak into
    // any party's statement nor the consolidated party total.
    const before = await stmt("category=customers");
    const beforeTotal = before.body.endingBalance;

    const entry = await handle.prisma.journalEntry.create({
      data: {
        entryDate: new Date("2026-07-15"), entryType: "JOURNAL", status: "POSTED",
        sourceType: "MANUAL", description: "partyless", createdBy: handle.ownerId,
        idempotencyKey: `PARTYLESS-${uniq()}`,
        lines: { create: [
          { accountId: arCtl, debit: "123", credit: "0" }, // no partyType/partyId
          { accountId: revenue, debit: "0", credit: "123" },
        ] },
      },
    });
    expect(entry.id).toBeTruthy();

    const after = await stmt("category=customers");
    expect(after.body.endingBalance).toBe(beforeTotal);
    expect(after.body.rows.every((r: any) => r.partyId != null)).toBe(true);
  });

  // ── reversal ─────────────────────────────────────────────────────────────

  it("21) reversal keeps both rows visible and nets the balance back", async () => {
    const acc = await mkAccount({ nameAr: "بنك عكس", category: "ASSET", accountType: "CURRENT_ASSET", treasuryType: "BANK" });
    const entryId = await postJournal({ debitAccountId: acc, creditAccountId: revenue, amount: "500" });
    const rev = await request(server()).post(`/api/v1/journal/${entryId}/reverse`).set(H(ownerToken))
      .send({ reason: "اختبار عكس", acknowledgeNegativeBalance: true });
    expect(rev.status).toBeLessThan(300);

    const res = await stmt(`category=banks&entityId=${acc}`);
    expect(res.body.rows.length).toBe(2); // original + reversal both remain
    expect(res.body.rows.some((r: any) => r.isReversal)).toBe(true);
    expect(res.body.endingBalance).toBe("0.00");

    const all = await stmt("category=banks");
    expect(find(all.body.breakdown, acc).endingBalance).toBe("0.00");
  });

  // ── row shape / drilldown / integrity ────────────────────────────────────

  it("22) rows carry the drilldown + account identity the UI needs", async () => {
    const res = await stmt("category=banks");
    const row = res.body.rows[0];
    for (const k of [
      "journalEntryId", "journalLineId", "entryDate", "entryNumber", "reference", "description",
      "debit", "credit", "runningBalance", "accountId", "accountCode", "accountName",
      "sourceType", "sourceId", "partyType", "partyId", "branchId", "isReversal",
    ]) {
      expect(row).toHaveProperty(k);
    }
    expect(row.accountCode).toBeTruthy();
  });

  it("23) consolidated debit/credit totals match the underlying journal_lines", async () => {
    const res = await stmt("category=banks");
    const ids = res.body.breakdown.map((b: any) => b.entityId);
    const agg = await handle.prisma.journalLine.aggregate({
      where: { accountId: { in: ids } },
      _sum: { debit: true, credit: true },
    });
    expect(new Decimal(agg._sum.debit!.toString()).toFixed(2)).toBe(res.body.periodDebit);
    expect(new Decimal(agg._sum.credit!.toString()).toFixed(2)).toBe(res.body.periodCredit);
  });

  // ── permissions / edge cases ─────────────────────────────────────────────

  it("24) requires authentication and an accounting role", async () => {
    expect((await request(server()).get("/api/v1/statements/consolidated?category=banks")).status).toBe(401);
    expect((await request(server()).get("/api/v1/statements/options")).status).toBe(401);
    expect((await stmt("category=banks", bmToken)).status).toBe(403);
  });

  // ── negative-treasury guard (Section L) ──────────────────────────────────

  it("26) the negative-treasury warning still guards posting, and an acknowledged entry lands in both the specific and consolidated statements", async () => {
    // A real treasury: the guard keys off isCashOrBank + treasuryType, not names.
    const treasury = await mkAccount({ nameAr: "خزنة تحذير", category: "ASSET", accountType: "CURRENT_ASSET", treasuryType: "CASH" });
    const spend = (acknowledge: boolean) =>
      request(server()).post("/api/v1/journal").set(H(ownerToken)).send({
        entryDate: "2026-07-15", entryType: "JOURNAL", description: "صرف من خزنة فارغة",
        ...(acknowledge ? { acknowledgeNegativeBalance: true, negativeBalanceReason: "اختبار" } : {}),
        lines: [
          { accountId: expOps, debit: "1000", credit: "0" },
          { accountId: treasury, debit: "0", credit: "1000" },
        ],
      });

    // Warning first: typed 409, nothing posted.
    const warned = await spend(false);
    expect(warned.status).toBe(409);
    expect(JSON.stringify(warned.body)).toMatch(/negative/i);
    expect((await stmt(`category=vaults&entityId=${treasury}`)).body.endingBalance).toBe("0.00");

    // Acknowledged: posts, and both views reflect it immediately.
    const posted = await spend(true);
    expect(posted.status).toBeLessThan(300);
    expect((await stmt(`category=vaults&entityId=${treasury}`)).body.endingBalance).toBe("-1000.00");
    expect(find((await stmt("category=vaults")).body.breakdown, treasury).endingBalance).toBe("-1000.00");

    // Reversing restores both; the read endpoint never warns on the way.
    const rev = await request(server()).post(`/api/v1/journal/${posted.body.id}/reverse`).set(H(ownerToken))
      .send({ reason: "إلغاء اختبار", acknowledgeNegativeBalance: true });
    expect(rev.status).toBeLessThan(300);
    const after = await stmt(`category=vaults&entityId=${treasury}`);
    expect(after.status).toBe(200); // read-only path never blocks on a negative balance
    expect(after.body.endingBalance).toBe("0.00");
    expect(find((await stmt("category=vaults")).body.breakdown, treasury).endingBalance).toBe("0.00");
  });

  it("25) an unknown category is rejected; an empty category returns 200 with a valid empty state", async () => {
    expect((await stmt("category=not_a_category")).status).toBe(400);

    const res = await stmt("category=fixed"); // no fixed-asset postings in this suite
    expect(res.status).toBe(200);
    expect(res.body.breakdown).toEqual([]);
    expect(res.body.rows).toEqual([]);
    expect(res.body.openingBalance).toBe("0.00");
    expect(res.body.endingBalance).toBe("0.00");
  });
});
