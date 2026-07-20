/**
 * Chromium E2E — Sales Invoice "حفظ PDF" direct download.
 *
 * Logs in, ensures a sales invoice exists (creates a draft via the API), opens
 * the Sales Invoices list, expands the invoice, asserts BOTH طباعة and حفظ PDF
 * are visible side-by-side, clicks حفظ PDF, captures the browser download, and
 * verifies the file is a non-empty .pdf named after the invoice — without any
 * page navigation, and with Print still available.
 */
import { expect, test, type Page } from "@playwright/test";
import { statSync } from "node:fs";

const API = "http://localhost:3001/api/v1";

async function login(page: Page, phone: string, password: string): Promise<string> {
  await page.goto("/ar/login");
  const r = await page.evaluate(
    async ({ API, phone, password }) => {
      const res = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ phone, password }),
      });
      return { status: res.status, body: await res.json() };
    },
    { API, phone, password },
  );
  if (r.status !== 200) throw new Error(`Login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken as string;
}

test.describe("sales invoice — Save PDF", () => {
  test("expanded invoice shows طباعة + حفظ PDF; Save PDF downloads a non-empty .pdf", async ({ page }) => {
    const token = await login(page, "+201000000000", "Owner@2026");

    // Ensure at least one sales invoice exists — create a DRAFT via the API.
    const invNumber = await page.evaluate(
      async ({ API, token }) => {
        const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
        const first = async (path: string) => {
          const j = await (await fetch(`${API}${path}`, { headers: h })).json();
          return Array.isArray(j) ? j[0] : (j.data?.[0] ?? j[0]);
        };
        const customer = await first("/customers");
        const branch = await first("/branches");
        const variant = await first("/products/variants");
        const res = await fetch(`${API}/sales-invoices`, {
          method: "POST",
          headers: h,
          body: JSON.stringify({
            invoiceDate: "2026-07-19",
            customerId: customer.id,
            branchId: branch.id,
            taxRate: "14",
            lines: [{ productVariantId: variant.id, quantity: "4", unitPrice: "500", costPrice: "500", discountPct: "0" }],
          }),
        });
        return (await res.json()).invoiceNumber as string;
      },
      { API, token },
    );

    await page.goto("/ar/sales/invoices");

    // Expand the row for our invoice (click its "تفاصيل" button).
    const row = page.locator("tr", { hasText: `SI-${invNumber}` }).first();
    await row.getByRole("button", { name: "تفاصيل" }).click();

    // Both actions present, side by side.
    const printBtn = page.getByRole("button", { name: "طباعة" }).first();
    const pdfBtn = page.getByRole("button", { name: /حفظ PDF/ }).first();
    await expect(printBtn).toBeVisible();
    await expect(pdfBtn).toBeVisible();

    // Click حفظ PDF and capture the direct download (no print dialog).
    const urlBefore = page.url();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfBtn.click(),
    ]);

    const filename = download.suggestedFilename();
    expect(filename).toMatch(/\.pdf$/);
    expect(filename).toContain(`SI-${invNumber}`);

    const filePath = await download.path();
    expect(filePath).toBeTruthy();
    expect(statSync(filePath!).size).toBeGreaterThan(0);

    // No navigation; Print still available.
    expect(page.url()).toBe(urlBefore);
    await expect(printBtn).toBeVisible();
  });
});
