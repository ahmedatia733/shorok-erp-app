/**
 * T059 — Playwright RTL/LTR + no-key-leakage sweep.
 *
 * Loads the login screen in /ar and /en and asserts:
 *   - <html lang dir> matches the locale segment
 *   - Real Arabic characters render in /ar; real Latin letters render in /en
 *   - No translation keys ("auth.title", "errors.network_error", etc.)
 *     bleed through to the visible body text
 *   - The language switcher actually navigates between locales
 *   - The phone + password inputs are forced LTR even in RTL
 */
import { expect, test } from "@playwright/test";

const KEY_LEAK = /\b[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9_]*){1,}\b/;
// Arabic block U+0600..U+06FF
const HAS_ARABIC = /[؀-ۿ]/;
const HAS_LATIN_LETTER = /[A-Za-z]/;

test.describe("i18n + RTL/LTR rendering", () => {
  // Scope readability checks to actual page copy. The language switcher
  // intentionally shows "ع" / "EN" in both locales — those are navigation
  // affordances, not localized content.
  const READABLE = "h1, h2, p, label";

  test("Arabic login screen is RTL and shows real Arabic copy", async ({ page }) => {
    await page.goto("/ar/login");
    await expect(page).toHaveURL(/\/ar\/login/);

    const html = page.locator("html");
    await expect(html).toHaveAttribute("dir", "rtl");
    await expect(html).toHaveAttribute("lang", "ar");

    const copy = (await page.locator(READABLE).allInnerTexts()).join(" ");
    expect(HAS_ARABIC.test(copy)).toBe(true);
    expect(KEY_LEAK.test(copy)).toBe(false);

    // Phone/password inputs override dir to ltr regardless of locale
    await expect(page.locator("input#phone")).toHaveAttribute("dir", "ltr");
    await expect(page.locator("input#password")).toHaveAttribute("dir", "ltr");
  });

  test("English login screen is LTR and shows real English copy", async ({ page }) => {
    await page.goto("/en/login");
    await expect(page).toHaveURL(/\/en\/login/);

    const html = page.locator("html");
    await expect(html).toHaveAttribute("dir", "ltr");
    await expect(html).toHaveAttribute("lang", "en");

    const copy = (await page.locator(READABLE).allInnerTexts()).join(" ");
    expect(HAS_LATIN_LETTER.test(copy)).toBe(true);
    expect(HAS_ARABIC.test(copy)).toBe(false);
    expect(KEY_LEAK.test(copy)).toBe(false);
  });

  test("Language switcher navigates between locales", async ({ page }) => {
    await page.goto("/ar/login");
    await page.getByRole("button", { name: "EN" }).click();
    await expect(page).toHaveURL(/\/en\/login/);
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    await page.getByRole("button", { name: "ع" }).click();
    await expect(page).toHaveURL(/\/ar\/login/);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });

  // The full post-login flow (form submit → API → /dashboard redirect)
  // is intentionally NOT tested here. The /dashboard route ships with US1
  // (Phase 3) and that story owns the corresponding E2E. The auth API
  // contract is already covered by the integration tests in
  // apps/api/tests/integration/auth.spec.ts.
});
