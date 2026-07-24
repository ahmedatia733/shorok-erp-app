/**
 * Returns BROWSER coverage (§10). Runs against the local test environment only
 * (web :3000 → API :3001 → TEST_DATABASE_URL). Requires the e2e fixture seed
 * (apps/api tests/e2e-returns-seed.ts). Covers: confirmed-invoice search, draft
 * create with historical dimensions/code, draft edit, confirm, Related Documents
 * on the original invoice via the deep link, absence of refund options, and the
 * purchase-return flow.
 */
import { test, expect, type Page } from "@playwright/test";

const OWNER_PHONE = "+201555000099";
const OWNER_PASSWORD = "E2eOwner@2026";

async function login(page: Page) {
  await page.goto("/ar/login");
  const res = await page.evaluate(
    async ({ phone, password }) => {
      const r = await fetch("http://localhost:3001/api/v1/auth/login", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ phone, password }),
      });
      return { status: r.status };
    },
    { phone: OWNER_PHONE, password: OWNER_PASSWORD },
  );
  if (res.status !== 200) throw new Error(`login failed ${res.status}`);
}

test.describe("returns — browser", () => {
  test.beforeEach(async ({ page }) => login(page));

  test("sales return: search → create draft (historical code/dims) → edit → confirm → related docs", async ({ page }) => {
    await page.goto("/ar/sales/returns/new");
    // Search the confirmed invoice by exact number.
    await page.getByPlaceholder("رقم الفاتورة أو اسم العميل").fill("1");
    await page.getByRole("button", { name: "اختيار" }).first().click();

    // Historical snapshots visible: product code + color + original metres.
    await expect(page.getByText("E2E-RED").first()).toBeVisible();
    await expect(page.getByText("أحمر").first()).toBeVisible();

    // Refund settlement options must be ABSENT.
    const settlement = page.locator("select").first();
    await expect(settlement).toContainText("رصيد دائن للعميل");
    await expect(settlement).not.toContainText("رد نقدي");
    await expect(settlement).not.toContainText("رد بنكي");

    // Enter a partial return (4 m² / 1 board) and save the draft.
    await page.getByPlaceholder("0").first().fill("4");
    await page.getByPlaceholder("تلقائي").first().fill("1");
    await page.getByRole("button", { name: "حفظ كمسودة" }).click();

    // On the draft detail: edit → change to 8 m², save.
    await expect(page).toHaveURL(/\/sales\/returns\/[0-9a-f-]{36}/);
    await expect(page.getByText("مسودة").first()).toBeVisible();
    await page.getByRole("button", { name: "تعديل" }).click();
    const editMeters = page.getByRole("textbox").filter({ hasText: "" }); // fallback below
    // The edit table meters input is the one holding "4"; set it to 8.
    await page.locator('input[inputmode="decimal"]').first().fill("8");
    await page.getByRole("button", { name: "حفظ التعديلات" }).click();

    // Confirm the return (a confirm() dialog is auto-accepted).
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "تأكيد المردود" }).click();
    await expect(page.getByText("مؤكد").first()).toBeVisible();

    // Related Documents: follow the "original invoice" deep link → the invoice
    // expands and lists this return under Related Documents.
    await page.getByRole("link", { name: /1|عرض/ }).first().click();
    await expect(page).toHaveURL(/\/sales\/invoices\?open=/);
    await expect(page.getByText("المستندات المرتبطة — المردودات")).toBeVisible({ timeout: 15000 });
  });

  test("over-return is rejected with a server error surfaced in the UI", async ({ page }) => {
    await page.goto("/ar/sales/returns/new");
    await page.getByPlaceholder("رقم الفاتورة أو اسم العميل").fill("2");
    await page.getByRole("button", { name: "اختيار" }).first().click();
    await expect(page.getByText("E2E-RED").first()).toBeVisible();
    // Return more than the 20 m² available → the server rejects (over_return).
    await page.getByPlaceholder("0").first().fill("999");
    await page.getByPlaceholder("تلقائي").first().fill("1");
    await page.getByRole("button", { name: "حفظ كمسودة" }).click();
    // A localized (Arabic) server error is shown and we stay on /new (no draft).
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/\/sales\/returns\/new/);
  });

  test("purchase return: search a confirmed purchase invoice → create a draft", async ({ page }) => {
    await page.goto("/ar/purchasing/returns/new");
    await page.getByPlaceholder("رقم الفاتورة أو اسم المورد").fill("PINV-E2E-1");
    await page.getByRole("button", { name: "اختيار" }).first().click();
    await expect(page.getByText("E2E-BLU").first()).toBeVisible();
    // Supplier refund options absent.
    const settlement = page.locator("select").first();
    await expect(settlement).not.toContainText("استرداد نقدي");
    await page.getByPlaceholder("0").first().fill("4");
    await page.getByPlaceholder("تلقائي").first().fill("1");
    await page.getByRole("button", { name: "حفظ كمسودة" }).click();
    await expect(page).toHaveURL(/\/purchasing\/returns\/[0-9a-f-]{36}/);
    await expect(page.getByText("مسودة").first()).toBeVisible();
  });
});
