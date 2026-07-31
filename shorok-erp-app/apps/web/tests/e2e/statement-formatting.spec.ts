/**
 * Account Statement — adaptive money formatting. A whole amount shows no trailing
 * ".00" (or the Arabic zero-piaster equivalent); a real non-zero decimal keeps
 * its piasters. Seeds a customer with one whole and one fractional AR movement
 * via the GL (POST /journal), then reads the customer statement. LOCAL only.
 */
import { test, expect, type Page } from "@playwright/test";

const API = "http://localhost:3001/api/v1";

interface Ctx { customerId: string; customerName: string }

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
    try { await call("/settings/periods", token, { year: 2026, month: 7 }); } catch { /* open */ }
    const ar = (await call("/accounts", token, { code: `FMTAR${u}`, nameAr: `ذمم عملاء ${u}`, nameEn: `AR ${u}`, category: "ASSET", accountType: "CURRENT_ASSET" })).id;
    const rev = (await call("/accounts", token, { code: `FMTRV${u}`, nameAr: `إيراد ${u}`, nameEn: `Rev ${u}`, category: "REVENUE", accountType: "REVENUE" })).id;
    const customerName = `عميل التنسيق ${u}`;
    const customerId = (await call("/customers", token, { nameAr: customerName })).id as string;

    // Whole amount (2,000) and a fractional amount (1,145.70) on the customer's AR.
    await call("/journal", token, { entryDate: "2026-07-10", entryType: "JOURNAL", description: "رصيد صحيح", acknowledgeNegativeBalance: true,
      lines: [{ accountId: ar, debit: "2000", credit: "0", partyType: "CUSTOMER", partyId: customerId }, { accountId: rev, debit: "0", credit: "2000" }] });
    await call("/journal", token, { entryDate: "2026-07-11", entryType: "JOURNAL", description: "رصيد بكسور", acknowledgeNegativeBalance: true,
      lines: [{ accountId: ar, debit: "1145.70", credit: "0", partyType: "CUSTOMER", partyId: customerId }, { accountId: rev, debit: "0", credit: "1145.70" }] });

    return { customerId, customerName };
  }, API);
}

async function openCustomer(page: Page, locale: string, customerName: string) {
  await page.goto("/ar/login");
  const ok = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/auth/login`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "+201000000000", password: "Owner@2026" }) });
    return r.status;
  }, API);
  expect(ok).toBe(200);
  await page.goto(`/${locale}/accounting/statement`);
  await expect(page.locator("#stmt-category")).toBeVisible({ timeout: 15_000 });
  await page.selectOption("#stmt-category", "customers");
  const entity = page.locator("#stmt-entity");
  await entity.click();
  await entity.fill("");
  await entity.fill(customerName);
  await page.locator('[role="option"]', { hasText: customerName }).first().click();
  await expect(page.locator("text=جارِ التحديث...")).toHaveCount(0, { timeout: 15_000 });
  const specific = locale === "en" ? "Detailed view" : "عرض تفصيلي";
  await expect(page.getByText(specific, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
}

const norm = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/٬/g, ",").replace(/٫/g, ".");

test.describe("statement adaptive money formatting", () => {
  let ctx: Ctx;
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    ctx = await seed(page);
    await page.close();
  });

  test("Arabic: whole amount hides the zero piasters; a real fraction keeps them (RTL)", async ({ page }) => {
    await openCustomer(page, "ar", ctx.customerName);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const table = page.getByTestId("statement-movements-table");

    const wholeRow = norm(await table.locator("tbody tr", { hasText: "رصيد صحيح" }).first().innerText());
    expect(wholeRow).toContain("2,000");
    expect(wholeRow).not.toContain("2,000.00"); // no trailing zero piasters

    const fracRow = norm(await table.locator("tbody tr", { hasText: "رصيد بكسور" }).first().innerText());
    expect(fracRow).toContain("1,145.70"); // real piasters preserved

    // Summary + totals use the same adaptive formatter (ending 3,145.70 is fractional).
    expect(norm(await page.getByTestId("statement-summary").innerText())).toContain("3,145.70");
  });

  test("English: Latin digits, whole shows no .00, fraction preserved (LTR)", async ({ page }) => {
    await openCustomer(page, "en", ctx.customerName);
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    const table = page.getByTestId("statement-movements-table");
    const whole = await table.locator("tbody tr", { hasText: "رصيد صحيح" }).first().innerText();
    expect(whole).toContain("2,000");
    expect(whole).not.toContain("2,000.00");
    const frac = await table.locator("tbody tr", { hasText: "رصيد بكسور" }).first().innerText();
    expect(frac).toContain("1,145.70");
  });
});
