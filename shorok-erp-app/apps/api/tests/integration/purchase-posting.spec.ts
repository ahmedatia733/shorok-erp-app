/**
 * Phase 3A (T031) — purchase-invoice posting through the PostingEngine.
 * Golden-path Dr/Cr + AP party dimension + stock + WAC + snapshots + balance;
 * idempotency (no double-post / no duplicate movement); PostingProfile
 * resolution; and the transitional body-account fallback.
 *
 * Each test uses a FRESH product variant so avg_cost assertions are isolated.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("purchase invoice posting (Phase 3A)", () => {
  let handle: TestApp;
  let ownerToken: string;
  let supplierId: string;
  let apAccountId: string;
  let inventoryAccountId: string;
  let vatAccountId: string;

  const auth = () => ({ Authorization: `Bearer ${ownerToken}` });
  const server = () => handle.app.getHttpServer();

  beforeAll(async () => {
    handle = await buildTestApp();
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    ownerToken = (await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" })).body.accessToken;

    supplierId = (await handle.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "Supplier" } })).id;

    const mk = (code: string, nameAr: string, category: "ASSET" | "LIABILITY", accountType: "CURRENT_ASSET" | "LIABILITY", systemRole?: string) =>
      handle.prisma.account.create({ data: { code, nameAr, nameEn: nameAr, category, accountType, isLeaf: true, active: true, ...(systemRole ? { systemRole: systemRole as never } : {}) } });
    const uniq = Date.now().toString().slice(-6);
    inventoryAccountId = (await mk(`TINV${uniq}`, "مخزون اختبار", "ASSET", "CURRENT_ASSET")).id;
    apAccountId = (await mk(`TAP${uniq}`, "موردون اختبار", "LIABILITY", "LIABILITY", "AP_CONTROL")).id;
    vatAccountId = (await mk(`TVAT${uniq}`, "ضريبة مشتريات اختبار", "ASSET", "CURRENT_ASSET")).id;

    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
  });

  afterAll(async () => teardownTestApp(handle));

  let skuSeq = 0;
  const freshVariant = async () => {
    const sku = await handle.prisma.productSku.create({ data: { code: `P3A-${++skuSeq}`, category: "NORMAL", colorNameAr: "ص", colorNameEn: "c" } });
    return (await handle.prisma.productVariant.create({
      data: { skuId: sku.id, sizeMetersPerBoard: "1", defaultSalePricePerMeter: "600", defaultPurchasePricePerMeter: "560" },
    })).id;
  };

  const createDraft = async (variantId: string, boards = "4", unitPrice = "560.00", taxRate = "14") => {
    const res = await request(server()).post("/api/v1/purchase-invoices").set(auth()).send({
      invoiceDate: "2026-07-15", supplierId, branchId: handle.branchId,
      lines: [{ productVariantId: variantId, boardsQuantity: boards, lengthM: "1", unitPrice, taxRate }],
    });
    expect(res.status).toBeLessThan(300);
    return res.body as { id: string; subtotal: string; taxAmount: string; grandTotal: string };
  };

  const setPostingProfile = async () => {
    await handle.prisma.postingProfile.deleteMany({});
    await handle.prisma.postingProfile.create({
      data: { effectiveFrom: new Date("2026-01-01"), inventoryAccountId, apAccountId, vatInputAccountId: vatAccountId, createdBy: handle.ownerId },
    });
  };

  const sum = (lines: Array<{ debit: unknown; credit: unknown }>, k: "debit" | "credit") =>
    lines.reduce((a, l) => a.add((l[k] as { toString(): string }).toString()), new Decimal(0));

  it("posts through the engine: exact Dr/Cr, AP supplier party, stock, WAC, snapshots, balanced", async () => {
    await setPostingProfile();
    const variantId = await freshVariant();
    const draft = await createDraft(variantId); // 4 @560 14%
    const res = await request(server()).post(`/api/v1/purchase-invoices/${draft.id}/confirm`).set(auth()).send({});
    expect(res.status).toBeLessThan(300);

    const inv = await handle.prisma.purchaseInvoice.findUnique({ where: { id: draft.id } });
    const entry = await handle.prisma.journalEntry.findUnique({ where: { id: inv!.journalEntryId! }, include: { lines: true } });
    expect(entry!.sourceType).toBe("PURCHASE_INVOICE");
    expect(entry!.sourceId).toBe(draft.id);

    const invLine = entry!.lines.find((l) => l.accountId === inventoryAccountId)!;
    const vatLine = entry!.lines.find((l) => l.accountId === vatAccountId)!;
    const apLine = entry!.lines.find((l) => l.accountId === apAccountId)!;
    // Journal matches the invoice's own computed totals (robust to line math).
    expect(new Decimal(invLine.debit.toString()).eq(draft.subtotal)).toBe(true);
    expect(new Decimal(vatLine.debit.toString()).eq(draft.taxAmount)).toBe(true);
    expect(new Decimal(apLine.credit.toString()).eq(draft.grandTotal)).toBe(true);
    // AP party dimension
    expect(apLine.partyType).toBe("SUPPLIER");
    expect(apLine.partyId).toBe(supplierId);
    // balanced
    expect(sum(entry!.lines, "debit").eq(sum(entry!.lines, "credit"))).toBe(true);
    // stock via InventoryEngine (audit row present)
    const bal = await handle.prisma.branchInventoryBalance.findUnique({ where: { branchId_productVariantId: { branchId: handle.branchId, productVariantId: variantId } } });
    expect(new Decimal(bal!.boardsOnHand.toString()).toString()).toBe("4");
    const mv = await handle.prisma.inventoryMovement.findFirst({ where: { referenceId: draft.id, movementType: "RECEIPT" } });
    expect(mv).not.toBeNull();
    const mvAudit = await handle.prisma.auditLog.findFirst({ where: { entityType: "inventory_movement", entityId: mv!.id } });
    expect(mvAudit).not.toBeNull();
    // WAC first receipt: subtotal / boards
    const variant = await handle.prisma.productVariant.findUnique({ where: { id: variantId } });
    const expectedAvg = new Decimal(draft.subtotal).div(4);
    expect(new Decimal(variant!.avgCost.toString()).eq(expectedAvg)).toBe(true);
    // snapshots
    const pline = await handle.prisma.purchaseInvoiceLine.findFirst({ where: { invoiceId: draft.id } });
    expect(new Decimal(pline!.unitCostAtPosting!.toString()).eq(expectedAvg)).toBe(true);
    expect(new Decimal(pline!.taxRateAtPosting!.toString()).toString()).toBe("14");
  });

  it("is idempotent: re-confirm blocked, no double-post, no duplicate movement", async () => {
    await setPostingProfile();
    const variantId = await freshVariant();
    const draft = await createDraft(variantId, "2", "500.00", "0");
    const first = await request(server()).post(`/api/v1/purchase-invoices/${draft.id}/confirm`).set(auth()).send({});
    expect(first.status).toBeLessThan(300);
    const second = await request(server()).post(`/api/v1/purchase-invoices/${draft.id}/confirm`).set(auth()).send({});
    expect(second.status).toBe(409); // invoice_not_draft guard

    expect(await handle.prisma.journalEntry.count({ where: { sourceType: "PURCHASE_INVOICE", sourceId: draft.id } })).toBe(1);
    expect(await handle.prisma.inventoryMovement.count({ where: { referenceId: draft.id, movementType: "RECEIPT" } })).toBe(1);
  });

  it("WAC builds forward across two purchases of the same variant", async () => {
    await setPostingProfile();
    const variantId = await freshVariant();
    const d1 = await createDraft(variantId, "4", "560.00", "0"); // 560/board, stock→4, avg→560
    await request(server()).post(`/api/v1/purchase-invoices/${d1.id}/confirm`).set(auth()).send({});
    const d2 = await createDraft(variantId, "4", "760.00", "0"); // 760/board
    await request(server()).post(`/api/v1/purchase-invoices/${d2.id}/confirm`).set(auth()).send({});
    const variant = await handle.prisma.productVariant.findUnique({ where: { id: variantId } });
    // (4*560 + 4*760)/8 = 660
    expect(new Decimal(variant!.avgCost.toString()).toString()).toBe("660");
  });

  it("no PostingProfile AND no body accounts → clear typed error, nothing posted", async () => {
    await handle.prisma.postingProfile.deleteMany({});
    const variantId = await freshVariant();
    const draft = await createDraft(variantId, "1", "100.00", "0");
    const res = await request(server()).post(`/api/v1/purchase-invoices/${draft.id}/confirm`).set(auth()).send({});
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("inventory_account_required");
    const inv = await handle.prisma.purchaseInvoice.findUnique({ where: { id: draft.id } });
    expect(inv!.status).toBe("DRAFT");
  });

  it("transitional fallback: no profile but body accounts → current UI flow still works", async () => {
    await handle.prisma.postingProfile.deleteMany({});
    const variantId = await freshVariant();
    const draft = await createDraft(variantId, "1", "100.00", "14");
    const res = await request(server()).post(`/api/v1/purchase-invoices/${draft.id}/confirm`).set(auth())
      .send({ apAccountId, inventoryAccountId, taxAccountId: vatAccountId });
    expect(res.status).toBeLessThan(300);
    const inv = await handle.prisma.purchaseInvoice.findUnique({ where: { id: draft.id } });
    expect(inv!.status).toBe("CONFIRMED");
    const entry = await handle.prisma.journalEntry.findFirst({ where: { sourceType: "PURCHASE_INVOICE", sourceId: draft.id }, include: { lines: true } });
    expect(entry).not.toBeNull();
    expect(sum(entry!.lines, "debit").eq(sum(entry!.lines, "credit"))).toBe(true);
  });
});
