/**
 * Purchase-invoice cancellation must reverse the TAX effect, not just stock.
 *
 * Bug: confirming a purchase invoice with VAT posts a debit to the (shared)
 * VAT account = input VAT. Cancelling reverses the journal — which posts a
 * CREDIT to that same VAT account. The tax ledger classified input/output VAT
 * purely by debit/credit sign, so the reversal credit was counted as *output*
 * VAT (a sale!) instead of netting the original input VAT back to zero. The
 * cancelled invoice therefore still showed its tax as active input VAT.
 *
 * These tests prove the tax ledger classifies each VAT line by its transaction
 * ORIGIN (purchase → input, sale → output) and nets reversals, so a cancelled
 * purchase invoice contributes zero net input VAT while the GL stays intact
 * (original debit + reversal credit both retained and balanced).
 */
import { Decimal } from "decimal.js";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("purchase invoice cancellation — tax reversal", () => {
  let handle: TestApp;
  let ownerToken: string;
  let supplierId: string;
  let variantId: string;
  let apAccountId: string;
  let inventoryAccountId: string;
  let vatAccountId: string;

  const BOARDS = "10";     // 10 boards @ 100 = 1000 subtotal
  const TAX = "140.00";    // 14% of 1000

  const auth = () => ({ Authorization: `Bearer ${ownerToken}` });
  const server = () => handle.app.getHttpServer();

  beforeAll(async () => {
    handle = await buildTestApp();

    const login = await request(server())
      .post("/api/v1/auth/login")
      .send({ phone: handle.ownerPhone, password: handle.ownerPassword });
    ownerToken = login.body.accessToken;

    supplierId = (await handle.prisma.supplier.create({
      data: { nameAr: "مورد ضريبة", nameEn: "Tax Supplier", active: true },
    })).id;

    const sku = await handle.prisma.productSku.create({
      data: { code: "PCT-01", category: "NORMAL", colorNameAr: "أزرق", colorNameEn: "Blue", active: true },
    });
    // 1 meter per board keeps the arithmetic simple: 10 boards @ 100/m = 1000
    // subtotal, 14% = 140 tax.
    variantId = (await handle.prisma.productVariant.create({
      data: { skuId: sku.id, sizeMetersPerBoard: "1", defaultSalePricePerMeter: "150", defaultPurchasePricePerMeter: "100", active: true },
    })).id;

    const mk = (code: string, nameAr: string, category: "ASSET" | "LIABILITY", accountType: "CURRENT_ASSET" | "LIABILITY") =>
      handle.prisma.account.create({ data: { code, nameAr, nameEn: nameAr, category, accountType, isLeaf: true, active: true } });
    apAccountId = (await mk("PCT-AP", "موردون اختبار الضريبة", "LIABILITY", "LIABILITY")).id;
    inventoryAccountId = (await mk("PCT-INV", "مخزون اختبار الضريبة", "ASSET", "CURRENT_ASSET")).id;
    // A single shared VAT account (name contains "ضريبة" so the ledger finds it),
    // mirroring production where vatInput === vatOutput.
    vatAccountId = (await mk("PCT-VAT", "ضريبة القيمة المضافة اختبار", "LIABILITY", "LIABILITY")).id;

    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
    await handle.prisma.postingProfile.create({
      data: { effectiveFrom: new Date("2026-01-01"), apAccountId, inventoryAccountId, vatInputAccountId: vatAccountId, vatOutputAccountId: vatAccountId, createdBy: handle.ownerId },
    });
  });

  afterAll(async () => teardownTestApp(handle));

  const confirmInvoice = async () => {
    const draft = await request(server()).post("/api/v1/purchase-invoices").set(auth()).send({
      invoiceDate: "2026-07-10", supplierId, branchId: handle.branchId,
      lines: [{ productVariantId: variantId, boardsQuantity: BOARDS, unitPrice: "100.00", taxRate: "14" }],
    });
    expect(draft.status).toBeLessThan(300);
    const id = draft.body.id as string;
    const conf = await request(server()).post(`/api/v1/purchase-invoices/${id}/confirm`).set(auth()).send({});
    expect(conf.status).toBeLessThan(300);
    return id;
  };

  const taxLedger = async () => {
    const res = await request(server())
      .get(`/api/v1/reports/tax-ledger?accountId=${vatAccountId}`)
      .set(auth());
    expect(res.status).toBe(200);
    return res.body as {
      opening: { debit: string; credit: string; inputVat: string; outputVat: string };
      entries: Array<{ entryId: string; debit: string; credit: string; vatDirection: string; vatAmount: string; isReversal: boolean; reversed: boolean; referenceType: string }>;
      periodTotals: { debit: string; credit: string; inputVat: string; outputVat: string };
      closing: { debit: string; credit: string; net: string; status: string };
    };
  };

  it("a confirmed purchase invoice contributes input VAT and no output VAT", async () => {
    const id = await confirmInvoice();
    const led = await taxLedger();

    expect(led.periodTotals.inputVat).toBe(TAX);
    expect(led.periodTotals.outputVat).toBe("0.00");

    const row = led.entries.find((e) => !e.isReversal && e.referenceType === "purchase_invoice");
    expect(row).toBeTruthy();
    expect(row!.vatDirection).toBe("input");
    expect(row!.vatAmount).toBe(TAX);

    // cleanup so each test starts from a clean VAT ledger
    await request(server()).post(`/api/v1/purchase-invoices/${id}/cancel`).set(auth()).send({});
  });

  it("cancelling nets input VAT back to zero while keeping the GL intact", async () => {
    const id = await confirmInvoice();
    const cancel = await request(server()).post(`/api/v1/purchase-invoices/${id}/cancel`).set(auth()).send({});
    expect(cancel.status).toBeLessThan(300);

    const led = await taxLedger();

    // Net input VAT across all rows on this account (original + reversal) is zero.
    const netInput = led.entries
      .filter((e) => e.vatDirection === "input")
      .reduce((s, e) => s.add(e.vatAmount), new Decimal(0));
    expect(netInput.toFixed(2)).toBe("0.00");

    // Original still there and flagged reversed; a reversal row exists.
    const original = led.entries.find((e) => e.referenceType === "purchase_invoice" && !e.isReversal);
    const reversal = led.entries.find((e) => e.isReversal);
    expect(original?.reversed).toBe(true);
    expect(reversal).toBeTruthy();
    expect(reversal!.vatDirection).toBe("input"); // reversal of a PURCHASE stays on the input side
    expect(new Decimal(reversal!.vatAmount).toFixed(2)).toBe("-140.00");

    // GL preserved: nothing deleted — the original debit and the reversal credit
    // are both retained, so raw debit and credit stay equal and non-zero.
    const rawDebit = led.entries.reduce((s, e) => s.add(e.debit || "0"), new Decimal(0));
    const rawCredit = led.entries.reduce((s, e) => s.add(e.credit || "0"), new Decimal(0));
    expect(rawDebit.eq(rawCredit)).toBe(true);
    expect(rawDebit.gte("140.00")).toBe(true);

    // The invoice itself is CANCELLED and its journal entry REVERSED.
    const inv = await handle.prisma.purchaseInvoice.findUnique({ where: { id } });
    expect(inv?.status).toBe("CANCELLED");
    const je = await handle.prisma.journalEntry.findUnique({ where: { id: inv!.journalEntryId! } });
    expect(je?.status).toBe("REVERSED");
  });

  it("the tax ledger period + closing show a zero net VAT position after cancellation", async () => {
    const id = await confirmInvoice();
    await request(server()).post(`/api/v1/purchase-invoices/${id}/cancel`).set(auth()).send({});
    const led = await taxLedger();
    expect(led.periodTotals.inputVat).toBe("0.00");
    expect(led.periodTotals.outputVat).toBe("0.00");
    expect(led.closing.net).toBe("0.00");
    expect(led.closing.status).toBe("zero");
  });

  it("cancelling a purchase does NOT wipe an unrelated output-VAT credit on the same account", async () => {
    // A credit to the shared VAT account that is NOT a purchase (e.g. a sale /
    // manual output VAT) must remain classified as output and survive a
    // purchase cancellation — the reversal only nets its own input side.
    const outVat = "90.00";
    await handle.prisma.journalEntry.create({
      data: {
        entryType: "JOURNAL",
        entryDate: new Date("2026-07-12"),
        description: "ضريبة مخرجات يدوية",
        status: "POSTED",
        sourceType: "MANUAL",
        createdBy: handle.ownerId,
        lines: {
          create: [
            { accountId: apAccountId,  debit: outVat, credit: "0" },
            { accountId: vatAccountId, debit: "0",    credit: outVat },
          ],
        },
      },
    });

    const id = await confirmInvoice();
    await request(server()).post(`/api/v1/purchase-invoices/${id}/cancel`).set(auth()).send({});

    const led = await taxLedger();
    // The manual output VAT is still counted; the cancelled purchase nets to zero.
    expect(new Decimal(led.periodTotals.outputVat).gte(outVat)).toBe(true);
    expect(led.periodTotals.inputVat).toBe("0.00");
  });
});
