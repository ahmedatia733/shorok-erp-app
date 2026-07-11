/**
 * Phase 3D (Commit 1) — core reversal hardening.
 * POST /journal/:id/reverse mirrors a posted entry through the PostingEngine,
 * marks the original REVERSED, links reversalOfId, preserves party/branch
 * dimensions, nets to zero, and is idempotent. DELETE /journal/:id is blocked.
 * Closed/missing period rejects atomically. Legacy manual entries reverse too.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("reversal hardening — journal reverse (Phase 3D)", () => {
  let handle: TestApp;
  let ownerToken: string;
  let cashAccountId: string;
  let apAccountId: string;
  let plainAccountId: string;
  let supplierId: string;

  const auth = () => ({ Authorization: `Bearer ${ownerToken}` });
  const server = () => handle.app.getHttpServer();

  beforeAll(async () => {
    handle = await buildTestApp();
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    ownerToken = (
      await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" })
    ).body.accessToken;

    const uniq = Date.now().toString().slice(-6);
    cashAccountId = (
      await handle.prisma.account.create({
        data: { code: `RCASH${uniq}`, nameAr: "خزينة", nameEn: "Cash", category: "ASSET", accountType: "CURRENT_ASSET", isLeaf: true, active: true },
      })
    ).id;
    apAccountId = (
      await handle.prisma.account.create({
        data: { code: `RAP${uniq}`, nameAr: "موردون", nameEn: "AP", category: "LIABILITY", accountType: "LIABILITY", isLeaf: true, active: true, systemRole: "AP_CONTROL" as never },
      })
    ).id;
    plainAccountId = (
      await handle.prisma.account.create({
        data: { code: `RPL${uniq}`, nameAr: "أخرى", nameEn: "Other", category: "LIABILITY", accountType: "LIABILITY", isLeaf: true, active: true },
      })
    ).id;
    supplierId = (await handle.prisma.supplier.create({ data: { nameAr: "مورد عكس", nameEn: "Rev Supplier" } })).id;

    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
  });

  afterAll(async () => teardownTestApp(handle));

  // A posted 2-line entry with party + branch dimensions on the AP line.
  const makeEntry = async () =>
    handle.prisma.journalEntry.create({
      data: {
        entryType: "JOURNAL",
        entryDate: new Date("2026-07-05"),
        description: "orig entry",
        status: "POSTED",
        createdBy: handle.ownerId,
        lines: {
          create: [
            { accountId: cashAccountId, debit: "100.00", credit: "0", branchId: handle.branchId },
            { accountId: apAccountId, debit: "0", credit: "100.00", partyType: "SUPPLIER", partyId: supplierId, branchId: handle.branchId },
          ],
        },
      },
      include: { lines: true },
    });

  const netByAccount = async (originalId: string) => {
    // Sum debits-credits across the original + its reversal for each account.
    const entries = await handle.prisma.journalEntry.findMany({
      where: { OR: [{ id: originalId }, { reversalOfId: originalId }] },
      include: { lines: true },
    });
    const net = new Map<string, Decimal>();
    for (const e of entries)
      for (const l of e.lines) {
        const cur = net.get(l.accountId) ?? new Decimal(0);
        net.set(l.accountId, cur.add(l.debit.toString()).sub(l.credit.toString()));
      }
    return net;
  };

  it("golden reversal: original REVERSED, mirror POSTED + linked, dims preserved, net zero", async () => {
    const orig = await makeEntry();
    const res = await request(server()).post(`/api/v1/journal/${orig.id}/reverse`).set(auth()).send({ reason: "test reversal" });
    expect(res.status).toBeLessThan(300);
    expect(res.body.journalEntryId).toBeTruthy();

    const original = await handle.prisma.journalEntry.findUnique({ where: { id: orig.id } });
    expect(original!.status).toBe("REVERSED");

    const reversal = await handle.prisma.journalEntry.findUnique({ where: { id: res.body.journalEntryId }, include: { lines: true } });
    expect(reversal!.status).toBe("POSTED");
    expect(reversal!.reversalOfId).toBe(orig.id);

    // Mirrored: cash was Dr 100 → now Cr 100; AP was Cr 100 [SUPPLIER] → now Dr 100, party+branch preserved.
    const cashLine = reversal!.lines.find((l) => l.accountId === cashAccountId)!;
    const apLine = reversal!.lines.find((l) => l.accountId === apAccountId)!;
    expect(new Decimal(cashLine.credit.toString()).toString()).toBe("100");
    expect(new Decimal(apLine.debit.toString()).toString()).toBe("100");
    expect(apLine.partyType).toBe("SUPPLIER");
    expect(apLine.partyId).toBe(supplierId);
    expect(apLine.branchId).toBe(handle.branchId);
    expect(cashLine.branchId).toBe(handle.branchId);

    const net = await netByAccount(orig.id);
    expect(net.get(cashAccountId)!.toString()).toBe("0");
    expect(net.get(apAccountId)!.toString()).toBe("0");
  });

  it("second reverse is idempotent — returns existing reversal, no duplicate", async () => {
    const orig = await makeEntry();
    const first = await request(server()).post(`/api/v1/journal/${orig.id}/reverse`).set(auth()).send({ reason: "rev one" });
    const second = await request(server()).post(`/api/v1/journal/${orig.id}/reverse`).set(auth()).send({ reason: "rev again" });
    expect(second.status).toBeLessThan(300);
    expect(second.body.journalEntryId).toBe(first.body.journalEntryId);
    expect(second.body.idempotent).toBe(true);
    expect(await handle.prisma.journalEntry.count({ where: { reversalOfId: orig.id } })).toBe(1);
  });

  it("closed/missing period rejects atomically — original unchanged, no reversal", async () => {
    const orig = await makeEntry();
    const res = await request(server()).post(`/api/v1/journal/${orig.id}/reverse`).set(auth()).send({ reason: "rev", reversalDate: "2026-03-10" });
    expect(res.status).toBe(409);
    expect(res.body.details?.reason === "period_not_open" || res.body.details?.reason === "period_closed").toBe(true);
    expect((await handle.prisma.journalEntry.findUnique({ where: { id: orig.id } }))!.status).toBe("POSTED");
    expect(await handle.prisma.journalEntry.count({ where: { reversalOfId: orig.id } })).toBe(0);
  });

  it("reversing a non-POSTED entry with no existing reversal → entry_not_reversible", async () => {
    // A REVERSED entry that we did NOT produce a reversal for (no reversal:<id> key).
    const stale = await handle.prisma.journalEntry.create({
      data: {
        entryType: "JOURNAL",
        entryDate: new Date("2026-07-05"),
        description: "already reversed elsewhere",
        status: "REVERSED",
        createdBy: handle.ownerId,
        lines: {
          create: [
            { accountId: cashAccountId, debit: "10.00", credit: "0" },
            { accountId: apAccountId, debit: "0", credit: "10.00" },
          ],
        },
      },
    });
    const res = await request(server()).post(`/api/v1/journal/${stale.id}/reverse`).set(auth()).send({ reason: "rev" });
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("entry_not_reversible");
    expect(await handle.prisma.journalEntry.count({ where: { reversalOfId: stale.id } })).toBe(0);
  });

  it("DELETE /journal/:id is blocked → use_reverse_instead, entry retained", async () => {
    const orig = await makeEntry();
    const res = await request(server()).delete(`/api/v1/journal/${orig.id}`).set(auth());
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("use_reverse_instead");
    expect(await handle.prisma.journalEntry.findUnique({ where: { id: orig.id } })).not.toBeNull();
  });

  it("legacy/manual POSTED journal (created via POST /journal) can be reversed", async () => {
    const created = await request(server()).post("/api/v1/journal").set(auth()).send({
      entryDate: "2026-07-06",
      description: "manual entry",
      lines: [
        { accountId: cashAccountId, debit: "50.00", credit: "0" },
        { accountId: plainAccountId, debit: "0", credit: "50.00" },
      ],
    });
    expect(created.status).toBeLessThan(300);
    const res = await request(server()).post(`/api/v1/journal/${created.body.id}/reverse`).set(auth()).send({ reason: "undo manual" });
    expect(res.status).toBeLessThan(300);
    expect((await handle.prisma.journalEntry.findUnique({ where: { id: created.body.id } }))!.status).toBe("REVERSED");
  });
});
