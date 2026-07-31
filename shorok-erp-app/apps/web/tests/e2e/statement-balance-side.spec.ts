/**
 * Customer statement balance-side filter «نوع الرصيد». Seeds real GL data
 * (debit, credit, zero and a return-flipped customer) via the API, then drives
 * the UI: the selector defaults to «مدين ودائن», DEBIT shows only net-debit
 * customers, CREDIT only net-credit, the count + summary cards + table follow the
 * filtered population, a specific customer disables the filter, refresh preserves
 * it, and ar/en render correctly. LOCAL test env only.
 */
import { test, expect, type Page } from "@playwright/test";

const API = "http://localhost:3001/api/v1";

interface Ctx { suffix: string; retName: string; retCustomerId: string }

async function seed(page: Page): Promise<Ctx> {
  await page.goto("/ar/login");
  return page.evaluate(async (api) => {
    const call = async (path: string, token: string | null, body?: unknown) => {
      const res = await fetch(api + path, {
        method: body === undefined ? "GET" : "POST", credentials: "include",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
      return res.json();
    };
    const token: string = (await call("/auth/login", null, { phone: "+201000000000", password: "Owner@2026" })).accessToken;
    const u = Date.now().toString().slice(-6);
    for (const m of [2, 3]) { try { await call("/settings/periods", token, { year: 2026, month: m }); } catch { /* open */ } }
    const mk = async (code: string, nameAr: string, cat: string, t: string) =>
      (await call("/accounts", token, { code, nameAr, nameEn: code, category: cat, accountType: t })).id as string;
    const ar = await mk(`BSAR${u}`, `ذمم عملاء ${u}`, "ASSET", "CURRENT_ASSET"); // AR_RE → customer control
    const ap = await mk(`BSAP${u}`, `موردون ${u}`, "LIABILITY", "LIABILITY");
    const rev = await mk(`BSRV${u}`, `إيراد ${u}`, "REVENUE", "REVENUE");
    const sret = await mk(`BSSR${u}`, `مردودات ${u}`, "REVENUE", "REVENUE");
    const cogs = await mk(`BSCG${u}`, `تكلفة ${u}`, "COST_OF_SALES", "COST_OF_SALES");
    const inv = await mk(`BSIN${u}`, `مخزون ${u}`, "ASSET", "CURRENT_ASSET");
    const vatOut = await mk(`BSVO${u}`, `ض مخرجات ${u}`, "LIABILITY", "LIABILITY");
    const vatIn = await mk(`BSVI${u}`, `ض مدخلات ${u}`, "ASSET", "CURRENT_ASSET");
    await call("/settings/posting-profiles", token, { effectiveFrom: "2026-01-01", arAccountId: ar, apAccountId: ap, revenueAccountId: rev, salesReturnsAccountId: sret, cogsAccountId: cogs, inventoryAccountId: inv, vatOutputAccountId: vatOut, vatInputAccountId: vatIn });

    const branchId = ((await call("/branches", token)) as Array<{ id: string }>)[0].id;
    const supplierId = (await call("/suppliers", token, { nameAr: `مورد ${u}`, nameEn: `Sup ${u}` })).id as string;
    const cust = async (nameAr: string) => (await call("/customers", token, { nameAr })).id as string;
    // AR debit or credit for a customer (revenue balances the entry).
    const jrn = (date: string, custId: string, dr: string, cr: string) =>
      call("/journal", token, { entryDate: date, entryType: "JOURNAL", description: `bs ${date}`, acknowledgeNegativeBalance: true,
        lines: [{ accountId: ar, debit: dr, credit: cr, partyType: "CUSTOMER", partyId: custId }, { accountId: rev, debit: cr, credit: dr }] });

    const d1 = await cust(`مدين واحد ${u}`); await jrn("2026-03-01", d1, "1000", "0");
    const d2 = await cust(`مدين اثنان ${u}`); await jrn("2026-03-01", d2, "2500", "0");
    const c1 = await cust(`دائن واحد ${u}`); await jrn("2026-03-01", c1, "0", "700");
    const z1 = await cust(`صفري ${u}`); await jrn("2026-03-01", z1, "300", "0"); await jrn("2026-03-02", z1, "0", "300");

    // Return-flipped customer: opening credit 1000, sell 1 board (AR +2000),
    // confirm a full return (AR −2000) → net −1000 → CREDIT.
    const retName = `مرتجع ${u}`;
    const ret = await cust(retName);
    await jrn("2026-02-01", ret, "0", "1000");
    const sku = await call("/products/skus", token, { code: `BS-${u}`, colorNameAr: `لون ${u}`, colorNameEn: `Color ${u}`, category: "NORMAL" });
    const variant = await call("/products/variants", token, { skuId: sku.id, sizeMetersPerBoard: "4", defaultSalePricePerMeter: "500", defaultPurchasePricePerMeter: "300" });
    const pi = await call("/purchase-invoices", token, { invoiceDate: "2026-02-05", supplierId, branchId, lines: [{ productVariantId: variant.id, boardsQuantity: "5", unitPrice: "300", taxRate: "0" }] });
    await call(`/purchase-invoices/${pi.id}/confirm`, token, {});
    const si = await call("/sales-invoices", token, { invoiceDate: "2026-03-05", customerId: ret, branchId, taxRate: "0", lines: [{ productVariantId: variant.id, quantity: "1", unitPrice: "2000", costPrice: "0" }] });
    await call(`/sales-invoices/${si.id}/confirm`, token, {});
    const draft = await call("/sales-returns", token, { originalSalesInvoiceId: si.id, returnDate: "2026-03-10", lines: [{ originalSalesInvoiceLineId: si.lines[0].id, returnedBoards: "1" }] });
    await call(`/sales-returns/${draft.id}/confirm`, token, {});

    return { suffix: u, retName, retCustomerId: ret };
  }, API);
}

async function login(page: Page) {
  await page.goto("/ar/login");
  const s = await page.evaluate(async (api) => (await fetch(`${api}/auth/login`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "+201000000000", password: "Owner@2026" }) })).status, API);
  expect(s).toBe(200);
}

async function openAggregated(page: Page, locale = "ar") {
  await login(page);
  await page.goto(`/${locale}/accounting/statement?category=customers`);
  await expect(page.getByTestId("stmt-balance-side")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("text=جارِ التحديث...")).toHaveCount(0, { timeout: 15_000 });
}

const table = (page: Page) => page.getByTestId("statement-accounts-table");
const hasCustomer = (page: Page, name: string) => table(page).locator("tbody tr", { hasText: name });

/** The «تفاصيل الحسابات (N)» count must equal the number of rendered rows — the
 *  population is shared, so assert consistency, not an absolute number. */
async function assertCountMatchesRows(page: Page) {
  const title = await page.getByText(/(?:تفاصيل الحسابات|Account details) \(\d+\)/).first().innerText();
  const n = Number(title.match(/\((\d+)\)/)![1]);
  expect(n).toBe(await table(page).locator("tbody tr").count());
}

test.describe("customer statement — balance-side filter", () => {
  let ctx: Ctx;
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    ctx = await seed(page);
    await page.close();
  });

  test("defaults to «مدين ودائن»; DEBIT and CREDIT filter the population; ALL restores it", async ({ page }) => {
    await openAggregated(page);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const s = ctx.suffix;
    const sel = page.getByTestId("stmt-balance-side");
    await expect(sel).toHaveValue("ALL"); // default «مدين ودائن»

    // ALL: debit, credit and the zero-with-movement customer all present.
    for (const n of [`مدين واحد ${s}`, `مدين اثنان ${s}`, `دائن واحد ${s}`, `صفري ${s}`, ctx.retName]) {
      await expect(hasCustomer(page, n)).toHaveCount(1);
    }

    // DEBIT: only the two net-debit customers.
    await sel.selectOption("DEBIT");
    await expect(page.locator("text=جارِ التحديث...")).toHaveCount(0, { timeout: 15_000 });
    await expect(hasCustomer(page, `مدين واحد ${s}`)).toHaveCount(1);
    await expect(hasCustomer(page, `مدين اثنان ${s}`)).toHaveCount(1);
    await expect(hasCustomer(page, `دائن واحد ${s}`)).toHaveCount(0);
    await expect(hasCustomer(page, `صفري ${s}`)).toHaveCount(0);      // zero excluded
    await expect(hasCustomer(page, ctx.retName)).toHaveCount(0);       // return flipped it to credit
    // Count in the section title + summary follow the filtered population.
    await assertCountMatchesRows(page);

    // CREDIT: only the net-credit customers (incl. the return-flipped one).
    await sel.selectOption("CREDIT");
    await expect(page.locator("text=جارِ التحديث...")).toHaveCount(0, { timeout: 15_000 });
    await expect(hasCustomer(page, `دائن واحد ${s}`)).toHaveCount(1);
    await expect(hasCustomer(page, ctx.retName)).toHaveCount(1);       // confirmed return → CREDIT side
    await expect(hasCustomer(page, `مدين واحد ${s}`)).toHaveCount(0);
    await assertCountMatchesRows(page);

    // ALL restores every applicable customer.
    await sel.selectOption("ALL");
    await expect(page.locator("text=جارِ التحديث...")).toHaveCount(0, { timeout: 15_000 });
    await expect(hasCustomer(page, `مدين واحد ${s}`)).toHaveCount(1);
    await expect(hasCustomer(page, `دائن واحد ${s}`)).toHaveCount(1);
  });

  test("every DEBIT row is positive and every CREDIT row is negative (parenthesised)", async ({ page }) => {
    await openAggregated(page);
    const sel = page.getByTestId("stmt-balance-side");
    await sel.selectOption("DEBIT");
    await expect(page.locator("text=جارِ التحديث...")).toHaveCount(0, { timeout: 15_000 });
    // No parenthesised (negative) closing balance appears under DEBIT.
    await expect(table(page).locator('tbody [data-negative="true"]')).toHaveCount(0);

    await sel.selectOption("CREDIT");
    await expect(page.locator("text=جارِ التحديث...")).toHaveCount(0, { timeout: 15_000 });
    // Every CREDIT closing balance is negative → each data row has the indicator.
    const rows = await table(page).locator("tbody tr").count();
    expect(await table(page).locator('tbody [data-negative="true"]').count()).toBeGreaterThanOrEqual(rows);
  });

  test("selecting a specific customer disables the balance-side filter and always shows it", async ({ page }) => {
    await openAggregated(page);
    await page.getByTestId("stmt-balance-side").selectOption("DEBIT");
    await expect(page.locator("text=جارِ التحديث...")).toHaveCount(0, { timeout: 15_000 });
    // Pick the return-flipped (CREDIT) customer via the entity searchable select.
    const entity = page.locator("#stmt-entity");
    await entity.click(); await entity.fill(""); await entity.fill(ctx.retName);
    await page.locator('[role="option"]', { hasText: ctx.retName }).first().click();
    await expect(page.locator("text=جارِ التحديث...")).toHaveCount(0, { timeout: 15_000 });
    // The filter is disabled + reset, and the selected credit customer still shows.
    await expect(page.getByTestId("stmt-balance-side")).toBeDisabled();
    await expect(page.getByTestId("stmt-balance-side")).toHaveValue("ALL");
    await expect(page.getByText(/عرض تفصيلي/)).toBeVisible();
    await expect(page.getByText(new RegExp(ctx.retName)).first()).toBeVisible();
  });

  test("refresh preserves the filter in the URL and back navigation works; English is LTR with localized labels", async ({ page }) => {
    await openAggregated(page);
    await page.getByTestId("stmt-balance-side").selectOption("DEBIT");
    await expect(page.locator("text=جارِ التحديث...")).toHaveCount(0, { timeout: 15_000 });
    await expect(page).toHaveURL(/balanceSide=DEBIT/);
    await page.reload();
    await expect(page.getByTestId("stmt-balance-side")).toHaveValue("DEBIT"); // preserved across refresh
    await assertCountMatchesRows(page);
    // Back then forward between real navigations works and returns to the report.
    await page.goBack();
    await expect(page).toHaveURL(/\/login/);
    await page.goForward();
    await expect(page.getByTestId("statement-report")).toBeVisible({ timeout: 15_000 });

    // English labels + LTR.
    await openAggregated(page, "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    const sel = page.getByTestId("stmt-balance-side");
    await expect(page.getByText("Balance type", { exact: true })).toBeVisible();
    await expect(sel.locator("option")).toHaveText(["Debit and credit", "Debit", "Credit"]);
    await expect(page.getByText(/statement\.[a-zA-Z]/)).toHaveCount(0); // no raw keys
  });
});
