/**
 * Return PDF downloads from the detail pages — DRAFT and CONFIRMED, sales and
 * purchase, Arabic «حفظ PDF» and English "Download PDF". Seeds real returns
 * through the API; asserts a download fires with the right filename and that the
 * return stays DRAFT (read-only). LOCAL test env only.
 *
 * REQUIRED SEED — demo seed (OWNER +201000000000):
 *   DATABASE_URL=<test> npx ts-node --transpile-only prisma/seed.ts
 * Do NOT run this spec in the same invocation as returns/treasuries/
 * journal-searchable: tests/e2e-returns-seed.ts TRUNCATES users and creates a
 * different OWNER (+201555000099), which makes this spec's login return 401.
 */
import { test, expect, type Page } from "@playwright/test";

const API = "http://localhost:3001/api/v1";

interface Ctx {
  draftSalesId: string;
  confirmedSalesId: string;
  draftPurchaseId: string;
  confirmedPurchaseId: string;
}

async function seed(page: Page): Promise<Ctx> {
  await page.goto("/ar/login");
  return page.evaluate(async (api) => {
    const call = async (path: string, token: string | null, body?: unknown, method?: string) => {
      const res = await fetch(api + path, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        credentials: "include",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
      return res.json();
    };
    const token: string = (await call("/auth/login", null, { phone: "+201000000000", password: "Owner@2026" })).accessToken;
    const u = Date.now().toString().slice(-6);
    for (const m of [2, 3]) { try { await call("/settings/periods", token, { year: 2026, month: m }); } catch { /* open */ } }
    const mk = async (code: string, nameAr: string, cat: string, t: string) =>
      (await call("/accounts", token, { code, nameAr, nameEn: code, category: cat, accountType: t })).id as string;
    const ar = await mk(`RPDAR${u}`, `ذمم ${u}`, "ASSET", "CURRENT_ASSET");
    const ap = await mk(`RPDAP${u}`, `موردون ${u}`, "LIABILITY", "LIABILITY");
    const rev = await mk(`RPDRV${u}`, `إيراد ${u}`, "REVENUE", "REVENUE");
    const sret = await mk(`RPDSR${u}`, `مردودات مبيعات ${u}`, "REVENUE", "REVENUE");
    const cogs = await mk(`RPDCG${u}`, `تكلفة ${u}`, "COST_OF_SALES", "COST_OF_SALES");
    const inv = await mk(`RPDIN${u}`, `مخزون ${u}`, "ASSET", "CURRENT_ASSET");
    const vatOut = await mk(`RPDVO${u}`, `ض مخرجات ${u}`, "LIABILITY", "LIABILITY");
    const vatIn = await mk(`RPDVI${u}`, `ض مدخلات ${u}`, "ASSET", "CURRENT_ASSET");
    await call("/settings/posting-profiles", token, { effectiveFrom: "2026-01-01", arAccountId: ar, apAccountId: ap, revenueAccountId: rev, salesReturnsAccountId: sret, cogsAccountId: cogs, inventoryAccountId: inv, vatOutputAccountId: vatOut, vatInputAccountId: vatIn });

    const branchId = ((await call("/branches", token)) as Array<{ id: string }>)[0].id;
    const supplierId = (await call("/suppliers", token, { nameAr: `مورد ${u}`, nameEn: `Sup ${u}` })).id as string;
    const customerId = (await call("/customers", token, { nameAr: `عميل PDF ${u}` })).id as string;
    const sku = await call("/products/skus", token, { code: `RPD-${u}`, colorNameAr: `لون ${u}`, colorNameEn: `Color ${u}`, category: "NORMAL" });
    const variant = await call("/products/variants", token, { skuId: sku.id, sizeMetersPerBoard: "4", defaultSalePricePerMeter: "500", defaultPurchasePricePerMeter: "300" });

    const stock = async () => {
      const pi = await call("/purchase-invoices", token, { invoiceDate: "2026-02-05", supplierId, branchId, lines: [{ productVariantId: variant.id, boardsQuantity: "10", unitPrice: "300", taxRate: "0" }] });
      await call(`/purchase-invoices/${pi.id}/confirm`, token, {});
      return pi.id as string;
    };
    const saleReturn = async (confirmIt: boolean) => {
      await stock();
      const si = await call("/sales-invoices", token, { invoiceDate: "2026-03-05", customerId, branchId, taxRate: "0", lines: [{ productVariantId: variant.id, quantity: "3", unitPrice: "500", costPrice: "0" }] });
      await call(`/sales-invoices/${si.id}/confirm`, token, {});
      const draft = await call("/sales-returns", token, { originalSalesInvoiceId: si.id, returnDate: "2026-03-10", lines: [{ originalSalesInvoiceLineId: si.lines[0].id, returnedBoards: "1" }] });
      if (confirmIt) await call(`/sales-returns/${draft.id}/confirm`, token, {});
      return draft.id as string;
    };
    const purchaseReturn = async (confirmIt: boolean) => {
      const pid = await stock();
      const line = (await call(`/purchase-returns/returnable/${pid}`, token)).lines[0].originalLineId;
      const draft = await call("/purchase-returns", token, { originalPurchaseInvoiceId: pid, returnDate: "2026-02-10", lines: [{ originalPurchaseInvoiceLineId: line, returnedBoards: "1" }] });
      if (confirmIt) await call(`/purchase-returns/${draft.id}/confirm`, token, {});
      return draft.id as string;
    };

    return {
      draftSalesId: await saleReturn(false),
      confirmedSalesId: await saleReturn(true),
      draftPurchaseId: await purchaseReturn(false),
      confirmedPurchaseId: await purchaseReturn(true),
    };
  }, API);
}

async function login(page: Page) {
  await page.goto("/ar/login");
  const status = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/auth/login`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "+201000000000", password: "Owner@2026" }) });
    return r.status;
  }, API);
  expect(status).toBe(200);
}

test.describe("return PDF downloads", () => {
  let ctx: Ctx;
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    ctx = await seed(page);
    await page.close();
  });
  test.beforeEach(async ({ page }) => login(page));

  test("1-5: DRAFT sales return — «حفظ PDF» downloads a draft PDF and the return stays DRAFT", async ({ page }) => {
    await page.goto(`/ar/sales/returns/${ctx.draftSalesId}`);
    await expect(page.getByText("مسودة").first()).toBeVisible({ timeout: 15_000 });
    const btn = page.getByTestId("sales-return-pdf");
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText("حفظ PDF");
    const [download] = await Promise.all([page.waitForEvent("download"), btn.click()]);
    expect(download.suggestedFilename()).toMatch(/sales-return-SR-\d+-draft\.pdf/);
    // Read-only: still DRAFT after the download.
    await expect(page.getByText("مسودة").first()).toBeVisible();
  });

  test("6-7: CONFIRMED sales return downloads a confirmed PDF", async ({ page }) => {
    await page.goto(`/ar/sales/returns/${ctx.confirmedSalesId}`);
    await expect(page.getByText("مؤكد").first()).toBeVisible({ timeout: 15_000 });
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("sales-return-pdf").click()]);
    expect(download.suggestedFilename()).toMatch(/sales-return-SR-\d+-confirmed\.pdf/);
  });

  test("8-10: DRAFT purchase return downloads a draft PDF and stays DRAFT", async ({ page }) => {
    await page.goto(`/ar/purchasing/returns/${ctx.draftPurchaseId}`);
    await expect(page.getByText("مسودة").first()).toBeVisible({ timeout: 15_000 });
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("purchase-return-pdf").click()]);
    expect(download.suggestedFilename()).toMatch(/purchase-return-PR-\d+-draft\.pdf/);
    await expect(page.getByText("مسودة").first()).toBeVisible();
  });

  test("11-12: CONFIRMED purchase return downloads a confirmed PDF", async ({ page }) => {
    await page.goto(`/ar/purchasing/returns/${ctx.confirmedPurchaseId}`);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("purchase-return-pdf").click()]);
    expect(download.suggestedFilename()).toMatch(/purchase-return-PR-\d+-confirmed\.pdf/);
  });

  test("13-14: Arabic shows «حفظ PDF», English shows «Download PDF»", async ({ page }) => {
    await page.goto(`/ar/sales/returns/${ctx.draftSalesId}`);
    await expect(page.getByTestId("sales-return-pdf")).toHaveText("حفظ PDF");
    await page.goto(`/en/sales/returns/${ctx.draftSalesId}`);
    await expect(page.getByTestId("sales-return-pdf")).toHaveText("Download PDF");
  });
});
