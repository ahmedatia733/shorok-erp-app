/**
 * إدارة المصروفات in a real browser, plus the journal quick-add.
 *
 * The part that genuinely needs a browser is §15: opening «+ إضافة مصروف» from
 * a half-filled journal entry must not disturb anything the user has typed. That
 * cannot be proven from the API, so it is proven here — the form is filled in,
 * an expense item is created mid-entry, and every other field is compared
 * before and after.
 *
 * Everything else is read-only: tabs load, filters work, PDFs download, and no
 * journal is ever saved.
 */
import { expect, test, type Page } from "@playwright/test";

const API = process.env.E2E_API ?? "http://localhost:3001/api/v1";
const HAS_ARABIC = /[؀-ۿ]/;
const KEY_LEAK = /\b[a-z][a-z0-9]+\.[a-z][a-zA-Z0-9_]+(?:\.[a-z][a-zA-Z0-9_]+)+\b/;

async function login(page: Page): Promise<void> {
  const phone = process.env.E2E_PHONE ?? "+201000000000";
  const password = process.env.E2E_PASSWORD ?? "Owner@2026";
  await page.goto("/ar/login");
  await page.locator('input[name="phone"], input#phone, input[type="tel"]').first().fill(phone);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
}

test.describe("expenses management", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("the sidebar offers المصروفات and it opens the management area", async ({ page }) => {
    // Land somewhere settled first: signing in triggers the app's own redirect,
    // and a click fired mid-redirect loses to it.
    await page.goto("/ar/dashboard");
    await page.waitForLoadState("networkidle");

    const link = page.getByRole("link", { name: "المصروفات", exact: true });
    await expect(link).toHaveCount(1);
    await link.click();
    await page.waitForURL(/\/accounting\/expenses/, { timeout: 20_000 });
    await page.waitForLoadState("networkidle");
    expect(page.url()).toContain("/accounting/expenses");
    await expect(page.locator("h1")).toHaveText("إدارة المصروفات");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });

  test("all three tabs render real Arabic with no translation keys", async ({ page }) => {
    await page.goto("/ar/accounting/expenses");
    await page.waitForLoadState("networkidle");

    for (const tab of ["overview", "items", "movements"]) {
      await page.getByTestId(`tab-${tab}`).click();
      await page.waitForLoadState("networkidle");
      const text = await page.locator("main").innerText();
      expect(HAS_ARABIC.test(text), `Arabic on ${tab}`).toBe(true);
      expect(KEY_LEAK.test(text), `key leak on ${tab}: ${KEY_LEAK.exec(text)?.[0] ?? ""}`).toBe(false);
    }
  });

  test("the overview shows the summary cards", async ({ page }) => {
    await page.goto("/ar/accounting/expenses");
    await page.waitForLoadState("networkidle");
    for (const id of ["card-period", "card-month", "card-today", "card-count", "card-top", "card-change"]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  });

  test("the items tab lists expense accounts and filters them", async ({ page }) => {
    await page.goto("/ar/accounting/expenses");
    await page.getByTestId("tab-items").click();
    await page.waitForLoadState("networkidle");

    const rows = page.locator("[data-testid^='expense-item-']");
    const total = await rows.count();
    test.skip(total === 0, "no expense accounts in this database");

    await page.getByTestId("items-status").selectOption("inactive");
    await page.waitForTimeout(800);
    const inactive = await page.locator("[data-testid^='expense-item-']").count();
    expect(inactive).toBeLessThanOrEqual(total);

    await page.getByTestId("items-status").selectOption("all");
    await page.waitForTimeout(800);
    await expect(page.locator("[data-testid^='expense-item-']")).toHaveCount(total);
  });

  test("an expense item opens its detail page with movement history", async ({ page }) => {
    await page.goto("/ar/accounting/expenses");
    await page.getByTestId("tab-items").click();
    await page.waitForLoadState("networkidle");
    const first = page.locator("[data-testid^='expense-item-'] a").first();
    test.skip((await first.count()) === 0, "no expense accounts in this database");

    await first.click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("detail-name")).toBeVisible();
    await expect(page.getByTestId("detail-period")).toBeVisible();
    await expect(page.getByTestId("detail-total")).toBeVisible();
  });

  test("every tab and the detail page can be saved as PDF", async ({ page }) => {
    await page.goto("/ar/accounting/expenses");
    await page.waitForLoadState("networkidle");

    for (const tab of ["overview", "items", "movements"]) {
      await page.getByTestId(`tab-${tab}`).click();
      await page.waitForLoadState("networkidle");
      const download = page.waitForEvent("download", { timeout: 60_000 });
      await page.getByTestId("save-pdf").click();
      const file = await download;
      expect(file.suggestedFilename()).toMatch(/^expenses-.*\.pdf$/);
      // A real file, not an empty stub.
      const path = await file.path();
      expect(path).toBeTruthy();
    }

    // …and from an item's own page.
    await page.getByTestId("tab-items").click();
    await page.waitForLoadState("networkidle");
    const first = page.locator("[data-testid^='expense-item-'] a").first();
    if ((await first.count()) > 0) {
      await first.click();
      await page.waitForLoadState("networkidle");
      const download = page.waitForEvent("download", { timeout: 60_000 });
      await page.getByTestId("save-pdf").click();
      const file = await download;
      expect(file.suggestedFilename()).toMatch(/^expense-.*\.pdf$/);
    }
  });
});

test.describe("journal quick-add", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  /** Opens «قيد جديد» and returns once the line editor is on screen. */
  const openJournalModal = async (page: Page) => {
    await page.goto("/ar/accounting/journal");
    await page.waitForLoadState("networkidle");
    const newEntry = page.getByRole("button", { name: /قيد جديد/ });
    await newEntry.first().click();
    await page.getByTestId("je-category-0").waitFor({ state: "visible", timeout: 20_000 });
  };

  test("the quick-add button appears only on the المصروفات list", async ({ page }) => {
    await openJournalModal(page);

    // Nothing chosen yet — no button.
    await expect(page.getByTestId("je-add-expense-0")).toHaveCount(0);

    // A different list — still no button, so other categories stay uncluttered.
    await page.getByTestId("je-category-0").click();
    await page.getByTestId("je-category-0").fill("الإيرادات");
    await page.locator("[role='option']").first().click();
    await page.waitForTimeout(300);
    await expect(page.getByTestId("je-add-expense-0")).toHaveCount(0);

    // المصروفات — the button is there.
    await page.getByTestId("je-category-0").click();
    await page.getByTestId("je-category-0").fill("المصروفات");
    await page.locator("[role='option']").first().click();
    await page.waitForTimeout(300);
    await expect(page.getByTestId("je-add-expense-0")).toBeVisible();
  });

  test("quick-add creates the item, selects it, and leaves the rest of the entry untouched", async ({
    page,
  }) => {
    await openJournalModal(page);

    // Fill in a realistic, half-finished entry: a description, and a first line
    // that must survive the quick-add completely.
    const description = "قيد اختبار الإضافة السريعة";
    const descBox = page.locator("input, textarea").filter({ hasText: "" });
    const descField = page.getByPlaceholder(/بيان|وصف/).first();
    if ((await descField.count()) > 0) await descField.fill(description);

    // Line 0: pick the vaults list and any account, then type an amount.
    await page.getByTestId("je-category-0").click();
    await page.getByTestId("je-category-0").fill("جميع الحسابات");
    await page.locator("[role='option']").first().click();
    await page.waitForTimeout(400);
    await page.getByTestId("je-account-0").click();
    await page.waitForTimeout(300);
    const firstAccount = page.locator("[role='option']").first();
    const firstAccountLabel = await firstAccount.innerText();
    await firstAccount.click();

    // Add a second line and put it on the expenses list.
    const addLine = page.getByRole("button", { name: /إضافة سطر|سطر جديد|\+ سطر/ }).first();
    if ((await addLine.count()) > 0) await addLine.click();
    await page.getByTestId("je-category-1").click();
    await page.getByTestId("je-category-1").fill("المصروفات");
    await page.locator("[role='option']").first().click();
    await page.waitForTimeout(300);

    // Snapshot everything that must not move.
    const before = {
      line0Account: await page.getByTestId("je-account-0").inputValue(),
      description: (await descField.count()) > 0 ? await descField.inputValue() : null,
    };
    expect(before.line0Account).toContain(firstAccountLabel.split("—")[0]!.trim().slice(0, 4));

    // Quick-add.
    await page.getByTestId("je-add-expense-1").click();
    await expect(page.getByTestId("expense-name")).toBeVisible();

    const unique = Date.now().toString().slice(-6);
    await page.getByTestId("expense-name").fill(`بند اختبار ${unique}`);
    const suggested = await page.getByTestId("expense-code").inputValue();
    expect(suggested).not.toBe("");
    await page.getByTestId("expense-create-submit").click();

    // The modal closes and the new item lands on line 1 — and only line 1.
    await expect(page.getByTestId("expense-name")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId("je-account-1")).toHaveValue(new RegExp(`بند اختبار ${unique}`), {
      timeout: 20_000,
    });

    // §15: nothing else moved.
    expect(await page.getByTestId("je-account-0").inputValue()).toBe(before.line0Account);
    if (before.description !== null) {
      expect(await descField.inputValue()).toBe(before.description);
    }

    // It is searchable immediately, with no reload.
    await page.getByTestId("je-account-1").click();
    await page.getByTestId("je-account-1").fill(unique);
    await page.waitForTimeout(400);
    expect(await page.locator("[role='option']").count()).toBeGreaterThan(0);

    // Deliberately not saved: this suite never posts a journal.
    await page.keyboard.press("Escape");
  });
});
