/**
 * Returns BROWSER coverage (§6/§5). Runs against the local test environment only
 * (web :3000 → API :3001 → TEST_DATABASE_URL). Requires the e2e fixture seed
 * (apps/api tests/e2e-returns-seed.ts → /tmp/shorok-e2e-fixture.json), which
 * creates 26 sales + 26 purchase invoices (so the oldest is OFF the first page),
 * pre-made returns for deep links, a legacy-ambiguous line, a draft return, and
 * three users: OWNER, ACCOUNTANT, BRANCH_MANAGER.
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const F = JSON.parse(readFileSync("/tmp/shorok-e2e-fixture.json", "utf8"));

async function login(page: Page, phone: string) {
  await page.goto("/ar/login");
  const res = await page.evaluate(
    async ({ phone, password }) => {
      const r = await fetch("http://localhost:3001/api/v1/auth/login", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ phone, password }),
      });
      return { status: r.status };
    },
    { phone, password: F.password },
  );
  if (res.status !== 200) throw new Error(`login failed ${res.status} for ${phone}`);
}

const searchAndPickSale = async (page: Page, number: string) => {
  await page.getByPlaceholder("رقم الفاتورة أو اسم العميل").fill(number);
  await page.getByRole("button", { name: "اختيار" }).first().click();
};

test.describe("returns — owner sales flow", () => {
  test.beforeEach(async ({ page }) => login(page, F.ownerPhone));

  test("1-6: search → draft (code/color/dims/effective-per-board) → edit (qty+reason+notes+line note) → confirm → Related Documents", async ({ page }) => {
    await page.goto("/ar/sales/returns/new");
    await searchAndPickSale(page, F.freshSaleOwnerNumber);

    // §3 historical snapshots on the create page.
    await expect(page.getByText("E2E-RED").first()).toBeVisible();
    await expect(page.getByText("أحمر").first()).toBeVisible();
    await expect(page.getByText("متر / لوح").first()).toBeVisible(); // whole-board size column
    await expect(page.getByText("عدد الألواح المرتجعة").first()).toBeVisible();
    // §9 refund options absent.
    const settlement = page.locator("select").first();
    await expect(settlement).toContainText("رصيد دائن للعميل");
    await expect(settlement).not.toContainText("رد نقدي");

    // Whole boards only — enter 1 board; metres are derived + read-only.
    await page.getByPlaceholder("0").first().fill("1");
    const metersCell = page.locator('[data-testid^="meters-"]').first();
    await expect(metersCell).toHaveText(/[0-9]/);          // derived metres shown
    await expect(metersCell.locator("input")).toHaveCount(0); // not editable
    await page.getByRole("button", { name: "حفظ كمسودة" }).click();
    await expect(page).toHaveURL(/\/sales\/returns\/[0-9a-f-]{36}/);

    // §3 edit: quantities + reason + notes + line note (boards input is numeric).
    await page.getByRole("button", { name: "تعديل" }).click();
    await page.locator('input[inputmode="numeric"]').first().fill("1");
    await page.getByLabel("السبب").fill("سبب تجريبي");
    await page.getByLabel("ملاحظات").fill("ملاحظة رأسية");
    await page.getByPlaceholder("اختياري").last().fill("ملاحظة سطر");
    await page.getByRole("button", { name: "حفظ التعديلات" }).click();
    await expect(page.getByText("ملاحظة رأسية")).toBeVisible({ timeout: 10000 });

    // §5 confirm.
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "تأكيد المردود" }).click();
    await expect(page.getByText("مؤكد").first()).toBeVisible();
    // §16 no draft editing after confirm.
    await expect(page.getByRole("button", { name: "تعديل" })).toHaveCount(0);

    // §6 Related Documents via the original-invoice link.
    await page.getByRole("link", { name: /عرض|[0-9]/ }).first().click();
    await expect(page).toHaveURL(/\/sales\/invoices\?open=/);
    await expect(page.getByText("المستندات المرتبطة — المردودات")).toBeVisible({ timeout: 15000 });
  });

  test("7: sales deep link OUTSIDE the first page — fetched, visible, expanded, Related Documents, survives refresh", async ({ page }) => {
    // Plain list shows only the newest 20 → the oldest (SI-1) is NOT present.
    await page.goto("/ar/sales/invoices");
    await expect(page.getByText("جارٍ التحميل", { exact: false })).toHaveCount(0, { timeout: 15000 }).catch(() => {});
    await expect(page.getByText(`SI-${F.oldSaleNumber}`, { exact: true })).toHaveCount(0);
    // Deep link → fetched + prepended + expanded + Related Documents visible.
    await page.goto(`/ar/sales/invoices?open=${F.oldSaleId}`);
    await expect(page.getByText(`SI-${F.oldSaleNumber}`, { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("المستندات المرتبطة — المردودات")).toBeVisible({ timeout: 15000 });
    // Refresh preserves the deep link.
    await page.reload();
    await expect(page.getByText("المستندات المرتبطة — المردودات")).toBeVisible({ timeout: 15000 });
  });

  test("7b: a missing/forbidden deep-link id shows the Arabic not-found notice", async ({ page }) => {
    await page.goto("/ar/sales/invoices?open=00000000-0000-0000-0000-000000000000");
    await expect(page.getByText("الفاتورة المطلوبة غير موجودة أو خارج صلاحيتك.")).toBeVisible({ timeout: 15000 });
  });

  test("8: legacy-ambiguous line is disabled with an Arabic explanation", async ({ page }) => {
    await page.goto("/ar/sales/returns/new");
    await searchAndPickSale(page, F.legacySaleNumber);
    await expect(page.getByText(/لا يمكن إرجاعه|غير قابل للتحديد/)).toBeVisible({ timeout: 10000 });
  });

  test("10: over-return shows an Arabic server error and creates no draft", async ({ page }) => {
    await page.goto("/ar/sales/returns/new");
    await searchAndPickSale(page, F.overReturnSaleNumber);
    await page.getByPlaceholder("0").first().fill("999");
    await page.getByRole("button", { name: "حفظ كمسودة" }).click();
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/\/sales\/returns\/new/);
  });
});

test.describe("returns — permissions (§11/§12)", () => {
  test("11: BRANCH_MANAGER views a draft but has NO edit/confirm/cancel, no create button, blocked new page", async ({ page }) => {
    await login(page, F.managerPhone);
    // Views a DRAFT return, but sees none of the mutation buttons.
    await page.goto(`/ar/sales/returns/${F.managerDraftReturnId}`);
    await expect(page.getByText("مسودة").first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "تعديل" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "تأكيد المردود" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "إلغاء المردود" })).toHaveCount(0);
    // No "new return" action on the list.
    await page.goto("/ar/sales/returns");
    await expect(page.getByRole("link", { name: "مردود جديد" })).toHaveCount(0);
    // The new page itself is blocked.
    await page.goto("/ar/sales/returns/new");
    await expect(page.getByText("غير مصرح لك بإنشاء مردود")).toBeVisible({ timeout: 10000 });
  });

  test("12: ACCOUNTANT can create/edit/confirm but has NO cancel button after confirm", async ({ page }) => {
    await login(page, F.accountantPhone);
    await page.goto("/ar/sales/returns/new");
    await searchAndPickSale(page, F.freshSaleAccountantNumber);
    await page.getByPlaceholder("0").first().fill("1");
    await page.getByRole("button", { name: "حفظ كمسودة" }).click();
    await expect(page).toHaveURL(/\/sales\/returns\/[0-9a-f-]{36}/);
    // Edit is allowed for the accountant.
    await page.getByRole("button", { name: "تعديل" }).click();
    await page.getByRole("button", { name: "إلغاء التعديل" }).click();
    // Confirm is allowed…
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "تأكيد المردود" }).click();
    await expect(page.getByText("مؤكد").first()).toBeVisible({ timeout: 10000 });
    // …but CANCEL is OWNER-only → absent for the accountant.
    await expect(page.getByRole("button", { name: "إلغاء المردود" })).toHaveCount(0);
  });
});

test.describe("returns — REAL foreign-branch deep links (§4)", () => {
  // A branch-B user deep-linking to an EXISTING branch-A invoice must see the
  // Arabic not-found/outside-permission notice and NO invoice data at all.
  test("4a: branch-B user cannot open an EXISTING branch-A SALES invoice", async ({ page }) => {
    await login(page, F.branchBPhone);
    await page.goto(`/ar/sales/invoices?open=${F.oldSaleId}`);
    await expect(page.getByText("الفاتورة المطلوبة غير موجودة أو خارج صلاحيتك.")).toBeVisible({ timeout: 15000 });
    // No leaked INVOICE identity, totals or related documents. (Customers are
    // global master data and legitimately appear in the page's filter dropdown,
    // so the invoice's own identity is what must be absent.)
    await expect(page.getByText(`SI-${F.oldSaleNumber}`, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("row", { name: new RegExp(`SI-${F.oldSaleNumber}\\b`) })).toHaveCount(0);
    await expect(page.getByText("المستندات المرتبطة — المردودات")).toHaveCount(0);
  });

  test("4b: branch-B user cannot open an EXISTING branch-A PURCHASE invoice", async ({ page }) => {
    await login(page, F.branchBPhone);
    await page.goto(`/ar/purchasing/invoices?open=${F.oldPurchaseId}`);
    await expect(page.getByText("فاتورة الشراء المطلوبة غير موجودة أو خارج صلاحيتك.")).toBeVisible({ timeout: 15000 });
    // The branch-A purchase invoice's own number must not appear anywhere.
    await expect(page.getByText("PINV-E2E-01", { exact: true })).toHaveCount(0);
    await expect(page.getByText("المستندات المرتبطة — المردودات")).toHaveCount(0);
  });
});

test.describe("returns — purchase UI permissions (§5)", () => {
  test("5a: BRANCH_MANAGER views a purchase draft with NO edit/confirm/cancel, no create, blocked new page", async ({ page }) => {
    await login(page, F.managerPhone);
    await page.goto(`/ar/purchasing/returns/${F.purchaseManagerDraftReturnId}`);
    await expect(page.getByText("مسودة").first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "تعديل" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "تأكيد المردود" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "إلغاء المردود" })).toHaveCount(0);
    await page.goto("/ar/purchasing/returns");
    await expect(page.getByRole("link", { name: "مردود جديد" })).toHaveCount(0);
    await page.goto("/ar/purchasing/returns/new");
    await expect(page.getByText("غير مصرح لك بإنشاء مردود")).toBeVisible({ timeout: 10000 });
  });

  test("5b: ACCOUNTANT can edit+confirm a purchase return but has NO cancel button", async ({ page }) => {
    await login(page, F.accountantPhone);
    await page.goto("/ar/purchasing/returns/new");
    await page.getByPlaceholder("رقم الفاتورة أو اسم المورد").fill(F.stockedPurchase2Number);
    await page.getByRole("button", { name: "اختيار" }).first().click();
    await page.getByPlaceholder("0").first().fill("1");
    await page.getByRole("button", { name: "حفظ كمسودة" }).click();
    await expect(page).toHaveURL(/\/purchasing\/returns\/[0-9a-f-]{36}/);
    await page.getByRole("button", { name: "تعديل" }).click();
    await page.getByRole("button", { name: "إلغاء التعديل" }).click();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "تأكيد المردود" }).click();
    await expect(page.getByText("مؤكد").first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "إلغاء المردود" })).toHaveCount(0);
  });
});

test.describe("returns — purchase flow (§13/§14/§15)", () => {
  test.beforeEach(async ({ page }) => login(page, F.ownerPhone));

  test("13: purchase search → draft → edit → confirm", async ({ page }) => {
    await page.goto("/ar/purchasing/returns/new");
    await page.getByPlaceholder("رقم الفاتورة أو اسم المورد").fill(F.stockedPurchaseNumber);
    await page.getByRole("button", { name: "اختيار" }).first().click();
    await expect(page.getByText("E2E-BLU").first()).toBeVisible();
    await page.getByPlaceholder("0").first().fill("1");
    await page.getByRole("button", { name: "حفظ كمسودة" }).click();
    await expect(page).toHaveURL(/\/purchasing\/returns\/[0-9a-f-]{36}/);
    await page.getByRole("button", { name: "تعديل" }).click();
    await page.locator('input[inputmode="numeric"]').first().fill("1");
    await page.getByRole("button", { name: "حفظ التعديلات" }).click();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "تأكيد المردود" }).click();
    await expect(page.getByText("مؤكد").first()).toBeVisible({ timeout: 10000 });
  });

  test("14+15: purchase deep link OUTSIDE the first page shows the invoice + its Related Documents", async ({ page }) => {
    await page.goto(`/ar/purchasing/invoices?open=${F.oldPurchaseId}`);
    await expect(page.getByText("المستندات المرتبطة — المردودات")).toBeVisible({ timeout: 15000 });
    await page.reload();
    await expect(page.getByText("المستندات المرتبطة — المردودات")).toBeVisible({ timeout: 15000 });
  });
});
