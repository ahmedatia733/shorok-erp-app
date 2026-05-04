/**
 * Phase 5 / US3 — Expenses UI smoke (Playwright).
 *
 * The full-fidelity branch-scope/RBAC/correction logic lives in the
 * integration tests. This file proves the UI renders the expenses pages
 * in both locales with localized real text and no key leakage.
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
}

test.describe("expenses", () => {
  test("/ar/expenses renders RTL with localized headers and no key leak", async ({ page }) => {
    await loginAs(page, "+201000000000", "Owner@2026");
    await page.goto("/ar/expenses");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    const copy = (await page.locator("h1, h2, h3, label, button").allInnerTexts()).join(" ");
    expect(HAS_ARABIC.test(copy)).toBe(true);
    expect(KEY_LEAK.test(copy)).toBe(false);
  });

  test("/en/expenses/new shows the localized form fields", async ({ page }) => {
    await loginAs(page, "+201000000000", "Owner@2026");
    await page.goto("/en/expenses/new");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    await expect(page.locator("input#date")).toHaveCount(1);
    await expect(page.locator("input#description")).toHaveCount(1);
    await expect(page.locator("input#amount")).toHaveCount(1);
    await expect(page.locator("input#account")).toHaveCount(1);

    const labels = (await page.locator("label, h2, h3").allInnerTexts()).join(" ");
    expect(/Description|Amount|Paid from/i.test(labels)).toBe(true);
    expect(KEY_LEAK.test(labels)).toBe(false);
  });
});
