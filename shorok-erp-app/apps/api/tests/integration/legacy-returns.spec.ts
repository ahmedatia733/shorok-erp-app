/**
 * مردودات بدون فواتير — goods sold before this ERP existed, coming back.
 *
 * The document's whole reason to exist is that the original electronic invoice
 * is missing, so the two numbers a normal return reads off that invoice have to
 * come from somewhere else: the selling price from the paper in the operator's
 * hand, and the cost from the approved policy — the variant's weighted-average
 * cost at the moment of confirmation, frozen on the line.
 *
 * Most of this suite is about that frozen number: that it is taken once, that a
 * later WAC change cannot rewrite it, that the cancellation reverses the amount
 * actually posted, and that no cost is ever invented when none exists.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { Decimal } from "decimal.js";
import { buildTestApp, teardownTestApp, openCurrentPeriod, type TestApp } from "./test-app";

jest.setTimeout(180000);
if (!process.env.CHROME_PATH && !process.env.PUPPETEER_EXECUTABLE_PATH) {
  process.env.CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}

describe("legacy sales returns (مردودات بدون فواتير)", () => {
  let h: TestApp;
  let ownerToken: string;
  let accountantToken: string;
  let customerId: string;
  let supplierId: string;
  let branchB: string;
  let skuId: string;
  let salesReturnsAccountId: string;

  const server = () => h.app.getHttpServer();
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const u = Date.now().toString().slice(-6);
  const today = () => new Date().toISOString().slice(0, 10);

  const get = (p: string, t = ownerToken) => request(server()).get(`/api/v1${p}`).set(H(t));
  const post = (p: string, b: unknown, t = ownerToken) =>
    request(server()).post(`/api/v1${p}`).set(H(t)).send(b);

  /** The variant's authoritative weighted-average cost per metre. */
  const wac = async (variantId: string) =>
    new Decimal(
      (await h.prisma.productVariant.findUnique({ where: { id: variantId } }))!.avgCostPerMeter.toString(),
    );

  const stock = async (variantId: string, branchId = h.branchId) => {
    const b = await h.prisma.branchInventoryBalance.findUnique({
      where: { branchId_productVariantId: { branchId, productVariantId: variantId } },
    });
    return { boards: new Decimal(b?.boardsOnHand?.toString() ?? "0"), meters: new Decimal(b?.metersOnHand?.toString() ?? "0") };
  };

  /** Buys stock the normal way, which is also how the WAC is legitimately moved. */
  const buy = async (size: string, boards: string, pricePerMeter: string, branchId = h.branchId) => {
    const inv = await post("/purchase-invoices", {
      invoiceDate: today(),
      supplierId,
      branchId,
      lines: [{ productSkuId: skuId, sizeMetersPerBoard: size, boardsQuantity: boards, unitPrice: pricePerMeter, taxRate: "0" }],
    });
    expect(inv.status).toBe(201);
    const c = await post(`/purchase-invoices/${inv.body.id}/confirm`, {});
    expect(c.status).toBeLessThan(300);
    return c;
  };

  const draft = (lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
    post("/legacy-returns", {
      customerId,
      branchId: h.branchId,
      paperInvoiceNumber: `PAPER-${u}`,
      paperInvoiceDate: "2026-01-15",
      returnDate: today(),
      lines,
      ...extra,
    });

  beforeAll(async () => {
    h = await buildTestApp();
    const pw = "Pwd@2026!";
    const passwordHash = await bcrypt.hash(pw, 10);
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash } });
    await h.prisma.user.create({
      data: {
        name: "محاسب", phone: `+2018${u}`, passwordHash, role: "ACCOUNTANT" as never, status: "ACTIVE",
        branchAccesses: { create: { branchId: h.branchId } },
      },
    });
    const login = async (phone: string) =>
      (await request(server()).post("/api/v1/auth/login").send({ phone, password: pw })).body.accessToken as string;
    ownerToken = await login(h.ownerPhone);
    accountantToken = await login(`+2018${u}`);

    customerId = (await h.prisma.customer.create({ data: { code: `C-${u}`, nameAr: `عميل ${u}` } })).id;
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: `مورد ${u}`, nameEn: `sup${u}` } })).id;
    branchB = (await h.prisma.branch.create({ data: { nameAr: "فرع ثانٍ", nameEn: "B", active: true } })).id;
    await h.prisma.userBranchAccess.create({ data: { userId: h.ownerId, branchId: branchB } });
    skuId = (await h.prisma.productSku.create({
      data: { code: `LR-${u}`, colorNameAr: "صاج مجلفن", colorNameEn: "Galv", category: "NORMAL" },
    })).id;

    const acc = (code: string, nameAr: string, cat: string, t: string, role?: string) =>
      h.prisma.account.create({
        data: { code, nameAr, nameEn: nameAr, category: cat as never, accountType: t as never, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) },
      });
    const arAccountId = (await acc(`AR${u}`, "عملاء", "ASSET", "CURRENT_ASSET", "AR_CONTROL")).id;
    const apAccountId = (await acc(`AP${u}`, "موردون", "LIABILITY", "LIABILITY", "AP_CONTROL")).id;
    const revenueAccountId = (await acc(`REV${u}`, "مبيعات", "REVENUE", "REVENUE")).id;
    // The dedicated contra-revenue account this feature required.
    salesReturnsAccountId = (await acc(`4200${u}`, "مردودات المبيعات", "REVENUE", "REVENUE")).id;
    const inventoryAccountId = (await acc(`INV${u}`, "مخزون", "ASSET", "CURRENT_ASSET")).id;
    const cogsAccountId = (await acc(`COGS${u}`, "تكلفة", "COST_OF_SALES", "COST_OF_SALES")).id;
    const vatOutputAccountId = (await acc(`VATO${u}`, "ض.ق.م", "LIABILITY", "LIABILITY")).id;
    const vatInputAccountId = (await acc(`VATI${u}`, "ض.مدخلات", "ASSET", "CURRENT_ASSET")).id;
    await h.prisma.postingProfile.create({
      data: {
        effectiveFrom: new Date("2026-01-01"),
        arAccountId, apAccountId, revenueAccountId, salesReturnsAccountId,
        inventoryAccountId, cogsAccountId, vatOutputAccountId, vatInputAccountId,
        createdBy: h.ownerId,
      },
    });
    await openCurrentPeriod(h);
  });

  afterAll(async () => teardownTestApp(h));

  // ── the cost snapshot, which is the whole point ──────────────────────────

  it("1) values the return at the CURRENT WAC and freezes it on the line", async () => {
    // A real purchase sets the weighted-average honestly: 20 boards × 5.25 m
    // at 475/m.
    await buy("5.25", "20", "475");
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    expect((await wac(variant.id)).toFixed(4)).toBe("475.0000");

    const d = await draft([
      { productVariantId: variant.id, returnedBoards: "2", unitPricePerMeter: "600" },
    ]);
    if (d.status !== 201) console.log("DRAFT FAILED", d.status, JSON.stringify(d.body));
    expect(d.status).toBe(201);
    // A draft knows no cost yet — the goods have not come back.
    expect(d.body.lines[0].costPerMeterSnapshot).toBeNull();

    const c = await post(`/legacy-returns/${d.body.id}/confirm`, {});
    expect(c.status).toBeLessThan(300);
    expect(c.body.status).toBe("CONFIRMED");

    const line = c.body.lines[0];
    // 2 boards × 5.25 m = 10.5 m at 475 → 4,987.50.
    expect(line.returnedMeters).toBe("10.5000");
    expect(line.costPerMeterSnapshot).toBe("475.0000");
    expect(line.lineCogs).toBe("4987.50");
    expect(c.body.cogsTotal).toBe("4987.50");
  });

  it("2) goods arriving at the current average do not move the average", async () => {
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    const before = await wac(variant.id);
    const d = await draft([{ productVariantId: variant.id, returnedBoards: "1", unitPricePerMeter: "600" }]);
    await post(`/legacy-returns/${d.body.id}/confirm`, {});
    // This is the reason the policy is safe: a return whose true cost is
    // unknowable must not silently revalue everything else.
    expect((await wac(variant.id)).toFixed(4)).toBe(before.toFixed(4));
  });

  it("3) a later WAC change never rewrites a confirmed return, and the cancellation reverses the ORIGINAL amount", async () => {
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    const d = await draft([{ productVariantId: variant.id, returnedBoards: "2", unitPricePerMeter: "600" }]);
    const confirmed = await post(`/legacy-returns/${d.body.id}/confirm`, {});
    const snapshot = confirmed.body.lines[0].costPerMeterSnapshot;
    const postedCogs = new Decimal(confirmed.body.cogsTotal);
    expect(snapshot).toBe("475.0000");
    expect(postedCogs.toFixed(2)).toBe("4987.50");

    // Move the WAC legitimately, by buying at a different price.
    await buy("5.25", "40", "600");
    const movedWac = await wac(variant.id);
    expect(movedWac.gt(475)).toBe(true);

    // The confirmed document is unchanged.
    const reread = await get(`/legacy-returns/${d.body.id}`);
    expect(reread.body.lines[0].costPerMeterSnapshot).toBe(snapshot);
    expect(reread.body.cogsTotal).toBe("4987.50");

    // Cancelling reverses what was posted, not what the WAC is now.
    const valueBefore = (await stock(variant.id)).meters.mul(await wac(variant.id));
    const cancel = await post(`/legacy-returns/${d.body.id}/cancel`, { reason: "خطأ في الإدخال" });
    expect(cancel.status).toBeLessThan(300);
    expect(cancel.body.status).toBe("CANCELLED");
    const valueAfter = (await stock(variant.id)).meters.mul(await wac(variant.id));
    expect(valueBefore.minus(valueAfter).toFixed(2)).toBe("4987.50");
  });

  it("4) a return created after the WAC moved snapshots the NEW cost", async () => {
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    const current = await wac(variant.id);
    const d = await draft([{ productVariantId: variant.id, returnedBoards: "1", unitPricePerMeter: "700" }]);
    const c = await post(`/legacy-returns/${d.body.id}/confirm`, {});
    expect(c.body.lines[0].costPerMeterSnapshot).toBe(current.toFixed(4));
    expect(c.body.lines[0].lineCogs).toBe(current.mul("5.25").toFixed(2));
  });

  it("5) confirmation is refused when the variant has no authoritative cost", async () => {
    // A size nobody has ever bought has no weighted average, so there is no
    // honest cost to post. Zero, the selling price and the purchase default are
    // all refused substitutes.
    const d = await draft([
      { productSkuId: skuId, sizeMetersPerBoard: "3.75", returnedBoards: "2", unitPricePerMeter: "600" },
    ]);
    expect(d.status).toBe(201);
    const c = await post(`/legacy-returns/${d.body.id}/confirm`, {});
    expect(c.status).toBe(409);
    expect(c.body.details.reason).toBe("legacy_return_cost_unavailable");
    // …and nothing was posted.
    const reread = await get(`/legacy-returns/${d.body.id}`);
    expect(reread.body.status).toBe("DRAFT");
    expect(reread.body.journalEntryId).toBeNull();
  });

  // ── document lifecycle ───────────────────────────────────────────────────

  it("6) a draft moves no stock, no ledger, no journal", async () => {
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    const before = {
      stock: await stock(variant.id),
      movements: await h.prisma.inventoryMovement.count(),
      journals: await h.prisma.journalEntry.count(),
      ctx: await h.prisma.customerTransaction.count(),
      wac: await wac(variant.id),
    };
    const d = await draft([{ productVariantId: variant.id, returnedBoards: "3", unitPricePerMeter: "600" }]);
    expect(d.status).toBe(201);
    expect(d.body.status).toBe("DRAFT");

    const after = await stock(variant.id);
    expect(after.boards.toFixed(4)).toBe(before.stock.boards.toFixed(4));
    expect(await h.prisma.inventoryMovement.count()).toBe(before.movements);
    expect(await h.prisma.journalEntry.count()).toBe(before.journals);
    expect(await h.prisma.customerTransaction.count()).toBe(before.ctx);
    expect((await wac(variant.id)).toFixed(4)).toBe(before.wac.toFixed(4));
  });

  it("7) confirming credits the customer, adds the stock, balances the journals, and touches no cash", async () => {
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    const beforeStock = await stock(variant.id);
    const d = await draft([{ productVariantId: variant.id, returnedBoards: "2", unitPricePerMeter: "600" }]);
    const c = await post(`/legacy-returns/${d.body.id}/confirm`, {});
    expect(c.status).toBeLessThan(300);

    // Stock rose by exactly the returned boards and metres.
    const afterStock = await stock(variant.id);
    expect(afterStock.boards.minus(beforeStock.boards).toFixed(4)).toBe("2.0000");
    expect(afterStock.meters.minus(beforeStock.meters).toFixed(4)).toBe("10.5000");

    // The customer was credited the return value — no cash anywhere.
    const ctx = await h.prisma.customerTransaction.findUnique({ where: { id: c.body.customerTransactionId } });
    expect(ctx!.direction).toBe("CR");
    expect(ctx!.amount.toFixed(2)).toBe(c.body.grandTotal);
    expect(ctx!.paymentAccountId).toBeNull();

    // Both journals balance.
    for (const jid of [c.body.journalEntryId, c.body.cogsJournalEntryId]) {
      const lines = await h.prisma.journalLine.findMany({ where: { journalEntryId: jid! } });
      const dr = lines.reduce((a, l) => a.plus(l.debit.toString()), new Decimal(0));
      const cr = lines.reduce((a, l) => a.plus(l.credit.toString()), new Decimal(0));
      expect(dr.toFixed(2)).toBe(cr.toFixed(2));
    }

    // The commercial entry debits the dedicated returns account.
    const commercial = await h.prisma.journalLine.findMany({ where: { journalEntryId: c.body.journalEntryId } });
    expect(commercial.some((l) => l.accountId === salesReturnsAccountId && l.debit.gt(0))).toBe(true);
    // Settlement is a customer credit and nothing else.
    expect(c.body.settlementMode).toBe("KEEP_AS_CUSTOMER_CREDIT");
  });

  it("8) confirm and cancel are both idempotent", async () => {
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    const d = await draft([{ productVariantId: variant.id, returnedBoards: "1", unitPricePerMeter: "600" }]);

    const journalsBefore = await h.prisma.journalEntry.count();
    const first = await post(`/legacy-returns/${d.body.id}/confirm`, {});
    const afterOne = await h.prisma.journalEntry.count();
    const second = await post(`/legacy-returns/${d.body.id}/confirm`, {});
    expect(second.status).toBeLessThan(300);
    // The retry returned the same document and posted nothing further.
    expect(await h.prisma.journalEntry.count()).toBe(afterOne);
    expect(second.body.journalEntryId).toBe(first.body.journalEntryId);
    expect(afterOne).toBeGreaterThan(journalsBefore);

    const c1 = await post(`/legacy-returns/${d.body.id}/cancel`, { reason: "مرة" });
    const movementsAfterCancel = await h.prisma.inventoryMovement.count();
    const c2 = await post(`/legacy-returns/${d.body.id}/cancel`, { reason: "مرتين" });
    expect(c2.status).toBeLessThan(300);
    expect(await h.prisma.inventoryMovement.count()).toBe(movementsAfterCancel);
    expect(c2.body.cancellationReason).toBe(c1.body.cancellationReason);
  });

  it("9) two simultaneous confirms post exactly once", async () => {
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    const d = await draft([{ productVariantId: variant.id, returnedBoards: "1", unitPricePerMeter: "600" }]);
    const before = await h.prisma.journalEntry.count();
    const results = await Promise.all([
      post(`/legacy-returns/${d.body.id}/confirm`, {}),
      post(`/legacy-returns/${d.body.id}/confirm`, {}),
      post(`/legacy-returns/${d.body.id}/confirm`, {}),
    ]);
    expect(results.every((r) => r.status < 300)).toBe(true);
    // One commercial entry + one COGS entry, however many callers asked.
    expect(await h.prisma.journalEntry.count()).toBe(before + 2);
  });

  it("10) cancelling is refused once the returned goods have been sold on", async () => {
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    const d = await draft([{ productVariantId: variant.id, returnedBoards: "2", unitPricePerMeter: "600" }]);
    await post(`/legacy-returns/${d.body.id}/confirm`, {});

    // Consume everything through the legitimate engine path.
    const onHand = (await stock(variant.id)).boards;
    const adj = await post("/inventory/adjustments", {
      branchId: h.branchId,
      productVariantId: variant.id,
      boardsDelta: `-${onHand.toFixed(0)}`,
      note: "بيع كامل الرصيد — اختبار",
    });
    expect(adj.status).toBeLessThan(300);

    const cancel = await post(`/legacy-returns/${d.body.id}/cancel`, { reason: "محاولة إلغاء" });
    expect(cancel.status).toBe(409);
    expect(cancel.body.details.reason).toBe("return_reversal_would_make_stock_negative");
    // Still confirmed — a refused cancellation changes nothing.
    expect((await get(`/legacy-returns/${d.body.id}`)).body.status).toBe("CONFIRMED");
  });

  // ── the document's own rules ─────────────────────────────────────────────

  it("11) a confirmed document cannot be edited", async () => {
    await buy("4", "10", "300");
    // Pick the size explicitly: other tests legitimately introduce further
    // sizes, so "the first one" is not a stable way to name a board.
    const all = await h.prisma.productVariant.findMany({ where: { skuId } });
    const small = all.find((v) => v.sizeMetersPerBoard.toFixed(2) === "4.00")!;
    const d = await draft([{ productVariantId: small.id, returnedBoards: "1", unitPricePerMeter: "500" }]);
    const confirmed = await post(`/legacy-returns/${d.body.id}/confirm`, {});
    expect(confirmed.status).toBeLessThan(300);
    const patch = await request(server())
      .patch(`/api/v1/legacy-returns/${d.body.id}`)
      .set(H(ownerToken))
      .send({ notes: "تعديل ممنوع" });
    expect(patch.status).toBe(409);
    expect(patch.body.details.reason).toBe("legacy_return_not_draft");
  });

  it("12) sizes stay distinct — ك and ص never collapse into one another", async () => {
    const variants = await h.prisma.productVariant.findMany({ where: { skuId }, orderBy: { sizeMetersPerBoard: "asc" } });
    const small = variants.find((v) => v.sizeMetersPerBoard.toFixed(2) === "4.00")!;
    const large = variants.find((v) => v.sizeMetersPerBoard.toFixed(2) === "5.25")!;
    const beforeSmall = await stock(small.id);
    const beforeLarge = await stock(large.id);

    const d = await draft([{ productVariantId: small.id, returnedBoards: "2", unitPricePerMeter: "500" }]);
    const c = await post(`/legacy-returns/${d.body.id}/confirm`, {});
    expect(c.body.lines[0].sizeBadgeAr).toBe("ص");
    expect(c.body.lines[0].returnedMeters).toBe("8.0000");

    expect((await stock(small.id)).boards.minus(beforeSmall.boards).toFixed(4)).toBe("2.0000");
    // The sibling size is untouched.
    expect((await stock(large.id)).boards.toFixed(4)).toBe(beforeLarge.boards.toFixed(4));
  });

  it("13) a custom board keeps its own identity and its measured dimensions", async () => {
    await buy("6.6", "5", "200");
    const custom = (await h.prisma.productVariant.findMany({ where: { skuId } })).find(
      (v) => v.sizeMetersPerBoard.toFixed(2) === "6.60",
    )!;
    const d = await draft([
      { productVariantId: custom.id, returnedBoards: "1", unitPricePerMeter: "400", lengthM: "3.3", widthM: "2" },
    ]);
    const c = await post(`/legacy-returns/${d.body.id}/confirm`, {});
    const line = c.body.lines[0];
    expect(line.sizeBadgeAr).toBe("م/خ");
    expect(line.sizeMetersPerBoard).toBe("6.6000");
    expect(line.returnedMeters).toBe("6.6000");
    expect(line.lengthM).toBe("3.3000");
    expect(line.widthM).toBe("2.0000");
  });

  it("14) the paper invoice is a reference, never a relation", async () => {
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    const salesBefore = await h.prisma.salesInvoice.count();
    const returnsBefore = await h.prisma.salesReturn.count();
    const d = await draft([{ productVariantId: variant.id, returnedBoards: "1", unitPricePerMeter: "600" }]);
    await post(`/legacy-returns/${d.body.id}/confirm`, {});
    // No invoice is fabricated, and this is not a SalesReturn.
    expect(await h.prisma.salesInvoice.count()).toBe(salesBefore);
    expect(await h.prisma.salesReturn.count()).toBe(returnsBefore);
    const row = await h.prisma.legacySalesReturn.findUnique({ where: { id: d.body.id } });
    expect(row!.paperInvoiceNumber).toBe(`PAPER-${u}`);
  });

  it("15) the archive of historical returns is never touched", async () => {
    const before = await h.prisma.historicalSalesReturnArchive.count();
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    const d = await draft([{ productVariantId: variant.id, returnedBoards: "1", unitPricePerMeter: "600" }]);
    await post(`/legacy-returns/${d.body.id}/confirm`, {});
    expect(await h.prisma.historicalSalesReturnArchive.count()).toBe(before);
  });

  // ── listing, filters, permissions ────────────────────────────────────────

  it("16) the list filters by status, customer, paper number and date", async () => {
    const all = await get("/legacy-returns");
    expect(all.status).toBe(200);
    expect(all.body.rows.length).toBeGreaterThan(0);
    expect(all.body.totalCount).toBeGreaterThan(0);

    const confirmed = await get("/legacy-returns?status=CONFIRMED");
    expect(confirmed.body.rows.every((r: { status: string }) => r.status === "CONFIRMED")).toBe(true);

    const byPaper = await get(`/legacy-returns?paperInvoiceNumber=PAPER-${u}`);
    expect(byPaper.body.rows.length).toBeGreaterThan(0);

    const byCustomer = await get(`/legacy-returns?customerId=${customerId}`);
    expect(byCustomer.body.rows.every((r: { customerId: string }) => r.customerId === customerId)).toBe(true);

    const none = await get("/legacy-returns?from=2020-01-01&to=2020-12-31");
    expect(none.body.rows).toHaveLength(0);
  });

  it("17) permissions match the existing returns exactly", async () => {
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    expect((await get("/legacy-returns", accountantToken)).status).toBe(200);
    const d = await draft([{ productVariantId: variant.id, returnedBoards: "1", unitPricePerMeter: "600" }]);
    // An accountant may draft and confirm…
    const acctDraft = await post(
      "/legacy-returns",
      {
        customerId, branchId: h.branchId, paperInvoiceNumber: `P2-${u}`,
        paperInvoiceDate: "2026-02-01", returnDate: today(),
        lines: [{ productVariantId: variant.id, returnedBoards: "1", unitPricePerMeter: "600" }],
      },
      accountantToken,
    );
    expect(acctDraft.status).toBe(201);
    expect((await post(`/legacy-returns/${acctDraft.body.id}/confirm`, {}, accountantToken)).status).toBeLessThan(300);
    // …but cancelling posted accounting stays with the OWNER.
    expect(
      (await post(`/legacy-returns/${acctDraft.body.id}/cancel`, { reason: "x" }, accountantToken)).status,
    ).toBe(403);
    expect(d.status).toBe(201);
  });

  it("18) a branch a user cannot see is neither listed nor readable", async () => {
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    const other = await post("/legacy-returns", {
      customerId, branchId: branchB, paperInvoiceNumber: `PB-${u}`,
      paperInvoiceDate: "2026-02-01", returnDate: today(),
      lines: [{ productVariantId: variant.id, returnedBoards: "1", unitPricePerMeter: "600" }],
    });
    expect(other.status).toBe(201);
    // The accountant has no access to branchB.
    expect((await get(`/legacy-returns/${other.body.id}`, accountantToken)).status).toBe(409);
    const list = await get("/legacy-returns", accountantToken);
    expect(list.body.rows.some((r: { id: string }) => r.id === other.body.id)).toBe(false);
  });

  it("18b) both PDFs render as real Arabic documents and write nothing", async () => {
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    const d = await draft([{ productVariantId: variant.id, returnedBoards: "1", unitPricePerMeter: "600" }]);
    const before = {
      docs: await h.prisma.legacySalesReturn.count(),
      movements: await h.prisma.inventoryMovement.count(),
      journals: await h.prisma.journalEntry.count(),
    };

    const binary = (res: NodeJS.ReadableStream, cb: (e: Error | null, b: Buffer) => void) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    };
    const fetchPdf = (path: string) =>
      request(server()).get(`/api/v1${path}`).set(H(ownerToken)).buffer(true).parse(binary as never);

    // A draft prints, and says on its face that it is a draft.
    const docPdf = await fetchPdf(`/legacy-returns/${d.body.id}/pdf`);
    expect(docPdf.status).toBe(200);
    expect(docPdf.headers["content-type"]).toContain("application/pdf");
    expect(docPdf.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(docPdf.body.toString("latin1")).toMatch(/FontFile2|FontFile3/);

    const listPdf = await fetchPdf("/legacy-returns/pdf?status=CONFIRMED");
    expect(listPdf.status).toBe(200);
    expect(listPdf.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(listPdf.headers["content-disposition"]).toContain("legacy-returns-");

    expect(await h.prisma.legacySalesReturn.count()).toBe(before.docs);
    expect(await h.prisma.inventoryMovement.count()).toBe(before.movements);
    expect(await h.prisma.journalEntry.count()).toBe(before.journals);
  });

  it("19) reading never writes", async () => {
    const before = {
      movements: await h.prisma.inventoryMovement.count(),
      journals: await h.prisma.journalEntry.count(),
      docs: await h.prisma.legacySalesReturn.count(),
    };
    for (let i = 0; i < 3; i += 1) {
      await get("/legacy-returns");
      await get("/legacy-returns?status=CONFIRMED");
    }
    expect(await h.prisma.inventoryMovement.count()).toBe(before.movements);
    expect(await h.prisma.journalEntry.count()).toBe(before.journals);
    expect(await h.prisma.legacySalesReturn.count()).toBe(before.docs);
  });
  // ── the statement link, and the stock effect, pinned ────────────────────

  it("the customer statement re-labels a legacy return so it links to its OWN page", async () => {
    await buy("5.25", "10", "500");
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    const d = await draft([{ productVariantId: variant.id, returnedBoards: "1", unitPricePerMeter: "700" }]);
    expect(d.status).toBe(201);
    expect((await post(`/legacy-returns/${d.body.id}/confirm`, {})).status).toBeLessThan(300);

    const stmt = await get(`/customers/statement/${customerId}`);
    expect(stmt.status).toBe(200);
    const row = stmt.body.entries.find((e: { sourceId: string }) => e.sourceId === d.body.id);
    expect(row).toBeDefined();

    // The journal is posted as SALES_RETURN because JournalSourceType has no
    // legacy value; the statement must hand the UI something that routes to the
    // legacy page rather than the ordinary sales-return page.
    expect(row.sourceType).toBe("LEGACY_SALES_RETURN");

    // The id really is a legacy return and NOT an ordinary one — which is
    // exactly why /sales/returns/:id answered "not found".
    expect(await h.prisma.legacySalesReturn.count({ where: { id: d.body.id } })).toBe(1);
    expect(await h.prisma.salesReturn.count({ where: { id: d.body.id } })).toBe(0);
  });

  it("anything still labelled SALES_RETURN is a genuine invoice-linked return", async () => {
    const stmt = await get(`/customers/statement/${customerId}`);
    for (const e of stmt.body.entries as Array<{ sourceType: string; sourceId: string }>) {
      if (e.sourceType === "SALES_RETURN" && e.sourceId) {
        expect(await h.prisma.legacySalesReturn.count({ where: { id: e.sourceId } })).toBe(0);
      }
    }
  });

  it("confirming adds exactly the returned boards and Decimal-safe metres to the chosen branch", async () => {
    await buy("5.25", "10", "500");
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    const before = await stock(variant.id);
    const otherBranchBefore = await h.prisma.branchInventoryBalance.findMany({ where: { NOT: { branchId: h.branchId } } });

    const d = await draft([{ productVariantId: variant.id, returnedBoards: "3", unitPricePerMeter: "700" }]);
    expect((await post(`/legacy-returns/${d.body.id}/confirm`, {})).status).toBeLessThan(300);

    const after = await stock(variant.id);
    const expectedMeters = new Decimal(3).mul(variant.sizeMetersPerBoard.toString());
    expect(after.boards.minus(before.boards).toFixed(4)).toBe("3.0000");
    expect(after.meters.minus(before.meters).toFixed(4)).toBe(expectedMeters.toFixed(4));

    // no other branch moved
    const otherBranchAfter = await h.prisma.branchInventoryBalance.findMany({ where: { NOT: { branchId: h.branchId } } });
    expect(otherBranchAfter.map((b) => `${b.branchId}:${b.boardsOnHand}`).sort())
      .toEqual(otherBranchBefore.map((b) => `${b.branchId}:${b.boardsOnHand}`).sort());

    // the movement is attributable to this exact document
    const movements = await h.prisma.inventoryMovement.findMany({
      where: { referenceType: "legacy_sales_return", referenceId: d.body.id },
    });
    expect(movements).toHaveLength(1);
    expect(new Decimal(movements[0]!.boardsQuantity.toString()).toFixed(4)).toBe("3.0000");
    expect(new Decimal(movements[0]!.metersQuantity.toString()).toFixed(4)).toBe(expectedMeters.toFixed(4));
    expect(movements[0]!.branchId).toBe(h.branchId);
  });

  it("a second confirmation adds no further stock", async () => {
    await buy("5.25", "10", "500");
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    const d = await draft([{ productVariantId: variant.id, returnedBoards: "2", unitPricePerMeter: "700" }]);
    expect((await post(`/legacy-returns/${d.body.id}/confirm`, {})).status).toBeLessThan(300);
    const after1 = await stock(variant.id);
    await post(`/legacy-returns/${d.body.id}/confirm`, {});
    const after2 = await stock(variant.id);
    expect(after2.boards.toFixed(4)).toBe(after1.boards.toFixed(4));
    expect(await h.prisma.inventoryMovement.count({ where: { referenceType: "legacy_sales_return", referenceId: d.body.id } })).toBe(1);
  });


  it("the movement is returned by the Inventory Movements API under ALL and under SALE_RETURN", async () => {
    await buy("5.25", "10", "500");
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    const d = await draft([{ productVariantId: variant.id, returnedBoards: "4", unitPricePerMeter: "700" }]);
    expect((await post(`/legacy-returns/${d.body.id}/confirm`, {})).status).toBeLessThan(300);

    // ALL — no movementType filter at all.
    const all = await get(`/inventory/movements?branchId=${h.branchId}&limit=200`);
    expect(all.status).toBe(200);
    const mine = all.body.data.filter((m: { referenceId: string }) => m.referenceId === d.body.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].referenceType).toBe("legacy_sales_return");
    expect(mine[0].movementType).toBe("SALE_RETURN");
    expect(mine[0].referenceId).toBe(d.body.id);

    // and under the SALE_RETURN filter the user would pick from the dropdown
    const filtered = await get(`/inventory/movements?branchId=${h.branchId}&movementType=SALE_RETURN&limit=200`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.some((m: { referenceId: string }) => m.referenceId === d.body.id)).toBe(true);

    // the row carries what the UI needs to name and link the document
    expect(mine[0].humanReadableNote).toContain("مردود بدون فاتورة");
  });

  it("cancelling writes exactly one reversing movement and nets the stock to zero", async () => {
    await buy("5.25", "10", "500");
    const variant = (await h.prisma.productVariant.findMany({ where: { skuId } }))[0]!;
    const before = await stock(variant.id);

    const d = await draft([{ productVariantId: variant.id, returnedBoards: "2", unitPricePerMeter: "700" }]);
    expect((await post(`/legacy-returns/${d.body.id}/confirm`, {})).status).toBeLessThan(300);
    const cancelled = await post(`/legacy-returns/${d.body.id}/cancel`, { reason: "اختبار" });
    expect(cancelled.status).toBeLessThan(300);

    const after = await stock(variant.id);
    expect(after.boards.toFixed(4)).toBe(before.boards.toFixed(4));
    expect(after.meters.toFixed(4)).toBe(before.meters.toFixed(4));

    const apply = await h.prisma.inventoryMovement.count({ where: { referenceType: "legacy_sales_return", referenceId: d.body.id } });
    const reverse = await h.prisma.inventoryMovement.count({ where: { referenceType: "legacy_sales_return_cancel", referenceId: d.body.id } });
    expect(apply).toBe(1);
    expect(reverse).toBe(1);

    // a second cancel adds nothing
    await post(`/legacy-returns/${d.body.id}/cancel`, { reason: "اختبار" });
    expect(await h.prisma.inventoryMovement.count({ where: { referenceType: "legacy_sales_return_cancel", referenceId: d.body.id } })).toBe(1);
  });
});
