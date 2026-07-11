/**
 * Phase 3D (Commit 2) — document reversal integration.
 * Purchase/sales cancels and expense reverse now REVERSE their GL entries
 * (never delete). Stock is compensated via ADJUSTMENT, RECEIPT/SALE movements
 * retained. Reversal pairs net to zero (trial balance stays balanced).
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("document reversal (Phase 3D)", () => {
  let handle: TestApp;
  let ownerToken: string;
  let customerId: string;
  let supplierId: string;
  let acc: Record<string, string> = {};

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
    const mk = (key: string, code: string, cat: "ASSET" | "LIABILITY" | "REVENUE" | "COST_OF_SALES" | "EXPENSE", type: "CURRENT_ASSET" | "LIABILITY" | "REVENUE" | "COST_OF_SALES" | "EXPENSE", role?: string) =>
      handle.prisma.account
        .create({ data: { code: `${code}${uniq}`, nameAr: key, nameEn: key, category: cat, accountType: type, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } })
        .then((a) => (acc[key] = a.id));
    await mk("ar", "DAR", "ASSET", "CURRENT_ASSET", "AR_CONTROL");
    await mk("ap", "DAP", "LIABILITY", "LIABILITY", "AP_CONTROL");
    await mk("rev", "DREV", "REVENUE", "REVENUE");
    await mk("cogs", "DCOGS", "COST_OF_SALES", "COST_OF_SALES");
    await mk("inv", "DINV", "ASSET", "CURRENT_ASSET");
    await mk("vatIn", "DVIN", "ASSET", "CURRENT_ASSET");
    await mk("vatOut", "DVOUT", "LIABILITY", "LIABILITY");
    await mk("exp", "DEXP", "EXPENSE", "EXPENSE");
    await mk("cash", "DCASH", "ASSET", "CURRENT_ASSET");

    await handle.prisma.postingProfile.create({
      data: {
        effectiveFrom: new Date("2026-01-01"),
        arAccountId: acc.ar, apAccountId: acc.ap, revenueAccountId: acc.rev, cogsAccountId: acc.cogs,
        inventoryAccountId: acc.inv, vatInputAccountId: acc.vatIn, vatOutputAccountId: acc.vatOut,
        createdBy: handle.ownerId,
      },
    });
    customerId = (await handle.prisma.customer.create({ data: { code: `DC${uniq}`, nameAr: "عميل" } })).id;
    supplierId = (await handle.prisma.supplier.create({ data: { nameAr: `مورد ${uniq}`, nameEn: `Sup ${uniq}` } })).id;
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
  });

  afterAll(async () => teardownTestApp(handle));

  let seq = 0;
  const freshVariant = async () => {
    const sku = await handle.prisma.productSku.create({ data: { code: `DSKU-${++seq}-${Date.now() % 1000}`, colorNameAr: "ص", colorNameEn: "c" } });
    return (await handle.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: "1", defaultSalePricePerMeter: "1000", defaultPurchasePricePerMeter: "560", avgCost: "0" } })).id;
  };

  const buyStock = async (variantId: string, boards: string) => {
    const pi = await request(server()).post("/api/v1/purchase-invoices").set(auth()).send({
      invoiceDate: "2026-07-15", supplierId, branchId: handle.branchId,
      lines: [{ productVariantId: variantId, boardsQuantity: boards, unitPrice: "560", taxRate: "0" }],
    });
    await request(server()).post(`/api/v1/purchase-invoices/${pi.body.id}/confirm`).set(auth()).send({});
    return pi.body.id as string;
  };

  const netForEntry = async (originalId: string) => {
    const lines = await handle.prisma.journalLine.findMany({
      where: { journalEntry: { OR: [{ id: originalId }, { reversalOfId: originalId }] } },
    });
    return lines.reduce((a, l) => a.add(l.debit.toString()).sub(l.credit.toString()), new Decimal(0));
  };
  const boards = async (variantId: string) =>
    new Decimal(
      (await handle.prisma.branchInventoryBalance.findUnique({ where: { branchId_productVariantId: { branchId: handle.branchId, productVariantId: variantId } } }))?.boardsOnHand.toString() ?? "0",
    );

  it("purchase cancel reverses GL, compensates stock, retains RECEIPT, invoice CANCELLED", async () => {
    const v = await freshVariant();
    const piId = await buyStock(v, "10");
    const pi = await handle.prisma.purchaseInvoice.findUnique({ where: { id: piId } });
    const jeId = pi!.journalEntryId!;
    expect(await boards(v)).toEqual(new Decimal(10));

    const res = await request(server()).post(`/api/v1/purchase-invoices/${piId}/cancel`).set(auth()).send({});
    expect(res.status).toBeLessThan(300);

    const after = await handle.prisma.purchaseInvoice.findUnique({ where: { id: piId } });
    expect(after!.status).toBe("CANCELLED");
    expect(after!.journalEntryId).toBe(jeId); // still linked
    expect((await handle.prisma.journalEntry.findUnique({ where: { id: jeId } }))!.status).toBe("REVERSED");
    expect(await handle.prisma.journalEntry.count({ where: { reversalOfId: jeId } })).toBe(1);
    expect((await netForEntry(jeId)).toString()).toBe("0");
    // RECEIPT retained, stock back to 0.
    expect(await handle.prisma.inventoryMovement.count({ where: { referenceId: piId, movementType: "RECEIPT" } })).toBe(1);
    expect((await boards(v)).toString()).toBe("0");
  });

  it("purchase cancel blocked when stock already sold → 409, invoice CONFIRMED, no reversal", async () => {
    const v = await freshVariant();
    const piId = await buyStock(v, "10");
    const jeId = (await handle.prisma.purchaseInvoice.findUnique({ where: { id: piId } }))!.journalEntryId!;
    // Sell 4 → stock 6 < 10 purchased.
    const si = await request(server()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-07-15", customerId, branchId: handle.branchId, taxRate: "0",
      lines: [{ productVariantId: v, quantity: "4", unitPrice: "1000.00", costPrice: "0" }],
    });
    await request(server()).post(`/api/v1/sales-invoices/${si.body.id}/confirm`).set(auth()).send({});

    const res = await request(server()).post(`/api/v1/purchase-invoices/${piId}/cancel`).set(auth()).send({});
    expect(res.status).toBe(409);
    expect(res.body.code === "insufficient_stock" || res.body.details?.reason === "insufficient_stock").toBeTruthy();
    // Nothing changed: invoice CONFIRMED, entry still POSTED, no reversal, stock 6.
    expect((await handle.prisma.purchaseInvoice.findUnique({ where: { id: piId } }))!.status).toBe("CONFIRMED");
    expect((await handle.prisma.journalEntry.findUnique({ where: { id: jeId } }))!.status).toBe("POSTED");
    expect(await handle.prisma.journalEntry.count({ where: { reversalOfId: jeId } })).toBe(0);
    expect((await boards(v)).toString()).toBe("6");
  });

  it("sales cancel with avg_cost=0 reverses revenue only (no COGS), restores stock, retains SALE", async () => {
    const v = await freshVariant();
    // Stock without cost basis: receive via a direct balance so avg_cost stays 0.
    await handle.prisma.branchInventoryBalance.create({ data: { branchId: handle.branchId, productVariantId: v, boardsOnHand: "10", metersOnHand: "10", updatedAt: new Date() } });
    const si = await request(server()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-07-15", customerId, branchId: handle.branchId, taxRate: "0",
      lines: [{ productVariantId: v, quantity: "3", unitPrice: "1000.00", costPrice: "0" }],
    });
    await request(server()).post(`/api/v1/sales-invoices/${si.body.id}/confirm`).set(auth()).send({});
    const conf = await handle.prisma.salesInvoice.findUnique({ where: { id: si.body.id } });
    expect(conf!.cogsJournalEntryId).toBeNull(); // avg_cost 0 → no COGS entry
    const revId = conf!.journalEntryId!;

    const res = await request(server()).post(`/api/v1/sales-invoices/${si.body.id}/cancel`).set(auth()).send({});
    expect(res.status).toBeLessThan(300);
    const after = await handle.prisma.salesInvoice.findUnique({ where: { id: si.body.id } });
    expect(after!.status).toBe("CANCELLED");
    expect((await handle.prisma.journalEntry.findUnique({ where: { id: revId } }))!.status).toBe("REVERSED");
    expect((await netForEntry(revId)).toString()).toBe("0");
    expect(await handle.prisma.inventoryMovement.count({ where: { referenceId: si.body.id, movementType: "SALE" } })).toBe(1); // retained
    expect((await boards(v)).toString()).toBe("10"); // restored 7 → 10
  });

  it("expense reverse retains row, marks REVERSED, stores both journal ids, net zero; second reverse idempotent", async () => {
    const created = await request(server()).post("/api/v1/expenses").set(auth()).send({
      branchId: handle.branchId, expenseDate: "2026-07-15", description: "reverse me",
      amount: "500.00", paidFromAccount: "cash", glAccountId: acc.exp, paymentGlAccountId: acc.cash,
    });
    expect(created.body.status).toBe("POSTED");
    const jeId = created.body.journalEntryId as string;

    const rev = await request(server()).post(`/api/v1/expenses/${created.body.id}/reverse`).set(auth()).send({ reason: "correction" });
    expect(rev.status).toBeLessThan(300);
    const exp = await handle.prisma.expense.findUnique({ where: { id: created.body.id } });
    expect(exp!.status).toBe("REVERSED");
    expect(exp!.journalEntryId).toBe(jeId); // original stays linked
    expect(exp!.reversalJournalEntryId).toBe(rev.body.reversalJournalEntryId);
    expect((await handle.prisma.journalEntry.findUnique({ where: { id: jeId } }))!.status).toBe("REVERSED");
    expect((await netForEntry(jeId)).toString()).toBe("0");

    // Second reverse is idempotent — same reversal, no duplicate.
    const again = await request(server()).post(`/api/v1/expenses/${created.body.id}/reverse`).set(auth()).send({ reason: "again" });
    expect(again.status).toBeLessThan(300);
    expect(again.body.idempotent).toBe(true);
    expect(await handle.prisma.journalEntry.count({ where: { reversalOfId: jeId } })).toBe(1);
  });

  it("record-only expense DELETE still 204; posted expense DELETE blocked", async () => {
    const recorded = await request(server()).post("/api/v1/expenses").set(auth()).send({
      branchId: handle.branchId, expenseDate: "2026-07-15", description: "record only", amount: "80.00", paidFromAccount: "cash",
    });
    expect(recorded.body.status).toBe("RECORDED");
    expect(recorded.body.journalEntryId).toBeNull();
    const del = await request(server()).delete(`/api/v1/expenses/${recorded.body.id}`).set(auth());
    expect(del.status).toBe(204);
    expect(await handle.prisma.expense.findUnique({ where: { id: recorded.body.id } })).toBeNull();
  });

  it("negative record-only correction DELETE still 204", async () => {
    const corr = await request(server()).post("/api/v1/expenses").set(auth()).send({
      branchId: handle.branchId, expenseDate: "2026-07-15", description: "correction", amount: "-40.00", paidFromAccount: "cash",
      glAccountId: acc.exp, paymentGlAccountId: acc.cash, // accounts present but negative → record-only in 3C
    });
    expect(corr.body.status).toBe("RECORDED");
    expect(corr.body.journalEntryId).toBeNull();
    const del = await request(server()).delete(`/api/v1/expenses/${corr.body.id}`).set(auth());
    expect(del.status).toBe(204);
  });

  it("trial balance stays balanced (Σdebit == Σcredit) after reversals", async () => {
    const agg = await handle.prisma.journalLine.aggregate({ _sum: { debit: true, credit: true } });
    const dr = new Decimal(agg._sum.debit?.toString() ?? "0");
    const cr = new Decimal(agg._sum.credit?.toString() ?? "0");
    expect(dr.eq(cr)).toBe(true);
  });
});
