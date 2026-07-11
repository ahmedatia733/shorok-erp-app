/**
 * Phase 3B (T033) — sales-invoice posting through the PostingEngine.
 * Golden-path revenue + COGS entries, AR customer party, stock SALE, COGS from
 * avg_cost (never cost_price), snapshots, idempotency, insufficient-stock
 * hard-block, avg_cost=0 skips COGS, missing-account errors, body fallback.
 *
 * Fresh variant + balance per test so stock/avg assertions are isolated.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("sales invoice posting (Phase 3B)", () => {
  let handle: TestApp;
  let ownerToken: string;
  let customerId: string;
  let arAccountId: string;
  let revenueAccountId: string;
  let vatOutAccountId: string;
  let cogsAccountId: string;
  let inventoryAccountId: string;

  const auth = () => ({ Authorization: `Bearer ${ownerToken}` });
  const server = () => handle.app.getHttpServer();

  beforeAll(async () => {
    handle = await buildTestApp();
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    ownerToken = (await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" })).body.accessToken;

    customerId = (await handle.prisma.customer.create({ data: { code: "SC-1", nameAr: "عميل" } })).id;

    const uniq = Date.now().toString().slice(-6);
    const mk = (code: string, nameAr: string, category: "ASSET" | "LIABILITY" | "REVENUE" | "COST_OF_SALES", accountType: "CURRENT_ASSET" | "LIABILITY" | "REVENUE" | "COST_OF_SALES", systemRole?: string) =>
      handle.prisma.account.create({ data: { code, nameAr, nameEn: nameAr, category, accountType, isLeaf: true, active: true, ...(systemRole ? { systemRole: systemRole as never } : {}) } });
    arAccountId = (await mk(`SAR${uniq}`, "عملاء", "ASSET", "CURRENT_ASSET", "AR_CONTROL")).id;
    revenueAccountId = (await mk(`SREV${uniq}`, "مبيعات", "REVENUE", "REVENUE")).id;
    vatOutAccountId = (await mk(`SVAT${uniq}`, "ضريبة مبيعات", "LIABILITY", "LIABILITY")).id;
    cogsAccountId = (await mk(`SCOGS${uniq}`, "تكلفة مبيعات", "COST_OF_SALES", "COST_OF_SALES")).id;
    inventoryAccountId = (await mk(`SINV${uniq}`, "مخزون", "ASSET", "CURRENT_ASSET")).id;

    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
  });

  afterAll(async () => teardownTestApp(handle));

  let seq = 0;
  // Create a variant with sizeMetersPerBoard=1 (so metres == boards), an
  // avg_cost, and a starting stock balance.
  const freshVariant = async (avgCost: string, stockBoards: string) => {
    const sku = await handle.prisma.productSku.create({ data: { code: `SP3B-${++seq}`, category: "NORMAL", colorNameAr: "ص", colorNameEn: "c" } });
    const v = await handle.prisma.productVariant.create({
      data: { skuId: sku.id, sizeMetersPerBoard: "1", defaultSalePricePerMeter: "1000", defaultPurchasePricePerMeter: "560", avgCost: avgCost },
    });
    if (new Decimal(stockBoards).gt(0)) {
      await handle.prisma.branchInventoryBalance.create({
        data: { branchId: handle.branchId, productVariantId: v.id, boardsOnHand: stockBoards, metersOnHand: stockBoards },
      });
    }
    return v.id;
  };

  const setProfile = async () => {
    await handle.prisma.postingProfile.deleteMany({});
    await handle.prisma.postingProfile.create({
      data: { effectiveFrom: new Date("2026-01-01"), arAccountId, revenueAccountId, vatOutputAccountId: vatOutAccountId, cogsAccountId, inventoryAccountId, createdBy: handle.ownerId },
    });
  };

  const createDraft = async (variantId: string, quantity = "4", unitPrice = "1000.00", taxRate = "14", costPrice = "999.00") => {
    const res = await request(server()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-07-15", customerId, branchId: handle.branchId, taxRate,
      lines: [{ productVariantId: variantId, quantity, unitPrice, costPrice }],
    });
    expect(res.status).toBeLessThan(300);
    return res.body as { id: string; subtotal: string; taxAmount: string; grandTotal: string };
  };

  const sum = (lines: Array<{ debit: unknown; credit: unknown }>, k: "debit" | "credit") =>
    lines.reduce((a, l) => a.add((l[k] as { toString(): string }).toString()), new Decimal(0));

  it("golden path: revenue + COGS entries, AR party, stock down, COGS from avg_cost, snapshots, balanced", async () => {
    await setProfile();
    const variantId = await freshVariant("560", "10"); // avg 560, 10 boards on hand
    const draft = await createDraft(variantId); // 4 @1000 14% → sub 4000, tax 560, grand 4560; costPrice 999 must be IGNORED
    const res = await request(server()).post(`/api/v1/sales-invoices/${draft.id}/confirm`).set(auth()).send({});
    expect(res.status).toBeLessThan(300);

    const inv = await handle.prisma.salesInvoice.findUnique({ where: { id: draft.id } });
    const rev = await handle.prisma.journalEntry.findUnique({ where: { id: inv!.journalEntryId! }, include: { lines: true } });
    const cogs = await handle.prisma.journalEntry.findUnique({ where: { id: inv!.cogsJournalEntryId! }, include: { lines: true } });

    // Revenue entry
    expect(rev!.sourceType).toBe("SALES_INVOICE");
    const ar = rev!.lines.find((l) => l.accountId === arAccountId)!;
    const revLine = rev!.lines.find((l) => l.accountId === revenueAccountId)!;
    const vat = rev!.lines.find((l) => l.accountId === vatOutAccountId)!;
    expect(new Decimal(ar.debit.toString()).eq(draft.grandTotal)).toBe(true);
    expect(new Decimal(revLine.credit.toString()).eq(draft.subtotal)).toBe(true);
    expect(new Decimal(vat.credit.toString()).eq(draft.taxAmount)).toBe(true);
    expect(ar.partyType).toBe("CUSTOMER");
    expect(ar.partyId).toBe(customerId);
    expect(sum(rev!.lines, "debit").eq(sum(rev!.lines, "credit"))).toBe(true);

    // COGS entry: 4 boards × avg 560 = 2240 (NOT 4×999 costPrice)
    const cogsDr = cogs!.lines.find((l) => l.accountId === cogsAccountId)!;
    const invCr = cogs!.lines.find((l) => l.accountId === inventoryAccountId)!;
    expect(new Decimal(cogsDr.debit.toString()).toString()).toBe("2240");
    expect(new Decimal(invCr.credit.toString()).toString()).toBe("2240");
    expect(sum(cogs!.lines, "debit").eq(sum(cogs!.lines, "credit"))).toBe(true);

    // Stock down by 4; SALE movement present
    const bal = await handle.prisma.branchInventoryBalance.findUnique({ where: { branchId_productVariantId: { branchId: handle.branchId, productVariantId: variantId } } });
    expect(new Decimal(bal!.boardsOnHand.toString()).toString()).toBe("6"); // 10 - 4
    const mv = await handle.prisma.inventoryMovement.findFirst({ where: { referenceId: draft.id, movementType: "SALE" } });
    expect(mv).not.toBeNull();

    // Snapshots
    const line = await handle.prisma.salesInvoiceLine.findFirst({ where: { invoiceId: draft.id } });
    expect(new Decimal(line!.unitCostAtPosting!.toString()).toString()).toBe("560");
    expect(new Decimal(line!.taxRateAtPosting!.toString()).toString()).toBe("14");
  });

  it("insufficient stock: rejected, no journal entry, no stock movement", async () => {
    await setProfile();
    const variantId = await freshVariant("560", "2"); // only 2 boards
    const draft = await createDraft(variantId, "4"); // sell 4
    const res = await request(server()).post(`/api/v1/sales-invoices/${draft.id}/confirm`).set(auth()).send({});
    expect(res.status).toBe(409);
    expect(res.body.code === "insufficient_stock" || res.body.details?.reason === "insufficient_stock" || res.body.message_en?.toLowerCase().includes("stock")).toBeTruthy();

    const inv = await handle.prisma.salesInvoice.findUnique({ where: { id: draft.id } });
    expect(inv!.status).toBe("DRAFT");
    expect(inv!.journalEntryId).toBeNull();
    expect(await handle.prisma.journalEntry.count({ where: { sourceType: "SALES_INVOICE", sourceId: draft.id } })).toBe(0);
    expect(await handle.prisma.inventoryMovement.count({ where: { referenceId: draft.id } })).toBe(0);
    const bal = await handle.prisma.branchInventoryBalance.findUnique({ where: { branchId_productVariantId: { branchId: handle.branchId, productVariantId: variantId } } });
    expect(new Decimal(bal!.boardsOnHand.toString()).toString()).toBe("2"); // unchanged
  });

  it("avg_cost = 0: posts revenue + stock, skips COGS entry (cogsJournalEntryId null)", async () => {
    await setProfile();
    const variantId = await freshVariant("0", "10"); // no cost basis
    const draft = await createDraft(variantId, "3", "1000.00", "0"); // no tax
    const res = await request(server()).post(`/api/v1/sales-invoices/${draft.id}/confirm`).set(auth()).send({});
    expect(res.status).toBeLessThan(300);
    const inv = await handle.prisma.salesInvoice.findUnique({ where: { id: draft.id } });
    expect(inv!.status).toBe("CONFIRMED");
    expect(inv!.journalEntryId).not.toBeNull(); // revenue posted
    expect(inv!.cogsJournalEntryId).toBeNull(); // COGS skipped
    expect(await handle.prisma.journalEntry.count({ where: { sourceType: "SALES_INVOICE", sourceId: draft.id } })).toBe(1);
    const mv = await handle.prisma.inventoryMovement.findFirst({ where: { referenceId: draft.id, movementType: "SALE" } });
    expect(mv).not.toBeNull(); // stock still moved
    const bal = await handle.prisma.branchInventoryBalance.findUnique({ where: { branchId_productVariantId: { branchId: handle.branchId, productVariantId: variantId } } });
    expect(new Decimal(bal!.boardsOnHand.toString()).toString()).toBe("7"); // 10 - 3
  });

  it("re-confirm is blocked, no double post (1 revenue + 1 COGS), no duplicate movement", async () => {
    await setProfile();
    const variantId = await freshVariant("560", "10");
    const draft = await createDraft(variantId, "2", "1000.00", "0");
    await request(server()).post(`/api/v1/sales-invoices/${draft.id}/confirm`).set(auth()).send({});
    const second = await request(server()).post(`/api/v1/sales-invoices/${draft.id}/confirm`).set(auth()).send({});
    expect(second.status).toBe(409);
    expect(await handle.prisma.journalEntry.count({ where: { sourceType: "SALES_INVOICE", sourceId: draft.id } })).toBe(2); // revenue + COGS, no dupes
    expect(await handle.prisma.inventoryMovement.count({ where: { referenceId: draft.id, movementType: "SALE" } })).toBe(1);
  });

  it("missing AR account (no profile, no body) → accounts_receivable_account_required", async () => {
    await handle.prisma.postingProfile.deleteMany({});
    const variantId = await freshVariant("560", "10");
    const draft = await createDraft(variantId, "1", "1000.00", "0");
    const res = await request(server()).post(`/api/v1/sales-invoices/${draft.id}/confirm`).set(auth()).send({});
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("accounts_receivable_account_required");
    expect((await handle.prisma.salesInvoice.findUnique({ where: { id: draft.id } }))!.status).toBe("DRAFT");
  });

  it("body-account fallback: no profile but body accounts → still posts", async () => {
    await handle.prisma.postingProfile.deleteMany({});
    const variantId = await freshVariant("560", "10");
    const draft = await createDraft(variantId, "2", "1000.00", "14");
    const res = await request(server()).post(`/api/v1/sales-invoices/${draft.id}/confirm`).set(auth())
      .send({ arAccountId, revenueAccountId, taxAccountId: vatOutAccountId, cogsAccountId, inventoryAccountId });
    expect(res.status).toBeLessThan(300);
    const inv = await handle.prisma.salesInvoice.findUnique({ where: { id: draft.id } });
    expect(inv!.status).toBe("CONFIRMED");
    const rev = await handle.prisma.journalEntry.findUnique({ where: { id: inv!.journalEntryId! }, include: { lines: true } });
    expect(sum(rev!.lines, "debit").eq(sum(rev!.lines, "credit"))).toBe(true);
  });

  it("cancel confirmed invoice: succeeds, CANCELLED, FKs cleared, CustomerTransaction deleted, stock restored (no P2003)", async () => {
    await setProfile();
    const variantId = await freshVariant("560", "10");
    const draft = await createDraft(variantId, "4", "1000.00", "14");
    const confirm = await request(server()).post(`/api/v1/sales-invoices/${draft.id}/confirm`).set(auth()).send({});
    expect(confirm.status).toBeLessThan(300);

    const confirmed = await handle.prisma.salesInvoice.findUnique({ where: { id: draft.id } });
    expect(confirmed!.status).toBe("CONFIRMED");
    // Preconditions for the FK-ordering bug: the invoice references a CustomerTransaction + journal entries.
    expect(confirmed!.customerTxId).not.toBeNull();
    expect(confirmed!.journalEntryId).not.toBeNull();
    const customerTxId = confirmed!.customerTxId!;
    const journalEntryId = confirmed!.journalEntryId!;
    const cogsJournalEntryId = confirmed!.cogsJournalEntryId!;
    // Stock was consumed on confirm (10 - 4 = 6).
    const balBefore = await handle.prisma.branchInventoryBalance.findUnique({ where: { branchId_productVariantId: { branchId: handle.branchId, productVariantId: variantId } } });
    expect(new Decimal(balBefore!.boardsOnHand.toString()).toString()).toBe("6");

    const cancel = await request(server()).post(`/api/v1/sales-invoices/${draft.id}/cancel`).set(auth()).send({});
    expect(cancel.status).toBeLessThan(300); // no 500 / P2003

    const cancelled = await handle.prisma.salesInvoice.findUnique({ where: { id: draft.id } });
    expect(cancelled!.status).toBe("CANCELLED");
    // FK references cleared on the invoice.
    expect(cancelled!.customerTxId).toBeNull();
    expect(cancelled!.journalEntryId).toBeNull();
    expect(cancelled!.cogsJournalEntryId).toBeNull();
    // Referenced rows removed — no dangling accounting trace.
    expect(await handle.prisma.customerTransaction.findUnique({ where: { id: customerTxId } })).toBeNull();
    expect(await handle.prisma.journalEntry.findUnique({ where: { id: journalEntryId } })).toBeNull();
    expect(await handle.prisma.journalEntry.findUnique({ where: { id: cogsJournalEntryId } })).toBeNull();
    // SALE movements removed; stock restored to the pre-confirm level.
    expect(await handle.prisma.inventoryMovement.count({ where: { referenceId: draft.id, movementType: "SALE" } })).toBe(0);
    const balAfter = await handle.prisma.branchInventoryBalance.findUnique({ where: { branchId_productVariantId: { branchId: handle.branchId, productVariantId: variantId } } });
    expect(new Decimal(balAfter!.boardsOnHand.toString()).toString()).toBe("10");
  });
});
