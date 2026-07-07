/**
 * Phase-1 hotfix tests (specs/elshrouq-erp-redesign/tasks.md T003).
 *
 * Proves the two P0 fixes on purchase-invoice confirm/cancel:
 *  - T001: stock changes go through InventoryEngine — confirming a purchase
 *    invoice actually increases BranchInventoryBalance (the old code wrote
 *    movement rows only), and cancelling reverses the balance with a
 *    compensating ADJUSTMENT movement instead of deleting history.
 *  - T002: an unbalanced journal entry can no longer be created — confirm
 *    without inventoryAccountId (or without taxAccountId when tax > 0) is
 *    rejected and the created entry always satisfies Σdebit == Σcredit.
 */
import { Decimal } from "decimal.js";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("purchase invoices — Phase 1 hotfixes", () => {
  let handle: TestApp;
  let ownerToken: string;
  let supplierId: string;
  let variantId: string;
  let apAccountId: string;
  let inventoryAccountId: string;
  let taxAccountId: string;

  const BOARDS = "10";

  beforeAll(async () => {
    handle = await buildTestApp();

    const login = await request(handle.app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ phone: handle.ownerPhone, password: handle.ownerPassword });
    ownerToken = login.body.accessToken;

    const supplier = await handle.prisma.supplier.create({
      data: { nameAr: "مورد اختبار", nameEn: "Test Supplier", active: true },
    });
    supplierId = supplier.id;

    const sku = await handle.prisma.productSku.create({
      data: { code: "HFX-01", category: "NORMAL", colorNameAr: "رمادي", colorNameEn: "Grey", active: true },
    });
    const variant = await handle.prisma.productVariant.create({
      data: {
        skuId: sku.id,
        sizeMetersPerBoard: "3",
        defaultSalePricePerMeter: "100",
        defaultPurchasePricePerMeter: "70",
        active: true,
      },
    });
    variantId = variant.id;

    const mkAccount = (code: string, nameAr: string, category: "ASSET" | "LIABILITY", accountType: "CURRENT_ASSET" | "LIABILITY") =>
      handle.prisma.account.create({
        data: { code, nameAr, nameEn: nameAr, category, accountType, isLeaf: true, active: true },
      });
    apAccountId = (await mkAccount("2101", "ذمم موردين اختبار", "LIABILITY", "LIABILITY")).id;
    inventoryAccountId = (await mkAccount("1201", "مخزون اختبار", "ASSET", "CURRENT_ASSET")).id;
    taxAccountId = (await mkAccount("2301", "ضريبة مدخلات اختبار", "LIABILITY", "LIABILITY")).id;
  });

  afterAll(async () => {
    await teardownTestApp(handle);
  });

  const createDraft = async () => {
    const res = await request(handle.app.getHttpServer())
      .post("/api/v1/purchase-invoices")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        invoiceDate: "2026-07-01",
        supplierId,
        branchId: handle.branchId,
        lines: [
          { productVariantId: variantId, boardsQuantity: BOARDS, unitPrice: "100.00", taxRate: "14" },
        ],
      });
    expect(res.status).toBeLessThan(300);
    return res.body.id as string;
  };

  const balanceBoards = async () => {
    const bal = await handle.prisma.branchInventoryBalance.findUnique({
      where: { branchId_productVariantId: { branchId: handle.branchId, productVariantId: variantId } },
    });
    return new Decimal(bal?.boardsOnHand?.toString() ?? "0");
  };

  it("T001: confirm increases BranchInventoryBalance through the engine", async () => {
    const before = await balanceBoards();

    const id = await createDraft();
    const res = await request(handle.app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${id}/confirm`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ apAccountId, inventoryAccountId, taxAccountId });
    expect(res.status).toBeLessThan(300);

    const after = await balanceBoards();
    expect(after.minus(before).toFixed(4)).toBe(new Decimal(BOARDS).toFixed(4));

    // Movement row exists AND is engine-applied (same-tx audit row present).
    const movement = await handle.prisma.inventoryMovement.findFirst({
      where: { referenceType: "purchase_invoice", referenceId: id, movementType: "RECEIPT" },
    });
    expect(movement).not.toBeNull();
    const movementAudit = await handle.prisma.auditLog.findFirst({
      where: { entityType: "inventory_movement", entityId: movement!.id },
    });
    expect(movementAudit).not.toBeNull();
  });

  it("T002: created journal entry is balanced (Σdebit == Σcredit)", async () => {
    const id = await createDraft();
    await request(handle.app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${id}/confirm`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ apAccountId, inventoryAccountId, taxAccountId });

    const invoice = await handle.prisma.purchaseInvoice.findUnique({ where: { id } });
    expect(invoice?.status).toBe("CONFIRMED");
    expect(invoice?.journalEntryId).not.toBeNull();
    const entry = await handle.prisma.journalEntry.findUnique({
      where: { id: invoice!.journalEntryId! },
      include: { lines: true },
    });
    const lines = entry!.lines;
    const totalDebit = lines.reduce((a, l) => a.add(l.debit.toString()), new Decimal(0));
    const totalCredit = lines.reduce((a, l) => a.add(l.credit.toString()), new Decimal(0));
    expect(totalDebit.toFixed(2)).toBe(totalCredit.toFixed(2));
    expect(totalDebit.gt(0)).toBe(true);
  });

  it("T002: confirm without inventoryAccountId is rejected and posts nothing", async () => {
    const id = await createDraft();
    const before = await balanceBoards();

    const res = await request(handle.app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${id}/confirm`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ apAccountId, taxAccountId }); // inventoryAccountId omitted
    expect(res.status).toBe(409);

    const invoice = await handle.prisma.purchaseInvoice.findUnique({ where: { id } });
    expect(invoice?.status).toBe("DRAFT");
    expect(invoice?.journalEntryId).toBeNull();
    expect((await balanceBoards()).toFixed(4)).toBe(before.toFixed(4));
  });

  it("T002: confirm without taxAccountId while tax > 0 is rejected", async () => {
    const id = await createDraft();
    const res = await request(handle.app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${id}/confirm`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ apAccountId, inventoryAccountId }); // taxAccountId omitted, taxRate 14
    expect(res.status).toBe(409);
    const invoice = await handle.prisma.purchaseInvoice.findUnique({ where: { id } });
    expect(invoice?.status).toBe("DRAFT");
  });

  it("T001: cancel reverses the balance via compensating ADJUSTMENT, keeping history", async () => {
    const before = await balanceBoards();

    const id = await createDraft();
    await request(handle.app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${id}/confirm`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ apAccountId, inventoryAccountId, taxAccountId });
    expect((await balanceBoards()).minus(before).toFixed(4)).toBe(new Decimal(BOARDS).toFixed(4));

    const res = await request(handle.app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${id}/cancel`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    expect(res.status).toBeLessThan(300);

    // Balance restored, original RECEIPT retained, compensating ADJUSTMENT added.
    expect((await balanceBoards()).toFixed(4)).toBe(before.toFixed(4));
    const receipt = await handle.prisma.inventoryMovement.findFirst({
      where: { referenceType: "purchase_invoice", referenceId: id, movementType: "RECEIPT" },
    });
    expect(receipt).not.toBeNull();
    const reversal = await handle.prisma.inventoryMovement.findFirst({
      where: { referenceType: "purchase_invoice_cancel", referenceId: id, movementType: "ADJUSTMENT" },
    });
    expect(reversal).not.toBeNull();
    expect(new Decimal(reversal!.boardsQuantity.toString()).toFixed(4)).toBe(new Decimal(BOARDS).negated().toFixed(4));
  });

  it("T001 guard: cancelling a pre-hotfix invoice (movement without audit row) does not touch the balance", async () => {
    const id = await createDraft();
    // Simulate the pre-hotfix state: CONFIRMED with a raw movement row and
    // NO balance update, NO movement audit row.
    const entry = await handle.prisma.journalEntry.create({
      data: {
        entryType: "PURCHASE_INVOICE",
        entryDate: new Date("2026-07-01"),
        description: "legacy",
        createdBy: handle.ownerId,
        lines: {
          create: [
            { accountId: inventoryAccountId, debit: "1000.00", credit: "0" },
            { accountId: apAccountId, debit: "0", credit: "1000.00" },
          ],
        },
      },
    });
    await handle.prisma.inventoryMovement.create({
      data: {
        branchId: handle.branchId,
        productVariantId: variantId,
        movementType: "RECEIPT",
        boardsQuantity: BOARDS,
        metersQuantity: "30",
        referenceType: "purchase_invoice",
        referenceId: id,
        createdBy: handle.ownerId,
      },
    });
    await handle.prisma.purchaseInvoice.update({
      where: { id },
      data: { status: "CONFIRMED", journalEntryId: entry.id, apAccountId, inventoryAccountId },
    });

    const before = await balanceBoards();
    const res = await request(handle.app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${id}/cancel`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    expect(res.status).toBeLessThan(300);
    // Balance untouched — no phantom decrement for a receipt that never landed.
    expect((await balanceBoards()).toFixed(4)).toBe(before.toFixed(4));
  });
});
