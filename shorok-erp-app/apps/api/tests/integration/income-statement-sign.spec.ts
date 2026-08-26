/**
 * قائمة الدخل — the sign convention, pinned.
 *
 * The income statement is debit-normal for the deduction sections:
 *
 *   revenue      = credit − debit      (credit-normal)
 *   costOfSales  = debit  − credit
 *   expense      = debit  − credit
 *   grossProfit  = revenue − costOfSales
 *   netProfit    = grossProfit − totalExpenses
 *
 * Two failures would each silently misstate profit, and each is easy to
 * introduce while "fixing" the other:
 *
 *  - applying an expense twice (subtracting an already-negative contribution),
 *    which ADDS the expense to profit;
 *  - treating a credit balance on an expense account as money spent, which
 *    would make a genuine refund INCREASE reported expenses.
 *
 * Both directions are asserted here, on real posted journals.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

const D = (v: unknown) => new Decimal((v as { toString(): string })?.toString() ?? "0");
const RANGE = "from=2026-01-01&to=2026-12-31";

describe("income statement — expense sign", () => {
  let handle: TestApp;
  let token: string, accountantToken: string;
  let cash: string, revenue: string, cogsAcc: string;
  let transport: string, rent: string, salaries: string;

  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });
  const server = () => handle.app.getHttpServer();
  const pnl = (qs = RANGE, t = token) =>
    request(server()).get(`/api/v1/reports/income-statement?${qs}`).set(auth(t));

  /** Post one balanced entry straight to the GL — the report's only input. */
  const post = async (date: string, lines: Array<{ account: string; debit?: string; credit?: string }>, description = "قيد اختبار") => {
    const res = await request(server()).post("/api/v1/journal").set(auth()).send({
      entryDate: date,
      description,
      lines: lines.map((l) => ({ accountId: l.account, debit: l.debit ?? "0", credit: l.credit ?? "0" })),
    });
    if (res.status >= 300) throw new Error(`journal post failed ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };

  beforeAll(async () => {
    handle = await buildTestApp();
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    await handle.prisma.user.create({
      data: { name: "acc", phone: "+201509090901", passwordHash: await bcrypt.hash("Pwd@2026!", 10), role: "ACCOUNTANT", status: "ACTIVE" },
    });
    accountantToken = (await request(server()).post("/api/v1/auth/login").send({ phone: "+201509090901", password: "Pwd@2026!" })).body.accessToken;

    const u = Date.now().toString().slice(-6);
    const mk = (code: string, nameAr: string, category: string, accountType: string, cashLike = false) =>
      handle.prisma.account.create({
        data: {
          code, nameAr, nameEn: nameAr, category: category as never, accountType: accountType as never,
          isLeaf: true, active: true, ...(cashLike ? { isCashOrBank: true } : {}),
        },
      });
    cash = (await mk(`CA${u}`, "الصندوق", "ASSET", "CURRENT_ASSET", true)).id;
    revenue = (await mk(`RV${u}`, "إيرادات المبيعات", "REVENUE", "REVENUE")).id;
    cogsAcc = (await mk(`CG${u}`, "تكلفة البضاعة المباعة", "COST_OF_SALES", "COST_OF_SALES")).id;
    transport = (await mk(`E1${u}`, "النقل والشحن", "EXPENSE", "EXPENSE")).id;
    rent = (await mk(`E2${u}`, "الإيجارات", "EXPENSE", "EXPENSE")).id;
    salaries = (await mk(`E3${u}`, "الرواتب والأجور", "EXPENSE", "EXPENSE")).id;

    for (let m = 1; m <= 12; m++) await handle.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });

    // Revenue 200,000 and cost of sales 120,000 → gross profit 80,000.
    await post("2026-03-01", [{ account: cash, debit: "200000" }, { account: revenue, credit: "200000" }], "مبيعات");
    await post("2026-03-02", [{ account: cogsAcc, debit: "120000" }, { account: cash, credit: "120000" }], "تكلفة المبيعات");
  }, 180_000);

  afterAll(async () => teardownTestApp(handle));

  it("with no expenses at all, net profit equals gross profit", async () => {
    const res = await pnl();
    expect(res.status).toBe(200);
    expect(D(res.body.revenue).toFixed(2)).toBe("200000.00");
    expect(D(res.body.costOfSales).toFixed(2)).toBe("120000.00");
    expect(D(res.body.grossProfit).toFixed(2)).toBe("80000.00");
    expect(D(res.body.totalExpenses).toFixed(2)).toBe("0.00");
    expect(D(res.body.netProfit).toFixed(2)).toBe("80000.00");
  });

  it("a normal expense debit REDUCES net profit, exactly once", async () => {
    const before = (await pnl()).body;
    await post("2026-04-01", [{ account: transport, debit: "900" }, { account: cash, credit: "900" }], "نقل وشحن");
    const after = (await pnl()).body;

    // The expense is a POSITIVE magnitude, and profit falls by exactly it.
    expect(D(after.totalExpenses).toFixed(2)).toBe("900.00");
    expect(D(after.grossProfit).toFixed(2)).toBe(D(before.grossProfit).toFixed(2)); // gross profit untouched
    expect(D(after.netProfit).toFixed(2)).toBe(D(before.netProfit).minus(900).toFixed(2));
    expect(D(after.netProfit).toFixed(2)).toBe("79100.00");

    // Applied ONCE: never 800 (twice) and never 900 higher (added).
    expect(D(after.netProfit).toFixed(2)).not.toBe(D(before.netProfit).minus(1800).toFixed(2));
    expect(D(after.netProfit).toFixed(2)).not.toBe(D(before.netProfit).plus(900).toFixed(2));

    // And the identity the whole report rests on.
    expect(D(after.netProfit).toFixed(2)).toBe(D(after.grossProfit).minus(after.totalExpenses).toFixed(2));
  });

  it("expenses across several accounts all follow the one rule", async () => {
    await post("2026-05-01", [{ account: rent, debit: "5000" }, { account: cash, credit: "5000" }], "إيجار");
    await post("2026-05-02", [{ account: salaries, debit: "10000" }, { account: cash, credit: "10000" }], "رواتب");
    const res = (await pnl()).body;

    expect(D(res.totalExpenses).toFixed(2)).toBe("15900.00"); // 900 + 5000 + 10000
    expect(D(res.grossProfit).toFixed(2)).toBe("80000.00");
    expect(D(res.netProfit).toFixed(2)).toBe("64100.00");

    // Every expense row is a positive magnitude, and they sum to the total.
    const sum = res.expenses.reduce((a: Decimal, e: { amount: string }) => a.plus(e.amount), new Decimal(0));
    expect(sum.toFixed(2)).toBe(D(res.totalExpenses).toFixed(2));
    for (const e of res.expenses) expect(D(e.amount).isPositive()).toBe(true);
    expect(res.expenses).toHaveLength(3);
  });

  it("a credit on an expense account REDUCES expenses — it is a refund, not another cost", async () => {
    const before = (await pnl()).body;
    // Carrier refunds 300 of the transport charge.
    await post("2026-06-01", [{ account: cash, debit: "300" }, { account: transport, credit: "300" }], "استرداد جزء من مصاريف النقل");
    const after = (await pnl()).body;

    expect(D(after.totalExpenses).toFixed(2)).toBe(D(before.totalExpenses).minus(300).toFixed(2));
    expect(D(after.totalExpenses).toFixed(2)).toBe("15600.00");
    // A refund legitimately increases profit — it must NOT be counted as a cost.
    expect(D(after.netProfit).toFixed(2)).toBe(D(before.netProfit).plus(300).toFixed(2));
    const line = after.expenses.find((e: { accountId: string }) => e.accountId === transport);
    expect(D(line.amount).toFixed(2)).toBe("600.00"); // 900 spent − 300 refunded
  });

  it("an expense account whose balance is entirely a credit reports a NEGATIVE expense", async () => {
    // This is the shape that makes net profit exceed gross profit. It is the
    // faithful reading of a credit balance, and the report must not hide it by
    // taking a magnitude — that would turn every refund into a cost.
    const before = (await pnl()).body;
    await post("2026-07-01", [{ account: cash, debit: "2000" }, { account: rent, credit: "7000" }, { account: cash, debit: "5000" }], "تسوية إيجار");
    const after = (await pnl()).body;

    const rentLine = after.expenses.find((e: { accountId: string }) => e.accountId === rent);
    expect(D(rentLine.amount).toFixed(2)).toBe("-2000.00"); // 5000 debited − 7000 credited
    expect(D(after.netProfit).toFixed(2)).toBe(D(before.netProfit).plus(7000).toFixed(2));
    // Still one coherent identity, even with a negative contribution.
    expect(D(after.netProfit).toFixed(2)).toBe(D(after.grossProfit).minus(after.totalExpenses).toFixed(2));
  });

  it("revenue, cost of sales and gross profit are untouched by any expense activity", async () => {
    const res = (await pnl()).body;
    expect(D(res.revenue).toFixed(2)).toBe("200000.00");
    expect(D(res.costOfSales).toFixed(2)).toBe("120000.00");
    expect(D(res.grossProfit).toFixed(2)).toBe("80000.00");
    expect(D(res.grossProfit).toFixed(2)).toBe(D(res.revenue).minus(res.costOfSales).toFixed(2));
  });

  it("reconciles to the underlying effective journal lines", async () => {
    const res = (await pnl()).body;
    const rows = await handle.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT a.category,
             coalesce(sum(jl.debit), 0)  AS dr,
             coalesce(sum(jl.credit), 0) AS cr
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      JOIN accounts a ON a.id = jl.account_id
      WHERE je.status = 'POSTED' AND je.reversal_of_id IS NULL
        AND je.entry_date BETWEEN '2026-01-01'::date AND '2026-12-31'::date
        AND a.is_leaf AND a.category IN ('REVENUE','COST_OF_SALES','EXPENSE')
      GROUP BY a.category`);
    const by = (c: string) => rows.find((r) => r.category === c) ?? { dr: 0, cr: 0 };
    const rev = D(by("REVENUE").cr).minus(D(by("REVENUE").dr));
    const cogs = D(by("COST_OF_SALES").dr).minus(D(by("COST_OF_SALES").cr));
    const exp = D(by("EXPENSE").dr).minus(D(by("EXPENSE").cr));

    expect(D(res.revenue).toFixed(2)).toBe(rev.toFixed(2));
    expect(D(res.costOfSales).toFixed(2)).toBe(cogs.toFixed(2));
    expect(D(res.totalExpenses).toFixed(2)).toBe(exp.toFixed(2));
    expect(D(res.netProfit).toFixed(2)).toBe(rev.minus(cogs).minus(exp).toFixed(2));
  });

  it("excludes reversed entries, so a cancelled expense nets to zero", async () => {
    const before = (await pnl()).body;
    const entry = await post("2026-08-01", [{ account: salaries, debit: "4000" }, { account: cash, credit: "4000" }], "راتب سيُعكس");
    const mid = (await pnl()).body;
    expect(D(mid.totalExpenses).toFixed(2)).toBe(D(before.totalExpenses).plus(4000).toFixed(2));

    const rev = await request(server()).post(`/api/v1/journal/${entry.id}/reverse`).set(auth()).send({ reason: "اختبار العكس" });
    expect(rev.status).toBeLessThan(300);

    const after = (await pnl()).body;
    expect(D(after.totalExpenses).toFixed(2)).toBe(D(before.totalExpenses).toFixed(2));
    expect(D(after.netProfit).toFixed(2)).toBe(D(before.netProfit).toFixed(2));
  });

  it("respects the date filter", async () => {
    const narrow = (await pnl("from=2026-04-01&to=2026-04-30")).body;
    expect(D(narrow.revenue).toFixed(2)).toBe("0.00");
    expect(D(narrow.totalExpenses).toFixed(2)).toBe("900.00"); // only the April transport charge
    expect(D(narrow.netProfit).toFixed(2)).toBe("-900.00");
  });

  it("net profit is the one authority — the same numbers reach the net-profit report", async () => {
    const is = (await pnl()).body;
    const np = await request(server()).get(`/api/v1/reports/financial/net-profit?${RANGE}`).set(auth());
    expect(np.status).toBe(200);
    expect(D(np.body.grossProfit).toFixed(2)).toBe(D(is.grossProfit).toFixed(2));
    expect(D(np.body.operatingExpenses).toFixed(2)).toBe(D(is.totalExpenses).toFixed(2));
    expect(D(np.body.netProfit).toFixed(2)).toBe(D(is.netProfit).toFixed(2));
  });

  it("is OWNER-only and unauthenticated requests are refused", async () => {
    expect((await pnl(RANGE, accountantToken)).status).toBe(403);
    expect((await request(server()).get(`/api/v1/reports/income-statement?${RANGE}`)).status).toBe(401);
  });


  // ── net revenue and contra-revenue ────────────────────────────────────────

  it("a sales return debits contra-revenue and is ALREADY inside the API's revenue total", async () => {
    const before = (await pnl()).body;
    // A contra-revenue account in the REVENUE category, debited by a return.
    const contra = (await handle.prisma.account.create({
      data: { code: `SR${Date.now().toString().slice(-6)}`, nameAr: "مردودات المبيعات", nameEn: "Sales returns",
              category: "REVENUE" as never, accountType: "REVENUE" as never, isLeaf: true, active: true },
    })).id;
    await post("2026-09-01", [{ account: contra, debit: "50000" }, { account: cash, credit: "50000" }], "مردودات مبيعات");
    const after = (await pnl()).body;

    // The revenue TOTAL already dropped by the return — it is net, not gross.
    expect(D(after.revenue).toFixed(2)).toBe(D(before.revenue).minus(50000).toFixed(2));
    // And the contra account appears as a NEGATIVE revenue line.
    const line = after.revenueLines.find((l: { accountId: string }) => l.accountId === contra);
    expect(D(line.amount).toFixed(2)).toBe("-50000.00");
  });

  it("the revenue total is exactly the sum of its lines — so a UI split cannot double count", async () => {
    const res = (await pnl()).body;
    const summed = res.revenueLines.reduce((a: Decimal, l: { amount: string }) => a.plus(l.amount), new Decimal(0));
    expect(summed.toFixed(2)).toBe(D(res.revenue).toFixed(2));

    // Reconstructing gross and deductions the way the statement does must return
    // the same net — never revenue minus the return a second time.
    const gross = res.revenueLines.filter((l: { amount: string }) => Number(l.amount) >= 0)
      .reduce((a: Decimal, l: { amount: string }) => a.plus(l.amount), new Decimal(0));
    const deductions = res.revenueLines.filter((l: { amount: string }) => Number(l.amount) < 0)
      .reduce((a: Decimal, l: { amount: string }) => a.plus(new Decimal(l.amount).abs()), new Decimal(0));
    expect(gross.minus(deductions).toFixed(2)).toBe(D(res.revenue).toFixed(2));
    expect(gross.minus(deductions).minus(deductions).toFixed(2)).not.toBe(D(res.revenue).toFixed(2));
  });

  it("net revenue − cost of sales = gross profit, with returns in play", async () => {
    const res = (await pnl()).body;
    expect(D(res.grossProfit).toFixed(2)).toBe(D(res.revenue).minus(res.costOfSales).toFixed(2));
  });

  it("gross profit − total expenses = net profit, with returns in play", async () => {
    const res = (await pnl()).body;
    expect(D(res.netProfit).toFixed(2)).toBe(D(res.grossProfit).minus(res.totalExpenses).toFixed(2));
  });

  it("every expense account the API returns is a leaf with a non-zero amount, so grouping can never lose one", async () => {
    const res = (await pnl()).body;
    expect(res.expenses.length).toBeGreaterThan(0);
    for (const e of res.expenses) {
      expect(e.accountId).toBeTruthy();
      expect(e.code).toBeTruthy();
      expect(D(e.amount).isZero()).toBe(false);
    }
    const summed = res.expenses.reduce((a: Decimal, e: { amount: string }) => a.plus(e.amount), new Decimal(0));
    expect(summed.toFixed(2)).toBe(D(res.totalExpenses).toFixed(2));
  });

  it("requesting the report writes nothing", async () => {
    const count = async () => ({
      journals: await handle.prisma.journalEntry.count(),
      journalLines: await handle.prisma.journalLine.count(),
      accounts: await handle.prisma.account.count(),
      audit: await handle.prisma.auditLog.count(),
      invoices: await handle.prisma.salesInvoice.count(),
      movements: await handle.prisma.inventoryMovement.count(),
    });
    const before = await count();
    await pnl();
    await pnl("from=2026-04-01&to=2026-04-30");
    await request(server()).get(`/api/v1/reports/financial/net-profit?${RANGE}`).set(auth());
    expect(await count()).toEqual(before);
  });
});
