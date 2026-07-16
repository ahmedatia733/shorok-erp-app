/**
 * Invoice PDF export — browser E2E (Playwright).
 *
 * Proves the "تصدير PDF" button on the sales-invoice detail page triggers a real
 * browser download whose bytes are a PDF. A DRAFT invoice is used so no posting
 * accounts are required — it exercises the same GET /sales-invoices/:id/pdf path.
 * Full content/auth coverage lives in the API integration tests.
 */
import { expect, test } from "@playwright/test";

const API = "http://localhost:3001/api/v1";

/** Logs in and builds a DRAFT sales invoice via the API; returns its id + number. */
async function seedDraftInvoice(page: import("@playwright/test").Page) {
  await page.goto("/ar/login");
  return page.evaluate(async (api) => {
    const post = async (path: string, token: string | null, body?: unknown) => {
      const res = await fetch(api + path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
      return res.json();
    };

    const login = await post("/auth/login", null, { phone: "+201000000000", password: "Owner@2026" });
    const token: string = login.accessToken;

    const branches = await post("/branches", token);
    const branchId: string = branches[0].id;
    const variants = await post("/products/variants", token);
    const variantId: string = variants[0].id;

    const customer = await post("/customers", token, { nameAr: `عميل PDF ${Date.now()}` });
    const invoice = await post("/sales-invoices", token, {
      invoiceDate: "2026-07-15",
      customerId: customer.id,
      branchId,
      taxRate: "14",
      lines: [{ productVariantId: variantId, quantity: "3", unitPrice: "525.00", costPrice: "300.00" }],
    });
    return { id: invoice.id as string, invoiceNumber: invoice.invoiceNumber as string };
  }, API);
}

test.describe("invoice PDF export", () => {
  test("sales invoice detail exposes a working PDF download", async ({ page }) => {
    const { id, invoiceNumber } = await seedDraftInvoice(page);

    await page.goto(`/ar/sales/invoices/${id}`);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    const exportBtn = page.getByRole("button", { name: "تصدير PDF" });
    await expect(exportBtn).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 20_000 }),
      exportBtn.click(),
    ]);

    // Filename comes from the server's Content-Disposition.
    expect(download.suggestedFilename()).toContain(`SI-${invoiceNumber}`);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);

    // Verify the bytes are a real PDF.
    const path = await download.path();
    const fs = await import("fs");
    const head = fs.readFileSync(path).subarray(0, 4).toString("latin1");
    expect(head).toBe("%PDF");
  });
});
