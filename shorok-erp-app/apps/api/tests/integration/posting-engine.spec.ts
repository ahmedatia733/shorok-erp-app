/**
 * Phase 2 — PostingEngine + ReversalService invariants (T014/T015/T016/T022).
 *
 * Exercises the engine against the real test schema through the Nest container,
 * proving the 7 invariants, idempotency, reversal round-trip, and a property
 * check that random valid postings keep the trial balance balanced.
 */
import { Decimal } from "decimal.js";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";
import { PostingEngine } from "../../src/modules/posting/posting.engine";
import { ReversalService } from "../../src/modules/posting/reversal.service";
import type { AuthenticatedUser } from "../../src/common/types/request-user";

describe("PostingEngine (Phase 2 foundation)", () => {
  let handle: TestApp;
  let engine: PostingEngine;
  let reversal: ReversalService;
  let actor: AuthenticatedUser;

  // account ids
  let cash: string;      // ASSET leaf
  let revenue: string;   // REVENUE leaf
  let arControl: string; // ASSET leaf with system_role AR_CONTROL
  let parent: string;    // non-leaf
  let inactive: string;  // leaf but inactive
  let customerId: string;

  const DATE = "2026-07-15"; // → period 2026-07

  const mkEntry = (over: Partial<Parameters<PostingEngine["post"]>[0]> = {}) => ({
    actor,
    sourceType: "MANUAL" as const,
    entryDate: DATE,
    description: "test entry",
    idempotencyKey: `test-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    lines: [
      { accountId: cash, debit: "100.00", credit: "0" },
      { accountId: revenue, debit: "0", credit: "100.00" },
    ],
    ...over,
  });

  beforeAll(async () => {
    handle = await buildTestApp();
    engine = handle.app.get(PostingEngine);
    reversal = handle.app.get(ReversalService);
    actor = { id: handle.ownerId, name: "Tester", phone: "+20100", email: null, role: "OWNER", status: "ACTIVE", allowedBranches: [] };

    const acc = (
      code: string,
      nameAr: string,
      category: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "COST_OF_SALES" | "EXPENSE",
      accountType: "CURRENT_ASSET" | "FIXED_ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "COST_OF_SALES" | "EXPENSE",
      extra: Record<string, unknown> = {},
    ) =>
      handle.prisma.account.create({
        data: { code, nameAr, nameEn: nameAr, category, accountType, isLeaf: true, active: true, ...extra },
      });
    cash = (await acc("T1001", "نقدية اختبار", "ASSET", "CURRENT_ASSET")).id;
    revenue = (await acc("T4001", "إيراد اختبار", "REVENUE", "REVENUE")).id;
    arControl = (await acc("T1100", "عملاء اختبار", "ASSET", "CURRENT_ASSET", { systemRole: "AR_CONTROL" })).id;
    parent = (await acc("T2000", "أب اختبار", "LIABILITY", "LIABILITY", { isLeaf: false })).id;
    inactive = (await acc("T9999", "معطّل", "EXPENSE", "EXPENSE", { active: false })).id;
    const cust = await handle.prisma.customer.create({ data: { code: "TC-1", nameAr: "عميل اختبار" } });
    customerId = cust.id;

    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
  });

  afterAll(async () => teardownTestApp(handle));

  // ── Invariant 1: balanced ──────────────────────────────────────────────────
  it("rejects an unbalanced entry", async () => {
    await expect(
      engine.post(mkEntry({ lines: [
        { accountId: cash, debit: "100.00", credit: "0" },
        { accountId: revenue, debit: "0", credit: "90.00" },
      ] })),
    ).rejects.toMatchObject({ details: { reason: "unbalanced_journal_entry" } });
  });

  // ── Invariant 2: debit XOR credit ──────────────────────────────────────────
  it("rejects a line with both debit and credit non-zero", async () => {
    await expect(
      engine.post(mkEntry({ lines: [
        { accountId: cash, debit: "100.00", credit: "100.00" },
        { accountId: revenue, debit: "0", credit: "100.00" },
      ] })),
    ).rejects.toMatchObject({ details: { reason: "line_not_debit_xor_credit" } });
  });

  it("rejects amounts beyond 2 decimal places", async () => {
    await expect(
      engine.post(mkEntry({ lines: [
        { accountId: cash, debit: "100.001", credit: "0" },
        { accountId: revenue, debit: "0", credit: "100.001" },
      ] })),
    ).rejects.toMatchObject({ details: { reason: "amount_exceeds_2dp" } });
  });

  // ── Invariant 3: period open ───────────────────────────────────────────────
  it("rejects when no period exists for the entry date", async () => {
    await expect(engine.post(mkEntry({ entryDate: "2025-01-10" }))).rejects.toMatchObject({
      details: { reason: "period_not_open" },
    });
  });

  it("rejects posting into a CLOSED period", async () => {
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 3, status: "CLOSED" } });
    await expect(engine.post(mkEntry({ entryDate: "2026-03-10" }))).rejects.toMatchObject({
      details: { reason: "period_closed" },
    });
  });

  // ── Invariant 4: postable accounts + party on control ──────────────────────
  it("rejects posting to a non-leaf account", async () => {
    await expect(
      engine.post(mkEntry({ lines: [
        { accountId: cash, debit: "50.00", credit: "0" },
        { accountId: parent, debit: "0", credit: "50.00" },
      ] })),
    ).rejects.toMatchObject({ details: { reason: "account_not_postable" } });
  });

  it("rejects posting to an inactive account", async () => {
    await expect(
      engine.post(mkEntry({ lines: [
        { accountId: cash, debit: "50.00", credit: "0" },
        { accountId: inactive, debit: "0", credit: "50.00" },
      ] })),
    ).rejects.toMatchObject({ details: { reason: "account_not_postable" } });
  });

  it("requires a party on an AR/AP control account", async () => {
    await expect(
      engine.post(mkEntry({ lines: [
        { accountId: arControl, debit: "100.00", credit: "0" }, // no party
        { accountId: revenue, debit: "0", credit: "100.00" },
      ] })),
    ).rejects.toMatchObject({ details: { reason: "party_required_on_control_account" } });
  });

  it("accepts a control-account line WITH a party", async () => {
    const res = await engine.post(mkEntry({ lines: [
      { accountId: arControl, debit: "100.00", credit: "0", partyType: "CUSTOMER", partyId: customerId },
      { accountId: revenue, debit: "0", credit: "100.00" },
    ] }));
    expect(res.idempotent).toBe(false);
    const lines = await handle.prisma.journalLine.findMany({ where: { journalEntryId: res.journalEntryId } });
    expect(lines.find((l) => l.accountId === arControl)?.partyId).toBe(customerId);
  });

  // ── Happy path + sequence numbering ────────────────────────────────────────
  it("posts a balanced entry, numbers it from the sequence, and audits it", async () => {
    const res1 = await engine.post(mkEntry());
    const res2 = await engine.post(mkEntry());
    expect(res2.entryNumber).toBeGreaterThan(res1.entryNumber); // monotonic, sequence-driven
    const entry = await handle.prisma.journalEntry.findUnique({ where: { id: res1.journalEntryId }, include: { lines: true } });
    expect(entry?.status).toBe("POSTED");
    expect(entry?.sourceType).toBe("MANUAL");
    expect(entry?.periodId).not.toBeNull();
    const audit = await handle.prisma.auditLog.findFirst({ where: { entityType: "journal_entry", entityId: res1.journalEntryId } });
    expect(audit).not.toBeNull();
  });

  // ── Invariant 6: idempotency ───────────────────────────────────────────────
  it("does not double-post for the same idempotency key", async () => {
    const key = `idem-${Date.now()}`;
    const first = await engine.post(mkEntry({ idempotencyKey: key }));
    const second = await engine.post(mkEntry({ idempotencyKey: key }));
    expect(second.idempotent).toBe(true);
    expect(second.journalEntryId).toBe(first.journalEntryId);
    const count = await handle.prisma.journalEntry.count({ where: { idempotencyKey: key } });
    expect(count).toBe(1);
  });

  // ── Reversal (Constitution VII) ────────────────────────────────────────────
  it("reverses a posted entry with a linked mirrored entry and marks it REVERSED", async () => {
    const posted = await engine.post(mkEntry());
    const rev = await reversal.reverse({ entryId: posted.journalEntryId, reason: "خطأ إدخال", actor });

    const original = await handle.prisma.journalEntry.findUnique({ where: { id: posted.journalEntryId } });
    const mirror = await handle.prisma.journalEntry.findUnique({ where: { id: rev.journalEntryId }, include: { lines: true } });
    expect(original?.status).toBe("REVERSED");
    expect(mirror?.reversalOfId).toBe(posted.journalEntryId);
    // debit/credit swapped
    const cashLine = mirror?.lines.find((l) => l.accountId === cash);
    expect(new Decimal(cashLine!.credit.toString()).toString()).toBe("100");
  });

  it("refuses to reverse an already-reversed entry (sequential re-reverse is an error)", async () => {
    const posted = await engine.post(mkEntry());
    await reversal.reverse({ entryId: posted.journalEntryId, reason: "once", actor });
    // The original is now REVERSED; a second sequential reverse hits the
    // status guard (the idempotency key only protects concurrent races).
    await expect(
      reversal.reverse({ entryId: posted.journalEntryId, reason: "twice", actor }),
    ).rejects.toMatchObject({ details: { reason: "entry_not_reversible" } });
  });

  // ── Property: random valid postings keep the trial balance balanced ────────
  it("keeps the global trial balance balanced across many random postings", async () => {
    for (let i = 0; i < 25; i++) {
      const amount = (Math.floor(Math.random() * 100000) / 100).toFixed(2);
      await engine.post(mkEntry({ lines: [
        { accountId: cash, debit: amount, credit: "0" },
        { accountId: revenue, debit: "0", credit: amount },
      ] }));
    }
    const agg = await handle.prisma.journalLine.aggregate({ _sum: { debit: true, credit: true } });
    expect(new Decimal(agg._sum.debit!.toString()).eq(new Decimal(agg._sum.credit!.toString()))).toBe(true);
  });
});
