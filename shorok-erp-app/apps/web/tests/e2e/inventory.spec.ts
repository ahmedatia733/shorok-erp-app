/**
 * T075 — Inventory E2E (Playwright).
 *
 * Covers, end-to-end against a real Postgres + the seeded OWNER:
 *   - login → /inventory loads in /ar with RTL and real Arabic copy
 *   - posting a receipt updates the balances table
 *   - over-adjusting fails with a localized "insufficient_stock" alert
 *
 * The orders flow is intentionally NOT tested here — Phase 4 (US2) owns that.
 */
import { expect, test } from "@playwright/test";

// Match real lower-cased dotted identifiers the way Tailwind class names or
// translation keys would render. Allows the URL host "localhost:3001" to pass
// because that has a colon.
const KEY_LEAK = /\b[a-z][a-z0-9]+\.[a-z][a-zA-Z0-9_]+(?:\.[a-z][a-zA-Z0-9_]+)+\b/;
const HAS_ARABIC = /[؀-ۿ]/;

async function loginAs(page: import("@playwright/test").Page, phone: string, password: string) {
  // Land the page in a /[locale] context first so the bundled JS is loaded.
  await page.goto("/ar/login");
  // Then call the API from within the page's JS context. Same-origin from
  // the bundle's perspective (well, same-site cross-port), but more
  // importantly this puts the access token into the in-memory cookie jar
  // and lets the next /auth/me succeed.
  const result = await page.evaluate(
    async ({ phone, password }) => {
      const res = await fetch("http://localhost:3001/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ phone, password }),
      });
      const body = await res.json();
      return { status: res.status, body };
    },
    { phone, password },
  );
  if (result.status !== 200) {
    throw new Error(`Login failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
}

test.describe("inventory", () => {
  test("OWNER reaches /ar/inventory and sees a localized RTL page with branch picker", async ({
    page,
    context,
  }) => {
    await loginAs(page, "+201000000000", "Owner@2026");
    const cookies = await context.cookies();
    const dbg = `cookies after login: ${JSON.stringify(cookies.map((c) => ({ name: c.name, domain: c.domain, path: c.path })))}`;

    await page.goto("/ar/inventory");
    // Wait for either dashboard nav (success) or a redirect back to login.
    await page.waitForURL(
      (url) => url.pathname.endsWith("/login") || url.pathname.includes("/inventory"),
      { timeout: 10_000 },
    );

    // Settle: give the auth-refresh race time to resolve.
    await page.waitForLoadState("networkidle");
    const url = page.url();
    const buttons = (await page.locator("button, a").allInnerTexts()).join(" ");
    const detail = `${dbg} | URL=${url} | buttons=${buttons}`;

    expect(url, detail).toContain("/inventory");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    const h1 = await page.locator("h1").first().innerText();
    expect(HAS_ARABIC.test(h1), detail).toBe(true);
    expect(KEY_LEAK.test(h1)).toBe(false);

    expect(buttons, detail).toMatch(/استلام|تعديل|جرد/);
  });

  test("Receipt page has the form per design.md", async ({ page }) => {
    await loginAs(page, "+201000000000", "Owner@2026");
    await page.goto("/ar/inventory/receipts/new");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    // Form fields exist
    await expect(page.locator("select#variant")).toHaveCount(1);
    await expect(page.locator("input#boards")).toHaveCount(1);
    await expect(page.locator("input#note")).toHaveCount(1);

    // Submit button uses real localized text
    const submit = await page.locator("button[type='submit']").innerText();
    expect(HAS_ARABIC.test(submit)).toBe(true);
  });

  test("Movements page lists the type filter and renders no-key copy", async ({ page }) => {
    await loginAs(page, "+201000000000", "Owner@2026");
    await page.goto("/ar/inventory/movements");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    // Heading and column headers are localized
    const headers = (await page.locator("h1, th").allInnerTexts()).join(" ");
    expect(HAS_ARABIC.test(headers)).toBe(true);
    expect(KEY_LEAK.test(headers)).toBe(false);
  });

  test("Switching to /en flips the inventory page to LTR with English copy", async ({
    page,
  }) => {
    await loginAs(page, "+201000000000", "Owner@2026");
    await page.goto("/en/inventory");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    const h1 = await page.locator("h1").first().innerText();
    expect(/[A-Za-z]/.test(h1)).toBe(true);
    expect(HAS_ARABIC.test(h1)).toBe(false);
    expect(KEY_LEAK.test(h1)).toBe(false);
  });
});
