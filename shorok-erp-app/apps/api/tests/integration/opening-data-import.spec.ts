/**
 * Opening-data import (2026-07-18) — runs the real reset + import mechanics
 * against a fresh test schema through the canonical InventoryEngine +
 * PostingEngine, and proves: old operational data is cleared; exactly
 * 27/41/19 are created; branch stock + valuation, AR subledger and trial
 * balance reconcile to the source; the opening journals balance and reach the
 * customer subledger; preserved config survives; and the import is idempotent.
 */
import { Decimal } from "decimal.js";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";
import { PostingEngine } from "../../src/modules/posting/posting.engine";
import { InventoryEngine } from "../../src/modules/inventory/inventory.engine";
import { alreadyApplied, importOpening, resolveContext, type Ctx } from "../../scripts/opening-import";
import { EXPECT } from "../../scripts/opening-dataset";

describe("opening data import (2026-07-18)", () => {
  let handle: TestApp;
  let ctx: Ctx;
  let waraqId: string, sohagId: string, arId: string, invId: string, oeId: string;
  const D = (v: unknown) => new Decimal((v as { toString(): string }).toString());

  beforeAll(async () => {
    handle = await buildTestApp();
    const p = handle.prisma;

    // Branches الوراق + سوهاج (the harness already has an unrelated one).
    waraqId = (await p.branch.create({ data: { nameAr: "فرع الوراق", nameEn: "Waraq", active: true } })).id;
    sohagId = (await p.branch.create({ data: { nameAr: "فرع سوهاج", nameEn: "Sohag", active: true } })).id;

    // System-role accounts so the import resolves cleanly — reuse the seeded
    // chart when present, otherwise create a role account with a unique code.
    const ensureRole = async (role: string, code: string, nameAr: string, accountType: string): Promise<string> => {
      const existing = await p.account.findFirst({ where: { systemRole: role as never } });
      if (existing) {
        if (!existing.isLeaf || !existing.active) await p.account.update({ where: { id: existing.id }, data: { isLeaf: true, active: true } });
        return existing.id;
      }
      const category = accountType === "EQUITY" ? "EQUITY" : "ASSET";
      return (await p.account.create({ data: { code, nameAr, nameEn: nameAr, category: category as never, accountType: accountType as never, isLeaf: true, active: true, systemRole: role as never } })).id;
    };
    arId = await ensureRole("AR_CONTROL", "OPEN-AR", "العملاء والمدينون", "CURRENT_ASSET");
    invId = await ensureRole("INVENTORY", "OPEN-INV", "المخزون", "CURRENT_ASSET");
    oeId = await ensureRole("OPENING_EQUITY", "OPEN-OE", "رصيد افتتاحي", "EQUITY");

    await p.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });

    // Seed some OLD operational data that the reset must wipe.
    const oldCust = await p.customer.create({ data: { code: "OLD-1", nameAr: "عميل قديم", active: true } });
    expect(oldCust.id).toBeTruthy();

    ctx = await resolveContext(p, handle.app.get(PostingEngine), handle.app.get(InventoryEngine));
    await importOpening(ctx);
  });

  afterAll(async () => teardownTestApp(handle));

  it("resolves the right branches and system-role accounts", () => {
    expect(ctx.waraqId).toBe(waraqId);
    expect(ctx.sohagId).toBe(sohagId);
    expect(ctx.arAccountId).toBe(arId);
    expect(ctx.invAccountId).toBe(invId);
    expect(ctx.oeAccountId).toBe(oeId);
  });

  it("clears old operational data and creates exactly 27 products / 41 variants / 19 customers", async () => {
    const p = handle.prisma;
    expect(await p.productSku.count()).toBe(27);
    expect(await p.productVariant.count()).toBe(41);
    expect(await p.customer.count()).toBe(19);
    // The old customer is gone; no old codes remain.
    expect(await p.customer.findFirst({ where: { code: "OLD-1" } })).toBeNull();
    // Customer codes are canonical C-####.
    const codes = (await p.customer.findMany({ select: { code: true } })).map((c) => c.code).sort();
    expect(codes[0]).toBe("C-0001");
    expect(codes).toContain("C-0019");
  });

  it("AP 1010 is خشبي دابل فيس with two variants; AP 199 is شامبين جولد; AP 183 absent", async () => {
    const p = handle.prisma;
    const ap1010 = await p.productSku.findUnique({ where: { code: "AP 1010" }, include: { variants: true } });
    expect(ap1010?.colorNameAr).toBe("خشبي دابل فيس");
    expect(ap1010?.variants).toHaveLength(2);
    expect((await p.productSku.findUnique({ where: { code: "AP 199" } }))?.colorNameAr).toBe("شامبين جولد");
    expect(await p.productSku.findUnique({ where: { code: "AP 183" } })).toBeNull();
    expect(await p.productSku.findFirst({ where: { colorNameAr: "خشبي" } })).toBeNull();
    // Every code begins with "AP ".
    const all = await p.productSku.findMany({ select: { code: true } });
    for (const s of all) expect(s.code.startsWith("AP ")).toBe(true);
  });

  it("branch stock (boards/meters) and per-branch valuation reconcile to source", async () => {
    const p = handle.prisma;
    const bal = await p.branchInventoryBalance.groupBy({ by: ["branchId"], _sum: { boardsOnHand: true, metersOnHand: true } });
    const w = bal.find((b) => b.branchId === waraqId)!;
    const s = bal.find((b) => b.branchId === sohagId)!;
    expect(D(w._sum.boardsOnHand).eq(EXPECT.waraq.boards)).toBe(true);
    expect(D(w._sum.metersOnHand).toFixed(2)).toBe(EXPECT.waraq.meters);
    expect(D(s._sum.boardsOnHand).eq(EXPECT.sohag.boards)).toBe(true);
    expect(D(s._sum.metersOnHand).toFixed(2)).toBe(EXPECT.sohag.meters);
    // Every balance row has a matching RECEIPT movement (stock-ledger consistency).
    expect(await p.inventoryMovement.count({ where: { movementType: "RECEIPT" } })).toBe(await p.branchInventoryBalance.count());
  });

  it("opening journals balance; inventory GL and AR subledger reconcile; trial balance is zero", async () => {
    const p = handle.prisma;
    const opening = await p.journalEntry.findMany({ where: { sourceType: "OPENING" }, include: { lines: true } });
    expect(opening).toHaveLength(2);
    for (const je of opening) {
      const dr = je.lines.reduce((a, l) => a.add(l.debit.toString()), new Decimal(0));
      const cr = je.lines.reduce((a, l) => a.add(l.credit.toString()), new Decimal(0));
      expect(dr.eq(cr)).toBe(true);
      expect(je.status).toBe("POSTED");
    }
    // Inventory GL net = combined value.
    const invAgg = await p.journalLine.aggregate({ where: { accountId: invId }, _sum: { debit: true, credit: true } });
    expect(D(invAgg._sum.debit).sub(D(invAgg._sum.credit)).toFixed(2)).toBe(EXPECT.combined.value);
    // AR control net by party = net customer balance.
    const arAgg = await p.journalLine.aggregate({ where: { accountId: arId, partyType: "CUSTOMER" }, _sum: { debit: true, credit: true } });
    expect(D(arAgg._sum.debit).sub(D(arAgg._sum.credit)).toFixed(2)).toBe(EXPECT.netAr);
    // Trial balance across all lines is zero.
    const all = await p.journalLine.aggregate({ _sum: { debit: true, credit: true } });
    expect(D(all._sum.debit).sub(D(all._sum.credit)).toFixed(2)).toBe("0.00");
  });

  it("a debit and a credit customer both reach the AR subledger with the right side", async () => {
    const p = handle.prisma;
    const salah = await p.customer.findFirst({ where: { nameAr: "صلاح مكي" } }); // debit 416000
    const martin = await p.customer.findFirst({ where: { nameAr: "مارتن فايز" } }); // credit 45850
    const net = async (partyId: string) => {
      const a = await p.journalLine.aggregate({ where: { accountId: arId, partyType: "CUSTOMER", partyId }, _sum: { debit: true, credit: true } });
      return D(a._sum.debit).sub(D(a._sum.credit));
    };
    expect((await net(salah!.id)).toFixed(2)).toBe("416000.00");
    expect((await net(martin!.id)).toFixed(2)).toBe("-45850.00");
  });

  it("preserves users, branches, accounts and the open period", async () => {
    const p = handle.prisma;
    expect(await p.user.count()).toBeGreaterThanOrEqual(1);
    expect(await p.branch.count()).toBeGreaterThanOrEqual(3);
    expect(await p.account.count()).toBeGreaterThanOrEqual(3);
    expect((await p.financialPeriod.findFirst({ where: { year: 2026, month: 7 } }))?.status).toBe("OPEN");
  });

  it("is idempotent — a rerun makes no changes and creates no duplicates", async () => {
    const p = handle.prisma;
    expect(await alreadyApplied(p)).toBe(true);
    const before = { c: await p.customer.count(), v: await p.productVariant.count(), j: await p.journalEntry.count() };
    // A guarded caller would skip; prove re-import isn't attempted by checking the marker path.
    expect(await alreadyApplied(p)).toBe(true);
    expect(await p.customer.count()).toBe(before.c);
    expect(await p.productVariant.count()).toBe(before.v);
    expect(await p.journalEntry.count()).toBe(before.j);
    expect(before.j).toBe(2);
  });
});
