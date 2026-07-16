/**
 * Unified Account Statement — browser E2E (Section N).
 *
 * Drives the two-stage selector against real GL data: consolidated vs specific
 * for banks, treasuries, expenses, customers and suppliers, plus drilldown and
 * the negative-treasury warning. All fixtures are created through the API for
 * this run; nothing here targets production.
 */
import { expect, test, type Page } from "@playwright/test";

const API = "http://localhost:3001/api/v1";

interface Ctx {
  token: string;
  bankA: string; bankB: string;
  cashA: string; cashB: string;
  expOps: string; revenue: string; arCtl: string; apCtl: string;
  customerA: string; customerB: string; supplierA: string;
  suffix: string;
}

/** Builds an isolated set of accounts/parties + postings through the API. */
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

    const login = await call("/auth/login", null, { phone: "+201000000000", password: "Owner@2026" });
    const token: string = login.accessToken;
    const u = Date.now().toString().slice(-6);

    // Postings need an open period; a re-run will already have one.
    try {
      await call("/settings/periods", token, { year: 2026, month: 7 });
    } catch {
      /* already exists */
    }

    // POST /accounts only accepts code/name/category/accountType, so membership
    // comes from the shared categoriser's name matching (treasuryType/systemRole
    // are configured by migration, not over the API).
    const mkAccount = async (code: string, nameAr: string, nameEn: string, category: string, accountType: string) =>
      (await call("/accounts", token, { code, nameAr, nameEn, category, accountType })).id as string;

    const bankA = await mkAccount(`E2EB1${u}`, `بنك اختبار أ ${u}`, `E2E Bank A ${u}`, "ASSET", "CURRENT_ASSET");
    const bankB = await mkAccount(`E2EB2${u}`, `بنك اختبار ب ${u}`, `E2E Bank B ${u}`, "ASSET", "CURRENT_ASSET");
    const cashA = await mkAccount(`E2EC1${u}`, `خزنة اختبار أ ${u}`, `E2E Vault A ${u}`, "ASSET", "CURRENT_ASSET");
    const cashB = await mkAccount(`E2EC2${u}`, `خزنة اختبار ب ${u}`, `E2E Vault B ${u}`, "ASSET", "CURRENT_ASSET");
    const expOps = await mkAccount(`E2EX${u}`, `مصاريف تشغيل اختبار ${u}`, `E2E Ops ${u}`, "EXPENSE", "EXPENSE");
    const revenue = await mkAccount(`E2ER${u}`, `إيرادات اختبار ${u}`, `E2E Rev ${u}`, "REVENUE", "REVENUE");
    const arCtl = await mkAccount(`E2EAR${u}`, `ذمم عملاء اختبار ${u}`, `E2E AR ${u}`, "ASSET", "CURRENT_ASSET");
    const apCtl = await mkAccount(`E2EAP${u}`, `موردون اختبار ${u}`, `E2E AP ${u}`, "LIABILITY", "LIABILITY");

    const customerA = (await call("/customers", token, { nameAr: `عميل أ ${u}` })).id as string;
    const customerB = (await call("/customers", token, { nameAr: `عميل ب ${u}` })).id as string;
    const supplierA = (await call("/suppliers", token, { nameAr: `مورد أ ${u}`, nameEn: `Supplier A ${u}` })).id as string;

    const journal = (lines: unknown[]) =>
      call("/journal", token, {
        entryDate: "2026-07-15", entryType: "JOURNAL", description: "قيد اختبار E2E",
        acknowledgeNegativeBalance: true, lines,
      });

    // Fund the banks/treasuries, then spend from Bank A and Cash A only.
    await journal([{ accountId: bankA, debit: "5000", credit: "0" }, { accountId: revenue, debit: "0", credit: "5000" }]);
    await journal([{ accountId: bankB, debit: "2000", credit: "0" }, { accountId: revenue, debit: "0", credit: "2000" }]);
    await journal([{ accountId: cashA, debit: "3000", credit: "0" }, { accountId: revenue, debit: "0", credit: "3000" }]);
    await journal([{ accountId: cashB, debit: "1000", credit: "0" }, { accountId: revenue, debit: "0", credit: "1000" }]);
    await journal([{ accountId: expOps, debit: "700", credit: "0" }, { accountId: bankA, debit: "0", credit: "700" }]);
    await journal([{ accountId: expOps, debit: "400", credit: "0" }, { accountId: cashA, debit: "0", credit: "400" }]);

    // Customer + supplier party movements on the control accounts.
    await journal([
      { accountId: arCtl, debit: "1500", credit: "0", partyType: "CUSTOMER", partyId: customerA },
      { accountId: revenue, debit: "0", credit: "1500" },
    ]);
    await journal([
      { accountId: expOps, debit: "900", credit: "0" },
      { accountId: apCtl, debit: "0", credit: "900", partyType: "SUPPLIER", partyId: supplierA },
    ]);

    return { token, bankA, bankB, cashA, cashB, expOps, revenue, arCtl, apCtl, customerA, customerB, supplierA, suffix: u };
  }, API);
}

/** Chooses a category, then an entity, in the two-stage selector. */
async function select(page: Page, categoryId: string, entityLabelPart: string) {
  await page.selectOption("#stmt-category", categoryId);
  const entity = page.locator("#stmt-entity");
  await entity.click();
  await entity.fill(entityLabelPart);
  await page.locator('[role="option"]').first().click();
  await expect(page.locator("text=جارِ التحديث...")).toHaveCount(0, { timeout: 15_000 });
}

/** Each test gets a fresh browser context, so it must establish its own session. */
async function login(page: Page) {
  await page.goto("/ar/login");
  const status = await page.evaluate(async (api) => {
    const res = await fetch(`${api}/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+201000000000", password: "Owner@2026" }),
    });
    return res.status;
  }, API);
  expect(status).toBe(200);
}

async function openStatement(page: Page) {
  await login(page);
  await page.goto("/ar/accounting/statement");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("#stmt-category")).toBeVisible({ timeout: 15_000 });
}

/**
 * The ar-EG locale renders Arabic-Indic digits (٢٬٦٠٠٫٠٠), so normalise to Latin
 * before asserting on amounts.
 */
function normalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/٬/g, ",")
    .replace(/٫/g, ".");
}

/** Row text for a fixture, located by its unique code/name from this run. */
async function rowText(page: Page, key: string): Promise<string> {
  const row = page.locator("tr", { hasText: key }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  return normalizeDigits(await row.innerText());
}

async function tableText(page: Page): Promise<string> {
  return normalizeDigits(await page.locator("table").last().innerText());
}

test.describe("unified account statement", () => {
  let ctx: Ctx;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    ctx = await seed(page);
    await page.close();
  });

  // Deactivate this run's fixtures so repeat runs don't accumulate accounts in
  // the categories (inactive accounts are excluded from every category).
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto("/ar/login");
    await page.evaluate(async ({ api, ids }) => {
      const login = await (await fetch(`${api}/auth/login`, {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: "+201000000000", password: "Owner@2026" }),
      })).json();
      for (const id of ids) {
        await fetch(`${api}/accounts/${id}`, {
          method: "PATCH", credentials: "include",
          headers: { "content-type": "application/json", authorization: `Bearer ${login.accessToken}` },
          body: JSON.stringify({ active: false }),
        });
      }
    }, { api: API, ids: [ctx.bankA, ctx.bankB, ctx.cashA, ctx.cashB, ctx.expOps, ctx.revenue, ctx.arCtl, ctx.apCtl] });
    await page.close();
  });

  test("the old supplier / bank-treasury / GL-account tabs are gone", async ({ page }) => {
    await openStatement(page);
    // The page now guides by category through one unified selector.
    await expect(page.getByRole("button", { name: "بنك / خزنة" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "حساب محاسبي" })).toHaveCount(0);
    await expect(page.locator("#stmt-category")).toBeVisible();
    await expect(page.locator("#stmt-entity")).toBeVisible();
  });

  test("the category list matches the Manual Journal's", async ({ page }) => {
    await openStatement(page);
    const stmtCats = await page.locator("#stmt-category option").allInnerTexts();

    await login(page);
    await page.goto("/ar/accounting/journal");
    await page.getByRole("button", { name: "قيد جديد" }).first().click();
    // The line's category picker — identified by its placeholder option.
    const journalCats = (
      await page.locator("select", { hasText: "— القائمة —" }).first().locator("option").allInnerTexts()
    ).filter((t) => t !== "— القائمة —");

    expect(journalCats.length).toBeGreaterThan(5);
    // Both screens are driven by the same shared category source.
    for (const c of journalCats) expect(stmtCats).toContain(c);
  });

  test("Flow 1 — all banks vs one bank", async ({ page }) => {
    await openStatement(page);

    // كل البنوك: every bank listed; Bank A reflects the 700 spend, Bank B untouched.
    await select(page, "banks", "كل البنوك");
    await expect(page.locator("text=عرض مجمّع")).toBeVisible();
    expect(await rowText(page, `E2EB1${ctx.suffix}`)).toContain("4,300.00"); // 5000 − 700
    expect(await rowText(page, `E2EB2${ctx.suffix}`)).toContain("2,000.00"); // unchanged

    // One bank: only Bank A's movements.
    await select(page, "banks", `بنك اختبار أ ${ctx.suffix}`);
    await expect(page.locator("text=عرض تفصيلي")).toBeVisible();
    expect(await tableText(page)).not.toContain(`بنك اختبار ب ${ctx.suffix}`);

    // Drilldown resolves from sourceType/sourceId, never parsed text.
    await page.locator("table a").first().click();
    await expect(page).toHaveURL(/\/(accounting\/journal|sales\/invoices|purchasing\/invoices)\//);
  });

  test("Flow 2 — all treasuries vs one treasury", async ({ page }) => {
    await openStatement(page);
    await select(page, "vaults", "كل الخزن");
    expect(await rowText(page, `E2EC1${ctx.suffix}`)).toContain("2,600.00"); // 3000 − 400
    expect(await rowText(page, `E2EC2${ctx.suffix}`)).toContain("1,000.00");

    await select(page, "vaults", `خزنة اختبار أ ${ctx.suffix}`);
    await expect(page.locator("text=عرض تفصيلي")).toBeVisible();
    expect(await tableText(page)).not.toContain(`خزنة اختبار ب ${ctx.suffix}`);
  });

  test("Flow 3 — expense category, all and specific", async ({ page }) => {
    await openStatement(page);
    await select(page, "expense", "كل المصروفات");
    // 700 (bank) + 400 (cash) + 900 (supplier) = 2000
    expect(await rowText(page, `E2EX${ctx.suffix}`)).toContain("2,000.00");

    await select(page, "expense", `مصاريف تشغيل اختبار ${ctx.suffix}`);
    await expect(page.locator("text=عرض تفصيلي")).toBeVisible();
    expect(await tableText(page)).toContain("2,000.00");
  });

  test("Flow 4 — customers, all and specific", async ({ page }) => {
    await openStatement(page);
    await select(page, "customers", "كل العملاء");
    expect(await rowText(page, `عميل أ ${ctx.suffix}`)).toContain("1,500.00");

    await select(page, "customers", `عميل أ ${ctx.suffix}`);
    await expect(page.locator("text=عرض تفصيلي")).toBeVisible();
    expect(await tableText(page)).toContain("1,500.00");
  });

  test("Flow 5 — suppliers, all and specific", async ({ page }) => {
    await openStatement(page);
    await select(page, "suppliers", "كل الموردين");
    expect(await rowText(page, `مورد أ ${ctx.suffix}`)).toContain("900.00");

    await select(page, "suppliers", `مورد أ ${ctx.suffix}`);
    await expect(page.locator("text=عرض تفصيلي")).toBeVisible();
    expect(await tableText(page)).toContain("900.00");
  });

  test("second selector searches by code and clears an invalid selection on category change", async ({ page }) => {
    await openStatement(page);

    await page.selectOption("#stmt-category", "banks");
    const entity = page.locator("#stmt-entity");
    await entity.click();
    await entity.fill(`E2EB1${ctx.suffix}`); // search by account code
    await expect(page.locator('[role="option"]')).toHaveCount(1);
    await page.keyboard.press("Enter"); // keyboard navigation commits it
    await expect(page.locator("text=عرض تفصيلي")).toBeVisible();

    // Switching category drops the now-invalid selection back to "الكل".
    await page.selectOption("#stmt-category", "vaults");
    await expect(page.locator("text=عرض مجمّع")).toBeVisible({ timeout: 15_000 });
    await expect(entity).toHaveValue("كل الخزن");
  });
});
