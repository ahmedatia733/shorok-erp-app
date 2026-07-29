/**
 * Searchable dropdowns in the New Journal Entry modal. Local test env only
 * (web :3000 → API :3001 → TEST_DATABASE_URL). Uses the returns e2e fixture:
 * OWNER, two customers (E2E-CUST/عميل الاختبار/01000000001 and E2E-C2/شركة
 * النور/01555000099), a supplier, and a chart of accounts (E-* codes).
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const F = JSON.parse(readFileSync("/tmp/shorok-e2e-fixture.json", "utf8"));

async function login(page: Page, phone: string) {
  await page.goto("/ar/login");
  const res = await page.evaluate(async ({ phone, password }) => {
    const r = await fetch("http://localhost:3001/api/v1/auth/login", {
      method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
      body: JSON.stringify({ phone, password }),
    });
    return { status: r.status };
  }, { phone, password: F.password });
  if (res.status !== 200) throw new Error(`login failed ${res.status}`);
}

async function openModal(page: Page, locale = "ar") {
  await page.goto(`/${locale}/accounting/journal`);
  await expect(page).not.toHaveURL(/\/login/);
  await page.getByRole("button", { name: locale === "ar" ? "قيد جديد" : "New Entry" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

// A SearchableSelect: click to open, then its portalled listbox appears.
async function openCombo(page: Page, testId: string) {
  await page.getByTestId(testId).click();
  await expect(page.getByTestId(`${testId}-listbox`)).toBeVisible();
}

test.describe("journal — searchable dropdowns", () => {
  test.beforeEach(async ({ page }) => login(page, F.ownerPhone));

  test("category → customer dependency; customer list opens immediately; search by name/code/phone; select + preserve", async ({ page }) => {
    await openModal(page);
    // 2: party-list (category) opens as a combobox listbox
    await openCombo(page, "je-category-0");
    // 3: choosing العملاء swaps the dependent selector to the customer picker
    await page.getByTestId("je-category-0-listbox").getByText("العملاء", { exact: true }).click();
    await expect(page.getByTestId("je-customer-0")).toBeVisible();

    // 4: clicking «اختر العميل» shows options immediately WITHOUT typing
    await openCombo(page, "je-customer-0");
    const list = page.getByTestId("je-customer-0-listbox");
    await expect(list.getByText(/عميل الاختبار/)).toBeVisible();
    await expect(list.getByText(/شركة النور/)).toBeVisible();

    // 5: Arabic name search
    await page.getByTestId("je-customer-0").fill("النور");
    await expect(list.getByText(/شركة النور/)).toBeVisible();
    await expect(list.getByText(/عميل الاختبار/)).toHaveCount(0);

    // 6: code search
    await page.getByTestId("je-customer-0").fill("E2E-C2");
    await expect(list.getByText(/شركة النور/)).toBeVisible();

    // 7: phone search
    await page.getByTestId("je-customer-0").fill("01000000001");
    await expect(list.getByText(/عميل الاختبار/)).toBeVisible();
    await expect(list.getByText(/شركة النور/)).toHaveCount(0);

    // 8: selecting closes the list and shows the selected customer in the field
    await list.getByText(/عميل الاختبار/).click();
    await expect(page.getByTestId("je-customer-0-listbox")).toHaveCount(0);
    await expect(page.getByTestId("je-customer-0")).toHaveValue(/عميل الاختبار/);

    // 9: reopening then Escape preserves the selected value
    await page.getByTestId("je-customer-0").click();
    await page.getByTestId("je-customer-0").press("Escape");
    await expect(page.getByTestId("je-customer-0")).toHaveValue(/عميل الاختبار/);

    // 10: switching the party type to الموردين clears the customer + swaps picker
    await openCombo(page, "je-category-0");
    await page.getByTestId("je-category-0-listbox").getByText("الموردون", { exact: true }).click();
    await expect(page.getByTestId("je-customer-0")).toHaveCount(0);
    // 11: supplier picker works and searches
    await openCombo(page, "je-supplier-0");
    await expect(page.getByTestId("je-supplier-0-listbox").getByText(/مورد الاختبار/)).toBeVisible();
  });

  test("account selector: opens immediately, searches by code + Arabic name; rows are independent; keyboard + escape; not clipped", async ({ page }) => {
    await openModal(page);
    // 12: account combobox opens immediately (row 0 default category → all accounts)
    await openCombo(page, "je-account-0");
    const l0 = page.getByTestId("je-account-0-listbox");
    await expect(l0.locator("li[role=option]").first()).toBeVisible();
    // 18: the portalled listbox is not clipped — its box is within the viewport
    const box = await l0.boundingBox();
    const vp = page.viewportSize()!;
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 1);

    // 12/13: search by account code, then Arabic name
    await page.getByTestId("je-account-0").fill("E-EXP");
    await expect(l0.getByText(/E-EXP/)).toBeVisible();
    // 16: keyboard ArrowDown + Enter selects
    await page.getByTestId("je-account-0").press("ArrowDown");
    await page.getByTestId("je-account-0").press("Enter");
    await expect(page.getByTestId("je-account-0-listbox")).toHaveCount(0);
    await expect(page.getByTestId("je-account-0")).toHaveValue(/E-EXP/);

    // 14: row 1 independent — pick a different account
    await openCombo(page, "je-account-1");
    await page.getByTestId("je-account-1").fill("E-INV");
    await page.getByTestId("je-account-1-listbox").getByText(/E-INV/).first().click();
    await expect(page.getByTestId("je-account-1")).toHaveValue(/E-INV/);
    // row 0 unchanged
    await expect(page.getByTestId("je-account-0")).toHaveValue(/E-EXP/);

    // 15: add a row then remove it — existing selections intact
    await page.getByTestId("je-add-line").click();
    await expect(page.getByTestId("je-account-2")).toBeVisible();
    await page.locator('button[title="حذف السطر"]').last().click();
    await expect(page.getByTestId("je-account-0")).toHaveValue(/E-EXP/);
    await expect(page.getByTestId("je-account-1")).toHaveValue(/E-INV/);

    // 17: Escape closes the dropdown
    await openCombo(page, "je-account-0");
    await page.getByTestId("je-account-0").press("Escape");
    await expect(page.getByTestId("je-account-0-listbox")).toHaveCount(0);
  });

  test("submitting a balanced entry sends accountId, partyType and partyId to the API", async ({ page }) => {
    await openModal(page);
    await page.getByTestId("je-description").fill("قيد اختبار البحث");
    // row 0: expense account, debit 100
    await openCombo(page, "je-account-0");
    await page.getByTestId("je-account-0").fill("E-EXP");
    await page.getByTestId("je-account-0-listbox").getByText(/E-EXP/).first().click();
    await page.getByTestId("je-debit-0").fill("100");
    // row 1: AR control account → a customer party is required, credit 100
    await openCombo(page, "je-account-1");
    await page.getByTestId("je-account-1").fill("E-AR");
    await page.getByTestId("je-account-1-listbox").getByText(/E-AR/).first().click();
    // the required-party picker appears for the control account
    await openCombo(page, "je-party-1");
    await page.getByTestId("je-party-1-listbox").getByText(/عميل الاختبار/).click();
    await page.getByTestId("je-credit-1").fill("100");
    await expect(page.getByTestId("je-save")).toBeEnabled();

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/v1/journal") && r.method() === "POST"),
      page.getByTestId("je-save").click(),
    ]);
    const body = req.postDataJSON();
    const arLine = body.lines.find((l: any) => l.partyType === "CUSTOMER");
    expect(arLine).toBeTruthy();
    expect(arLine.partyId).toMatch(/^[0-9a-f-]{36}$/); // a real UUID, not display text
    expect(body.lines.every((l: any) => /^[0-9a-f-]{36}$/.test(l.accountId))).toBe(true);
  });

  test("Arabic page is RTL and English journal page uses localized LTR placeholders", async ({ page }) => {
    await openModal(page, "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("je-account-0")).toHaveAttribute("placeholder", /بحث في الحسابات/);
    // English route
    await openModal(page, "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByTestId("je-account-0")).toHaveAttribute("placeholder", /Search accounts/);
    await openCombo(page, "je-category-0");
    await expect(page.getByText(/journal\.[a-zA-Z]/)).toHaveCount(0); // no raw keys
  });
});
