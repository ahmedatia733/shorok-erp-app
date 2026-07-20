/**
 * Sales invoices priced PER METER (confirmed business rule).
 *
 * The line quantity is the number of BOARDS; the backend independently derives
 * totalMeters = boards × sizeMetersPerBoard (from the DB variant, never a client
 * total) and computes lineTotal = totalMeters × unitPricePerMeter after
 * discount. Proves the spec examples end-to-end, plus posting (revenue = the
 * per-metre invoice total), inventory (boards reduce by the boards sold; metres
 * by boards × size) and COGS (boards × avg_cost).
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("sales invoices — per-meter pricing", () => {
  let handle: TestApp;
  let ownerToken: string;
  let customerId: string;
  let arAccountId: string, revenueAccountId: string, vatOutAccountId: string, cogsAccountId: string, inventoryAccountId: string;

  const auth = () => ({ Authorization: `Bearer ${ownerToken}` });
  const server = () => handle.app.getHttpServer();

  beforeAll(async () => {
    handle = await buildTestApp();
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    ownerToken = (await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" })).body.accessToken;

    customerId = (await handle.prisma.customer.create({ data: { code: "PM-1", nameAr: "عميل المتر" } })).id;

    const uniq = Date.now().toString().slice(-6);
    const mk = (code: string, nameAr: string, category: any, accountType: any, systemRole?: string) =>
      handle.prisma.account.create({ data: { code, nameAr, nameEn: nameAr, category, accountType, isLeaf: true, active: true, ...(systemRole ? { systemRole: systemRole as never } : {}) } });
    arAccountId = (await mk(`PMAR${uniq}`, "عملاء", "ASSET", "CURRENT_ASSET", "AR_CONTROL")).id;
    revenueAccountId = (await mk(`PMREV${uniq}`, "مبيعات", "REVENUE", "REVENUE")).id;
    vatOutAccountId = (await mk(`PMVAT${uniq}`, "ضريبة مبيعات", "LIABILITY", "LIABILITY")).id;
    cogsAccountId = (await mk(`PMCOGS${uniq}`, "تكلفة مبيعات", "COST_OF_SALES", "COST_OF_SALES")).id;
    inventoryAccountId = (await mk(`PMINV${uniq}`, "مخزون", "ASSET", "CURRENT_ASSET")).id;

    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
    await handle.prisma.postingProfile.create({
      data: { effectiveFrom: new Date("2026-01-01"), arAccountId, revenueAccountId, vatOutputAccountId: vatOutAccountId, cogsAccountId, inventoryAccountId, createdBy: handle.ownerId },
    });
  });

  afterAll(async () => teardownTestApp(handle));

  let seq = 0;
  const freshVariant = async (size: string, salePerMeter: string, purchasePerMeter: string, avgCost: string, stockBoards: string) => {
    const sku = await handle.prisma.productSku.create({ data: { code: `PM-${++seq}`, category: "NORMAL", colorNameAr: "ص", colorNameEn: "c" } });
    const v = await handle.prisma.productVariant.create({
      data: { skuId: sku.id, sizeMetersPerBoard: size, defaultSalePricePerMeter: salePerMeter, defaultPurchasePricePerMeter: purchasePerMeter, avgCost },
    });
    if (new Decimal(stockBoards).gt(0)) {
      await handle.prisma.branchInventoryBalance.create({
        data: { branchId: handle.branchId, productVariantId: v.id, boardsOnHand: stockBoards, metersOnHand: new Decimal(stockBoards).mul(size).toFixed(4) },
      });
    }
    return v.id;
  };

  const createDraft = async (variantId: string, boards: string, unitPrice: string, costPrice: string, discountPct = "0", taxRate = "0") => {
    const res = await request(server()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-07-15", customerId, branchId: handle.branchId, taxRate,
      lines: [{ productVariantId: variantId, quantity: boards, unitPrice, costPrice, discountPct }],
    });
    expect(res.status).toBeLessThan(300);
    return res.body;
  };

  it("Example A: 10 boards × 4.00 × 498 → line total & cost 19,920.00 (backend-computed)", async () => {
    const v = await freshVariant("4.00", "498", "498", "0", "0");
    // NOTE: no line total sent — the backend computes it from boards × size × price.
    const inv = await createDraft(v, "10", "498", "498");
    expect(inv.lines[0].quantity).toBe("10");                // boards stored
    expect(inv.lines[0].metersQuantity).toBe("40.0000");     // derived metres
    expect(inv.lines[0].lineTotal).toBe("19920.00");
    expect(inv.lines[0].lineCost).toBe("19920.00");
    expect(inv.subtotal).toBe("19920.00");
  });

  it("Example B: 45 boards × 5.25 × 498 → 117,652.50", async () => {
    const v = await freshVariant("5.25", "498", "498", "0", "0");
    const inv = await createDraft(v, "45", "498", "498");
    expect(inv.lines[0].metersQuantity).toBe("236.2500");
    expect(inv.lines[0].lineTotal).toBe("117652.50");
  });

  it("Example C: 8 boards × 3.75; sale 750 → 22,500.00; cost 498 → 14,940.00; profit 7,560.00", async () => {
    const v = await freshVariant("3.75", "750", "498", "0", "0");
    const inv = await createDraft(v, "8", "750", "498");
    expect(inv.lines[0].metersQuantity).toBe("30.0000");
    expect(inv.lines[0].lineTotal).toBe("22500.00");
    expect(inv.lines[0].lineCost).toBe("14940.00");
    const profit = new Decimal(inv.lines[0].lineTotal).minus(inv.lines[0].lineCost);
    expect(profit.toFixed(2)).toBe("7560.00");
  });

  it("discount is taken from the per-meter gross sale, and VAT from the net total", async () => {
    const v = await freshVariant("4.00", "498", "498", "0", "0");
    // 10 boards × 4 × 498 = 19,920 gross; 10% discount = 1,992; net = 17,928; VAT 14% = 2,509.92
    const inv = await createDraft(v, "10", "498", "498", "10", "14");
    expect(inv.subtotal).toBe("17928.00");
    expect(inv.discountAmount).toBe("1992.00");
    expect(inv.taxAmount).toBe("2509.92");
    expect(inv.grandTotal).toBe("20437.92");
  });

  it("confirm: revenue = per-meter total; stock reduces by BOARDS; metres by boards×size; COGS = boards×avg", async () => {
    const v = await freshVariant("4.00", "498", "498", "2000", "20"); // avg 2000/board, 20 boards
    const inv = await createDraft(v, "10", "498", "498", "0", "14"); // sub 19,920; VAT 2,788.80; grand 22,708.80
    const res = await request(server()).post(`/api/v1/sales-invoices/${inv.id}/confirm`).set(auth()).send({});
    expect(res.status).toBeLessThan(300);

    const saved = await handle.prisma.salesInvoice.findUnique({ where: { id: inv.id } });
    const rev = await handle.prisma.journalEntry.findUnique({ where: { id: saved!.journalEntryId! }, include: { lines: true } });
    const cogs = await handle.prisma.journalEntry.findUnique({ where: { id: saved!.cogsJournalEntryId! }, include: { lines: true } });

    // Revenue = subtotal (per-metre net); AR = grand total; VAT = tax.
    expect(new Decimal(rev!.lines.find((l) => l.accountId === revenueAccountId)!.credit.toString()).toFixed(2)).toBe("19920.00");
    expect(new Decimal(rev!.lines.find((l) => l.accountId === arAccountId)!.debit.toString()).toFixed(2)).toBe("22708.80");

    // COGS = 10 boards × avg 2000 = 20,000.
    expect(new Decimal(cogs!.lines.find((l) => l.accountId === cogsAccountId)!.debit.toString()).toFixed(2)).toBe("20000.00");

    // Stock: 20 → 10 boards (deduct the 10 boards sold, NOT 10/size); metres 80 → 40.
    const bal = await handle.prisma.branchInventoryBalance.findUnique({ where: { branchId_productVariantId: { branchId: handle.branchId, productVariantId: v } } });
    expect(new Decimal(bal!.boardsOnHand.toString()).toFixed(4)).toBe("10.0000");
    expect(new Decimal(bal!.metersOnHand.toString()).toFixed(4)).toBe("40.0000");
    const mv = await handle.prisma.inventoryMovement.findFirst({ where: { referenceId: inv.id, movementType: "SALE" } });
    expect(new Decimal(mv!.boardsQuantity.toString()).toFixed(4)).toBe("-10.0000");
  });

  it("non-498 prices load per the variant and compute per meter (750 stays 750)", async () => {
    const v = await freshVariant("4.00", "750", "635", "0", "0");
    const inv = await createDraft(v, "2", "750", "635");
    // 2 × 4 × 750 = 6000 sale; 2 × 4 × 635 = 5080 cost.
    expect(inv.lines[0].lineTotal).toBe("6000.00");
    expect(inv.lines[0].lineCost).toBe("5080.00");
  });
});
