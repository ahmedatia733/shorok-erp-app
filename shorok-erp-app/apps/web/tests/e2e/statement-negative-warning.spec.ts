/**
 * Section L / Flow 6 — a posting (and its reversal) must appear immediately in
 * BOTH the specific statement and its consolidated category, with no re-login
 * and no cached balance, and the read-only statement endpoint must never warn or
 * block on a negative treasury.
 *
 * The 409 warning itself is asserted in the API integration suite
 * (consolidated-statement.spec "26"), because the guard keys off the
 * isCashOrBank/treasuryType config that only migrations can set — POST /accounts
 * cannot create a real treasury, so a browser fixture can't trigger the warning.
 * Nothing here touches production.
 */
import { expect, test, type Page } from "@playwright/test";

const API = "http://localhost:3001/api/v1";

interface Ctx {
  cashA: string;
  expOps: string;
  suffix: string;
}

async function api<T>(page: Page, path: string, token: string | null, body?: unknown, method?: string): Promise<T> {
  return page.evaluate(
    async ({ api, path, token, body, method }) => {
      const res = await fetch(api + path, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        credentials: "include",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
      return res.json();
    },
    { api: API, path, token, body, method },
  ) as Promise<T>;
}

async function loginToken(page: Page): Promise<string> {
  await page.goto("/ar/login");
  const r = await api<{ accessToken: string }>(page, "/auth/login", null, {
    phone: "+201000000000",
    password: "Owner@2026",
  });
  return r.accessToken;
}

test.describe("negative treasury warning + statement sync", () => {
  let ctx: Ctx;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const token = await loginToken(page);
    const u = Date.now().toString().slice(-6);
    try {
      await api(page, "/settings/periods", token, { year: 2026, month: 7 });
    } catch {
      /* already open */
    }
    // An unfunded treasury: any spend from it projects a negative balance.
    const cashA = (await api<{ id: string }>(page, "/accounts", token, {
      code: `NEGC${u}`, nameAr: `خزنة تحذير ${u}`, nameEn: `Warn Vault ${u}`,
      category: "ASSET", accountType: "CURRENT_ASSET",
    })).id;
    const expOps = (await api<{ id: string }>(page, "/accounts", token, {
      code: `NEGX${u}`, nameAr: `مصروف تحذير ${u}`, nameEn: `Warn Exp ${u}`,
      category: "EXPENSE", accountType: "EXPENSE",
    })).id;
    ctx = { cashA, expOps, suffix: u };
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    const token = await loginToken(page);
    for (const id of [ctx.cashA, ctx.expOps]) {
      await api(page, `/accounts/${id}`, token, { active: false }, "PATCH").catch(() => undefined);
    }
    await page.close();
  });

  test("Flow 6 — a posting and its reversal update the specific and consolidated statements immediately", async ({ page }) => {
    const token = await loginToken(page);

    /** Raw post so the typed 409 body can be asserted rather than thrown away. */
    const spend = (acknowledge: boolean) =>
      page.evaluate(
        async ({ api, token, body }) => {
          const r = await fetch(`${api}/journal`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
          });
          return { status: r.status, body: await r.json() };
        },
        {
          api: API,
          token,
          body: {
            entryDate: "2026-07-15",
            entryType: "JOURNAL",
            description: `تحذير رصيد سالب ${ctx.suffix}`,
            ...(acknowledge ? { acknowledgeNegativeBalance: true, negativeBalanceReason: "اختبار" } : {}),
            lines: [
              { accountId: ctx.expOps, debit: "1000", credit: "0" },
              { accountId: ctx.cashA, debit: "0", credit: "1000" },
            ],
          },
        },
      );

    const statement = (category: string, entityId?: string) =>
      api<{ endingBalance: string; breakdown: { entityId: string; endingBalance: string }[] }>(
        page,
        `/statements/consolidated?category=${category}${entityId ? `&entityId=${entityId}` : ""}`,
        token,
      );

    // Starts empty.
    expect((await statement("vaults", ctx.cashA)).endingBalance).toBe("0.00");

    const posted = await spend(true);
    expect(posted.status).toBeLessThan(300);
    expect(posted.body.id).toBeTruthy();

    // 6) The specific treasury statement reflects it immediately — no re-login.
    const specific = await statement("vaults", ctx.cashA);
    expect(specific.endingBalance).toBe("-1000.00");

    // 7) …and so does the consolidated category.
    const consolidated = await statement("vaults");
    const mine = consolidated.breakdown.find((b) => b.entityId === ctx.cashA);
    expect(mine?.endingBalance).toBe("-1000.00");

    // 8) Reversing returns both to zero, with both rows still visible.
    await api(page, `/journal/${posted.body.id}/reverse`, token, {
      reason: "إلغاء اختبار",
      acknowledgeNegativeBalance: true,
    });
    expect((await statement("vaults", ctx.cashA)).endingBalance).toBe("0.00");
    const afterAll = await statement("vaults");
    expect(afterAll.breakdown.find((b) => b.entityId === ctx.cashA)?.endingBalance).toBe("0.00");
  });

  test("the read-only statement endpoint never warns, even on a negative treasury", async ({ page }) => {
    const token = await loginToken(page);
    // Post a negative-projecting entry with acknowledgement, then read it back.
    await api(page, "/journal", token, {
      entryDate: "2026-07-15", entryType: "JOURNAL", description: `قراءة سالبة ${ctx.suffix}`,
      acknowledgeNegativeBalance: true, negativeBalanceReason: "اختبار",
      lines: [
        { accountId: ctx.expOps, debit: "250", credit: "0" },
        { accountId: ctx.cashA, debit: "0", credit: "250" },
      ],
    });

    // Reading a negative treasury is a plain 200 — the guard lives in posting.
    const res = await page.evaluate(
      async ({ api, id, token }) => {
        const r = await fetch(`${api}/statements/consolidated?category=vaults&entityId=${id}`, {
          credentials: "include",
          headers: { authorization: `Bearer ${token}` },
        });
        return { status: r.status, body: await r.json() };
      },
      { api: API, id: ctx.cashA, token },
    );
    expect(res.status).toBe(200);
    expect(res.body.endingBalance).toBe("-250.00");
  });
});
