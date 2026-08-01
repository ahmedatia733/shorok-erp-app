import { test, expect } from "@playwright/test";

test("navigation should not lose session", async ({ page }) => {
  // 1. Go to login page
  await page.goto("/ar/login");
  
  // 2. Fill login form
  await page.fill('input[name="phone"]', "+201000000000");
  await page.fill('input[name="password"]', "Owner@2026");
  await page.click('button[type="submit"]');

  // 3. Wait for navigation to dashboard/orders (or similar protected page)
  await expect(page).toHaveURL(/\/ar\/(orders|dashboard|settings|purchasing)/);

  // 4. Click a sidebar link
  await page.click('text="مردودات المشتريات"'); // Purchase Returns

  // 5. It should NOT redirect to login
  await expect(page).not.toHaveURL(/\/ar\/login/);
  await expect(page).toHaveURL(/\/ar\/purchasing\/returns/);
});
