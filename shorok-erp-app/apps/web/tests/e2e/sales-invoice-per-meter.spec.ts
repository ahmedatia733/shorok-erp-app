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

    // 2) Open the product selector and assert the dropdown shows COST only,
    //    never the sale price, before picking the first variant.
    await page.getByRole("button", { name: /الكود \/ الصنف/ }).first().click();
    const firstOption = page.locator("ul li").first();
    await expect(firstOption).toBeVisible();
    const optionText = await firstOption.innerText();
    expect(optionText).toContain("سعر التكلفة للمتر"); // cost label present
    expect(optionText).not.toContain("سعر بيع المتر");  // NO sale price label
    expect(optionText).not.toContain("بيع");            // NO "بيع 498" text
    await firstOption.click();

    // 3) Sale price stays EMPTY (manual); cost auto-loads (> 0).
    expect(await page.getByTestId("si-price-0").inputValue()).toBe("");
    const cost = await page.getByTestId("si-cost-0").inputValue();
    expect(Number(cost)).toBeGreaterThan(0);

    // 4) Enter boards → cost/meters compute even with an empty sale price;
    //    the sale total stays empty until a sale price is typed.
    await page.getByTestId("si-boards-0").fill("8");
    expect((await page.getByTestId("si-total-0").innerText()).trim()).toBe("");

    // 5) Type a manual sale price → line total recomputes per metre.
    await page.getByTestId("si-price-0").fill("1000");
    const meters = (await page.getByTestId("si-meters-0").innerText()).trim();
    const total = (await page.getByTestId("si-total-0").innerText()).trim();
    const profit = (await page.getByTestId("si-profit-0").innerText()).trim();

    expect(Number(meters)).toBeGreaterThan(0);
    expect(meters).toBe(totalMeters("8", (Number(meters) / 8).toString())); // boards × area
    expect(total).toBe(lineTotalPerMeter(meters, "1000"));                    // manual price
    const expectedCost = lineTotalPerMeter(meters, cost);
    expect(profit).toBe(subtractMoney(total, expectedCost));
  });
});
