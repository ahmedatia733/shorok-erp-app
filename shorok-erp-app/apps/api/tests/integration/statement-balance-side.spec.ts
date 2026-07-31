/**
 * Customer statement balance-side filter (balanceSide=ALL|DEBIT|CREDIT).
 * Classifies each customer by its FINAL balance for the period
 * (finalBalance = opening + debit − credit; >0 DEBIT, <0 CREDIT, =0 excluded),
 * then recomputes the aggregate cards + movement rows from ONLY the retained
 * customers. Proves classification, zero exclusion, opening + date-range effects,
 * that cards/count/movements match the filtered population, specific-customer
 * pass-through, and validation. LOCAL test schema only.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

const D = (v: unknown) => new Decimal((v as { toString(): string }).toString());

describe("statement — customer balance-side filter", () => {
  let h: TestApp;
  let token: string;
  let arId: string, revId: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const srv = () => h.app.getHttpServer();

  // Customers: A debit, B credit, C zero-with-movement, D opening-only debit,
  // E flips by date (debit before window, credit inside window).
  const cust: Record<string, string> = {};

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(srv()).post("/api/v1/auth/login").send({ phone: h.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    const u = Date.now().toString().slice(-6);
    arId = (await h.prisma.account.create({ data: { code: `AR${u}`, nameAr: "ذمم عملاء", nameEn: "AR", category: "ASSET", accountType: "CURRENT_ASSET", isLeaf: true, active: true, systemRole: "AR_CONTROL" } })).id;
    revId = (await h.prisma.account.create({ data: { code: `RV${u}`, nameAr: "إيراد", nameEn: "Rev", category: "REVENUE", accountType: "REVENUE", isLeaf: true, active: true } })).id;
    for (const k of ["A", "B", "C", "D", "E"]) cust[k] = (await h.prisma.customer.create({ data: { code: `BS-${k}-${u}`, nameAr: `عميل ${k} ${u}` } })).id;
    for (const m of [5, 6, 7, 8]) await h.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });
  });
  afterAll(async () => teardownTestApp(h));

  // Post an AR debit or credit for a customer on a date (revenue is the balancer).
  const post = async (date: string, custId: string, arDebit: string, arCredit: string) => {
    const lines = [
      { accountId: arId, debit: arDebit, credit: arCredit, partyType: "CUSTOMER", partyId: custId },
      { accountId: revId, debit: arCredit, credit: arDebit },
    ];
    const r = await request(srv()).post("/api/v1/journal").set(auth()).send({ entryDate: date, entryType: "JOURNAL", description: `bs ${date}`, acknowledgeNegativeBalance: true, lines });
    expect(r.status).toBeLessThan(300);
  };

  const stmt = (q: string) => request(srv()).get(`/api/v1/statements/consolidated?category=customers&${q}`).set(auth());
  const ids = (body: any) => new Set<string>(body.breakdown.map((b: any) => b.entityId));
  const byId = (body: any, id: string) => body.breakdown.find((b: any) => b.entityId === id);

  it("classifies customers by final balance; ALL == missing; DEBIT/CREDIT exclude zero", async () => {
    await post("2026-07-10", cust.A, "1000", "0"); // A: +1000 → DEBIT
    await post("2026-07-10", cust.B, "0", "500");  // B: −500  → CREDIT
    await post("2026-07-10", cust.C, "300", "0");  // C: debit then credit → 0 (with movement)
    await post("2026-07-11", cust.C, "0", "300");
    await post("2026-06-01", cust.D, "800", "0");  // D: opening-only debit (before any window) → DEBIT

    const all = (await stmt("balanceSide=ALL")).body;
    const missing = (await stmt("")).body; // no balanceSide → same as ALL
    expect(ids(missing)).toEqual(ids(all));
    // ALL includes A, B and C (C has movement though it nets to zero).
    for (const k of ["A", "B", "C", "D"]) expect(ids(all).has(cust[k])).toBe(true);
    expect(D(byId(all, cust.A).endingBalance).toFixed(2)).toBe("1000.00");
    expect(D(byId(all, cust.B).endingBalance).toFixed(2)).toBe("-500.00");
    expect(D(byId(all, cust.C).endingBalance).toFixed(2)).toBe("0.00");

    const debit = (await stmt("balanceSide=DEBIT")).body;
    expect(ids(debit).has(cust.A)).toBe(true);
    expect(ids(debit).has(cust.D)).toBe(true);
    expect(ids(debit).has(cust.B)).toBe(false);
    expect(ids(debit).has(cust.C)).toBe(false); // zero excluded
    expect(debit.breakdown.every((b: any) => D(b.endingBalance).gt(0))).toBe(true);

    const credit = (await stmt("balanceSide=CREDIT")).body;
    expect(ids(credit).has(cust.B)).toBe(true);
    expect(ids(credit).has(cust.A)).toBe(false);
    expect(ids(credit).has(cust.C)).toBe(false); // zero excluded
    expect(credit.breakdown.every((b: any) => D(b.endingBalance).lt(0))).toBe(true);
  });

  it("aggregate cards, count and movements match the filtered population", async () => {
    const debit = (await stmt("balanceSide=DEBIT")).body;
    // Cards == sum of only the retained rows.
    const sum = (f: (b: any) => Decimal) => debit.breakdown.reduce((a: Decimal, b: any) => a.plus(f(b)), new Decimal(0));
    expect(D(debit.openingBalance).toFixed(2)).toBe(sum((b) => D(b.openingBalance)).toFixed(2));
    expect(D(debit.periodDebit).toFixed(2)).toBe(sum((b) => D(b.debit)).toFixed(2));
    expect(D(debit.periodCredit).toFixed(2)).toBe(sum((b) => D(b.credit)).toFixed(2));
    expect(D(debit.endingBalance).toFixed(2)).toBe(sum((b) => D(b.endingBalance)).toFixed(2));
    // Movement rows belong ONLY to the retained customers.
    const retained = ids(debit);
    expect(debit.rows.length).toBeGreaterThan(0);
    expect(debit.rows.every((r: any) => retained.has(r.partyId))).toBe(true);
    // The excluded credit customer B never leaks into a DEBIT movement.
    expect(debit.rows.some((r: any) => r.partyId === cust.B)).toBe(false);
  });

  it("opening balance is included in classification and the date range can flip the side", async () => {
    await post("2026-06-15", cust.E, "1000", "0"); // before window
    await post("2026-07-15", cust.E, "0", "1500");  // inside window

    // Whole history: 1000 − 1500 = −500 → CREDIT.
    expect(ids((await stmt("balanceSide=CREDIT")).body).has(cust.E)).toBe(true);
    expect(ids((await stmt("balanceSide=DEBIT")).body).has(cust.E)).toBe(false);

    // Window ending 2026-06-30 sees only the +1000 debit → DEBIT.
    expect(ids((await stmt("balanceSide=DEBIT&to=2026-06-30")).body).has(cust.E)).toBe(true);
    expect(ids((await stmt("balanceSide=CREDIT&to=2026-06-30")).body).has(cust.E)).toBe(false);

    // From 2026-07-01 the +1000 is the OPENING; it still classifies (opening − 1500 = −500 → CREDIT).
    const fromWin = (await stmt("balanceSide=CREDIT&from=2026-07-01")).body;
    const e = byId(fromWin, cust.E);
    expect(D(e.openingBalance).toFixed(2)).toBe("1000.00");
    expect(D(e.endingBalance).toFixed(2)).toBe("-500.00");
  });

  it("a specific customer is always returned, regardless of balanceSide", async () => {
    // B is a CREDIT customer; asking for it with balanceSide=DEBIT must still return it.
    const r = await stmt(`entityId=${cust.B}&balanceSide=DEBIT`);
    expect(r.status).toBe(200);
    expect(r.body.entityId).toBe(cust.B);
    expect(r.body.breakdown).toHaveLength(1);
    expect(r.body.breakdown[0].entityId).toBe(cust.B);
    expect(D(r.body.endingBalance).lt(0)).toBe(true);
  });

  it("rejects an invalid balanceSide and requires auth", async () => {
    expect((await stmt("balanceSide=WHATEVER")).status).toBe(400);
    expect((await request(srv()).get(`/api/v1/statements/consolidated?category=customers&balanceSide=DEBIT`)).status).toBe(401);
  });
});
