/**
 * T137 — Full app i18n + RTL/LTR sweep.
 *
 * Walks every authenticated page in both /ar and /en and checks:
 *   - <html dir> matches the locale (rtl for ar, ltr for en)
 *   - <html lang> matches the locale
 *   - the visible body has real localized text (Arabic glyphs in /ar,
 *     readable English in /en)
 *   - no translation key strings leak through (e.g. "settings.users.title")
 *
 * The list of routes is the canonical MVP set; if a new route ships,
 * add it here so this sweep keeps providing coverage.
 */
import { expect, test, type Page } from "@playwright/test";

const HAS_ARABIC = /[؀-ۿ]/;
// Match `something.someThing.foo` patterns that look like dot-namespaced
// translation keys. Excludes hostnames (the colon in "localhost:3001"
// stops the regex from matching them).
const KEY_LEAK = /\b[a-z][a-z0-9]+\.[a-z][a-zA-Z0-9_]+(?:\.[a-z][a-zA-Z0-9_]+)+\b/;

const ROUTES = [
  "/dashboard",
  "/orders",
  "/orders/new",
  "/inventory",
  "/inventory/movements",
  "/inventory/receipts/new",
  "/inventory/adjustments/new",
  "/inventory/counts/new",
  "/expenses",
  "/expenses/new",
  "/suppliers",
  "/suppliers/new",
  "/factory-orders",
  "/factory-orders/new",
  "/reports",
  "/audit",
  "/settings/users",
  "/settings/branches",
  "/settings/products",
  "/settings/system",
];

async function login(page: Page) {
  await page.goto("/ar/login");
  const result = await page.evaluate(async () => {
    const res = await fetch("http://localhost:3001/api/v1/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+201000000000", password: "Owner@2026" }),
    });
    return { status: res.status, body: await res.json() };
  });
  if (result.status !== 200) {
    throw new Error(`Login failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
}

test.describe("i18n + RTL/LTR sweep", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("every AR route renders RTL with real Arabic and no key leak", async ({ page }) => {
    for (const route of ROUTES) {
      await page.goto(`/ar${route}`);
      await page.waitForLoadState("domcontentloaded");
      await expect(page.locator("html"), `dir=rtl on /ar${route}`).toHaveAttribute(
        "dir",
        "rtl",
      );
      await expect(page.locator("html"), `lang=ar on /ar${route}`).toHaveAttribute(
        "lang",
        "ar",
      );
      const text = await page.locator("body").innerText();
      expect(HAS_ARABIC.test(text), `Arabic glyphs on /ar${route}`).toBe(true);
      expect(KEY_LEAK.test(text), `no key leak on /ar${route} (got: ${KEY_LEAK.exec(text)?.[0] ?? ""})`).toBe(false);
    }
  });

  test("every EN route renders LTR with English copy and no key leak", async ({ page }) => {
    for (const route of ROUTES) {
      await page.goto(`/en${route}`);
      await page.waitForLoadState("domcontentloaded");
      await expect(page.locator("html"), `dir=ltr on /en${route}`).toHaveAttribute(
        "dir",
        "ltr",
      );
      await expect(page.locator("html"), `lang=en on /en${route}`).toHaveAttribute(
        "lang",
        "en",
      );
      const text = await page.locator("body").innerText();
      expect(/[a-z]/i.test(text), `English chars on /en${route}`).toBe(true);
      expect(KEY_LEAK.test(text), `no key leak on /en${route} (got: ${KEY_LEAK.exec(text)?.[0] ?? ""})`).toBe(false);
    }
  });
});
