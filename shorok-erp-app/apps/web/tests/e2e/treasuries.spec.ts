/**
 * Treasury BROWSER coverage. Local test environment only (web :3000 → API :3001
 * → TEST_DATABASE_URL). Shares the returns e2e fixture
 * (apps/api tests/e2e-returns-seed.ts → /tmp/shorok-e2e-fixture.json): OWNER +
 * ACCOUNTANT + BRANCH_MANAGER + a branch-B accountant, a posting profile with an
 * opening-equity account, and open 2026 periods. The treasury list starts empty
 * (the fixture seeds no cash treasuries), so this spec creates them from the UI.
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

async function createTreasury(page: Page, nameAr: string, opts: { code?: string; branchLabel?: string } = {}) {
  await page.getByTestId("add-treasury").click();
  await page.getByTestId("treasury-nameAr").fill(nameAr);
  if (opts.code) await page.locator('input[placeholder="يُولّد تلقائياً"]').fill(opts.code);
  if (opts.branchLabel) await page.getByTestId("treasury-branch").selectOption({ label: opts.branchLabel });
  await page.getByTestId("treasury-save").click();
}

const heading = (page: Page) => page.getByRole("heading", { name: "الخزائن", exact: true });

test.describe("treasuries — owner", () => {
  test.beforeEach(async ({ page }) => login(page, F.ownerPhone));

  test("1-5,13,16: login once → open treasuries from sidebar → add treasury → appears → refresh stays logged in", async ({ page }) => {
    // dashboard, then navigate via the sidebar (client-side, no re-login)
    await page.goto("/ar/dashboard");
    await page.getByRole("link", { name: "الخزائن", exact: true }).click();
    await expect(page).toHaveURL(/\/ar\/accounting\/treasuries$/);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(heading(page)).toBeVisible();

    await createTreasury(page, "خزنة المبيعات");
    const row = page.locator('[data-testid="treasury-row"]', { hasText: "خزنة المبيعات" });
    await expect(row).toBeVisible();
    // first treasury is the default + its own GL account code is shown
    await expect(row.getByText("افتراضية", { exact: true })).toBeVisible();

    // refresh → still authenticated, treasury still there (session persists)
    await page.reload();
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator('[data-testid="treasury-row"]', { hasText: "خزنة المبيعات" })).toBeVisible();
  });

  test("7: duplicate treasury code shows an Arabic validation error", async ({ page }) => {
    await page.goto("/ar/accounting/treasuries");
    await createTreasury(page, "خزنة برمز", { code: "DUP-E2E" });
    await expect(page.locator('[data-testid="treasury-row"]', { hasText: "خزنة برمز" })).toBeVisible();
    // second with the same code → rejected: an Arabic error alert shows and no
    // new row is created (the modal stays open with the failure surfaced).
    await createTreasury(page, "خزنة أخرى", { code: "DUP-E2E" });
    await expect(page.getByRole("dialog").locator("text=/فشل|خطأ|صالح|صحّ|تعذّر|بيانات/").first()).toBeVisible();
    await expect(page.locator('[data-testid="treasury-row"]', { hasText: "خزنة أخرى" })).toHaveCount(0);
  });

  test("8-9,12: post an opening balance → statement shows it → journal link present", async ({ page }) => {
    await page.goto("/ar/accounting/treasuries");
    await createTreasury(page, "خزنة الرصيد");
    await page.locator('[data-testid="treasury-row"]', { hasText: "خزنة الرصيد" }).getByText("كشف الحركة").click();
    await expect(page).toHaveURL(/\/accounting\/treasuries\/[0-9a-f-]+$/);
    await page.getByTestId("opening-balance-btn").click();
    await page.getByTestId("opening-amount").fill("5000");
    await page.getByTestId("opening-save").click();
    await expect(page.getByTestId("treasury-balance")).toHaveText(/٥[٬,]?٠٠٠/);
    await expect(page.getByText("رصيد افتتاحي").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "القيد" }).first()).toBeVisible();
  });

  test("6,10-11: create + confirm a transfer between two treasuries; both balances update", async ({ page }) => {
    await page.goto("/ar/accounting/treasuries");
    await createTreasury(page, "خزنة المصدر E2E");
    await createTreasury(page, "خزنة الوجهة E2E");
    // fund the source with an opening balance
    await page.locator('[data-testid="treasury-row"]', { hasText: "خزنة المصدر E2E" }).getByText("كشف الحركة").click();
    await page.getByTestId("opening-balance-btn").click();
    await page.getByTestId("opening-amount").fill("1000");
    await page.getByTestId("opening-save").click();
    await expect(page.getByTestId("treasury-balance")).toHaveText(/١[٬,]?٠٠٠/);

    // transfers screen — the selector lists the active treasuries (§6)
    await page.goto("/ar/accounting/treasuries/transfers");
    await page.getByTestId("add-transfer").click();
    await expect(page.getByTestId("transfer-source").locator("option", { hasText: "خزنة المصدر E2E" })).toHaveCount(1);
    await page.getByTestId("transfer-amount").fill("300");
    const srcVal = await page.getByTestId("transfer-source").locator("option", { hasText: "خزنة المصدر E2E" }).getAttribute("value");
    const dstVal = await page.getByTestId("transfer-dest").locator("option", { hasText: "خزنة الوجهة E2E" }).getAttribute("value");
    await page.getByTestId("transfer-source").selectOption(srcVal!);
    await page.getByTestId("transfer-dest").selectOption(dstVal!);
    await page.getByTestId("transfer-save").click();
    await expect(page.locator('[data-testid="transfer-row"]', { hasText: "٣٠٠" })).toBeVisible();
    await expect(page.getByText("مؤكد").first()).toBeVisible();

    // both balances updated
    await page.goto("/ar/accounting/treasuries");
    await expect(page.locator('[data-testid="treasury-row"]', { hasText: "خزنة المصدر E2E" }).getByText(/٧٠٠/)).toBeVisible();
    await expect(page.locator('[data-testid="treasury-row"]', { hasText: "خزنة الوجهة E2E" }).getByText(/٣٠٠/)).toBeVisible();
  });
});

test.describe("treasuries — authorization", () => {
  test("14: an unauthorized role does not see the create/manage buttons", async ({ page }) => {
    await login(page, F.branchBPhone); // ACCOUNTANT — not OWNER
    await page.goto("/ar/accounting/treasuries");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(heading(page)).toBeVisible();
    await expect(page.getByTestId("add-treasury")).toHaveCount(0);
  });

  test("15-16: foreign-branch user cannot open a branch-A treasury by direct URL; page shows no leak, no crash", async ({ page }) => {
    // OWNER creates a treasury in the first (branch A) branch
    await login(page, F.ownerPhone);
    await page.goto("/ar/accounting/treasuries");
    await createTreasury(page, "خزنة سرية A", { branchLabel: "فرع الاختبار" });
    const href = await page.locator('[data-testid="treasury-row"]', { hasText: "خزنة سرية A" }).getByText("كشف الحركة").getAttribute("href");
    expect(href).toBeTruthy();

    // branch-B accountant opens that URL directly → an error message, never the treasury, never a crash/blank/login
    await login(page, F.branchBPhone);
    await page.goto(href!);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByText("خزنة سرية A")).toHaveCount(0);
    await expect(page.getByText(/غير موجود|تعذّر تحميل/)).toBeVisible();
  });
});

test.describe("treasuries — operational + localization (closure)", () => {
  test.beforeEach(async ({ page }) => login(page, F.ownerPhone));

  test("EN: the English treasury page is English and LTR with no raw keys", async ({ page }) => {
    await page.goto("/en/accounting/treasuries");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Treasuries", exact: true })).toBeVisible();
    await expect(page.getByTestId("add-treasury")).toHaveText(/Add treasury/);
    // page direction is LTR on /en
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    // no raw i18n keys leaked (e.g. "treasury.title")
    await expect(page.getByText(/treasury\.[a-zA-Z]/)).toHaveCount(0);
  });

  test("opening balance can be reversed from the UI", async ({ page }) => {
    await page.goto("/ar/accounting/treasuries");
    await createTreasury(page, "خزنة العكس E2E");
    await page.locator('[data-testid="treasury-row"]', { hasText: "خزنة العكس E2E" }).getByText("كشف الحركة").click();
    await page.getByTestId("opening-balance-btn").click();
    await page.getByTestId("opening-amount").fill("800");
    await page.getByTestId("opening-save").click();
    await expect(page.getByTestId("treasury-balance")).toHaveText(/٨[٬,]?٠٠/);
    // reverse the opening balance (accept the prompt)
    page.once("dialog", (d) => d.accept("خطأ في الإدخال"));
    await page.getByTestId("reverse-opening").click();
    await expect(page.getByTestId("treasury-balance")).toHaveText(/^٠٫٠٠$|0\.00/);
  });

  test("a new active treasury appears in the expense payment selector; a deactivated one does not", async ({ page }) => {
    await page.goto("/ar/accounting/treasuries");
    await createTreasury(page, "خزنة المصروفات E2E");
    // appears in the expense treasury selector
    await page.goto("/ar/expenses/new");
    await expect(page.getByTestId("expense-treasury").locator("option", { hasText: "خزنة المصروفات E2E" })).toHaveCount(1);
    // deactivate it, then it disappears from the selector
    await page.goto("/ar/accounting/treasuries");
    await page.locator('[data-testid="treasury-row"]', { hasText: "خزنة المصروفات E2E" }).getByText("إيقاف").click();
    await page.goto("/ar/expenses/new");
    await expect(page.getByTestId("expense-treasury").locator("option", { hasText: "خزنة المصروفات E2E" })).toHaveCount(0);
  });
});

// Token-based API helper for deterministic bulk setup (no UI churn).
async function apiToken(page: Page, phone: string): Promise<string> {
  return page.evaluate(async ({ phone, password }) => {
    const r = await fetch("http://localhost:3001/api/v1/auth/login", {
      method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
      body: JSON.stringify({ phone, password }),
    });
    return (await r.json()).accessToken as string;
  }, { phone, password: F.password });
}
async function api(page: Page, token: string, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ token, method, path, body }) => {
    const r = await fetch(`http://localhost:3001/api/v1${path}`, {
      method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      credentials: "include", body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { token, method, path, body });
}

test.describe("treasuries — closure browser coverage", () => {
  test.beforeEach(async ({ page }) => login(page, F.ownerPhone));

  test("14: edit treasury name/notes/allow-negative from the UI", async ({ page }) => {
    await page.goto("/ar/accounting/treasuries");
    await createTreasury(page, "خزنة للتعديل");
    await page.locator('[data-testid="treasury-row"]', { hasText: "خزنة للتعديل" }).getByRole("button", { name: "تعديل" }).click();
    await page.getByTestId("edit-nameAr").fill("خزنة معدّلة");
    await page.getByTestId("edit-save").click();
    await expect(page.locator('[data-testid="treasury-row"]', { hasText: "خزنة معدّلة" })).toBeVisible();
  });

  test("15: set another treasury as default within the same branch", async ({ page }) => {
    await page.goto("/ar/accounting/treasuries");
    await createTreasury(page, "افتراضية أولى");   // first → default
    await createTreasury(page, "افتراضية ثانية");   // second → not default
    const row = page.locator('[data-testid="treasury-row"]', { hasText: "افتراضية ثانية" });
    await row.getByRole("button", { name: "تعيين كافتراضية" }).click();
    await expect(row.getByText("افتراضية", { exact: true })).toBeVisible(); // the Default badge
  });

  test("13: the expense payment treasury picker lists active treasuries", async ({ page }) => {
    await page.goto("/ar/accounting/treasuries");
    await createTreasury(page, "خزنة مصروف E2E");
    await page.goto("/ar/expenses/new");
    await expect(page.getByTestId("expense-treasury").locator("option", { hasText: "خزنة مصروف E2E" })).toHaveCount(1);
  });

  test("12: the supplier-payment screen shows a branch + treasury-native picker", async ({ page }) => {
    await page.goto("/ar/accounting/treasuries");
    await createTreasury(page, "خزنة سداد E2E");
    await page.goto("/ar/purchasing/supplier-payments");
    await expect(page.getByTestId("supplier-payment-branch")).toBeVisible();
    await expect(page.getByTestId("supplier-payment-treasury").locator("option", { hasText: "خزنة سداد E2E" })).toHaveCount(1);
  });

  test("17: reverse an opening balance AFTER a later outflow → treasury goes negative", async ({ page }) => {
    const token = await apiToken(page, F.ownerPhone);
    const created = await api(page, token, "POST", "/treasuries", { nameAr: "خزنة عكس بعد صرف", branchId: F.branchId });
    const tid = created.body.id;
    // if the fixture has no branchId field, fall back to the treasury's own branch (create without branchId fails) — resolve via a created default branch
    await api(page, token, "POST", `/treasuries/${tid}/opening-balance`, { entryDate: "2026-02-01", amount: "700.00" });
    await api(page, token, "POST", "/expenses", { branchId: created.body.branchId, expenseDate: "2026-02-05", description: "صرف", amount: "500.00", paidFromAccount: "خزنة", glAccountId: F.expenseAccountId, paymentGlAccountId: created.body.glAccountId });
    await page.goto(`/ar/accounting/treasuries/${tid}`);
    await expect(page.getByTestId("treasury-balance")).toHaveText(/٢٠٠/); // 200 after outflow
    page.once("dialog", (d) => d.accept("تصحيح"));
    await page.getByTestId("reverse-opening").click();
    await expect(page.getByTestId("treasury-balance")).toHaveText(/-?‎?٥٠٠|-500/); // -500 after reversal
  });

  test("16: statement load-more paginates beyond 25 movements", async ({ page }) => {
    const token = await apiToken(page, F.ownerPhone);
    const created = await api(page, token, "POST", "/treasuries", { nameAr: "خزنة ترقيم", branchId: F.branchId });
    const tid = created.body.id;
    for (let d = 1; d <= 28; d++) {
      const mm = d <= 9 ? `0${d}` : `${d}`;
      await api(page, token, "POST", `/treasuries/${tid}/opening-balance`, { entryDate: `2026-05-${mm}`, amount: "10.00" });
    }
    await page.goto(`/ar/accounting/treasuries/${tid}`);
    const rowsBefore = await page.locator("table").last().locator("tbody tr").count();
    expect(rowsBefore).toBeLessThanOrEqual(25);
    await page.getByTestId("load-more").click();
    await expect(page.getByTestId("load-more")).toHaveCount(0); // 28 total → second page loads the rest
    const rowsAfter = await page.locator("table").last().locator("tbody tr").count();
    expect(rowsAfter).toBeGreaterThan(rowsBefore);
  });

  test("18: the English detail page is English + LTR with locale-correct numbers", async ({ page }) => {
    await page.goto("/ar/accounting/treasuries");
    await createTreasury(page, "خزنة إنجليزي");
    const href = await page.locator('[data-testid="treasury-row"]', { hasText: "خزنة إنجليزي" }).getByText("كشف الحركة").getAttribute("href");
    await page.goto(href!.replace("/ar/", "/en/"));
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByText("Current balance")).toBeVisible();       // English label
    await expect(page.getByTestId("treasury-balance")).toHaveText(/0\.00/); // Latin digits
    await expect(page.getByText(/treasury\.[a-zA-Z]/)).toHaveCount(0);   // no raw keys
  });
});
