/**
 * Confirmed PURCHASE invoice revision — end to end through the real API.
 *
 * A purchase is where cost enters the system, so the hard part is not the
 * journal: it is that the shared per-variant WAC this receipt set has since
 * been consumed by later sales. These tests pin the valuation replay against
 * real data — with later sales, later purchases, several branches, returns and
 * opening stock — and prove the identity the adjustment journal depends on:
 *
 *   Δ receipt value = Δ inventory value + Δ COGS − Δ inventory difference
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

const D = (v: unknown) => new Decimal((v as { toString(): string }).toString());

describe("confirmed purchase invoice revision", () => {
  let h: TestApp;
  let token: string;
  let supplierId: string, supplier2Id: string, customerId: string, branch2Id: string;
  const acc: Record<string, string> = {};
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const srv = () => h.app.getHttpServer();

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(srv()).post("/api/v1/auth/login").send({ phone: h.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: "مورد أول", nameEn: "S1" } })).id;
    supplier2Id = (await h.prisma.supplier.create({ data: { nameAr: "مورد ثانٍ", nameEn: "S2" } })).id;
    customerId = (await h.prisma.customer.create({ data: { code: "PC", nameAr: "عميل" } })).id;
    branch2Id = (await h.prisma.branch.create({ data: { nameAr: "فرع ثانٍ", nameEn: "Branch 2", active: true } })).id;

    const u = Date.now().toString().slice(-6);
    const mk = async (k: string, code: string, cat: string, t: string, role?: string) => {
      acc[k] = (await h.prisma.account.create({
        data: { code: `${code}${u}`, nameAr: code, nameEn: code, category: cat as never, accountType: t as never, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) },
      })).id;
    };
    await mk("ar", "AR", "ASSET", "CURRENT_ASSET", "AR_CONTROL");
    await mk("ap", "AP", "LIABILITY", "LIABILITY", "AP_CONTROL");
    await mk("rev", "RV", "REVENUE", "REVENUE");
    await mk("sret", "SR", "REVENUE", "REVENUE");
    await mk("vatO", "VO", "LIABILITY", "LIABILITY");
    await mk("vatI", "VI", "ASSET", "CURRENT_ASSET");
    await mk("cogs", "CG", "COST_OF_SALES", "COST_OF_SALES");
    await mk("inv", "IN", "ASSET", "CURRENT_ASSET", "INVENTORY");
    await mk("shr", "SH", "EXPENSE", "EXPENSE");
    acc.cash = (await h.prisma.account.create({
      data: {
        code: `CS${u}`, nameAr: "خزنة", nameEn: "Cash", category: "ASSET", accountType: "CURRENT_ASSET",
        isLeaf: true, active: true, isCashOrBank: true, treasuryType: "CASH",
      },
    })).id;
    await h.prisma.postingProfile.create({
      data: {
        effectiveFrom: new Date("2026-01-01"), arAccountId: acc.ar, apAccountId: acc.ap, revenueAccountId: acc.rev,
        salesReturnsAccountId: acc.sret, vatOutputAccountId: acc.vatO, vatInputAccountId: acc.vatI,
        cogsAccountId: acc.cogs, inventoryAccountId: acc.inv, shrinkageAccountId: acc.shr, createdBy: h.ownerId,
      },
    });
    for (let m = 1; m <= 12; m++) await h.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });
  });
  afterAll(async () => teardownTestApp(h));

  // ── fixtures ─────────────────────────────────────────────────────────────
  let seq = 0;
  const newVariant = async (size = "4") => {
    const sku = await h.prisma.productSku.create({ data: { code: `PV-${++seq}`, category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
    return (await h.prisma.productVariant.create({
      data: { skuId: sku.id, sizeMetersPerBoard: size, defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" },
    })).id;
  };

  const purchase = async (opts: {
    variantId?: string; boards?: string; pricePerMeter?: string; branchId?: string; date?: string;
    supplier?: string; taxRate?: string;
    lines?: Array<{ productVariantId: string; boardsQuantity: string; unitPrice: string; taxRate?: string }>;
  }) => {
    const d = await request(srv()).post("/api/v1/purchase-invoices").set(auth()).send({
      invoiceDate: opts.date ?? "2026-02-01", supplierId: opts.supplier ?? supplierId, branchId: opts.branchId ?? h.branchId,
      lines: opts.lines ?? [{ productVariantId: opts.variantId!, boardsQuantity: opts.boards!, unitPrice: opts.pricePerMeter!, taxRate: opts.taxRate ?? "0" }],
    });
    expect(d.status).toBeLessThan(300);
    const c = await request(srv()).post(`/api/v1/purchase-invoices/${d.body.id}/confirm`).set(auth()).send({});
    expect(c.status).toBeLessThan(300);
    return d.body.id as string;
  };

  const sale = async (variantId: string, boards: string, price: string, branchId = h.branchId, date = "2026-03-01") => {
    const d = await request(srv()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: date, customerId, branchId, taxRate: "0",
      lines: [{ productVariantId: variantId, quantity: boards, unitPrice: price, costPrice: "0" }],
    });
    expect(d.status).toBeLessThan(300);
    const c = await request(srv()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(auth()).send({});
    expect(c.status).toBeLessThan(300);
    return d.body.id as string;
  };

  const payloadFrom = async (invoiceId: string) => {
    const inv = (await h.prisma.purchaseInvoice.findUnique({ where: { id: invoiceId } }))!;
    const lines = await h.prisma.purchaseInvoiceLine.findMany({ where: { invoiceId }, orderBy: { id: "asc" } });
    return {
      invoiceDate: inv.invoiceDate.toISOString().slice(0, 10),
      dueDate: inv.dueDate ? inv.dueDate.toISOString().slice(0, 10) : null,
      supplierId: inv.supplierId,
      branchId: inv.branchId,
      basedOn: inv.basedOn,
      docDirection: inv.docDirection,
      customsNumber: inv.customsNumber,
      notes: inv.notes,
      lines: lines.map((l) => ({
        lineId: l.id,
        productVariantId: l.productVariantId,
        boardsQuantity: D(l.boardsQuantity).toFixed(4),
        unitPrice: D(l.unitPrice).toFixed(2),
        taxRate: D(l.taxRate).toFixed(2),
        isFree: l.isFree,
      })),
    };
  };

  let keySeq = 0;
  const nextKey = () => `prevtest-${Date.now()}-${++keySeq}`;

  const revise = async (invoiceId: string, payload: unknown, opts: { reason?: string; expectBlocked?: boolean } = {}) => {
    const inv = (await h.prisma.purchaseInvoice.findUnique({ where: { id: invoiceId } }))!;
    const reason = opts.reason ?? "تصحيح فاتورة المورد بعد مراجعة المستندات";
    const pv = await request(srv()).post(`/api/v1/purchase-invoices/${invoiceId}/revisions/preview`).set(auth())
      .send({ expectedRevisionNumber: inv.revisionNumber, reason, payload });
    if (opts.expectBlocked) return { preview: pv, exec: null as null };
    expect(pv.status).toBeLessThan(300);
    const exec = await request(srv()).post(`/api/v1/purchase-invoices/${invoiceId}/revisions`).set(auth()).send({
      expectedRevisionNumber: inv.revisionNumber,
      previewFingerprint: pv.body.previewFingerprint,
      reason,
      idempotencyKey: nextKey(),
      acknowledgedWarnings: pv.body.warnings.map((w: { code: string }) => w.code),
      payload,
    });
    return { preview: pv, exec };
  };

  const wac = async (variantId: string) => D((await h.prisma.productVariant.findUnique({ where: { id: variantId } }))!.avgCostPerMeter);
  const globalMeters = async (variantId: string) => {
    const a = await h.prisma.branchInventoryBalance.aggregate({ _sum: { metersOnHand: true }, where: { productVariantId: variantId } });
    return D(a._sum.metersOnHand ?? 0);
  };
  const branchBoards = async (variantId: string, branchId: string) => {
    const b = await h.prisma.branchInventoryBalance.findUnique({ where: { branchId_productVariantId: { branchId, productVariantId: variantId } } });
    return D(b?.boardsOnHand ?? 0);
  };
  const accountNet = async (accountId: string) => {
    const lines = await h.prisma.journalLine.findMany({ where: { accountId, journalEntry: { status: "POSTED", reversalOfId: null } } });
    return lines.reduce((a, l) => a.plus(D(l.debit)).minus(D(l.credit)), new Decimal(0));
  };
  const ledgerBalanced = async () => {
    const lines = await h.prisma.journalLine.findMany();
    const g = new Map<string, { d: Decimal; c: Decimal }>();
    for (const l of lines) {
      const cur = g.get(l.journalEntryId) ?? { d: new Decimal(0), c: new Decimal(0) };
      g.set(l.journalEntryId, { d: cur.d.plus(D(l.debit)), c: cur.c.plus(D(l.credit)) });
    }
    return [...g.values()].every((x) => x.d.eq(x.c));
  };
  const noNegativeStock = async () =>
    (await h.prisma.branchInventoryBalance.findMany()).every((b) => D(b.boardsOnHand).gte(0) && D(b.metersOnHand).gte(0));

  // ── 1–2. price and quantity, nothing sold yet ────────────────────────────
  it("1. revises the purchase price — WAC follows, supplier payable follows", async () => {
    const v = await newVariant();
    const inv = await purchase({ variantId: v, boards: "10", pricePerMeter: "500" }); // 40 m @ 500
    expect((await wac(v)).toFixed(4)).toBe("500.0000");
    const apBefore = await accountNet(acc.ap);

    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "550.00";
    const { preview, exec } = await revise(inv, p);
    expect(preview.body.committedChanges).toBe(0);
    expect(preview.body.blocking).toHaveLength(0);
    expect(exec!.status).toBeLessThan(300);

    expect((await wac(v)).toFixed(4)).toBe("550.0000");
    expect((await globalMeters(v)).toFixed(4)).toBe("40.0000");
    // AP is a credit balance, so a bigger payable is a more negative net.
    expect((await accountNet(acc.ap)).minus(apBefore).toFixed(2)).toBe("-2000.00");
    expect(D((await h.prisma.purchaseInvoice.findUnique({ where: { id: inv } }))!.grandTotal).toFixed(2)).toBe("22000.00");
    expect(await ledgerBalanced()).toBe(true);
  });

  it("2. revises the purchase quantity", async () => {
    const v = await newVariant();
    const inv = await purchase({ variantId: v, boards: "10", pricePerMeter: "500" });
    const p = await payloadFrom(inv);
    p.lines[0]!.boardsQuantity = "15.0000";
    expect((await revise(inv, p)).exec!.status).toBeLessThan(300);

    expect((await globalMeters(v)).toFixed(4)).toBe("60.0000");
    expect((await wac(v)).toFixed(4)).toBe("500.0000");
    expect(await noNegativeStock()).toBe(true);
  });

  it("3. adds a line", async () => {
    const v1 = await newVariant();
    const v2 = await newVariant("5.25");
    const inv = await purchase({ variantId: v1, boards: "10", pricePerMeter: "500" });
    const p = await payloadFrom(inv);
    (p.lines as unknown[]).push({ productVariantId: v2, boardsQuantity: "4.0000", unitPrice: "600.00", taxRate: "0.00", isFree: false });
    expect((await revise(inv, p)).exec!.status).toBeLessThan(300);
    expect((await globalMeters(v2)).toFixed(4)).toBe("21.0000");
    expect((await wac(v2)).toFixed(4)).toBe("600.0000");
  });

  it("4. removes a line and takes its stock back out", async () => {
    const v1 = await newVariant();
    const v2 = await newVariant();
    const inv = await purchase({
      lines: [
        { productVariantId: v1, boardsQuantity: "10", unitPrice: "500" },
        { productVariantId: v2, boardsQuantity: "5", unitPrice: "600" },
      ],
    });
    const p = await payloadFrom(inv);
    p.lines = p.lines.filter((l) => l.productVariantId === v1);
    expect((await revise(inv, p)).exec!.status).toBeLessThan(300);
    expect((await globalMeters(v2)).toFixed(4)).toBe("0.0000");
    expect(await noNegativeStock()).toBe(true);
  });

  it("5. changes the variant on a line", async () => {
    const v1 = await newVariant();
    const v2 = await newVariant();
    const inv = await purchase({ variantId: v1, boards: "10", pricePerMeter: "500" });
    const p = await payloadFrom(inv);
    p.lines[0]!.productVariantId = v2;
    expect((await revise(inv, p)).exec!.status).toBeLessThan(300);
    expect((await globalMeters(v1)).toFixed(4)).toBe("0.0000");
    expect((await globalMeters(v2)).toFixed(4)).toBe("40.0000");
    expect((await wac(v2)).toFixed(4)).toBe("500.0000");
  });

  it("6. changes the branch — the global WAC is untouched, the quantities move", async () => {
    const v = await newVariant();
    const inv = await purchase({ variantId: v, boards: "10", pricePerMeter: "500" });
    const wacBefore = await wac(v);

    const p = await payloadFrom(inv);
    p.branchId = branch2Id;
    expect((await revise(inv, p)).exec!.status).toBeLessThan(300);

    expect((await branchBoards(v, h.branchId)).toFixed(4)).toBe("0.0000");
    expect((await branchBoards(v, branch2Id)).toFixed(4)).toBe("10.0000");
    expect((await globalMeters(v)).toFixed(4)).toBe("40.0000");
    expect((await wac(v)).toFixed(4)).toBe(wacBefore.toFixed(4));
  });

  it("7. changes the supplier — the payable moves between them", async () => {
    const v = await newVariant();
    const inv = await purchase({ variantId: v, boards: "10", pricePerMeter: "500" });
    const netFor = async (partyId: string) => {
      const lines = await h.prisma.journalLine.findMany({
        where: { accountId: acc.ap, partyId, journalEntry: { status: "POSTED", reversalOfId: null } },
      });
      return lines.reduce((a, l) => a.plus(D(l.credit)).minus(D(l.debit)), new Decimal(0));
    };
    const b1 = await netFor(supplierId), b2 = await netFor(supplier2Id);

    const p = await payloadFrom(inv);
    p.supplierId = supplier2Id;
    expect((await revise(inv, p)).exec!.status).toBeLessThan(300);

    expect((await netFor(supplierId)).minus(b1).toFixed(2)).toBe("-20000.00");
    expect((await netFor(supplier2Id)).minus(b2).toFixed(2)).toBe("20000.00");
  });

  it("8. changes the document date", async () => {
    const v = await newVariant();
    const inv = await purchase({ variantId: v, boards: "10", pricePerMeter: "500" });
    const p = await payloadFrom(inv);
    p.invoiceDate = "2026-04-10";
    expect((await revise(inv, p)).exec!.status).toBeLessThan(300);
    const after = (await h.prisma.purchaseInvoice.findUnique({ where: { id: inv } }))!;
    expect(after.invoiceDate.toISOString().slice(0, 10)).toBe("2026-04-10");
    const rev = (await h.prisma.purchaseInvoiceRevision.findFirst({ where: { purchaseInvoiceId: inv } }))!;
    expect(rev.previousDocumentDate.toISOString().slice(0, 10)).toBe("2026-02-01");
  });

  // ── linked payments ──────────────────────────────────────────────────────
  // PaymentVoucher / PaymentVoucherAllocation exist in the schema but have no
  // HTTP surface yet — nothing in `src/modules` serves them, and production
  // holds zero of both. The fixture is therefore built directly so the revision
  // service can still be proven against a real allocation: what it must respect
  // is a POSTED voucher and its allocation rows, whatever created them.
  let voucherSeq = 0;
  const pay = async (invoiceId: string, amount: string) => {
    const voucher = await h.prisma.paymentVoucher.create({
      data: {
        voucherDate: new Date("2026-02-10"), branchId: h.branchId, supplierId,
        treasuryAccountId: acc.cash, amount, status: "POSTED",
        reference: `PV-FIXTURE-${++voucherSeq}`, createdBy: h.ownerId, postedBy: h.ownerId, postedAt: new Date(),
      },
    });
    await h.prisma.paymentVoucherAllocation.create({
      data: { paymentVoucherId: voucher.id, purchaseInvoiceId: invoiceId, amount },
    });
    return voucher.id;
  };

  it("9. keeps the payment voucher untouched when the revised total is still above it", async () => {
    const v = await newVariant();
    const inv = await purchase({ variantId: v, boards: "10", pricePerMeter: "500" }); // 20 000
    const voucherId = await pay(inv, "20000.00");
    const snap = (await h.prisma.paymentVoucher.findUnique({ where: { id: voucherId }, include: { allocations: true } }))!;

    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "625.00"; // → 25 000
    const { preview, exec } = await revise(inv, p);
    expect(exec!.status).toBeLessThan(300);
    expect(preview.body.partyImpactAfter.outstandingAfter).toBe("5000.00");

    const after = (await h.prisma.paymentVoucher.findUnique({ where: { id: voucherId }, include: { allocations: true } }))!;
    expect(D(after.amount).toFixed(2)).toBe(D(snap.amount).toFixed(2));
    expect(after.supplierId).toBe(snap.supplierId);
    expect(after.status).toBe(snap.status);
    expect(after.allocations).toHaveLength(snap.allocations.length);
  });

  it("10. leaves the supplier in advance when the revised total drops below what was paid", async () => {
    const v = await newVariant();
    const inv = await purchase({ variantId: v, boards: "10", pricePerMeter: "500" }); // 20 000
    await pay(inv, "20000.00");

    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "425.00"; // → 17 000
    const { preview, exec } = await revise(inv, p);
    expect(preview.body.warnings.map((w: { code: string }) => w.code)).toContain("revision_creates_supplier_advance");
    expect(preview.body.partyImpactAfter.creditAfter).toBe("3000.00");
    expect(exec!.status).toBeLessThan(300);
  });

  it("11. honours the linked purchase return as a floor on the revised quantity", async () => {
    const v = await newVariant();
    const inv = await purchase({ variantId: v, boards: "10", pricePerMeter: "500" });
    const lineId = (await h.prisma.purchaseInvoiceLine.findFirst({ where: { invoiceId: inv } }))!.id;
    const r = await request(srv()).post("/api/v1/purchase-returns").set(auth()).send({
      originalPurchaseInvoiceId: inv, returnDate: "2026-02-20",
      lines: [{ originalPurchaseInvoiceLineId: lineId, returnedBoards: "4" }],
    });
    expect(r.status).toBeLessThan(300);
    expect((await request(srv()).post(`/api/v1/purchase-returns/${r.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);

    const tooFew = await payloadFrom(inv);
    tooFew.lines[0]!.boardsQuantity = "3.0000";
    const blocked = await revise(inv, tooFew, { expectBlocked: true });
    expect(blocked.preview.body.blocking.map((b: { code: string }) => b.code)).toContain("quantity_below_linked_return");

    // Exactly the returned quantity is allowed, and the return stays untouched.
    const ok = await payloadFrom(inv);
    ok.lines[0]!.boardsQuantity = "4.0000";
    expect((await revise(inv, ok)).exec!.status).toBeLessThan(300);
    const rets = await h.prisma.purchaseReturn.findMany({ where: { originalPurchaseInvoiceId: inv }, include: { lines: true } });
    expect(rets).toHaveLength(1);
    expect(rets[0]!.status).toBe("CONFIRMED");
    expect(D(rets[0]!.lines[0]!.returnedBoards).toFixed(0)).toBe("4");
  });

  // ── the WAC replay ───────────────────────────────────────────────────────
  it("12. WAC with no later movements — the whole difference stays in stock", async () => {
    const v = await newVariant();
    const inv = await purchase({ variantId: v, boards: "10", pricePerMeter: "500" }); // 40 m
    const cogsBefore = await accountNet(acc.cogs);

    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "550.00";
    const { preview, exec } = await revise(inv, p);
    expect(exec!.status).toBeLessThan(300);

    expect(preview.body.valuation.totalCogsDelta).toBe("0.00");
    expect(preview.body.valuation.totalInventoryValueDelta).toBe("2000.00");
    expect((await accountNet(acc.cogs)).minus(cogsBefore).toFixed(2)).toBe("0.00");
    expect((await wac(v)).toFixed(4)).toBe("550.0000");
  });

  it("13. WAC with a later sale — the difference splits between stock and COGS", async () => {
    const v = await newVariant();
    const inv = await purchase({ variantId: v, boards: "25", pricePerMeter: "500" }); // 100 m @ 500
    await sale(v, "15", "900"); // 60 m out, 40 m left
    const cogsBefore = await accountNet(acc.cogs);
    const invAccBefore = await accountNet(acc.inv);

    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "550.00"; // 100 m now cost 55 000 → +5 000
    const { preview, exec } = await revise(inv, p);
    expect(exec!.status).toBeLessThan(300);

    expect(preview.body.valuation.replayRequired).toBe(true);
    expect(preview.body.valuation.totalCogsDelta).toBe("3000.00");     // 60 % already sold
    expect(preview.body.valuation.totalInventoryValueDelta).toBe("2000.00");
    expect(preview.body.valuation.variants[0].replayReproducedCurrentState).toBe(true);
    expect(preview.body.valuation.variants[0].replayEventCount).toBeGreaterThan(0);

    // Posted: COGS takes 3 000, and Inventory nets +5 000 − 3 000 = +2 000.
    expect((await accountNet(acc.cogs)).minus(cogsBefore).toFixed(2)).toBe("3000.00");
    expect((await accountNet(acc.inv)).minus(invAccBefore).toFixed(2)).toBe("2000.00");
    expect((await wac(v)).toFixed(4)).toBe("550.0000");
    // …and the ledger's inventory movement equals the physical revaluation.
    expect((await globalMeters(v)).times(await wac(v)).toFixed(2)).toBe("22000.00");
    expect(await ledgerBalanced()).toBe(true);
  });

  it("14. WAC with a later purchase in between", async () => {
    const v = await newVariant();
    const first = await purchase({ variantId: v, boards: "25", pricePerMeter: "500", date: "2026-02-01" }); // 100 m
    await sale(v, "15", "900", h.branchId, "2026-03-01");                                                   // 60 m out
    await purchase({ variantId: v, boards: "25", pricePerMeter: "600", date: "2026-04-01" });                // +100 m @600
    await sale(v, "10", "900", h.branchId, "2026-05-01");                                                   // 40 m out
    const before = { wac: await wac(v), meters: await globalMeters(v) };

    const p = await payloadFrom(first);
    p.lines[0]!.unitPrice = "550.00";
    const { preview, exec } = await revise(first, p);
    expect(exec!.status).toBeLessThan(300);
    expect(preview.body.valuation.variants[0].replayReproducedCurrentState).toBe(true);
    // The quantity is untouched; only the valuation moves.
    expect((await globalMeters(v)).toFixed(4)).toBe(before.meters.toFixed(4));
    expect((await wac(v)).gt(before.wac)).toBe(true);
    // The whole +5 000 is still accounted for across stock and cost of sales.
    const split = D(preview.body.valuation.totalInventoryValueDelta).plus(D(preview.body.valuation.totalCogsDelta));
    expect(split.toFixed(2)).toBe("5000.00");
    expect(await ledgerBalanced()).toBe(true);
  });

  it("15. WAC across multiple branches — the pool is global", async () => {
    const v = await newVariant();
    const inv = await purchase({ variantId: v, boards: "25", pricePerMeter: "500", branchId: h.branchId });
    await purchase({ variantId: v, boards: "25", pricePerMeter: "500", branchId: branch2Id, date: "2026-02-05" });
    await sale(v, "10", "900", branch2Id, "2026-03-01"); // consumed from the OTHER branch

    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "600.00";
    const { preview, exec } = await revise(inv, p);
    expect(exec!.status).toBeLessThan(300);
    // The replay is not branch-scoped: the sale out of branch 2 still absorbs
    // part of a cost change made on a branch-1 purchase.
    expect(D(preview.body.valuation.totalCogsDelta).gt(0)).toBe(true);
    expect(preview.body.valuation.variants[0].replayReproducedCurrentState).toBe(true);
    expect(D(preview.body.valuation.totalInventoryValueDelta).plus(D(preview.body.valuation.totalCogsDelta)).toFixed(2)).toBe("10000.00");
  });

  it("16. WAC with a sales return in the window", async () => {
    const v = await newVariant();
    const inv = await purchase({ variantId: v, boards: "25", pricePerMeter: "500" });
    const si = await sale(v, "15", "900");
    const lineId = (await h.prisma.salesInvoiceLine.findFirst({ where: { invoiceId: si } }))!.id;
    const r = await request(srv()).post("/api/v1/sales-returns").set(auth()).send({
      originalSalesInvoiceId: si, returnDate: "2026-03-10",
      lines: [{ originalSalesInvoiceLineId: lineId, returnedBoards: "5" }],
    });
    expect(r.status).toBeLessThan(300);
    expect((await request(srv()).post(`/api/v1/sales-returns/${r.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);

    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "550.00";
    const { preview, exec } = await revise(inv, p);
    expect(exec!.status).toBeLessThan(300);
    expect(preview.body.valuation.variants[0].replayReproducedCurrentState).toBe(true);
    // The return came back at its own recorded historical cost, so it does not
    // move when the purchase cost changes — the split is still exactly 5 000.
    expect(D(preview.body.valuation.totalInventoryValueDelta).plus(D(preview.body.valuation.totalCogsDelta)).toFixed(2)).toBe("5000.00");
    expect(await ledgerBalanced()).toBe(true);
  });

  it("17. WAC with opening stock already on hand before the purchase", async () => {
    const v = await newVariant();
    // Opening stock arrives as a valueless count correction, exactly as the
    // opening-inventory import posts it, with the WAC set alongside.
    await h.prisma.branchInventoryBalance.create({
      data: { branchId: h.branchId, productVariantId: v, boardsOnHand: "10", metersOnHand: "40" },
    });
    await h.prisma.productVariant.update({ where: { id: v }, data: { avgCostPerMeter: "480", avgCost: "1920" } });

    const inv = await purchase({ variantId: v, boards: "10", pricePerMeter: "520" }); // +40 m @ 520
    // Pool: 40×480 + 40×520 = 40 000 over 80 m → 500/m
    expect((await wac(v)).toFixed(4)).toBe("500.0000");
    await sale(v, "10", "900"); // 40 m out at 500

    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "620.00"; // +4 000 on the way in
    const { preview, exec } = await revise(inv, p);
    expect(exec!.status).toBeLessThan(300);
    expect(preview.body.valuation.variants[0].replayReproducedCurrentState).toBe(true);
    expect(D(preview.body.valuation.totalInventoryValueDelta).plus(D(preview.body.valuation.totalCogsDelta)).toFixed(2)).toBe("4000.00");
    expect(await ledgerBalanced()).toBe(true);
  });

  it("18-19. posts the COGS and inventory-value adjustments as one balanced entry", async () => {
    const v = await newVariant();
    const inv = await purchase({ variantId: v, boards: "25", pricePerMeter: "500" });
    await sale(v, "15", "900");

    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "550.00";
    const { exec } = await revise(inv, p);
    expect(exec!.status).toBeLessThan(300);

    const ids = exec!.body.valuationJournalEntryIds as string[];
    expect(ids).toHaveLength(1);
    const entry = (await h.prisma.journalEntry.findUnique({ where: { id: ids[0]! }, include: { lines: true } }))!;
    const dr = entry.lines.reduce((a, l) => a.plus(D(l.debit)), new Decimal(0));
    const cr = entry.lines.reduce((a, l) => a.plus(D(l.credit)), new Decimal(0));
    expect(dr.toFixed(2)).toBe(cr.toFixed(2));
    expect(dr.toFixed(2)).toBe("3000.00");
    expect(entry.lines.find((l) => l.accountId === acc.cogs)!.debit.toFixed(2)).toBe("3000.00");
    expect(entry.lines.find((l) => l.accountId === acc.inv)!.credit.toFixed(2)).toBe("3000.00");
  });

  it("20. exact Decimal rounding — a repeating rate never loses a piastre", async () => {
    const v = await newVariant("5.25");
    // 3 boards × 5.25 = 15.75 m; 15.75 × 498.8235 = 7 856.470125 → 7 856.47
    const inv = await purchase({ variantId: v, boards: "3", pricePerMeter: "498.82" });
    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "498.83";
    const { exec } = await revise(inv, p);
    expect(exec!.status).toBeLessThan(300);
    const after = (await h.prisma.purchaseInvoice.findUnique({ where: { id: inv } }))!;
    expect(D(after.subtotal).toFixed(2)).toBe("7856.57"); // 15.75 × 498.83
    expect((await wac(v)).toFixed(4)).toBe("498.8300");
    expect(await ledgerBalanced()).toBe(true);
  });

  it("21-22. keeps every original movement and journal, and links explicit reversal + replacement", async () => {
    const v = await newVariant();
    const inv = await purchase({ variantId: v, boards: "10", pricePerMeter: "500" });
    const invoice0 = (await h.prisma.purchaseInvoice.findUnique({ where: { id: inv } }))!;
    const originalMovements = await h.prisma.inventoryMovement.findMany({ where: { referenceType: "purchase_invoice", referenceId: inv } });
    const originalJournal = invoice0.journalEntryId!;

    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "530.00";
    const { exec } = await revise(inv, p);
    expect(exec!.status).toBeLessThan(300);

    const stillThere = await h.prisma.inventoryMovement.findMany({ where: { id: { in: originalMovements.map((m) => m.id) } } });
    expect(stillThere).toHaveLength(originalMovements.length);
    for (const m of stillThere) {
      const was = originalMovements.find((o) => o.id === m.id)!;
      expect(D(m.metersQuantity).toFixed(4)).toBe(D(was.metersQuantity).toFixed(4));
    }
    const orig = (await h.prisma.journalEntry.findUnique({ where: { id: originalJournal }, include: { lines: true } }))!;
    expect(orig.lines.length).toBeGreaterThan(0);
    expect(orig.status).toBe("REVERSED");

    const rev = (await h.prisma.purchaseInvoiceRevision.findFirst({ where: { purchaseInvoiceId: inv } }))!;
    expect(rev.reversalJournalEntryId).toBeTruthy();
    expect(rev.replacementJournalEntryId).toBeTruthy();
    expect((rev.reversalMovementIds as string[]).length).toBe(1);
    expect((rev.replacementMovementIds as string[]).length).toBe(1);
    // A supplier has no separate ledger table in this system — the AP journal
    // lines are the party entries, so these lists are legitimately empty.
    expect(rev.reversalPartyTxIds).toEqual([]);
    expect(rev.replacementPartyTxIds).toEqual([]);
  });

  it("23. a second identical request returns the same revision and creates nothing", async () => {
    const v = await newVariant();
    const inv = await purchase({ variantId: v, boards: "10", pricePerMeter: "500" });
    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "515.00";

    const pv = await request(srv()).post(`/api/v1/purchase-invoices/${inv}/revisions/preview`).set(auth())
      .send({ expectedRevisionNumber: 1, reason: "تصحيح السعر حسب المستند", payload: p });
    const body = {
      expectedRevisionNumber: 1, previewFingerprint: pv.body.previewFingerprint,
      reason: "تصحيح السعر حسب المستند", idempotencyKey: nextKey(), acknowledgedWarnings: [], payload: p,
    };
    const first = await request(srv()).post(`/api/v1/purchase-invoices/${inv}/revisions`).set(auth()).send(body);
    expect(first.status).toBeLessThan(300);

    const counts = async () => ({
      journals: await h.prisma.journalEntry.count(),
      movements: await h.prisma.inventoryMovement.count(),
      revisions: await h.prisma.purchaseInvoiceRevision.count(),
    });
    const before = await counts();
    const wacBefore = await wac(v);
    const second = await request(srv()).post(`/api/v1/purchase-invoices/${inv}/revisions`).set(auth()).send(body);
    expect(second.status).toBeLessThan(300);
    expect(second.body.idempotentReplay).toBe(true);
    expect(second.body.revision.id).toBe(first.body.revision.id);
    expect(await counts()).toEqual(before);
    expect((await wac(v)).toFixed(4)).toBe(wacBefore.toFixed(4));
  });

  it("refuses to reverse a receipt whose stock has already been consumed", async () => {
    const v = await newVariant();
    const inv = await purchase({ variantId: v, boards: "10", pricePerMeter: "500" });
    await sale(v, "10", "900"); // everything bought is now gone

    const p = await payloadFrom(inv);
    p.lines[0]!.boardsQuantity = "6.0000";
    const { preview } = await revise(inv, p, { expectBlocked: true });
    expect(preview.body.blocking.map((b: { code: string }) => b.code)).toContain("reversal_would_make_stock_negative");
    expect(await noNegativeStock()).toBe(true);
  });

  it("reports the whole valuation picture in the preview without writing anything", async () => {
    const v = await newVariant();
    const inv = await purchase({ variantId: v, boards: "25", pricePerMeter: "500" });
    await sale(v, "15", "900");
    const snapshot = {
      wac: (await wac(v)).toFixed(4),
      meters: (await globalMeters(v)).toFixed(4),
      journals: await h.prisma.journalEntry.count(),
      movements: await h.prisma.inventoryMovement.count(),
      revisions: await h.prisma.purchaseInvoiceRevision.count(),
    };

    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "575.00";
    const pv = await request(srv()).post(`/api/v1/purchase-invoices/${inv}/revisions/preview`).set(auth())
      .send({ expectedRevisionNumber: 1, reason: "معاينة فقط", payload: p });
    expect(pv.status).toBeLessThan(300);

    const val = pv.body.valuation;
    expect(val.replayRequired).toBe(true);
    expect(val.replayStartAt).toBeTruthy();
    expect(val.variants).toHaveLength(1);
    expect(val.variants[0].currentWacPerMeter).toBe("500.0000");
    expect(val.variants[0].projectedWacPerMeter).toBe("575.0000");
    expect(val.variants[0].currentGlobalMeters).toBe("40.0000");
    expect(val.variants[0].projectedGlobalMeters).toBe("40.0000");
    expect(pv.body.journals.map((j: { kind: string }) => j.kind)).toEqual(
      expect.arrayContaining(["REVERSAL", "REPLACEMENT", "VALUATION_ADJUSTMENT"]),
    );
    expect(pv.body.committedChanges).toBe(0);

    expect((await wac(v)).toFixed(4)).toBe(snapshot.wac);
    expect((await globalMeters(v)).toFixed(4)).toBe(snapshot.meters);
    expect(await h.prisma.journalEntry.count()).toBe(snapshot.journals);
    expect(await h.prisma.inventoryMovement.count()).toBe(snapshot.movements);
    expect(await h.prisma.purchaseInvoiceRevision.count()).toBe(snapshot.revisions);
  });
});
