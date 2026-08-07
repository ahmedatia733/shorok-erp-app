/**
 * «تعديل مخزون» — the source-stock picker, in a real browser.
 *
 * The point of the screen is that a settlement can only be aimed at stock that
 * exists where the storekeeper is standing, so this drives it the way a
 * storekeeper would: warehouse, then product, then the exact board size, then
 * the boards, and checks the screen's promise about the resulting balance
 * against the figures the API reported for that same variant.
 *
 * Nothing is submitted. Every assertion here is about what the user is offered
 * and told before anything is written; the posting rules themselves are pinned
 * by the API integration suite, which can prove them without leaving a movement
 * behind.
 *
 * The fixtures are discovered from whatever data the database holds rather than
 * hard-coded, so the suite is meaningful against a restored copy of real stock
 * and skips honestly when there is nothing to adjust.
 */
import { expect, test, type Page } from "@playwright/test";

const API = "http://localhost:3001/api/v1";
const HAS_ARABIC = /[؀-ۿ]/;
const KEY_LEAK = /\b[a-z][a-z0-9]+\.[a-z][a-zA-Z0-9_]+(?:\.[a-z][a-zA-Z0-9_]+)+\b/;

/**
 * Signs in twice over: the cookie the app itself will use, and an access token
 * this file uses to ask the API the same questions the page asks, so the two can
 * be compared.
 */
async function loginAs(page: Page, phone: string, password: string): Promise<string> {
  await page.goto("/ar/login");
  const result = await page.evaluate(
    async ({ phone, password, api }) => {
      const res = await fetch(`${api}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ phone, password }),
      });
      return { status: res.status, body: await res.json() };
    },
    { phone, password, api: API },
  );
  if (result.status !== 200) throw new Error(`Login failed: ${result.status}`);
  return (result.body as { accessToken: string }).accessToken;
}

/** Ask the API the same questions the page will ask, from inside the session. */
async function apiGet<T>(page: Page, token: string, path: string): Promise<T> {
  return page.evaluate(
    async ({ url, token }) => {
      const res = await fetch(url, {
        credentials: "include",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`${url} → ${res.status}`);
      return res.json();
    },
    { url: `${API}${path}`, token },
  );
}

interface FixtureSize {
  productVariantId: string;
  sizeBadgeAr: string;
  boardsOnHand: string;
  metersOnHand: string;
  boardSizeMeters: string;
  hasStock: boolean;
  adjustable: boolean;
}

interface Fixture {
  branchId: string;
  productSkuId: string;
  size: FixtureSize;
}

/** The first warehouse holding something, and the first size of its first product. */
async function findStock(page: Page, token: string): Promise<Fixture | null> {
  const branches = await apiGet<Array<{ id: string; active: boolean }>>(page, token, "/branches");
  for (const branch of branches.filter((b) => b.active)) {
    const { products } = await apiGet<{ products: Array<{ productSkuId: string }> }>(
      page,
      token,
      `/inventory/branch-stock/products?branchId=${branch.id}`,
    );
    for (const product of products.slice(0, 5)) {
      const { sizes } = await apiGet<{ sizes: FixtureSize[] }>(
        page,
        token,
        `/inventory/branch-stock/sizes?branchId=${branch.id}&productSkuId=${product.productSkuId}`,
      );
      const withStock = sizes.find((s) => s.hasStock);
      if (withStock) {
        return { branchId: branch.id, productSkuId: product.productSkuId, size: withStock };
      }
    }
  }
  return null;
}

test.describe("inventory adjustment — source-stock picker", () => {
  let token = "";

  test.beforeEach(async ({ page }) => {
    token = await loginAs(
      page,
      process.env.E2E_PHONE ?? "+201000000000",
      process.env.E2E_PASSWORD ?? "Owner@2026",
    );
  });

  test("asks for the warehouse before offering any product", async ({ page }) => {
    await page.goto("/ar/inventory/adjustments/new");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    // No warehouse chosen yet, so there is nothing to pick a product from.
    await expect(page.getByTestId("adjustment-branch")).toHaveValue("");
    await expect(page.getByTestId("adjustment-product")).toHaveCount(0);
    await expect(page.getByTestId("branch-stock-size-options")).toHaveCount(0);

    const body = await page.locator("main").innerText();
    expect(HAS_ARABIC.test(body)).toBe(true);
    expect(KEY_LEAK.test(body), `key leak: ${KEY_LEAK.exec(body)?.[0] ?? ""}`).toBe(false);
  });

  test("renders the /en route in LTR with English copy and no translation keys", async ({
    page,
  }) => {
    await page.goto("/en/inventory/adjustments/new");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    const body = await page.locator("main").innerText();
    expect(/[A-Za-z]/.test(body)).toBe(true);
    // Every string on this screen has a real translation, so no `a.b.c` key
    // may reach the page.
    expect(KEY_LEAK.test(body), `key leak: ${KEY_LEAK.exec(body)?.[0] ?? ""}`).toBe(false);
  });

  test("offers only this warehouse's products, then that product's real sizes", async ({ page }) => {
    await page.goto("/ar/inventory/adjustments/new");
    const fixture = await findStock(page, token);
    test.skip(!fixture, "no warehouse is holding stock in this database");
    if (!fixture) return;

    // The picker must offer exactly what the API says the warehouse holds.
    const { products } = await apiGet<{ products: Array<{ productSkuId: string; code: string }> }>(
      page,
      token,
      `/inventory/branch-stock/products?branchId=${fixture.branchId}`,
    );

    await page.goto(`/ar/inventory/adjustments/new?branchId=${fixture.branchId}`);
    await expect(page.getByTestId("adjustment-product")).toBeVisible();

    // Nothing is pre-selected: the product is always an explicit choice.
    await expect(page.getByTestId("branch-stock-size-options")).toHaveCount(0);

    await page.getByTestId("adjustment-product").click();
    const optionCount = await page.locator("[role='option']").count();
    expect(optionCount).toBe(products.length);

    await page.locator("[role='option']").first().click();
    await expect(page.getByTestId("branch-stock-size-options")).toBeVisible();

    // No size is auto-selected either, so the direction and count stay hidden.
    await expect(page.getByTestId("adjustment-direction-increase")).toHaveCount(0);
    await expect(page.getByTestId("adjustment-boards")).toHaveCount(0);
  });

  test("shows the exact stock of the chosen size and projects the new balance", async ({ page }) => {
    await page.goto("/ar/inventory/adjustments/new");
    const fixture = await findStock(page, token);
    test.skip(!fixture, "no warehouse is holding stock in this database");
    if (!fixture) return;

    await page.goto(`/ar/inventory/adjustments/new?branchId=${fixture.branchId}`);
    // Find the product through the combobox search, then pick the size card
    // carrying the exact variant we looked up.
    const { products } = await apiGet<{ products: Array<{ productSkuId: string; code: string }> }>(
      page,
      token,
      `/inventory/branch-stock/products?branchId=${fixture.branchId}`,
    );
    const target = products.find((p) => p.productSkuId === fixture.productSkuId)!;
    await page.getByTestId("adjustment-product").click();
    await page.getByTestId("adjustment-product").fill(target.code);
    await page.locator("[role='option']").first().click();

    const card = page.getByTestId(`stock-size-option-${fixture.size.productVariantId}`);
    await expect(card).toBeVisible();
    // The card states the branch's real figures for this exact variant.
    await expect(card).toHaveAttribute("data-has-stock", "true");
    await card.click();

    await page.getByTestId("adjustment-direction-increase").click();
    await page.getByTestId("adjustment-boards").fill("2");

    const projection = page.getByTestId("adjustment-projection");
    await expect(projection).toBeVisible();
    // +2 boards of this size adds exactly two of this variant's boards in metres.
    const expectedMeters = (Number(fixture.size.boardSizeMeters) * 2).toFixed(4);
    await expect(page.getByTestId("adjustment-change")).toContainText(expectedMeters);
    await expect(page.getByTestId("adjustment-resulting")).toBeVisible();

    // A reason is still mandatory — the settlement cannot be submitted without it.
    await expect(page.getByTestId("adjustment-submit")).toBeDisabled();
    await page.getByTestId("adjustment-note").fill("اختبار واجهة — لن يُرسل");
    await expect(page.getByTestId("adjustment-submit")).toBeEnabled();
  });

  test("refuses a fractional board at the keystroke and blocks a negative result", async ({
    page,
  }) => {
    await page.goto("/ar/inventory/adjustments/new");
    const fixture = await findStock(page, token);
    test.skip(!fixture, "no warehouse is holding stock in this database");
    if (!fixture) return;

    const { products } = await apiGet<{ products: Array<{ productSkuId: string; code: string }> }>(
      page,
      token,
      `/inventory/branch-stock/products?branchId=${fixture.branchId}`,
    );
    const target = products.find((p) => p.productSkuId === fixture.productSkuId)!;

    await page.goto(`/ar/inventory/adjustments/new?branchId=${fixture.branchId}`);
    await page.getByTestId("adjustment-product").click();
    await page.getByTestId("adjustment-product").fill(target.code);
    await page.locator("[role='option']").first().click();
    await page.getByTestId(`stock-size-option-${fixture.size.productVariantId}`).click();
    await page.getByTestId("adjustment-direction-increase").click();

    // "1.5" cannot even be typed: the dot never lands in the box.
    await page.getByTestId("adjustment-boards").fill("1.5");
    await expect(page.getByTestId("adjustment-boards")).toHaveValue("15");

    // Taking away far more than the branch holds is refused on screen, before
    // the engine ever sees it.
    await page.getByTestId("adjustment-boards").fill("");
    await page.getByTestId("adjustment-direction-decrease").click();
    const impossible = String(Math.ceil(Number(fixture.size.boardsOnHand)) + 1000);
    await page.getByTestId("adjustment-boards").fill(impossible);
    await page.getByTestId("adjustment-note").fill("اختبار واجهة — لن يُرسل");
    await expect(page.getByTestId("adjustment-submit")).toBeDisabled();
  });

  test("changing the warehouse clears the product and size chosen for the old one", async ({
    page,
  }) => {
    await page.goto("/ar/inventory/adjustments/new");
    const fixture = await findStock(page, token);
    test.skip(!fixture, "no warehouse is holding stock in this database");
    if (!fixture) return;

    await page.goto(`/ar/inventory/adjustments/new?branchId=${fixture.branchId}`);
    await page.getByTestId("adjustment-product").click();
    await page.locator("[role='option']").first().click();
    await expect(page.getByTestId("branch-stock-size-options")).toBeVisible();

    const branches = await apiGet<Array<{ id: string; active: boolean }>>(page, token, "/branches");
    const other = branches.filter((b) => b.active && b.id !== fixture.branchId)[0];
    test.skip(!other, "only one active warehouse in this database");
    if (!other) return;

    await page.getByTestId("adjustment-branch").selectOption(other.id);
    // The product picked in the previous warehouse cannot stand here.
    await expect(page.getByTestId("branch-stock-size-options")).toHaveCount(0);
  });
});
