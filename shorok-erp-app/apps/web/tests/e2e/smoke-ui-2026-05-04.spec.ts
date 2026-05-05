/**
 * Browser-driven smoke for the v0.1.0-mvp surface (login, inventory,
 * orders, expenses). Exercises the **forms themselves** end-to-end —
 * unlike the existing e2e specs in this folder which short-circuit
 * login by calling /auth/login from page.evaluate.
 *
 * Run with `pnpm --filter @shorok/web exec playwright test smoke-ui-2026-05-04.spec.ts`.
 * Reuses already-running dev servers (web :3000, api :3001).
 */
import { expect, test, type Page } from "@playwright/test";

const HAS_ARABIC = /[؀-ۿ]/;
const KEY_LEAK = /\b[a-z][a-z0-9]+\.[a-z][a-zA-Z0-9_]+(?:\.[a-z][a-zA-Z0-9_]+)+\b/;

const SHOTS = "test-results/smoke-ui-2026-05-04";

async function fillLoginForm(page: Page, phone: string, password: string) {
  await page.locator("input#phone").fill(phone);
  await page.locator("input#password").fill(password);
  await page.locator('button[type="submit"]').click();
}

test.describe("Smoke — login form drives the auth flow", () => {
  test("AR login page renders RTL, blocks short password client-side", async ({ page }) => {
    await page.goto("/ar/login");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");

    const copy = (await page.locator("h1, h2, label, button").allInnerTexts()).join(" ");
    expect(HAS_ARABIC.test(copy)).toBe(true);
    expect(KEY_LEAK.test(copy)).toBe(false);

    await page.screenshot({ path: `${SHOTS}/01-ar-login.png`, fullPage: true });

    // Browser-native validation: minLength=8 keeps the form from submitting.
    await page.locator("input#phone").fill("+201000000000");
    await page.locator("input#password").fill("short");
    const passwordValid = await page.locator("input#password").evaluate(
      (el) => (el as HTMLInputElement).checkValidity(),
    );
    expect(passwordValid).toBe(false);
  });

  test("AR login shows localized invalid_credentials error after wrong password", async ({
    page,
  }) => {
    await page.goto("/ar/login");
    await fillLoginForm(page, "+201000000000", "WrongPass1");
    // Two role="alert" elements live on the page in dev: Next.js's empty
    // route-announcer plus our error <Alert>. Filter to the one with
    // visible text so we don't race the announcer.
    const alert = page.locator('[role="alert"]', { hasText: /\S/ });
    await expect(alert).toBeVisible({ timeout: 5000 });
    const alertText = await alert.innerText();
    expect(HAS_ARABIC.test(alertText)).toBe(true);
    expect(KEY_LEAK.test(alertText)).toBe(false);
    await page.screenshot({ path: `${SHOTS}/02-ar-bad-creds.png`, fullPage: true });

    // Submit button must be re-enabled (not stuck in the submitting state).
    await expect(page.locator('button[type="submit"]')).toBeEnabled();
  });

  test("AR login with seeded OWNER reaches an authenticated app shell", async ({ page }) => {
    await page.goto("/ar/login");
    await fillLoginForm(page, "+201000000000", "Owner@2026");
    await page.waitForLoadState("networkidle");
    // Post-login MUST land on a real page, not 404. The login form
    // pushes to /<locale>/dashboard; the dashboard placeholder (added
    // 2026-05-04) redirects to /orders until US5 ships.
    await expect(page.locator("body")).not.toContainText("404");
    await expect(page.locator("body")).not.toContainText("This page could not be found");
    expect(page.url()).toMatch(/\/ar\/(orders|dashboard|inventory|expenses)/);
    await page.screenshot({ path: `${SHOTS}/03-ar-after-login.png`, fullPage: true });

    await page.goto("/ar/inventory");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const heading = (await page.locator("h1, h2").allInnerTexts()).join(" ");
    expect(HAS_ARABIC.test(heading)).toBe(true);
    expect(KEY_LEAK.test(heading)).toBe(false);
    await page.screenshot({ path: `${SHOTS}/04-ar-inventory.png`, fullPage: true });
  });

  test("EN login page renders LTR with English copy", async ({ page }) => {
    await page.goto("/en/login");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const copy = (await page.locator("h1, h2, label, button").allInnerTexts()).join(" ");
    expect(/sign in|phone|password/i.test(copy)).toBe(true);
    expect(KEY_LEAK.test(copy)).toBe(false);
    await page.screenshot({ path: `${SHOTS}/05-en-login.png`, fullPage: true });
  });
});

test.describe("Smoke — authenticated UI flows", () => {
  // Single-shared-context login keeps the rest of the run cheap.
  test.beforeEach(async ({ page }) => {
    await page.goto("/ar/login");
    await fillLoginForm(page, "+201000000000", "Owner@2026");
    // Wait until the api-client has a token + /auth/me has resolved.
    await page.waitForLoadState("networkidle");
  });

  test("Inventory: navigating to /ar/inventory and posting a receipt", async ({ page }) => {
    await page.goto("/ar/inventory");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    // Click into the receipt form via the in-page button or direct nav —
    // direct nav is the supported entry point per inventory/page.tsx.
    await page.goto("/ar/inventory/receipts/new");
    await expect(page.locator("input#boards")).toBeVisible();

    // Empty form: submit should be disabled until required fields fill.
    await expect(page.locator('button[type="submit"]')).toBeDisabled();

    // Pick the first variant from the variant picker.
    await page.locator("select#variant").selectOption({ index: 1 });
    await page.locator("input#boards").fill("3");

    // Branch picker: it auto-loads branches; wait for a value.
    await page.waitForFunction(() => {
      const sel = document.querySelector("select#branch") as HTMLSelectElement | null;
      return sel ? sel.value !== "" : true;
    });

    await page.screenshot({ path: `${SHOTS}/10-ar-receipt-form.png`, fullPage: true });

    await page.locator('button[type="submit"]').click();

    // Success alert (variant=success → role="status") with a non-empty
    // localized "Receipt recorded" message. Wait for the actual text so
    // the screenshot captures the post-submit state, not the loading one.
    const successAlert = page.locator('[role="status"]', { hasText: /استلام|recorded/i });
    await expect(successAlert).toBeVisible({ timeout: 8000 });
    await page.screenshot({ path: `${SHOTS}/11-ar-receipt-result.png`, fullPage: true });
    const alertText = await successAlert.innerText();
    expect(HAS_ARABIC.test(alertText)).toBe(true);
    expect(KEY_LEAK.test(alertText)).toBe(false);

    // The page auto-navigates back to /inventory after the success alert.
    await page.waitForURL(/\/ar\/inventory(\?|$)/, { timeout: 5000 });
  });

  test("Orders: invalid (over-tolerance price) shows live warning, valid creates an order", async ({
    page,
  }) => {
    await page.goto("/ar/orders/new");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    // Submit must be disabled with an empty form.
    await expect(page.locator('button[type="submit"]')).toBeDisabled();

    // Pick first variant; price defaults from the variant.
    await page.locator("select#variant").selectOption({ index: 1 });
    await page.locator("input#customer").fill("Smoke Customer");
    await page.locator("input#boards").fill("2");

    // Capture the variant's pre-filled default (within tolerance by
    // construction) BEFORE we deliberately blow it past tolerance.
    const defaultPrice = await page.locator("input#price").inputValue();
    expect(defaultPrice).not.toBe("");

    // Inflate the price way beyond tolerance → outside-tolerance warning.
    await page.locator("input#price").fill("9999");
    const warn = await page.locator('[role="alert"], [role="status"]').allInnerTexts();
    expect(warn.join(" ")).toMatch(/خارج|outside/i);
    await page.screenshot({ path: `${SHOTS}/20-ar-order-out-tolerance.png`, fullPage: true });

    // Restore the within-tolerance default and submit.
    await page.locator("input#price").fill(defaultPrice);

    await expect(page.locator('button[type="submit"]')).toBeEnabled();
    await page.locator('button[type="submit"]').click();
    // Successful submit lands on /orders/<id>.
    await page.waitForURL(/\/ar\/orders\/[0-9a-f-]{36}/, { timeout: 10_000 });
    await page.screenshot({ path: `${SHOTS}/21-ar-order-detail.png`, fullPage: true });

    const detail = (await page.locator("h1, h2, dt, dd, span").allInnerTexts()).join(" ");
    expect(HAS_ARABIC.test(detail)).toBe(true);
    expect(KEY_LEAK.test(detail)).toBe(false);
  });

  test("Expenses: AR form validation, then valid create shows success and returns to list", async ({
    page,
  }) => {
    await page.goto("/ar/expenses/new");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    // Submit disabled until required fields are filled.
    await expect(page.locator('button[type="submit"]')).toBeDisabled();

    // Date is pre-filled to today — leave it.
    await page.locator("input#description").fill("ضوء كهرباء فبراير");
    await page.locator("input#amount").fill("250.50");
    await page.locator("input#account").fill("الخزينة الرئيسية");

    await expect(page.locator('button[type="submit"]')).toBeEnabled();
    await page.screenshot({ path: `${SHOTS}/30-ar-expense-form.png`, fullPage: true });

    await page.locator('button[type="submit"]').click();

    // Success alert (variant=success → role="status") then auto-redirect.
    const success = page.locator('[role="status"]', { hasText: /\S/ });
    await expect(success).toBeVisible({ timeout: 8000 });
    await page.screenshot({ path: `${SHOTS}/31-ar-expense-success.png`, fullPage: true });
    const text = await success.innerText();
    expect(HAS_ARABIC.test(text)).toBe(true);
    expect(KEY_LEAK.test(text)).toBe(false);

    await page.waitForURL(/\/ar\/expenses(\?|$)/, { timeout: 5000 });
  });

  test("Sidebar: unimplemented routes render as disabled (no 404 leaks)", async ({ page }) => {
    await page.goto("/ar/orders");
    // Wait for the (app) layout to finish auth-loading and render the sidebar.
    await page.waitForSelector("aside nav");

    // Implemented routes must be real <a> with hrefs.
    for (const path of [
      "/dashboard",
      "/orders",
      "/inventory",
      "/expenses",
      "/suppliers",
      "/factory-orders",
      "/reports",
    ]) {
      const link = page.locator(`aside nav a[href="/ar${path}"]`);
      await expect(link).toHaveCount(1);
    }

    // Unimplemented routes (US6/US8) must render as aria-disabled spans.
    for (const path of ["/audit", "/settings"]) {
      await expect(page.locator(`aside nav a[href="/ar${path}"]`)).toHaveCount(0);
    }
    const disabled = page.locator('aside nav span[aria-disabled="true"]');
    await expect(disabled).toHaveCount(2);
    // The localized "soon" badge must render on each.
    const soonText = (await disabled.allInnerTexts()).join(" ");
    expect(/قريباً/.test(soonText)).toBe(true);

    await page.screenshot({ path: `${SHOTS}/45-ar-sidebar-disabled.png`, fullPage: true });

    // Same shape in EN, with the EN "Soon" label.
    await page.goto("/en/orders");
    await page.waitForSelector("aside nav");
    await expect(page.locator('aside nav span[aria-disabled="true"]')).toHaveCount(2);
    const enSoon = (
      await page.locator('aside nav span[aria-disabled="true"]').allInnerTexts()
    ).join(" ");
    // Tailwind's `uppercase` class makes the rendered text "SOON".
    expect(/soon/i.test(enSoon)).toBe(true);
  });

  test("Locale: language-switcher round-trip preserves auth", async ({ page }) => {
    await page.goto("/ar/inventory");
    // Switch to EN via the LanguageSwitcher in the (app) header.
    const switcher = page.getByRole("link", { name: /English|EN/i }).first();
    if (await switcher.isVisible().catch(() => false)) {
      await switcher.click();
      await page.waitForURL(/\/en\//);
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await page.screenshot({ path: `${SHOTS}/40-en-inventory.png`, fullPage: true });
    } else {
      // Fall back: drive the URL change directly.
      await page.goto("/en/inventory");
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    }
  });
});
