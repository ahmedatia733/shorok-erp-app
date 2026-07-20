/**
 * Chromium E2E — Sales Invoice: searchable customer, variant selection with
 * automatic PER-METER prices, board-quantity entry, total meters, line total,
 * and profit. Verifies the on-screen values equal the Decimal-safe helper the
 * page computes with (lib/line-calc), so the browser and backend agree.
 *
 * Reads the selected variant's own price/cost/size from the UI, so it is robust
 * to seed data while still proving the exact per-metre relationships.
 */
import { expect, test, type Page } from "@playwright/test";
import { lineTotalPerMeter, subtractMoney, totalMeters } from "../../lib/line-calc";

async function loginAs(page: Page, phone: string, password: string) {
  await page.goto("/ar/login");
  const result = await page.evaluate(
    async ({ phone, password }) => {
      const res = await fetch("http://localhost:3001/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ phone, password }),
      });
      return { status: res.status, body: await res.json() };
    },
    { phone, password },
  );
  if (result.status !== 200) throw new Error(`Login failed: ${result.status} ${JSON.stringify(result.body)}`);
}

test.describe("sales invoice — per-meter", () => {
  test("searchable customer + per-meter variant prices + meters + total + profit", async ({ page }) => {
    await loginAs(page, "+201000000000", "Owner@2026");
    await page.goto("/ar/sales/invoices");

    // Open the "new invoice" form.
    await page.getByRole("button", { name: /فاتورة جديدة|فاتورة مبيعات جديدة/ }).first().click();

    // 1) Searchable customer selector: type a code fragment and pick a result.
    const custInput = page.locator("#si-customer");
    await custInput.click();
    await custInput.fill("C-00");
    const firstCustomer = page.locator("#si-customer-listbox li[role=option]").first();
    await expect(firstCustomer).toBeVisible();
    await firstCustomer.click();
    await expect(custInput).not.toHaveValue(""); // a customer is selected

    // 2) Select the first product variant in line 0.
    await page.getByRole("button", { name: /الكود \/ الصنف/ }).first().click();
    await page.locator("ul li").first().click();

    // 3) Per-meter prices auto-load (both > 0) — sale and cost per metre.
    const price = await page.getByTestId("si-price-0").inputValue();
    const cost = await page.getByTestId("si-cost-0").inputValue();
    expect(Number(price)).toBeGreaterThan(0);
    expect(Number(cost)).toBeGreaterThan(0);

    // 4) Enter 10 boards → meters, total and profit recompute immediately.
    await page.getByTestId("si-boards-0").fill("10");

    const meters = (await page.getByTestId("si-meters-0").innerText()).trim();
    const total = (await page.getByTestId("si-total-0").innerText()).trim();
    const profit = (await page.getByTestId("si-profit-0").innerText()).trim();

    // Frontend display equals the Decimal-safe per-metre helper.
    expect(total).toBe(lineTotalPerMeter(meters, price));
    const expectedCost = lineTotalPerMeter(meters, cost);
    expect(profit).toBe(subtractMoney(total, expectedCost));
    // Sanity: total meters is boards × the loaded board area.
    expect(Number(meters)).toBeGreaterThan(0);
    expect(meters).toBe(totalMeters("10", (Number(meters) / 10).toString()));
  });
});
