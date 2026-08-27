/**
 * «مردود بدون فاتورة» — confirmation errors must say what is actually wrong.
 *
 * Every business rule in this API arrives as `validation_failed` with the real
 * cause in `details.reason`, so a page that renders only the envelope message
 * shows «البيانات المدخلة غير صحيحة» for a missing inventory cost, a missing
 * posting account and a closed period alike. That is what LRN-5 hit in
 * production: the refusal was correct, but the owner could not tell why.
 *
 * This seeds a return on a variant nobody has ever purchased — so it has no
 * weighted-average cost and the refusal is genuine — and asserts the page
 * explains it. LOCAL test env only.
 */
import { test, expect, type Page } from "@playwright/test";

const API = "http://localhost:3001/api/v1";
const OWNER = { phone: "+201000000000", password: "Owner@2026" };

interface Ctx {
  returnId: string;
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
    const ar = await mk(`LRECAR${u}`, `ذمم عملاء ${u}`, "ASSET", "CURRENT_ASSET");
    const ap = await mk(`LRECAP${u}`, `موردون ${u}`, "LIABILITY", "LIABILITY");
    const rev = await mk(`LRECRV${u}`, `إيراد ${u}`, "REVENUE", "REVENUE");
    const sret = await mk(`LRECSR${u}`, `مردودات مبيعات ${u}`, "REVENUE", "REVENUE");
    const cogs = await mk(`LRECCG${u}`, `تكلفة ${u}`, "COST_OF_SALES", "COST_OF_SALES");
    const inv = await mk(`LRECIN${u}`, `مخزون ${u}`, "ASSET", "CURRENT_ASSET");
    const vatOut = await mk(`LRECVO${u}`, `ض مخرجات ${u}`, "LIABILITY", "LIABILITY");
    const vatIn = await mk(`LRECVI${u}`, `ض مدخلات ${u}`, "ASSET", "CURRENT_ASSET");
    // A complete profile WITH the sales-returns account, so the only thing
    // standing in the way is the missing inventory cost.
    await call("/settings/posting-profiles", token, {
      effectiveFrom: "2026-01-01", arAccountId: ar, apAccountId: ap, revenueAccountId: rev,
      salesReturnsAccountId: sret, cogsAccountId: cogs, inventoryAccountId: inv,
      vatOutputAccountId: vatOut, vatInputAccountId: vatIn,
    });

    const branchId = ((await call("/branches", token)) as Array<{ id: string }>)[0].id;
    const customerId = (await call("/customers", token, { nameAr: `عميل الخطأ ${u}` })).id as string;

    const productCode = `LREC-${u}`;
    const sku = await call("/products/skus", token, {
      code: productCode, colorNameAr: `خشبي دابل فيس ${u}`, colorNameEn: `Wood ${u}`, category: "NORMAL",
    });
    // Never purchased → no weighted-average cost → the refusal is real.
    const variant = await call("/products/variants", token, {
      skuId: sku.id, sizeMetersPerBoard: "5.25",
      defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0",
    });

    const lr = await call("/legacy-returns", token, {
      customerId, branchId,
      paperInvoiceNumber: `PAPER-${u}`, paperInvoiceDate: "2026-02-06", returnDate: "2026-02-10",
      // The exact shape of LRN-5: 5 boards of 5.25 m at a high return price.
      lines: [{ productVariantId: variant.id, returnedBoards: "5", unitPricePerMeter: "6666" }],
    });

    return { returnId: lr.id as string, productCode };
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

test.describe("«مردود بدون فاتورة» — confirmation errors are specific", () => {
  let ctx: Ctx;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    ctx = await seed(page);
    await page.close();
  });

  test("1: a missing inventory cost is explained, not hidden behind the generic message", async ({ page }) => {
    await login(page);
    await page.goto(`/ar/sales/legacy-returns/${ctx.returnId}`);
    await expect(page.getByText("مسودة").first()).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("lrd-confirm").click();

    // The page also carries an empty live-region alert, so target the one that
    // actually says something.
    const alert = page.locator('[role="alert"]').filter({ hasText: /\S/ }).first();
    await expect(alert).toBeVisible({ timeout: 20_000 });
    const text = (await alert.innerText()).trim();

    // The defect: every business rule collapsed into this one sentence.
    expect(text).not.toBe("البيانات المدخلة غير صحيحة.");
    expect(text).toContain("تكلفة");
    expect(text).toContain("5.25"); // the exact size, so the owner knows which variant
    // and it must never leak the raw reason code or internals
    expect(text).not.toContain("legacy_return_cost_unavailable");
    expect(text).not.toContain("    at ");
    expect(text.toLowerCase()).not.toContain("select ");
  });

  test("2: the refusal leaves the document a draft with nothing posted", async ({ page }) => {
    await login(page);
    await page.goto(`/ar/sales/legacy-returns/${ctx.returnId}`);
    await expect(page.getByText("مسودة").first()).toBeVisible({ timeout: 20_000 });

    // Still a draft, and still offering the confirm button — a posted document
    // would show neither.
    await expect(page.getByTestId("lrd-confirm")).toBeVisible();
    await expect(page.getByTestId("lrd-cancel")).toHaveCount(0);
    const body = await page.locator("body").innerText();
    expect(body).toContain("مسودة");
    expect(body).not.toContain("مؤكد");
  });
});
