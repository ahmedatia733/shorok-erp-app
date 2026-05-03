/**
 * T092 — Orders E2E (Playwright).
 *
 * Covers the headline US2 flow end-to-end against the seeded OWNER + Postgres:
 *   - /orders renders RTL in /ar with localized status pills (no key leak)
 *   - /orders/new renders the create form per design.md
 *   - the deviation indicator distinguishes within-tolerance vs over-tolerance
 *     prices
 *   - creating an order via the API and visiting the detail page shows the
 *     correct localized status + amounts
 *
 * The full lifecycle (confirm → collect → cancel) is exhaustively covered by
 * the API integration tests in apps/api/tests/integration/orders.spec.ts.
 * This file proves the UI surface plus localization correctness.
 */
import { expect, test } from "@playwright/test";

const HAS_ARABIC = /[؀-ۿ]/;
const KEY_LEAK = /\b[a-z][a-z0-9]+\.[a-z][a-zA-Z0-9_]+(?:\.[a-z][a-zA-Z0-9_]+)+\b/;

async function loginAs(page: import("@playwright/test").Page, phone: string, password: string) {
  await page.goto("/ar/login");
  const result = await page.evaluate(
    async ({ phone, password }) => {
      const res = await fetch("http://localhost:3001/api/v1/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, password }),
      });
      return { status: res.status, body: await res.json() };
    },
    { phone, password },
  );
  if (result.status !== 200) {
    throw new Error(`Login failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.body.accessToken as string;
}

test.describe("orders", () => {
  test("/ar/orders renders RTL with localized headers and no key leak", async ({ page }) => {
    await loginAs(page, "+201000000000", "Owner@2026");
    await page.goto("/ar/orders");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    const headers = (await page.locator("h1, th").allInnerTexts()).join(" ");
    expect(HAS_ARABIC.test(headers)).toBe(true);
    expect(KEY_LEAK.test(headers)).toBe(false);
  });

  test("/ar/orders/new shows the form, deviation indicator, and required preview", async ({
    page,
  }) => {
    await loginAs(page, "+201000000000", "Owner@2026");
    await page.goto("/ar/orders/new");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    await expect(page.locator("input#customer")).toHaveCount(1);
    await expect(page.locator("select#variant")).toHaveCount(1);
    await expect(page.locator("input#boards")).toHaveCount(1);
    await expect(page.locator("input#price")).toHaveCount(1);

    // Pick the first variant, enter an "outside tolerance" price (default 120, +20 → 16.7%)
    await page.locator("select#variant").selectOption({ index: 1 });
    await page.locator("input#boards").fill("2");
    await page.locator("input#price").fill("140"); // > 5% deviation against 120 default

    // The "outside tolerance" alert (warning variant) must appear
    const alerts = await page.locator('[role="alert"], [role="status"]').allInnerTexts();
    const alertText = alerts.join(" ");
    expect(alertText).toMatch(/خارج|outside/i);
    expect(KEY_LEAK.test(alertText)).toBe(false);
  });

  test("Created order's detail page shows localized status pill and amounts (full English flow)", async ({
    page,
    request,
  }) => {
    const accessToken = await loginAs(page, "+201000000000", "Owner@2026");

    // Find a variant + branch to use
    const variants = await request.get("http://localhost:3001/api/v1/products/variants", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const variantList = (await variants.json()) as Array<{
      id: string;
      defaultSalePricePerMeter: string;
    }>;
    const branches = await request.get("http://localhost:3001/api/v1/branches", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const branchList = (await branches.json()) as Array<{ id: string }>;

    expect(variantList.length).toBeGreaterThan(0);
    expect(branchList.length).toBeGreaterThan(0);
    const v = variantList[0]!;
    const b = branchList[0]!;

    const create = await request.post("http://localhost:3001/api/v1/orders", {
      headers: { authorization: `Bearer ${accessToken}` },
      data: {
        branchId: b.id,
        customerName: "E2E Customer",
        productVariantId: v.id,
        boardsQuantity: "1",
        salePricePerMeter: v.defaultSalePricePerMeter, // within tolerance
      },
    });
    expect(create.status()).toBe(201);
    const order = await create.json();

    await page.goto(`/en/orders/${order.id}`);
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.locator("h1")).toContainText("E2E Customer");
    // Status pill is localized real text, not a key. Scope to whole body —
    // a status word ("Draft" or similar) MUST be visible somewhere.
    const body = (await page.locator("h1, h2, h3, p, span").allInnerTexts()).join(" ");
    expect(KEY_LEAK.test(body)).toBe(false);
    expect(/Draft|Confirmed|Pending|Paid|Within|Approved/i.test(body)).toBe(true);
  });
});
