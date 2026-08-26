/**
 * حركات المخزون — the المستند column.
 *
 * The ledger listed every movement but never said which document caused it, so
 * a «مردود بدون فاتورة» looked like stock appearing for no reason. This seeds a
 * real confirmed legacy return through the API and then drives the movements
 * page: the movement it produced must name its document and link to the legacy
 * return's own page.
 *
 * The link target is the part worth pinning. An invoice-linked «مردود مبيعات»
 * and a «مردود بدون فاتورة» are different documents on different routes, and
 * sending one to the other's page is what produced a dead link on the customer
 * statement. LOCAL test env only.
 */
import { test, expect, type Page } from "@playwright/test";

const API = "http://localhost:3001/api/v1";

const OWNER = { phone: "+201000000000", password: "Owner@2026" };

interface Ctx {
  legacyReturnId: string;
  purchaseInvoiceId: string;
  productCode: string;
}

async function seed(page: Page): Promise<Ctx> {
  await page.goto("/ar/login");
  return page.evaluate(async ([api, owner]) => {
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
    const token: string = (await call("/auth/login", null, owner)).accessToken;
    const u = Date.now().toString().slice(-6);
    for (const month of [1, 2, 3]) {
      try { await call("/settings/periods", token, { year: 2026, month }); } catch { /* already open */ }
    }

    const mk = async (code: string, nameAr: string, category: string, accountType: string) =>
      (await call("/accounts", token, { code, nameAr, nameEn: nameAr, category, accountType })).id as string;
    const ar = await mk(`IMDAR${u}`, `ذمم عملاء ${u}`, "ASSET", "CURRENT_ASSET");
    const ap = await mk(`IMDAP${u}`, `موردون ${u}`, "LIABILITY", "LIABILITY");
    const rev = await mk(`IMDRV${u}`, `إيراد ${u}`, "REVENUE", "REVENUE");
    const sret = await mk(`IMDSR${u}`, `مردودات مبيعات ${u}`, "REVENUE", "REVENUE");
    const cogs = await mk(`IMDCG${u}`, `تكلفة ${u}`, "COST_OF_SALES", "COST_OF_SALES");
    const inv = await mk(`IMDIN${u}`, `مخزون ${u}`, "ASSET", "CURRENT_ASSET");
    const vatOut = await mk(`IMDVO${u}`, `ض مخرجات ${u}`, "LIABILITY", "LIABILITY");
    const vatIn = await mk(`IMDVI${u}`, `ض مدخلات ${u}`, "ASSET", "CURRENT_ASSET");
    // A legacy return cannot be confirmed without a sales-returns account.
    await call("/settings/posting-profiles", token, {
      effectiveFrom: "2026-01-01", arAccountId: ar, apAccountId: ap, revenueAccountId: rev,
      salesReturnsAccountId: sret, cogsAccountId: cogs, inventoryAccountId: inv,
      vatOutputAccountId: vatOut, vatInputAccountId: vatIn,
    });

    const branchId = ((await call("/branches", token)) as Array<{ id: string }>)[0].id;
    const supplierId = (await call("/suppliers", token, { nameAr: `مورد ${u}`, nameEn: `Sup ${u}` })).id as string;
    const customerId = (await call("/customers", token, { nameAr: `عميل المستند ${u}` })).id as string;

    const productCode = `IMD-${u}`;
    const sku = await call("/products/skus", token, {
      code: productCode, colorNameAr: `لون ${u}`, colorNameEn: `Color ${u}`, category: "NORMAL",
    });
    const variant = await call("/products/variants", token, {
      skuId: sku.id, sizeMetersPerBoard: "5.25",
      defaultSalePricePerMeter: "600", defaultPurchasePricePerMeter: "475",
    });

    // A real purchase, so the return has an honest weighted-average cost to freeze.
    const pi = await call("/purchase-invoices", token, {
      invoiceDate: "2026-02-05", supplierId, branchId,
      lines: [{ productVariantId: variant.id, boardsQuantity: "10", unitPrice: "475", taxRate: "0" }],
    });
    await call(`/purchase-invoices/${pi.id}/confirm`, token, {});

    // The return without an invoice — the document this column exists for.
    const lr = await call("/legacy-returns", token, {
      customerId, branchId,
      paperInvoiceNumber: `PAPER-${u}`, paperInvoiceDate: "2026-01-15", returnDate: "2026-03-05",
      lines: [{ productVariantId: variant.id, returnedBoards: "2", unitPricePerMeter: "600" }],
    });
    const confirmed = await call(`/legacy-returns/${lr.id}/confirm`, token, {});

    return { legacyReturnId: confirmed.id as string, purchaseInvoiceId: pi.id as string, productCode };
  }, [API, OWNER] as const);
}

async function login(page: Page) {
  await page.goto("/ar/login");
  const status = await page.evaluate(async ([api, owner]) => {
    const r = await fetch(`${api}/auth/login`, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(owner),
    });
    return r.status;
  }, [API, OWNER] as const);
  expect(status).toBe(200);
}

test.describe("حركات المخزون — the المستند column", () => {
  let ctx: Ctx;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    ctx = await seed(page);
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto("/ar/inventory/movements");
    await expect(page.locator("table")).toBeVisible({ timeout: 20_000 });
  });

  test("1: the column exists and names the document behind a movement", async ({ page }) => {
    await expect(page.getByRole("columnheader", { name: "المستند" })).toBeVisible();
    // The seeded purchase and legacy return are the newest movements.
    const body = await page.locator("body").innerText();
    expect(body).toContain("مردود بدون فاتورة");
    expect(body).toContain("فاتورة مشتريات");
  });

  test("2: a legacy return links to its OWN page, not the invoice-return route", async ({ page }) => {
    const link = page.locator(`a[href="/ar/sales/legacy-returns/${ctx.legacyReturnId}"]`).first();
    await expect(link).toBeVisible({ timeout: 20_000 });
    await expect(link).toHaveText(/مردود بدون فاتورة/);

    // The bug this replaces: the row pointed at /sales/returns/<legacy id>, a
    // route that can never resolve because the id is not a sales return.
    await expect(page.locator(`a[href="/ar/sales/returns/${ctx.legacyReturnId}"]`)).toHaveCount(0);
  });

  test("3: following that link opens the real document", async ({ page }) => {
    await page.locator(`a[href="/ar/sales/legacy-returns/${ctx.legacyReturnId}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`/sales/legacy-returns/${ctx.legacyReturnId}`));
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("غير موجود");
    expect(body).toContain(ctx.productCode);
  });

  test("4: a purchase movement links to its invoice", async ({ page }) => {
    const link = page.locator(`a[href="/ar/purchasing/invoices/${ctx.purchaseInvoiceId}"]`).first();
    await expect(link).toBeVisible({ timeout: 20_000 });
    await expect(link).toHaveText(/فاتورة مشتريات/);
  });

  test("5: no movement row renders a blank document cell", async ({ page }) => {
    const rows = await page.locator("tbody tr").count();
    expect(rows).toBeGreaterThan(0);
    for (let i = 0; i < rows; i++) {
      const cells = await page.locator("tbody tr").nth(i).locator("td").allInnerTexts();
      // المستند sits immediately before the note column
      expect(cells[cells.length - 2]?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });
});
