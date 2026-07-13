/**
 * E2E — a posted Purchase Invoice updates the exact variant's avg_cost, and the
 * Sales Invoice selector then displays that avg_cost as the actual cost.
 *
 * Chain: create purchase → confirm purchase → reload the sales selector data
 * (GET /products/variants, exactly what the web selector calls) → resolve the
 * displayed cost with the real web helper (resolveVariantCost) → assert it
 * equals the updated avg_cost. Also proves DRAFT purchases don't move avg_cost,
 * exact SKU/size matching (no cross-variant cost), weighted averaging, and that
 * COGS stays server-controlled on avg_cost regardless of the client cost.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";
import { resolveVariantCost } from "../../../web/lib/variant-cost";

describe("sales invoice cost reflects posted purchase avg_cost (E2E)", () => {
  let handle: TestApp;
  let ownerToken: string;
  let supplierId: string;
  let arAccountId: string, revenueAccountId: string, inventoryAccountId: string, cogsAccountId: string, apAccountId: string, vatAccountId: string;

  const auth = () => ({ Authorization: `Bearer ${ownerToken}` });
  const server = () => handle.app.getHttpServer();

  // GET /products/variants — the exact call the sales selector makes.
  type ApiVariant = { id: string; sizeMetersPerBoard: string; defaultPurchasePricePerMeter: string; avgCost: string; sku: { code: string; colorNameAr: string } };
  const selectorVariant = async (variantId: string): Promise<ApiVariant> => {
    const res = await request(server()).get("/api/v1/products/variants").set(auth());
    expect(res.status).toBe(200);
    return (res.body as ApiVariant[]).find((v) => v.id === variantId)!;
  };
  // What the selector actually shows for a variant.
  const displayedCost = (v: ApiVariant) => resolveVariantCost(v.avgCost, v.defaultPurchasePricePerMeter);

  const newVariant = async (sizeMeters = "1", defaultPurchase = "560", sku?: string) => {
    const skuRow = sku
      ? await handle.prisma.productSku.findUniqueOrThrow({ where: { code: sku } })
      : await handle.prisma.productSku.create({ data: { code: `PC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
    return (await handle.prisma.productVariant.create({
      data: { skuId: skuRow.id, sizeMetersPerBoard: sizeMeters, defaultSalePricePerMeter: "1000", defaultPurchasePricePerMeter: defaultPurchase, avgCost: "0" },
    })).id;
  };

  const purchaseDraft = (variantId: string, boards: string, unitPrice: string) =>
    request(server()).post("/api/v1/purchase-invoices").set(auth()).send({
      invoiceDate: "2026-07-15", supplierId, branchId: handle.branchId,
      lines: [{ productVariantId: variantId, boardsQuantity: boards, lengthM: "1", unitPrice, taxRate: "0" }],
    });
  const confirmPurchase = (id: string) => request(server()).post(`/api/v1/purchase-invoices/${id}/confirm`).set(auth()).send({});

  beforeAll(async () => {
    handle = await buildTestApp();
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    ownerToken = (await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    supplierId = (await handle.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "Supplier" } })).id;

    const uniq = Date.now().toString().slice(-6);
    const acc = (code: string, nameAr: string, cat: string, t: string, role?: string) =>
      handle.prisma.account.create({ data: { code, nameAr, nameEn: nameAr, category: cat as never, accountType: t as never, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) } });
    arAccountId = (await acc(`AR${uniq}`, "عملاء", "ASSET", "CURRENT_ASSET", "AR_CONTROL")).id;
    apAccountId = (await acc(`AP${uniq}`, "موردون", "LIABILITY", "LIABILITY", "AP_CONTROL")).id;
    revenueAccountId = (await acc(`REV${uniq}`, "مبيعات", "REVENUE", "REVENUE")).id;
    inventoryAccountId = (await acc(`INV${uniq}`, "مخزون", "ASSET", "CURRENT_ASSET")).id;
    cogsAccountId = (await acc(`COGS${uniq}`, "تكلفة", "COST_OF_SALES", "COST_OF_SALES")).id;
    vatAccountId = (await acc(`VATIN${uniq}`, "ضريبة مشتريات", "ASSET", "CURRENT_ASSET")).id;
    await handle.prisma.postingProfile.create({ data: { effectiveFrom: new Date("2026-01-01"), arAccountId, apAccountId, revenueAccountId, inventoryAccountId, cogsAccountId, vatInputAccountId: vatAccountId, createdBy: handle.ownerId } });
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
  });

  afterAll(async () => teardownTestApp(handle));

  it("posting a purchase at 560 makes the selector display cost = avg_cost = 560 (actual)", async () => {
    const variantId = await newVariant("1", "560");
    // Before any purchase: avg_cost = 0 → selector falls back to the default as an estimate.
    const before = displayedCost(await selectorVariant(variantId));
    expect(before.source).toBe("estimate");

    const draft = await purchaseDraft(variantId, "4", "560.00");
    expect(draft.status).toBeLessThan(300);
    const confirm = await confirmPurchase(draft.body.id);
    expect(confirm.status).toBeLessThan(300);

    const after = await selectorVariant(variantId);
    expect(new Decimal(after.avgCost).toString()).toBe("560"); // avg updated before the selector reads it
    const shown = displayedCost(after);
    expect(shown.source).toBe("actual");
    expect(new Decimal(shown.value!).toString()).toBe("560"); // displayed cost === updated avg_cost
  });

  it("a DRAFT purchase does not change avg_cost or the displayed cost", async () => {
    const variantId = await newVariant("1", "560");
    const draft = await purchaseDraft(variantId, "4", "560.00");
    expect(draft.status).toBeLessThan(300); // created but NOT confirmed
    const v = await selectorVariant(variantId);
    expect(new Decimal(v.avgCost).toString()).toBe("0");
    expect(displayedCost(v).source).not.toBe("actual"); // still no actual cost
  });

  it("matches the exact SKU/size — a sibling size keeps its own (unposted) cost", async () => {
    const skuCode = `PCX-${Date.now()}`;
    await handle.prisma.productSku.create({ data: { code: skuCode, category: "NORMAL", colorNameAr: "أخضر", colorNameEn: "green" } });
    const small = await newVariant("4", "560", skuCode);   // size 4.0
    const large = await newVariant("5.25", "560", skuCode); // size 5.25
    await confirmPurchase((await purchaseDraft(small, "4", "560.00")).body.id); // post ONLY the small size

    const smallV = await selectorVariant(small);
    const largeV = await selectorVariant(large);
    expect(new Decimal(smallV.avgCost).toString()).toBe("560");
    expect(displayedCost(smallV)).toEqual({ value: "560", source: "actual" });
    // The large size was never posted → its avg_cost is untouched; it must NOT show the small size's 560 as actual.
    expect(new Decimal(largeV.avgCost).toString()).toBe("0");
    expect(displayedCost(largeV).source).not.toBe("actual");
  });

  it("later purchases move the displayed cost to the weighted average", async () => {
    const variantId = await newVariant("1", "560");
    await confirmPurchase((await purchaseDraft(variantId, "4", "560.00")).body.id); // avg 560
    await confirmPurchase((await purchaseDraft(variantId, "4", "760.00")).body.id); // 4@560 + 4@760 → 660
    const v = await selectorVariant(variantId);
    expect(new Decimal(v.avgCost).toString()).toBe("660");
    expect(displayedCost(v)).toEqual({ value: "660", source: "actual" });
  });

  it("COGS stays server-controlled on avg_cost and ignores the client-entered cost", async () => {
    const variantId = await newVariant("1", "560");
    await confirmPurchase((await purchaseDraft(variantId, "10", "560.00")).body.id); // avg 560, stock 10
    const customerId = (await handle.prisma.customer.create({ data: { code: `SC-${Date.now()}`, nameAr: "عميل" } })).id;

    const sDraft = await request(server()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-07-16", customerId, branchId: handle.branchId, taxRate: "0",
      lines: [{ productVariantId: variantId, quantity: "2", unitPrice: "1000", costPrice: "999" }], // client cost 999 must be ignored
    });
    expect(sDraft.status).toBeLessThan(300);
    const conf = await request(server()).post(`/api/v1/sales-invoices/${sDraft.body.id}/confirm`).set(auth()).send({});
    expect(conf.status).toBeLessThan(300);

    const inv = await handle.prisma.salesInvoice.findUnique({ where: { id: sDraft.body.id } });
    const cogs = await handle.prisma.journalEntry.findUnique({ where: { id: inv!.cogsJournalEntryId! }, include: { lines: true } });
    const cogsDr = cogs!.lines.find((l) => l.accountId === cogsAccountId)!;
    expect(new Decimal(cogsDr.debit.toString()).toString()).toBe("1120"); // 2 × avg 560, NOT 2 × 999
  });
});
