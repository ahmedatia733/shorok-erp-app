/**
 * حركات المخزون — the search box must actually filter the table.
 *
 * The bug this guards: the page kept an "applied query" state that nothing ever
 * wrote to, so the search parameter was never sent and the old browser-side
 * filter had already been removed. Typing ص left every ك row on screen, and
 * Enter did nothing because no key handler existed. Both symptoms are asserted
 * here against the rendered table, not against the API — the API was correct
 * the whole time, which is exactly why an API-only test would have passed.
 *
 * LOCAL test env only.
 */
import { test, expect, type Page } from "@playwright/test";

const API = "http://localhost:3001/api/v1";
const OWNER = { phone: "+201000000000", password: "Owner@2026" };

interface Ctx {
  code: string;
  otherCode: string;
}

async function seed(page: Page): Promise<Ctx> {
  await page.goto("/ar/login");
  return page.evaluate(async ([api, owner]) => {
    const call = async (path: string, token: string | null, body?: unknown) => {
      const res = await fetch(api + path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
      return res.json();
    };
    const token: string = (await call("/auth/login", null, owner)).accessToken;
    const u = Date.now().toString().slice(-6);
    const branchId = ((await call("/branches", token)) as Array<{ id: string }>)[0].id;

    const code = `MVS-${u}`;
    const sku = await call("/products/skus", token, {
      code, colorNameAr: "خشبي دابل فيس", colorNameEn: "Wood", category: "NORMAL",
    });
    // One product across all three classes, the shape the live catalogue has.
    for (const [size, boards] of [["5.25", "9"], ["4", "11"], ["3.75", "6"]] as const) {
      const v = await call("/products/variants", token, {
        skuId: sku.id, sizeMetersPerBoard: size,
        defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0",
      });
      await call("/inventory/receipts", token, {
        branchId, productVariantId: v.id, boardsQuantity: boards, note: `استلام ${size}`,
      });
    }

    // A product whose Arabic name contains ك and ص, to prove those letters are
    // not matched as size tokens inside ordinary text.
    const otherCode = `KOB-${u}`;
    const other = await call("/products/skus", token, {
      code: otherCode, colorNameAr: "كوبرا صيني", colorNameEn: "Cobra", category: "NORMAL",
    });
    const ov = await call("/products/variants", token, {
      skuId: other.id, sizeMetersPerBoard: "6.6",
      defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0",
    });
    await call("/inventory/receipts", token, {
      branchId, productVariantId: ov.id, boardsQuantity: "4", note: "استلام كوبرا",
    });

    return { code, otherCode };
  }, [API, OWNER] as const);
}

async function login(page: Page) {
  await page.goto("/ar/login");
  const status = await page.evaluate(async ([api, owner]) => {
    const r = await fetch(`${api}/auth/login`, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" }, body: JSON.stringify(owner),
    });
    return r.status;
  }, [API, OWNER] as const);
  expect(status).toBe(200);
}

/** Every size cell currently rendered in the table. */
const sizes = (page: Page) => page.getByTestId("mv-size").allInnerTexts();

async function search(page: Page, text: string) {
  const box = page.getByTestId("mv-search");
  await box.fill(text);
  // the debounce, plus the round trip
  await page.waitForTimeout(1200);
}

test.describe("حركات المخزون — search actually filters", () => {
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
    await page.waitForTimeout(800);
  });

  test("1: the unfiltered table really does contain a mix of ك and ص", async ({ page }) => {
    const all = (await sizes(page)).join(" ");
    expect(all).toContain("ك");
    expect(all).toContain("ص");
  });

  test("2: typing ص leaves only 4.00 rows — the reported bug", async ({ page }) => {
    await search(page, "ص");
    const cells = await sizes(page);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c).toContain("4.00");
      expect(c).not.toContain("5.25");
    }
  });

  test("3: typing ك leaves only 5.25 rows", async ({ page }) => {
    await search(page, "ك");
    const cells = await sizes(page);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(c).toContain("5.25");
  });

  test("4: typing م ق leaves only custom sizes", async ({ page }) => {
    await search(page, "م ق");
    const cells = await sizes(page);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c).not.toContain("5.25");
      expect(c).not.toContain("4.00");
    }
  });

  test("5: clearing the box brings the mixed list back", async ({ page }) => {
    await search(page, "ص");
    expect((await sizes(page)).join(" ")).not.toContain("5.25");
    await search(page, "");
    const all = (await sizes(page)).join(" ");
    expect(all).toContain("5.25");
    expect(all).toContain("4.00");
  });

  test("6: a product code returns every size for that code", async ({ page }) => {
    await search(page, ctx.code);
    const all = (await sizes(page)).join(" ");
    expect(all).toContain("5.25");
    expect(all).toContain("4.00");
    expect(all).toContain("3.75");
  });

  test("7: code plus size class combines", async ({ page }) => {
    await search(page, `${ctx.code} ص`);
    const cells = await sizes(page);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(c).toContain("4.00");

    await search(page, `${ctx.code} ك`);
    for (const c of await sizes(page)) expect(c).toContain("5.25");

    await search(page, `${ctx.code} م ق`);
    for (const c of await sizes(page)) expect(c).toContain("3.75");
  });

  test("8: an exact custom measurement filters to that size", async ({ page }) => {
    await search(page, "3.75");
    const cells = await sizes(page);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(c).toContain("3.75");
  });

  test("9: a name containing ك and ص is not read as a size search", async ({ page }) => {
    await search(page, "كوبرا");
    const cells = await sizes(page);
    expect(cells.length).toBeGreaterThan(0);
    // «كوبرا صيني» is a 6.6 board; a substring bug would have filtered to 5.25
    for (const c of cells) expect(c).toContain("6.60");
  });

  test("10: Enter applies immediately, without reloading or submitting", async ({ page }) => {
    let navigated = false;
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigated = true; });

    const box = page.getByTestId("mv-search");
    await box.fill("ص");
    await box.press("Enter");
    // Deliberately shorter than the 300 ms debounce plus round trip would need
    // if Enter did nothing — this is the assertion that Enter is wired.
    await page.waitForTimeout(700);

    const cells = await sizes(page);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(c).toContain("4.00");
    expect(navigated).toBe(false);
    await expect(box).toHaveValue("ص");
  });

  test("11: rapid retyping leaves the LAST query's results, not an earlier one", async ({ page }) => {
    const box = page.getByTestId("mv-search");
    await box.fill("ك");
    await page.waitForTimeout(120);
    await box.fill("ص");   // switches before the first request can settle
    await page.waitForTimeout(1500);

    const cells = await sizes(page);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(c).toContain("4.00");
    await expect(box).toHaveValue("ص");
  });

  test("12: a slow earlier response cannot overwrite a newer one", async ({ page }) => {
    // Hold the unfiltered request open, then search. If the stale guard were
    // missing, the delayed unfiltered page would land last and restore ك rows.
    let first = true;
    await page.route("**/inventory/movements**", async (route) => {
      if (first && !route.request().url().includes("search=")) {
        first = false;
        await new Promise((r) => setTimeout(r, 2500));
      }
      await route.continue();
    });
    await page.goto("/ar/inventory/movements");
    const box = page.getByTestId("mv-search");
    await box.fill("ص");
    await box.press("Enter");
    await page.waitForTimeout(4000); // long enough for the delayed one to arrive

    const cells = await sizes(page);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(c).toContain("4.00");
  });
});

test.describe("the outer inventory interface shows the same size", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("13: the stock table shows the class badge and the measurement", async ({ page }) => {
    await page.goto("/ar/inventory");
    await expect(page.locator("table").first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1500);

    const cells = await page.getByTestId("stock-size").allInnerTexts();
    expect(cells.length).toBeGreaterThan(0);
    const joined = cells.join(" ");
    // a class badge and a real measurement, never a bare number
    expect(joined).toMatch(/ك|ص|م ق/);
    expect(joined).toMatch(/\d+\.\d{2}/);
    for (const c of cells) expect(c).toContain("م");
  });

  test("14: the recent-movements preview shows it too", async ({ page }) => {
    await page.goto("/ar/inventory");
    await page.waitForTimeout(1500);
    const cells = await page.getByTestId("recent-size").allInnerTexts();
    if (cells.length === 0) test.skip(true, "no recent movements in this branch");
    for (const c of cells) {
      expect(c).toMatch(/ك|ص|م ق/);
      expect(c).toMatch(/\d+\.\d{2}/);
    }
  });
});
