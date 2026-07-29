/**
 * Account Statement — unified-report layout (redesign).
 *
 * Proves the page reads as ONE connected accounting report: a single bordered
 * container holding the header, filter toolbar, totals summary strip and the
 * detailed accounts table (with a totals footer), rather than a filter box +
 * four floating summary cards stacked above a table. It also checks the
 * accounting presentation (tabular, aligned, parenthesised negatives) and the
 * Arabic/English localisation.
 *
 * All fixtures are created through the API for this run and deactivated after,
 * so nothing here touches production and repeat runs don't accumulate accounts.
 */
import { expect, test, type Page } from "@playwright/test";

const API = "http://localhost:3001/api/v1";

interface Ctx {
  suffix: string;
  bankFund: string; // funded bank, ends at 4,300 (positive)
  negVault: string; // unfunded vault, ends at -900 (negative)
  expOps: string;
  revenue: string;
  customerA: string;
  arCtl: string;
  fixtureAccounts: string[];
}

async function seed(page: Page): Promise<Ctx> {
  await page.goto("/ar/login");
  return page.evaluate(async (api) => {
    const call = async (path: string, token: string | null, body?: unknown, method?: string) => {
      const res = await fetch(api + path, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        credentials: "include",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
      return res.json();
    };

    const token: string = (await call("/auth/login", null, { phone: "+201000000000", password: "Owner@2026" })).accessToken;
    const u = Date.now().toString().slice(-6);
    try { await call("/settings/periods", token, { year: 2026, month: 7 }); } catch { /* open */ }

    const mk = async (code: string, nameAr: string, nameEn: string, category: string, accountType: string) =>
      (await call("/accounts", token, { code, nameAr, nameEn, category, accountType })).id as string;

    const bankFund = await mk(`LAYB${u}`, `بنك التخطيط ${u}`, `Layout Bank ${u}`, "ASSET", "CURRENT_ASSET");
    const negVault = await mk(`LAYV${u}`, `خزنة سالبة ${u}`, `Layout Neg Vault ${u}`, "ASSET", "CURRENT_ASSET");
    const expOps = await mk(`LAYX${u}`, `مصروف التخطيط ${u}`, `Layout Exp ${u}`, "EXPENSE", "EXPENSE");
    const revenue = await mk(`LAYR${u}`, `إيراد التخطيط ${u}`, `Layout Rev ${u}`, "REVENUE", "REVENUE");
    const arCtl = await mk(`LAYAR${u}`, `ذمم التخطيط ${u}`, `Layout AR ${u}`, "ASSET", "CURRENT_ASSET");
    const customerA = (await call("/customers", token, { nameAr: `عميل التخطيط ${u}` })).id as string;

    const journal = (lines: unknown[]) =>
      call("/journal", token, {
        entryDate: "2026-07-15", entryType: "JOURNAL", description: "قيد تخطيط",
        acknowledgeNegativeBalance: true, negativeBalanceReason: "اختبار", lines,
      });

    // Funded bank spends 700 → closes at 4,300 (positive).
    await journal([{ accountId: bankFund, debit: "5000", credit: "0" }, { accountId: revenue, debit: "0", credit: "5000" }]);
    await journal([{ accountId: expOps, debit: "700", credit: "0" }, { accountId: bankFund, debit: "0", credit: "700" }]);
    // Unfunded vault spends 900 → closes at -900 (negative, exercises the indicator).
    await journal([{ accountId: expOps, debit: "900", credit: "0" }, { accountId: negVault, debit: "0", credit: "900" }]);
    // A receivable on a customer party.
    await journal([
      { accountId: arCtl, debit: "1500", credit: "0", partyType: "CUSTOMER", partyId: customerA },
      { accountId: revenue, debit: "0", credit: "1500" },
    ]);

    return { suffix: u, bankFund, negVault, expOps, revenue, customerA, arCtl,
      fixtureAccounts: [bankFund, negVault, expOps, revenue, arCtl] };
  }, API);
}

async function login(page: Page) {
  await page.goto("/ar/login");
  const status = await page.evaluate(async (api) => {
    const res = await fetch(`${api}/auth/login`, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+201000000000", password: "Owner@2026" }),
    });
    return res.status;
  }, API);
  expect(status).toBe(200);
}

async function openStatement(page: Page, locale = "ar") {
  await login(page);
  await page.goto(`/${locale}/accounting/statement`);
  await expect(page.locator("#stmt-category")).toBeVisible({ timeout: 15_000 });
}

/** Two-stage selector: native category <select> then the searchable entity box. */
async function select(page: Page, categoryId: string, entityLabelPart: string) {
  await page.selectOption("#stmt-category", categoryId);
  const entity = page.locator("#stmt-entity");
  await entity.click();
  await entity.fill("");
  await entity.fill(entityLabelPart);
  await page.locator('[role="option"]').first().click();
  await expect(page.locator("text=جارِ التحديث...")).toHaveCount(0, { timeout: 15_000 });
}

function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/٬/g, ",").replace(/٫/g, ".");
}

test.describe("account statement — unified report layout", () => {
  let ctx: Ctx;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    ctx = await seed(page);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto("/ar/login");
    await page.evaluate(async ({ api, ids }) => {
      const token = (await (await fetch(`${api}/auth/login`, {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: "+201000000000", password: "Owner@2026" }),
      })).json()).accessToken;
      for (const id of ids) {
        await fetch(`${api}/accounts/${id}`, {
          method: "PATCH", credentials: "include",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ active: false }),
        });
      }
    }, { api: API, ids: ctx.fixtureAccounts });
    await page.close();
  });

  test("1–4, 9–12: one report container holds the toolbar, summary strip and accounts table (Arabic RTL)", async ({ page }) => {
    await openStatement(page);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    const report = page.getByTestId("statement-report");
    await expect(report).toBeVisible();
    // Toolbar lives INSIDE the single report container.
    await expect(report.locator("#stmt-category")).toBeVisible();
    await expect(report.locator("#stmt-entity")).toBeVisible();

    // List selector opens and is searchable (portalled listbox).
    await report.locator("#stmt-entity").click();
    await expect(page.locator('[role="listbox"]')).toBeVisible();
    await page.keyboard.press("Escape");

    await select(page, "banks", "كل البنوك");

    // Summary strip is inside the report — the four headings, once each.
    const summary = report.getByTestId("statement-summary");
    await expect(summary).toBeVisible();
    for (const h of ["الرصيد الافتتاحي", "إجمالي المدين", "إجمالي الدائن", "الرصيد النهائي"]) {
      await expect(summary.getByText(h, { exact: true })).toHaveCount(1);
    }

    // Accounts table is inside the same container, with the accounting columns.
    const acc = report.getByTestId("statement-accounts-table");
    await expect(acc).toBeVisible();
    const heads = (await acc.locator("thead th").allInnerTexts()).map((s) => s.trim());
    for (const c of ["الكود", "الاسم", "الرصيد الافتتاحي", "مدين", "دائن", "الإجراءات"]) {
      expect(heads).toContain(c);
    }

    // Monetary cells are tabular and LTR-aligned.
    const firstMoney = acc.locator("tbody tr").first().locator("td").nth(2).locator("span");
    await expect(firstMoney).toHaveClass(/tabular-nums/);
    await expect(firstMoney).toHaveAttribute("dir", "ltr");
  });

  test("21: seeded balances are unchanged (funded bank closes at 4,300.00)", async ({ page }) => {
    await openStatement(page);
    await select(page, "banks", "كل البنوك");
    const row = page.locator("tr", { hasText: `LAYB${ctx.suffix}` }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    expect(normalizeDigits(await row.innerText())).toContain("4,300.00");
    // The totals footer restates the authoritative total for the same column.
    const footer = page.getByTestId("statement-accounts-table").locator("tfoot");
    await expect(footer).toBeVisible();
    expect(normalizeDigits(await footer.innerText())).toContain("الإجمالي");
  });

  test("13: a negative closing balance carries a non-colour, accessible indicator", async ({ page }) => {
    await openStatement(page);
    await select(page, "vaults", "كل الخزن");
    const row = page.locator("tr", { hasText: `LAYV${ctx.suffix}` }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Closing balance cell is flagged negative, wrapped in parentheses, and
    // labelled — not colour-only.
    const neg = row.locator('[data-negative="true"]').first();
    await expect(neg).toBeVisible();
    const txt = normalizeDigits(await neg.innerText());
    expect(txt.startsWith("(")).toBeTruthy();
    expect(txt).toContain("900.00");
    await expect(neg).toHaveAttribute("aria-label", /رصيد سالب/);
  });

  test("5–7, 14: customers selector + drill-down via عرض التفاصيل, dates functional", async ({ page }) => {
    await openStatement(page);
    // Choosing العملاء swaps the entity label to العميل.
    await page.selectOption("#stmt-category", "customers");
    await expect(page.getByText("العميل", { exact: true })).toBeVisible();

    await select(page, "customers", "كل العملاء");
    // Drill into the seeded customer via the row action button.
    const row = page.locator("tr", { hasText: `عميل التخطيط ${ctx.suffix}` }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole("button", { name: "عرض التفاصيل" }).click();
    await expect(page.locator("text=عرض تفصيلي")).toBeVisible({ timeout: 15_000 });

    // Date filter is wired: a from-date in the future empties the movements.
    await page.fill("#stmt-from", "2027-01-01");
    await page.getByRole("button", { name: "تحديث" }).click();
    await expect(page.locator("text=جارِ التحديث...")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText("لا توجد حركات في هذه الفترة.")).toBeVisible();
  });

  test("8, 16: an empty result renders inside the table body, and the show-without-movement toggle reloads", async ({ page }) => {
    await openStatement(page);
    // A specific account with a future from-date has no movements in the period,
    // so the empty-state must render INSIDE the table body — not as a floating
    // element beside it.
    await select(page, "banks", `بنك التخطيط ${ctx.suffix}`);
    await expect(page.locator("text=عرض تفصيلي")).toBeVisible();
    await page.fill("#stmt-from", "2099-01-01");
    await page.getByRole("button", { name: "تحديث" }).click();
    await expect(page.locator("text=جارِ التحديث...")).toHaveCount(0, { timeout: 15_000 });
    const emptyCell = page.locator("table tbody td", { hasText: "لا توجد حركات في هذه الفترة." });
    await expect(emptyCell).toBeVisible();

    // The include-zero toggle stays functional: back on a consolidated view,
    // toggling it triggers a reload and the accounts table still renders rows.
    await select(page, "banks", "كل البنوك");
    await page.getByText("إظهار الحسابات بدون حركة").click();
    await expect(page.locator("text=جارِ التحديث...")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("statement-accounts-table").locator("tbody tr").first()).toBeVisible();
  });

  test("15: the accounts table header is sticky while its body scrolls", async ({ page }) => {
    await openStatement(page);
    await select(page, "banks", "كل البنوك");
    const pos = await page
      .getByTestId("statement-accounts-table")
      .locator("thead th")
      .first()
      .evaluate((el) => getComputedStyle(el.parentElement!.parentElement!).position);
    expect(pos).toBe("sticky");
  });

  test("17–20: English route is LTR with localized headings, Latin-digit money and no raw keys", async ({ page }) => {
    await openStatement(page, "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByText("Account Statement", { exact: true })).toBeVisible();

    await page.selectOption("#stmt-category", "banks");
    const entity = page.locator("#stmt-entity");
    await entity.click();
    await entity.fill("");
    await entity.fill("كل البنوك");
    await page.locator('[role="option"]').first().click();
    await expect(page.locator("text=Refreshing...")).toHaveCount(0, { timeout: 15_000 });

    const summary = page.getByTestId("statement-summary");
    for (const h of ["Opening Balance", "Total Debit", "Total Credit", "Closing Balance"]) {
      await expect(summary.getByText(h, { exact: true })).toHaveCount(1);
    }
    // Headers are localized in the DOM ("Code", "Name", …); the thead renders
    // them via CSS `uppercase`, so compare case-insensitively.
    const heads = (await page.getByTestId("statement-accounts-table").locator("thead th").allInnerTexts()).map((s) => s.trim().toLowerCase());
    for (const c of ["code", "name", "debit", "credit", "actions"]) expect(heads).toContain(c);

    // English money uses Latin digits (no Arabic-Indic digits anywhere in a cell).
    const money = page.getByTestId("statement-accounts-table").locator("tbody tr").first().locator("td").nth(2).innerText();
    expect(await money).toMatch(/[0-9]/);
    expect(await money).not.toMatch(/[٠-٩]/);

    // No raw translation keys leaked into the DOM.
    await expect(page.getByText(/statement\.[a-zA-Z]/)).toHaveCount(0);
    await expect(page.getByText(/accounting\.statement/)).toHaveCount(0);
  });

  test("22: the statement endpoint still refuses an unauthenticated request", async ({ page }) => {
    await page.goto("/ar/login");
    const status = await page.evaluate(async (api) => {
      const res = await fetch(`${api}/statements/consolidated?category=banks`, { credentials: "include" });
      return res.status;
    }, API);
    expect(status).toBe(401);
  });
});
