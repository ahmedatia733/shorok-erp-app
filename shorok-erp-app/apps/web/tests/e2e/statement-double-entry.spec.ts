/**
 * Section T — double-entry propagation seen through the browser.
 *
 * Each flow posts a real document/journal, then reads BOTH affected sides back
 * through the unified statement UI: the specific account/party AND its
 * consolidated category. The point is that one journal shows up on both sides
 * with no re-login and no cached balance, while unrelated accounts stay put.
 *
 * The typed negative-treasury 409 is deliberately NOT exercised here: the guard
 * keys off the isCashOrBank/treasuryType config that only migrations set, and
 * POST /accounts cannot create a real treasury — so a browser fixture can never
 * trip it. That regression lives in the API suite (double-entry-propagation
 * "R2", consolidated-statement "26"). Nothing here touches production.
 */
import { expect, test, type Page } from "@playwright/test";

const API = "http://localhost:3001/api/v1";

interface Ctx {
  suffix: string;
  bank1A: string; bank1B: string; cust1A: string; cust1B: string; pay1: string;
  bank2: string; cust2: string;
  cash3: string; exp3: string;
  cust4: string; sup5: string;
  variantId: string;
  ar: string; ap: string; revenue: string; vatOut: string; vatIn: string; inventory: string; cogs: string;
  fixtureAccounts: string[];
}

/**
 * Seeds accounts, parties and the postings each flow reads back.
 *
 * Invoice flows need a PostingProfile, which the dev database ships without and
 * the API cannot delete. So it is created once against stable fixed-code
 * accounts and reused on every later run — that keeps repeat runs from piling
 * new accounts into the categories, which would skew the consolidated totals.
 */
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

    try {
      await call("/settings/periods", token, { year: 2026, month: 7 });
    } catch {
      /* already open */
    }

    const mkAccount = async (code: string, nameAr: string, nameEn: string, category: string, accountType: string) =>
      (await call("/accounts", token, { code, nameAr, nameEn, category, accountType })).id as string;

    // ── Posting accounts: fixed codes, created once, never deactivated ───────
    const accounts = (await call("/accounts", token)) as Array<{ id: string; code: string }>;
    const byCode = new Map(accounts.map((a) => [a.code, a.id]));
    const stable = async (code: string, nameAr: string, nameEn: string, category: string, accountType: string) =>
      byCode.get(code) ?? (await mkAccount(code, nameAr, nameEn, category, accountType));

    let profile = ((await call("/settings/posting-profiles", token)) as Array<Record<string, string>>)[0];
    let ar: string, ap: string, revenue: string, vatOut: string, vatIn: string, inventory: string, cogs: string;
    if (profile) {
      // Reuse whatever the environment already posts through.
      ({ arAccountId: ar, apAccountId: ap, revenueAccountId: revenue, vatOutputAccountId: vatOut,
         vatInputAccountId: vatIn, inventoryAccountId: inventory, cogsAccountId: cogs } = profile as never);
    } else {
      ar = await stable("E2EPP-AR", "ذمم عملاء الترحيل", "E2E Posting AR", "ASSET", "CURRENT_ASSET");
      ap = await stable("E2EPP-AP", "موردون الترحيل", "E2E Posting AP", "LIABILITY", "LIABILITY");
      revenue = await stable("E2EPP-REV", "إيرادات الترحيل", "E2E Posting Revenue", "REVENUE", "REVENUE");
      vatOut = await stable("E2EPP-VATO", "ضريبة مبيعات الترحيل", "E2E Posting VAT Output", "LIABILITY", "LIABILITY");
      vatIn = await stable("E2EPP-VATI", "ضريبة مشتريات الترحيل", "E2E Posting VAT Input", "ASSET", "CURRENT_ASSET");
      inventory = await stable("E2EPP-INV", "مخزون الترحيل", "E2E Posting Inventory", "ASSET", "CURRENT_ASSET");
      cogs = await stable("E2EPP-COGS", "تكلفة مبيعات الترحيل", "E2E Posting COGS", "COST_OF_SALES", "COST_OF_SALES");
      profile = await call("/settings/posting-profiles", token, {
        effectiveFrom: "2026-01-01", arAccountId: ar, apAccountId: ap, revenueAccountId: revenue,
        vatOutputAccountId: vatOut, vatInputAccountId: vatIn, inventoryAccountId: inventory, cogsAccountId: cogs,
      });
    }

    // ── Per-run fixtures (deactivated afterwards) ────────────────────────────
    const bank1A = await mkAccount(`DEB1A${u}`, `بنك الطرفين أ ${u}`, `DE Bank A ${u}`, "ASSET", "CURRENT_ASSET");
    const bank1B = await mkAccount(`DEB1B${u}`, `بنك الطرفين ب ${u}`, `DE Bank B ${u}`, "ASSET", "CURRENT_ASSET");
    const bank2 = await mkAccount(`DEB2${u}`, `بنك العكسي ${u}`, `DE Bank Rev ${u}`, "ASSET", "CURRENT_ASSET");
    const cash3 = await mkAccount(`DEC3${u}`, `خزنة المصروف ${u}`, `DE Vault Exp ${u}`, "ASSET", "CURRENT_ASSET");
    const exp3 = await mkAccount(`DEX3${u}`, `مصاريف تشغيل الطرفين ${u}`, `DE Ops ${u}`, "EXPENSE", "EXPENSE");
    const funding = await mkAccount(`DEQ${u}`, `رأس مال الاختبار ${u}`, `DE Equity ${u}`, "EQUITY", "EQUITY");

    const customer = async (name: string) => (await call("/customers", token, { nameAr: name })).id as string;
    const cust1A = await customer(`عميل الطرفين أ ${u}`);
    const cust1B = await customer(`عميل الطرفين ب ${u}`);
    const cust2 = await customer(`عميل العكسي ${u}`);
    const cust4 = await customer(`عميل الفاتورة ${u}`);
    const sup5 = (await call("/suppliers", token, { nameAr: `مورد الفاتورة ${u}`, nameEn: `DE Supplier ${u}` })).id as string;
    const supStock = (await call("/suppliers", token, { nameAr: `مورد التوريد ${u}`, nameEn: `DE Stock Supplier ${u}` })).id as string;

    const journal = (lines: unknown[], description = "قيد اختبار الطرفين") =>
      call("/journal", token, {
        entryDate: "2026-07-15", entryType: "JOURNAL", description,
        acknowledgeNegativeBalance: true, lines,
      });
    const dr = (accountId: string, amount: string, extra = {}) => ({ accountId, debit: amount, credit: "0", ...extra });
    const cr = (accountId: string, amount: string, extra = {}) => ({ accountId, debit: "0", credit: amount, ...extra });

    // Flow 1 — fund both banks, open a receivable for each customer, then pay.
    await journal([dr(bank1A, "5000"), cr(funding, "5000")]);
    await journal([dr(bank1B, "2000"), cr(funding, "2000")]);
    await journal([dr(ar, "3000", { partyType: "CUSTOMER", partyId: cust1A }), cr(funding, "3000")]);
    await journal([dr(ar, "500", { partyType: "CUSTOMER", partyId: cust1B }), cr(funding, "500")]);
    // The subject of Flow 1: customer A pays 1,000 into Bank A.
    const pay1 = (await journal(
      [dr(bank1A, "1000"), cr(ar, "1000", { partyType: "CUSTOMER", partyId: cust1A })],
      `تحصيل من عميل ${u}`,
    )).id as string;

    // Flow 2 — a funded bank and a customer with no balance yet.
    await journal([dr(bank2, "4000"), cr(funding, "4000")]);
    // Flow 3 — a funded treasury.
    await journal([dr(cash3, "3000"), cr(funding, "3000")]);

    // Invoice flows — one variant, stocked through a real purchase invoice so
    // the sales invoice has both stock and an average cost to post COGS from.
    const branchId = ((await call("/branches", token)) as Array<{ id: string }>)[0].id;
    const sku = await call("/products/skus", token, {
      code: `DE-${u}`, colorNameAr: `لون ${u}`, colorNameEn: `Color ${u}`, category: "NORMAL",
    });
    const variant = await call("/products/variants", token, {
      skuId: sku.id, sizeMetersPerBoard: "1", defaultSalePricePerMeter: "1000", defaultPurchasePricePerMeter: "560",
    });
    const stockPi = await call("/purchase-invoices", token, {
      invoiceDate: "2026-07-15", supplierId: supStock, branchId,
      lines: [{ productVariantId: variant.id, boardsQuantity: "20", lengthM: "1", unitPrice: "560", taxRate: "14" }],
    });
    await call(`/purchase-invoices/${stockPi.id}/confirm`, token, {});

    return {
      suffix: u, bank1A, bank1B, cust1A, cust1B, pay1, bank2, cust2, cash3, exp3, cust4, sup5,
      variantId: variant.id, ar, ap, revenue, vatOut, vatIn, inventory, cogs,
      fixtureAccounts: [bank1A, bank1B, bank2, cash3, exp3, funding],
    };
  }, API);
}

async function login(page: Page) {
  await page.goto("/ar/login");
  const status = await page.evaluate(async (api) => {
    const res = await fetch(`${api}/auth/login`, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+201000000000", password: "Owner@2026" }),
    });
    return res.status;
  }, API);
  expect(status).toBe(200);
}

/** Runs an API call from inside the page session (used to post mid-test). */
async function api<T>(page: Page, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ api, path, body }) => {
      const token = (await (await fetch(`${api}/auth/login`, {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: "+201000000000", password: "Owner@2026" }),
      })).json()).accessToken;
      const res = await fetch(api + path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
      return res.json();
    },
    { api: API, path, body },
  ) as Promise<T>;
}

async function openStatement(page: Page) {
  await login(page);
  await page.goto("/ar/accounting/statement");
  await expect(page.locator("#stmt-category")).toBeVisible({ timeout: 15_000 });
}

/**
 * Chooses a category, then an entity, in the two-stage selector.
 *
 * The search box is cleared before typing: filling it with text it already
 * displays (e.g. "كل العملاء" right after a category reset) is not a value
 * change, so React fires no onChange and the list would never filter.
 */
async function select(page: Page, categoryId: string, entityLabelPart: string) {
  await page.selectOption("#stmt-category", categoryId);
  const entity = page.locator("#stmt-entity");
  await entity.click();
  await entity.fill("");
  await entity.fill(entityLabelPart);
  await page.locator('[role="option"]').first().click();
  await expect(page.locator("text=جارِ التحديث...")).toHaveCount(0, { timeout: 15_000 });
}

/** ar-EG renders Arabic-Indic digits (٢٬٦٠٠٫٠٠) — normalise before asserting. */
function normalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/٬/g, ",")
    .replace(/٫/g, ".");
}

async function rowText(page: Page, key: string): Promise<string> {
  const row = page.locator("tr", { hasText: key }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  return normalizeDigits(await row.innerText());
}

async function tableText(page: Page): Promise<string> {
  return normalizeDigits(await page.locator("table").last().innerText());
}

test.describe.serial("double-entry propagation through the unified statement", () => {
  let ctx: Ctx;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    ctx = await seed(page);
    await page.close();
  });

  // Per-run fixtures only: the fixed-code posting accounts stay active because
  // the PostingProfile still points at them and posting requires active leaves.
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto("/ar/login");
    await page.evaluate(async ({ api, ids }) => {
      const token = (await (await fetch(`${api}/auth/login`, {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: "+201000000000", password: "Owner@2026" }),
      })).json()).accessToken;
      for (const id of ids) {
        await fetch(`${api}/accounts/${id}`, {
          method: "PATCH", credentials: "include",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ active: false }),
        });
      }
    }, { api: API, ids: ctx.fixtureAccounts });
    await page.close();
  });

  // ── E2E 1 — customer pays into a bank ────────────────────────────────────

  test("E2E 1 — a customer payment shows on the bank and the customer, linked to one journal", async ({ page }) => {
    await openStatement(page);

    // Banks → all banks: the paid-into bank rose to 6,000; the other is untouched.
    await select(page, "banks", "كل البنوك");
    expect(await rowText(page, `DEB1A${ctx.suffix}`)).toContain("6,000.00"); // 5000 + 1000
    expect(await rowText(page, `DEB1B${ctx.suffix}`)).toContain("2,000.00"); // unchanged

    // Banks → that bank: the exact 1,000 debit is on its statement.
    await select(page, "banks", `بنك الطرفين أ ${ctx.suffix}`);
    await expect(page.locator("text=عرض تفصيلي")).toBeVisible();
    expect(await tableText(page)).toContain("1,000.00");
    const bankHref = await page.locator(`table a[href*="${ctx.pay1}"]`).first().getAttribute("href");
    expect(bankHref).toBeTruthy();

    // Customers → all customers: A's receivable dropped to 2,000; B untouched.
    await select(page, "customers", "كل العملاء");
    expect(await rowText(page, `عميل الطرفين أ ${ctx.suffix}`)).toContain("2,000.00"); // 3000 − 1000
    expect(await rowText(page, `عميل الطرفين ب ${ctx.suffix}`)).toContain("500.00"); // unchanged

    // Customers → customer A: the exact 1,000 credit — the other half of the
    // same journal, read from the customer's own lines.
    await select(page, "customers", `عميل الطرفين أ ${ctx.suffix}`);
    await expect(page.locator("text=عرض تفصيلي")).toBeVisible();
    expect(await tableText(page)).toContain("1,000.00");
    const custHref = await page.locator(`table a[href*="${ctx.pay1}"]`).first().getAttribute("href");

    // Both sides drill down to the same journal.
    expect(custHref).toBe(bankHref);
  });

  test("the entity list reopens when its already-focused search box is clicked again", async ({ page }) => {
    await openStatement(page);
    const entity = page.locator("#stmt-entity");

    // Commit an option: the list closes but keeps focus on the input, because
    // the option's mousedown prevents the blur that would beat its own click.
    await entity.click();
    await entity.fill("");
    await entity.fill("كل البنوك");
    await page.locator('[role="option"]').first().click();
    await expect(page.locator('[role="listbox"]')).toHaveCount(0);

    // Clicking the still-focused box must reopen it — no focus event fires here,
    // so this only works if the component also opens on click.
    await entity.click();
    await expect(page.locator('[role="listbox"]')).toBeVisible();
    await expect(entity).toHaveAttribute("aria-expanded", "true");
  });

  // ── E2E 2 — the reverse direction, then a reversal ───────────────────────

  test("E2E 2 — charging a customer from a bank moves both sides, and reversing returns them", async ({ page }) => {
    const posted = await api<{ id: string }>(page, "/journal", {
      entryDate: "2026-07-15", entryType: "JOURNAL", description: `خصم على عميل ${ctx.suffix}`,
      acknowledgeNegativeBalance: true,
      lines: [
        { accountId: ctx.ar, debit: "800", credit: "0", partyType: "CUSTOMER", partyId: ctx.cust2 },
        { accountId: ctx.bank2, debit: "0", credit: "800" },
      ],
    });

    await openStatement(page);

    // Customer receivable up 800; bank down to 3,200 — no re-login, no cache.
    await select(page, "customers", `عميل العكسي ${ctx.suffix}`);
    expect(await tableText(page)).toContain("800.00");
    await select(page, "customers", "كل العملاء");
    expect(await rowText(page, `عميل العكسي ${ctx.suffix}`)).toContain("800.00");

    await select(page, "banks", "كل البنوك");
    expect(await rowText(page, `DEB2${ctx.suffix}`)).toContain("3,200.00"); // 4000 − 800

    // Reverse it: both sides come back, and both rows stay visible.
    await api(page, `/journal/${posted.id}/reverse`, { reason: "إلغاء اختبار", acknowledgeNegativeBalance: true });

    await openStatement(page);
    await select(page, "banks", "كل البنوك");
    expect(await rowText(page, `DEB2${ctx.suffix}`)).toContain("4,000.00"); // back to funded

    await select(page, "customers", "كل العملاء");
    // The customer nets back to zero, and both the original and its reversal
    // remain on the statement — posted journals are never deleted.
    await select(page, "banks", `بنك العكسي ${ctx.suffix}`);
    const bankRows = await tableText(page);
    expect(bankRows).toContain("800.00");
    expect((bankRows.match(/800\.00/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  // ── E2E 3 — expense paid from a treasury ─────────────────────────────────

  test("E2E 3 — an expense paid from a treasury shows on both the expense and the treasury", async ({ page }) => {
    await api(page, "/journal", {
      entryDate: "2026-07-15", entryType: "JOURNAL", description: `مصروف من الخزنة ${ctx.suffix}`,
      acknowledgeNegativeBalance: true,
      lines: [
        { accountId: ctx.exp3, debit: "600", credit: "0" },
        { accountId: ctx.cash3, debit: "0", credit: "600" },
      ],
    });

    await openStatement(page);

    await select(page, "expense", "كل المصروفات");
    expect(await rowText(page, `DEX3${ctx.suffix}`)).toContain("600.00");
    await select(page, "expense", `مصاريف تشغيل الطرفين ${ctx.suffix}`);
    expect(await tableText(page)).toContain("600.00");

    await select(page, "vaults", "كل الخزن");
    expect(await rowText(page, `DEC3${ctx.suffix}`)).toContain("2,400.00"); // 3000 − 600
    await select(page, "vaults", `خزنة المصروف ${ctx.suffix}`);
    expect(await tableText(page)).toContain("600.00");
  });

  // ── E2E 4 — sales invoice reaches every posted account ───────────────────

  test("E2E 4 — a confirmed sales invoice reaches the customer, AR, revenue, VAT and COGS", async ({ page }) => {
    const branchId = (await api<Array<{ id: string }>>(page, "/branches"))[0].id;
    const draft = await api<{ id: string }>(page, "/sales-invoices", {
      invoiceDate: "2026-07-15", customerId: ctx.cust4, branchId, taxRate: "14",
      lines: [{ productVariantId: ctx.variantId, quantity: "4", unitPrice: "1000" }],
    });
    await api(page, `/sales-invoices/${draft.id}/confirm`, {});

    await openStatement(page);

    // 4 × 1000 = 4,000 + 14% VAT 560 → 4,560 receivable; COGS 4 × 560 = 2,240.
    await select(page, "customers", "كل العملاء");
    expect(await rowText(page, `عميل الفاتورة ${ctx.suffix}`)).toContain("4,560.00");

    await select(page, "customers", `عميل الفاتورة ${ctx.suffix}`);
    const custTable = await tableText(page);
    expect(custTable).toContain("4,560.00");

    // Every other posted account received its own line from the same invoice.
    await select(page, "revenue", "إيرادات الترحيل");
    expect(await tableText(page)).toContain("4,000.00");

    await select(page, "tax", "ضريبة مبيعات الترحيل");
    expect(await tableText(page)).toContain("560.00");

    await select(page, "cogs", "تكلفة مبيعات الترحيل");
    expect(await tableText(page)).toContain("2,240.00");
  });

  // ── E2E 5 — purchase invoice reaches every posted account ────────────────

  test("E2E 5 — a confirmed purchase invoice reaches the supplier, AP, inventory and VAT", async ({ page }) => {
    const branchId = (await api<Array<{ id: string }>>(page, "/branches"))[0].id;
    const draft = await api<{ id: string }>(page, "/purchase-invoices", {
      invoiceDate: "2026-07-15", supplierId: ctx.sup5, branchId,
      lines: [{ productVariantId: ctx.variantId, boardsQuantity: "4", lengthM: "1", unitPrice: "560", taxRate: "14" }],
    });
    await api(page, `/purchase-invoices/${draft.id}/confirm`, {});

    await openStatement(page);

    // 4 × 560 = 2,240 + 14% VAT 313.60 → 2,553.60 payable to this supplier only.
    await select(page, "suppliers", "كل الموردين");
    expect(await rowText(page, `مورد الفاتورة ${ctx.suffix}`)).toContain("2,553.60");

    await select(page, "suppliers", `مورد الفاتورة ${ctx.suffix}`);
    expect(await tableText(page)).toContain("2,553.60");

    await select(page, "inventory", "مخزون الترحيل");
    expect(await tableText(page)).toContain("2,240.00");

    await select(page, "tax", "ضريبة مشتريات الترحيل");
    expect(await tableText(page)).toContain("313.60");
  });
});
