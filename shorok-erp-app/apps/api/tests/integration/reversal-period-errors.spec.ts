/**
 * Reversal policy A + D.
 *
 * A — the accounting date semantics are unchanged: a reversal still posts at
 *     today's date, and the FinancialPeriod guard is still enforced.
 * D — a missing or closed period now produces a specific, actionable message in
 *     Arabic and English instead of a generic validation failure.
 *
 * The point of these tests is that D did NOT weaken A.
 */

import { I18nService } from "nestjs-i18n";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";
import { PostingEngine } from "../../src/modules/posting/posting.engine";
import type { ApiError } from "../../src/common/errors/api-errors";
import type { AuthenticatedUser } from "../../src/common/types/request-user";

let app: TestApp;
let posting: PostingEngine;
let i18n: I18nService;
let actor: AuthenticatedUser;
let debitAccountId: string;
let creditAccountId: string;

async function leafAccount(code: string, nameAr: string) {
  return app.prisma.account.create({
    data: {
      code,
      nameAr,
      nameEn: nameAr,
      category: "EXPENSE",
      accountType: "EXPENSE",
      isLeaf: true,
      active: true,
    },
  });
}

function postAt(entryDate: string) {
  return posting.post({
    actor,
    entryDate,
    entryType: "MANUAL",
    sourceType: "MANUAL",
    description: "period guard probe",
    idempotencyKey: `period-probe:${entryDate}:${Math.random()}`,
    // branchId is a per-LINE dimension, not a request-level field.
    lines: [
      { accountId: debitAccountId, debit: "10.00", credit: "0.00", branchId: app.branchId },
      { accountId: creditAccountId, debit: "0.00", credit: "10.00", branchId: app.branchId },
    ],
  });
}

beforeAll(async () => {
  app = await buildTestApp();
  posting = app.app.get(PostingEngine);
  i18n = app.app.get(I18nService);
  actor = {
    id: app.ownerId,
    name: "Period Probe",
    phone: app.ownerPhone,
    email: null,
    role: "OWNER",
    status: "ACTIVE",
    allowedBranches: [app.branchId],
  };
  const suffix = Date.now().toString(36);
  debitAccountId = (await leafAccount(`PGD-${suffix}`, "حساب اختبار مدين")).id;
  creditAccountId = (await leafAccount(`PGC-${suffix}`, "حساب اختبار دائن")).id;
}, 60_000);

afterAll(async () => {
  await teardownTestApp(app);
});

describe("A — the period guard is still enforced", () => {
  it("refuses to post into a month that has no period at all", async () => {
    await expect(postAt("2019-04-10")).rejects.toMatchObject({
      status: 409,
      details: { reason: "period_not_open", year: 2019, month: 4 },
    });
  });

  it("refuses to post into a CLOSED period", async () => {
    await app.prisma.financialPeriod.upsert({
      where: { year_month: { year: 2019, month: 5 } },
      update: { status: "CLOSED" },
      create: { year: 2019, month: 5, status: "CLOSED" },
    });
    await expect(postAt("2019-05-10")).rejects.toMatchObject({
      status: 409,
      details: { reason: "period_closed", year: 2019, month: 5 },
    });
  });

  it("still posts normally into an OPEN period", async () => {
    await app.prisma.financialPeriod.upsert({
      where: { year_month: { year: 2019, month: 6 } },
      update: { status: "OPEN" },
      create: { year: 2019, month: 6, status: "OPEN" },
    });
    const result = await postAt("2019-06-10");
    expect(result.journalEntryId).toBeTruthy();
  });
});

describe("D — the failure is specific and actionable", () => {
  it("carries a dedicated i18n key rather than the generic validation one", async () => {
    await expect(postAt("2019-07-10")).rejects.toMatchObject({
      i18nKey: "errors.period_not_open",
    });
    await app.prisma.financialPeriod.upsert({
      where: { year_month: { year: 2019, month: 8 } },
      update: { status: "CLOSED" },
      create: { year: 2019, month: 8, status: "CLOSED" },
    });
    await expect(postAt("2019-08-10")).rejects.toMatchObject({
      i18nKey: "errors.period_closed",
    });
  });

  it("renders an Arabic message that names the month and the fix", async () => {
    let error: ApiError | null = null;
    await postAt("2019-09-10").catch((e) => {
      error = e as ApiError;
    });
    expect(error).not.toBeNull();

    const message = (await i18n.translate(error!.i18nKey, {
      lang: "ar",
      args: error!.details ?? {},
    })) as string;

    expect(message).toContain("9");
    expect(message).toContain("2019");
    expect(message).toContain("الفترة المالية");
    expect(message).toContain("الفترات المالية"); // where to go
    // It must no longer be the generic message.
    const generic = (await i18n.translate("errors.validation_failed", { lang: "ar" })) as string;
    expect(message).not.toBe(generic);
  });

  it("renders an English message that names the month and the fix", async () => {
    let error: ApiError | null = null;
    await postAt("2019-10-10").catch((e) => {
      error = e as ApiError;
    });
    expect(error).not.toBeNull();

    const message = (await i18n.translate(error!.i18nKey, {
      lang: "en",
      args: error!.details ?? {},
    })) as string;

    expect(message).toContain("10");
    expect(message).toContain("2019");
    expect(message.toLowerCase()).toContain("financial period");
    expect(message.toLowerCase()).toContain("settings");
  });

  it("does not auto-open the period as a side effect of failing", async () => {
    await postAt("2019-11-10").catch(() => undefined);
    const period = await app.prisma.financialPeriod.findUnique({
      where: { year_month: { year: 2019, month: 11 } },
    });
    expect(period).toBeNull();
  });
});
