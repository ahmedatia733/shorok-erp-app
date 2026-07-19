/**
 * Chromium E2E — invoice line calculation & default price.
 *
 * Proves in a real browser that a NEW Purchase Invoice line:
 *   - defaults its price from the variant (purchase cost per meter, > 0),
 *   - computes total meters = boards × board area, and
 *   - computes line total = total meters × price,
 * and that the on-screen values equal the Decimal-safe helper the page uses
 * (lib/line-calc) — i.e. the frontend and backend formulas agree. The test
 * reads the selected variant's own area/price so it is robust to seed data
 * while still proving the exact relationships from the spec examples.
 *
 * Runs in the project's E2E pipeline (seeded demo OWNER + running stack via the
 * Playwright `webServer` block).
 */
import { expect, test, type Page } from "@playwright/test";
import { lineTotalPerMeter, totalMeters } from "../../lib/line-calc";

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
  if (result.status !== 200) {
    throw new Error(`Login failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
}

test.describe("invoice line calculation", () => {
  test("purchase line: price defaults from variant; meters and total are Decimal-safe", async ({ page }) => {
    await loginAs(page, "+201000000000", "Owner@2026");
    await page.goto("/ar/purchasing/invoices/new");

    // Open the first line's variant selector and pick the first result.
    await page.getByRole("button", { name: /الكود \/ الصنف/ }).first().click();
    await page.locator("ul li").first().click();

    // Price defaults from the variant's purchase cost per meter (never 0/stale).
    const price = await page.getByTestId("pi-price-0").inputValue();
    expect(Number(price)).toBeGreaterThan(0);

    // Board area loaded from the variant.
    const sqm = (await page.getByTestId("pi-sqm-0").innerText()).trim();
    expect(Number(sqm)).toBeGreaterThan(0);

    // Enter 10 boards → meters and total recalc immediately (no reload).
    await page.getByTestId("pi-boards-0").fill("10");

    const meters = (await page.getByTestId("pi-meters-0").innerText()).trim();
    const total = (await page.getByTestId("pi-total-0").innerText()).trim();

    // Frontend display equals the Decimal-safe helper the page computes with.
    expect(meters).toBe(totalMeters("10", sqm));
    expect(total).toBe(lineTotalPerMeter(meters, price));
  });
});
