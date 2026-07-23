/**
 * LEGACY costing documentation. The CANONICAL model is now meter-based — see
 * `meter-costing.spec.ts` (lineCogs = metersQuantity × avgCostPerMeter). This
 * file documents that the LEGACY per-BOARD snapshots are still preserved
 * (avg_cost, unit_cost_at_posting) and that for NATIVE-size sales the two bases
 * coincide (boards × per-board == metres × per-metre == the posted COGS journal).
 *
 * Proves the unit of SalesInvoiceLine.unitCostAtPosting via the REAL
 * purchase→WAC→sale→journal flow (never seeding avg_cost directly).
 *
 * Evidence chain (see costing.ts / sales confirm):
 *   purchase: unitCost = lineTotalExTax / boards            → cost PER BOARD
 *   avg_cost  = weightedAverageCost(... "per board")        → cost PER BOARD
 *   sale:     unitCostAtPosting = avg_cost                  → cost PER BOARD
 *             cogs journal      = Σ boards × avg_cost
 * Therefore reporting COGS = Σ(boards × unit_cost_at_posting), and it must
 * equal the posted COGS journal. `meters × unitCostAtPosting` would be wrong.
 *
 * The two required proof cases are constructed via a purchase at a known price
 * PER METER, so that unit_cost_at_posting = pricePerMeter × boardArea:
 *   A) boards 2, meters 8 (area 4), price 400/m → per-board 1600 → COGS 3200
 *   B) custom boards 2, meters 6 (area 3), price 400/m → per-board 1200 → COGS 2400
 * Boards ≠ meters in both, so a boards/meters unit mix-up cannot pass.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

const D = (v: unknown) => new Decimal((v as { toString(): string }).toString());

describe("reporting COGS unit (per board) — proven via real purchase→sale→journal", () => {
  let handle: TestApp;
  let token: string;
  let repId: string, customerId: string, supplierId: string;
  let cogsAcc: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => handle.app.getHttpServer();

  beforeAll(async () => {
    handle = await buildTestApp();
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    repId = (await handle.prisma.salesRepresentative.create({ data: { code: "CR", nameAr: "مندوب" } })).id;
    customerId = (await handle.prisma.customer.create({ data: { code: "CU", nameAr: "عميل" } })).id;
    supplierId = (await handle.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "S" } })).id;
    const u = Date.now().toString().slice(-6);
    const mk = (c: string, cat: any, t: any, role?: string) =>
      handle.prisma.account.create({ data: { code: c, nameAr: c, nameEn: c, category: cat, accountType: t, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } });
    const ar = (await mk(`AR${u}`, "ASSET", "CURRENT_ASSET", "AR_CONTROL")).id;
    const ap = (await mk(`AP${u}`, "LIABILITY", "LIABILITY", "AP_CONTROL")).id;
    const rev = (await mk(`RV${u}`, "REVENUE", "REVENUE")).id;
    const vatO = (await mk(`VO${u}`, "LIABILITY", "LIABILITY")).id;
    const vatI = (await mk(`VI${u}`, "ASSET", "CURRENT_ASSET")).id;
    cogsAcc = (await mk(`CG${u}`, "COST_OF_SALES", "COST_OF_SALES")).id;
    const inv = (await mk(`IN${u}`, "ASSET", "CURRENT_ASSET")).id;
    await handle.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId: ar, apAccountId: ap, revenueAccountId: rev, vatOutputAccountId: vatO, vatInputAccountId: vatI, cogsAccountId: cogsAcc, inventoryAccountId: inv, createdBy: handle.ownerId } });
    for (let m = 1; m <= 12; m++) await handle.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });
  });
  afterAll(async () => teardownTestApp(handle));

  let seq = 0;
  const newVariant = async (size: string) => {
    const sku = await handle.prisma.productSku.create({ data: { code: `CU-${++seq}`, category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
    return (await handle.prisma.productVariant.create({ data: { skuId: sku.id, sizeMetersPerBoard: size, defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0" } })).id;
  };
  // Purchase `boards` at `pricePerMeter` (accountant enters price PER METER).
  const purchaseAtPerMeter = async (variantId: string, boards: string, pricePerMeter: string, dims?: { lengthM?: string; widthM?: string }) => {
    const d = await request(server()).post("/api/v1/purchase-invoices").set(auth()).send({
      invoiceDate: "2026-02-01", supplierId, branchId: handle.branchId,
      lines: [{ productVariantId: variantId, boardsQuantity: boards, unitPrice: pricePerMeter, taxRate: "0", ...(dims ?? {}) }],
    });
    expect(d.status).toBeLessThan(300);
    expect((await request(server()).post(`/api/v1/purchase-invoices/${d.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);
  };
  const saleConfirmed = async (variantId: string, boards: string, price: string, dims?: { lengthM?: string; widthM?: string }) => {
    const d = await request(server()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-03-01", customerId, branchId: handle.branchId, taxRate: "0", salesRepresentativeId: repId,
      lines: [{ productVariantId: variantId, quantity: boards, unitPrice: price, costPrice: "0", ...(dims ?? {}) }],
    });
    expect(d.status).toBeLessThan(300);
    expect((await request(server()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);
    return d.body.id as string;
  };
  const cogsJournalAmount = async (invoiceId: string) => {
    const inv = await handle.prisma.salesInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv?.cogsJournalEntryId) return new Decimal(0);
    const line = await handle.prisma.journalLine.findFirst({ where: { journalEntryId: inv.cogsJournalEntryId, accountId: cogsAcc } });
    return D(line!.debit);
  };
  const repCogs = async (variantId: string) => {
    // Filter to THIS test's variant so the assertion is isolated from other tests'
    // sales sharing the same rep/date in this suite.
    const r = await request(server()).get(`/api/v1/reports/sales-representatives/summary?preset=custom&from=2026-01-01&to=2026-12-31&productVariantId=${variantId}`).set(auth());
    return D(r.body.representatives[0].cogs);
  };

  it("evidence: unit_cost_at_posting equals the purchase cost PER BOARD (lineTotal/boards)", async () => {
    const v = await newVariant("4.0000");
    await purchaseAtPerMeter(v, "10", "400"); // 10 boards × 4m × 400 = 16000 → per board 1600
    const variant = await handle.prisma.productVariant.findUnique({ where: { id: v } });
    expect(D(variant!.avgCost).toFixed(2)).toBe("1600.00"); // PER BOARD, not per meter (400)
    const id = await saleConfirmed(v, "2", "999", { lengthM: "4" });
    const line = await handle.prisma.salesInvoiceLine.findFirst({ where: { invoiceId: id } });
    expect(D(line!.unitCostAtPosting).toFixed(2)).toBe("1600.00"); // snapshot = per board
  });

  it("A) boards 2 / meters 8, price 400/m → COGS 3,200.00 (boards×perBoard == meters×perMeter == journal)", async () => {
    const v = await newVariant("4.0000");
    await purchaseAtPerMeter(v, "10", "400"); // per-board 1600
    const id = await saleConfirmed(v, "2", "999", { lengthM: "4" }); // meters 8
    const line = await handle.prisma.salesInvoiceLine.findFirst({ where: { invoiceId: id } });
    const boards = D(line!.quantity), meters = D(line!.metersQuantity), perBoard = D(line!.unitCostAtPosting);
    expect(boards.toFixed(0)).toBe("2");
    expect(meters.toFixed(4)).toBe("8.0000");
    // Correct expression (per board):
    expect(boards.mul(perBoard).toFixed(2)).toBe("3200.00");
    // Business check: == metersSold × costPerMeter(400):
    expect(meters.mul(400).toFixed(2)).toBe("3200.00");
    // The WRONG expression would give a different number → proves boards≠meters guards it:
    expect(meters.mul(perBoard).toFixed(2)).toBe("12800.00");
    // Reporting COGS reconciles to the posted COGS journal:
    expect((await cogsJournalAmount(id)).toFixed(2)).toBe("3200.00");
    expect((await repCogs(v)).toFixed(2)).toBe("3200.00");
  });

  it("B) CUSTOM boards 2 / meters 6 (area 3), price 400/m → COGS 2,400.00 (== journal)", async () => {
    // Buy the board as a 3m board at 400/m → per-board 1200; sell 2 with custom area 3.
    const v = await newVariant("3.0000");
    await purchaseAtPerMeter(v, "10", "400"); // 10×3×400=12000 → per board 1200
    expect(D((await handle.prisma.productVariant.findUnique({ where: { id: v } }))!.avgCost).toFixed(2)).toBe("1200.00");
    const id = await saleConfirmed(v, "2", "999", { lengthM: "2", widthM: "1.5" }); // area 3 → meters 6
    const line = await handle.prisma.salesInvoiceLine.findFirst({ where: { invoiceId: id } });
    expect(D(line!.metersQuantity).toFixed(4)).toBe("6.0000");
    expect(D(line!.quantity).mul(line!.unitCostAtPosting).toFixed(2)).toBe("2400.00"); // 2 × 1200
    expect((await cogsJournalAmount(id)).toFixed(2)).toBe("2400.00");
    expect((await repCogs(v)).toFixed(2)).toBe("2400.00");
  });

  it("reporting COGS always equals the posted COGS journal (large variant, boards≠meters)", async () => {
    const v = await newVariant("5.2500");
    await purchaseAtPerMeter(v, "8", "200"); // 8×5.25×200=8400 → per board 1050
    const id = await saleConfirmed(v, "3", "999", { lengthM: "5.25" }); // 3 boards, 15.75 m
    // per board 1050 → COGS 3 × 1050 = 3150 (== 15.75 m × 200/m)
    expect((await cogsJournalAmount(id)).toFixed(2)).toBe("3150.00");
    expect((await repCogs(v)).toFixed(2)).toBe("3150.00");
  });
});
