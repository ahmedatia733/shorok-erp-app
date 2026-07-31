/**
 * Account Statement — sales-return movement label + link (this task).
 *
 * Seeds a real invoice → confirmed sales return through the API, then drives the
 * customer statement UI: the return row must read «مردود فاتورة مبيعات رقم N»
 * (NOT the raw «رصيد دائن للعميل»), be a link to the return document, and keep its
 * GL debit/credit/balance across navigation. Also checks the Excel-like grid and
 * the English «Sales Invoice Return» label. LOCAL test env only.
 */
import { test, expect, type Page } from "@playwright/test";

const API = "http://localhost:3001/api/v1";

interface Ctx {
  customerId: string;
  customerName: string;
  salesReturnId: string;
  returnNumber: string;
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
    for (const month of [2, 3]) { try { await call("/settings/periods", token, { year: 2026, month }); } catch { /* open */ } }

    const mk = async (code: string, nameAr: string, nameEn: string, category: string, accountType: string) =>
      (await call("/accounts", token, { code, nameAr, nameEn, category, accountType })).id as string;
    const ar = await mk(`SRLAR${u}`, `ذمم عملاء ${u}`, `AR ${u}`, "ASSET", "CURRENT_ASSET");
    const ap = await mk(`SRLAP${u}`, `موردون ${u}`, `AP ${u}`, "LIABILITY", "LIABILITY");
    const rev = await mk(`SRLRV${u}`, `إيراد ${u}`, `Rev ${u}`, "REVENUE", "REVENUE");
    const sret = await mk(`SRLSR${u}`, `مردودات مبيعات ${u}`, `Sales Returns ${u}`, "REVENUE", "REVENUE");
    const cogs = await mk(`SRLCG${u}`, `تكلفة ${u}`, `COGS ${u}`, "COST_OF_SALES", "COST_OF_SALES");
    const inv = await mk(`SRLIN${u}`, `مخزون ${u}`, `Inv ${u}`, "ASSET", "CURRENT_ASSET");
    const vatOut = await mk(`SRLVO${u}`, `ض مخرجات ${u}`, `VAT Out ${u}`, "LIABILITY", "LIABILITY");
    const vatIn = await mk(`SRLVI${u}`, `ض مدخلات ${u}`, `VAT In ${u}`, "ASSET", "CURRENT_ASSET");
    // Append a COMPLETE posting profile (incl. VAT) that HAS the sales-returns
    // account (createdAt tiebreaker makes it the one in force).
    await call("/settings/posting-profiles", token, {
      effectiveFrom: "2026-01-01", arAccountId: ar, apAccountId: ap, revenueAccountId: rev,
      salesReturnsAccountId: sret, cogsAccountId: cogs, inventoryAccountId: inv,
      vatOutputAccountId: vatOut, vatInputAccountId: vatIn,
    });

    const branchId = ((await call("/branches", token)) as Array<{ id: string }>)[0].id;
    const supplierId = (await call("/suppliers", token, { nameAr: `مورد ${u}`, nameEn: `Sup ${u}` })).id as string;
    const customerName = `عميل الكشف ${u}`;
    const customerId = (await call("/customers", token, { nameAr: customerName })).id as string;

    const sku = await call("/products/skus", token, { code: `SRL-${u}`, colorNameAr: `لون ${u}`, colorNameEn: `Color ${u}`, category: "NORMAL" });
    const variant = await call("/products/variants", token, { skuId: sku.id, sizeMetersPerBoard: "4", defaultSalePricePerMeter: "500", defaultPurchasePricePerMeter: "300" });

    // Stock 5 boards, sell 2, return 1 whole board (4 m × 500 = 2,000 credit).
    const pi = await call("/purchase-invoices", token, { invoiceDate: "2026-02-05", supplierId, branchId, lines: [{ productVariantId: variant.id, boardsQuantity: "5", unitPrice: "300", taxRate: "0" }] });
    await call(`/purchase-invoices/${pi.id}/confirm`, token, {});
    const si = await call("/sales-invoices", token, { invoiceDate: "2026-03-05", customerId, branchId, taxRate: "0", lines: [{ productVariantId: variant.id, quantity: "2", unitPrice: "500", costPrice: "0" }] });
    await call(`/sales-invoices/${si.id}/confirm`, token, {});
    const draft = await call("/sales-returns", token, { originalSalesInvoiceId: si.id, returnDate: "2026-03-10", lines: [{ originalSalesInvoiceLineId: si.lines[0].id, returnedBoards: "1" }] });
    const sr = await call(`/sales-returns/${draft.id}/confirm`, token, {});

    return { customerId, customerName, salesReturnId: sr.id, returnNumber: String(sr.returnNumber) };
  }, API);
}

async function login(page: Page) {
  await page.goto("/ar/login");
  const status = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/auth/login`, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+201000000000", password: "Owner@2026" }),
    });
    return r.status;
  }, API);
  expect(status).toBe(200);
}

/** Select category=customers then the seeded customer in the two-stage toolbar. */
async function openCustomer(page: Page, locale: string, customerName: string) {
  await login(page);
  await page.goto(`/${locale}/accounting/statement`);
  await expect(page.locator("#stmt-category")).toBeVisible({ timeout: 15_000 });
  await page.selectOption("#stmt-category", "customers");
  const entity = page.locator("#stmt-entity");
  await entity.click();
  await entity.fill("");
  await entity.fill(customerName);
  // Click the option for THIS customer (not the pinned "all"), so the specific
  // one-customer view is loaded deterministically.
  await page.locator('[role="option"]', { hasText: customerName }).first().click();
  await expect(page.locator("text=جارِ التحديث...")).toHaveCount(0, { timeout: 15_000 });
  await expect(entity).toHaveValue(new RegExp(customerName));
  // Wait for the SPECIFIC (one-customer) view to finish loading — the header
  // only shows this once `data` is set — so the row's running balance is the
  // specific-view value, not a transient consolidated one.
  const viewSpecific = locale === "en" ? "Detailed view" : "عرض تفصيلي";
  await expect(page.getByText(viewSpecific, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
}

function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/٬/g, ",").replace(/٫/g, ".");
}

test.describe("statement — sales return label + link", () => {
  let ctx: Ctx;
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    ctx = await seed(page);
    await page.close();
  });

  test("Arabic: Excel grid, explicit return label, clickable link, GL values preserved", async ({ page }) => {
    await openCustomer(page, "ar", ctx.customerName);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    const table = page.getByTestId("statement-movements-table");
    await expect(table).toBeVisible();
    // Grid structure: header cells + bordered data cells.
    expect(await table.locator("thead th").count()).toBeGreaterThanOrEqual(6);
    const firstTd = table.locator("tbody tr").first().locator("td").first();
    const borderW = await firstTd.evaluate((el) => parseFloat(getComputedStyle(el).borderTopWidth));
    expect(borderW).toBeGreaterThan(0);

    // The sales-return movement row (located by its unique return number).
    const row = table.locator("tbody tr", { hasText: `رقم ${ctx.returnNumber}` }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("مردود فاتورة مبيعات");
    // 4) does NOT show the raw customer-credit note; 5/6) shows explicit label + number.
    await expect(row).not.toContainText("رصيد دائن للعميل");
    await expect(row).toContainText(new RegExp(`مردود فاتورة مبيعات رقم ${ctx.returnNumber}`));

    // 7/8) the label is a link to the sales-return document.
    const link = row.getByRole("link");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", `/ar/sales/returns/${ctx.salesReturnId}`);

    // 9) capture the row's money cells, navigate, come back, re-check unchanged.
    const cells = row.locator("td");
    const before = {
      debit: normalizeDigits(await cells.nth(-3).innerText()),
      credit: normalizeDigits(await cells.nth(-2).innerText()),
      balance: normalizeDigits(await cells.nth(-1).innerText()),
    };
    expect(before.credit).toContain("2,000");

    await link.click();
    await expect(page).toHaveURL(new RegExp(`/ar/sales/returns/${ctx.salesReturnId}`));
    await expect(page.getByText(/مردود مبيعات #/)).toBeVisible({ timeout: 15_000 });

    await openCustomer(page, "ar", ctx.customerName); // fresh load
    const row2 = page.getByTestId("statement-movements-table").locator("tbody tr", { hasText: `رقم ${ctx.returnNumber}` }).first();
    const cells2 = row2.locator("td");
    expect(normalizeDigits(await cells2.nth(-3).innerText())).toBe(before.debit);
    expect(normalizeDigits(await cells2.nth(-2).innerText())).toBe(before.credit);
    expect(normalizeDigits(await cells2.nth(-1).innerText())).toBe(before.balance);
  });

  test("English: LTR and «Sales Invoice Return» label", async ({ page }) => {
    await openCustomer(page, "en", ctx.customerName);
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    const row = page.getByTestId("statement-movements-table").locator("tbody tr", { hasText: `No. ${ctx.returnNumber}` }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText(new RegExp(`Sales Invoice Return No\\. ${ctx.returnNumber}`));
    await expect(row.getByRole("link")).toHaveAttribute("href", `/en/sales/returns/${ctx.salesReturnId}`);
  });
});
