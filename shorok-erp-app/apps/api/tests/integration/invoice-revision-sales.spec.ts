/**
 * Confirmed SALES invoice revision — end to end through the real API.
 *
 * The invariant under test throughout: a confirmed invoice is a posted
 * document. Revising it must never rewrite what was posted — it reverses the
 * version in force, reposts the revised one, and leaves every original journal,
 * movement and party row exactly where it was.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

const D = (v: unknown) => new Decimal((v as { toString(): string }).toString());

describe("confirmed sales invoice revision", () => {
  let h: TestApp;
  let token: string;
  let customerId: string, customer2Id: string, supplierId: string, repId: string, branch2Id: string;
  const acc: Record<string, string> = {};
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const srv = () => h.app.getHttpServer();

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(srv()).post("/api/v1/auth/login").send({ phone: h.ownerPhone, password: "Pwd@2026!" })).body.accessToken;
    customerId = (await h.prisma.customer.create({ data: { code: "RC1", nameAr: "عميل أول" } })).id;
    customer2Id = (await h.prisma.customer.create({ data: { code: "RC2", nameAr: "عميل ثانٍ" } })).id;
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "S" } })).id;
    repId = (await h.prisma.salesRepresentative.create({ data: { code: "RP", nameAr: "مندوب" } })).id;
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
  /** Buy `boards` boards of a fresh variant at `pricePerMeter` into a branch. */
  const buy = async (size: string, pricePerMeter: string, boards = "40", branchId = h.branchId) => {
    const sku = await h.prisma.productSku.create({ data: { code: `RV-${++seq}`, category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
    const variantId = (await h.prisma.productVariant.create({
      data: { skuId: sku.id, sizeMetersPerBoard: size, defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" },
    })).id;
    const p = await request(srv()).post("/api/v1/purchase-invoices").set(auth()).send({
      invoiceDate: "2026-02-01", supplierId, branchId,
      lines: [{ productVariantId: variantId, boardsQuantity: boards, unitPrice: pricePerMeter, taxRate: "0" }],
    });
    const c = await request(srv()).post(`/api/v1/purchase-invoices/${p.body.id}/confirm`).set(auth()).send({});
    expect(c.status).toBeLessThan(300);
    return variantId;
  };

  const sell = async (opts: {
    variantId: string; boards: string; price: string; taxRate?: string; branchId?: string; customer?: string;
    lines?: Array<{ productVariantId: string; quantity: string; unitPrice: string }>;
  }) => {
    const d = await request(srv()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-03-01", customerId: opts.customer ?? customerId, branchId: opts.branchId ?? h.branchId,
      taxRate: opts.taxRate ?? "0", salesRepresentativeId: repId,
      lines: opts.lines ?? [{ productVariantId: opts.variantId, quantity: opts.boards, unitPrice: opts.price, costPrice: "0" }],
    });
    expect(d.status).toBeLessThan(300);
    const c = await request(srv()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(auth()).send({});
    expect(c.status).toBeLessThan(300);
    return d.body.id as string;
  };

  const currentLines = async (invoiceId: string) =>
    h.prisma.salesInvoiceLine.findMany({ where: { invoiceId }, orderBy: { id: "asc" } });

  const payloadFrom = async (invoiceId: string) => {
    const inv = (await h.prisma.salesInvoice.findUnique({ where: { id: invoiceId } }))!;
    const lines = await currentLines(invoiceId);
    return {
      invoiceDate: inv.invoiceDate.toISOString().slice(0, 10),
      dueDate: inv.dueDate ? inv.dueDate.toISOString().slice(0, 10) : null,
      customerId: inv.customerId,
      branchId: inv.branchId,
      salesRepresentativeId: inv.salesRepresentativeId,
      taxRate: D(inv.taxRate).toFixed(2),
      notes: inv.notes,
      lines: lines.map((l) => ({
        lineId: l.id,
        productVariantId: l.productVariantId,
        quantity: D(l.quantity).toFixed(4),
        unitPrice: D(l.unitPrice).toFixed(2),
        costPrice: D(l.costPrice).toFixed(2),
        discountPct: D(l.discountPct).toFixed(2),
        unitLabel: l.unitLabel,
      })),
    };
  };

  let keySeq = 0;
  const nextKey = () => `revtest-${Date.now()}-${++keySeq}`;

  /** Preview then execute, asserting the preview was clean unless told otherwise. */
  const revise = async (invoiceId: string, payload: unknown, opts: { reason?: string; expectBlocked?: boolean; ackAll?: boolean } = {}) => {
    const inv = (await h.prisma.salesInvoice.findUnique({ where: { id: invoiceId } }))!;
    const reason = opts.reason ?? "تصحيح بيانات الفاتورة بناءً على طلب العميل";
    const pv = await request(srv()).post(`/api/v1/sales-invoices/${invoiceId}/revisions/preview`).set(auth())
      .send({ expectedRevisionNumber: inv.revisionNumber, reason, payload });
    if (opts.expectBlocked) return { preview: pv, exec: null as null };
    expect(pv.status).toBeLessThan(300);
    const exec = await request(srv()).post(`/api/v1/sales-invoices/${invoiceId}/revisions`).set(auth()).send({
      expectedRevisionNumber: inv.revisionNumber,
      previewFingerprint: pv.body.previewFingerprint,
      reason,
      idempotencyKey: nextKey(),
      acknowledgedWarnings: opts.ackAll === false ? [] : pv.body.warnings.map((w: { code: string }) => w.code),
      payload,
    });
    return { preview: pv, exec };
  };

  const bal = async (variantId: string, branchId = h.branchId) =>
    h.prisma.branchInventoryBalance.findUnique({ where: { branchId_productVariantId: { branchId, productVariantId: variantId } } });

  const ledgerBalanced = async () => {
    const lines = await h.prisma.journalLine.findMany({ include: { journalEntry: true } });
    const groups = new Map<string, { d: Decimal; c: Decimal }>();
    for (const l of lines) {
      const g = groups.get(l.journalEntryId) ?? { d: new Decimal(0), c: new Decimal(0) };
      groups.set(l.journalEntryId, { d: g.d.plus(D(l.debit)), c: g.c.plus(D(l.credit)) });
    }
    return [...groups.values()].every((g) => g.d.eq(g.c));
  };

  /** Net movement on an account across POSTED, non-reversal entries (trial-balance rule). */
  const accountNet = async (accountId: string) => {
    const lines = await h.prisma.journalLine.findMany({
      where: { accountId, journalEntry: { status: "POSTED", reversalOfId: null } },
    });
    return lines.reduce((a, l) => a.plus(D(l.debit)).minus(D(l.credit)), new Decimal(0));
  };

  // ── 1. price only ────────────────────────────────────────────────────────
  it("1. revises only the manual selling price — stock and COGS untouched, revenue moves", async () => {
    const v = await buy("4", "500");
    const inv = await sell({ variantId: v, boards: "10", price: "800" });
    const stockBefore = await bal(v);
    const cogsBefore = await accountNet(acc.cogs);
    const revBefore = await accountNet(acc.rev);

    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "900.00";
    const { preview, exec } = await revise(inv, p);

    expect(preview.body.committedChanges).toBe(0);
    expect(preview.body.blocking).toHaveLength(0);
    expect(exec!.status).toBeLessThan(300);

    const after = (await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!;
    expect(after.revisionNumber).toBe(2);
    expect(after.status).toBe("CONFIRMED");
    expect(D(after.grandTotal).toFixed(2)).toBe("36000.00"); // 10 boards × 4 m × 900
    // Revenue moved by exactly the price difference; cost of sales did not move.
    expect((await accountNet(acc.rev)).minus(revBefore).toFixed(2)).toBe("-4000.00"); // revenue is a credit balance
    expect((await accountNet(acc.cogs)).minus(cogsBefore).toFixed(2)).toBe("0.00");
    const stockAfter = await bal(v);
    expect(D(stockAfter!.boardsOnHand).toFixed(4)).toBe(D(stockBefore!.boardsOnHand).toFixed(4));
    expect(D(stockAfter!.metersOnHand).toFixed(4)).toBe(D(stockBefore!.metersOnHand).toFixed(4));
    expect(await ledgerBalanced()).toBe(true);
  });

  it("2. revises the quantity upward — stock falls further, COGS rises at the historical cost", async () => {
    const v = await buy("4", "500");
    const inv = await sell({ variantId: v, boards: "10", price: "800" });
    const before = await bal(v);
    const cogsBefore = await accountNet(acc.cogs);

    const p = await payloadFrom(inv);
    p.lines[0]!.quantity = "15.0000";
    const { exec } = await revise(inv, p);
    expect(exec!.status).toBeLessThan(300);

    const after = await bal(v);
    expect(D(before.boardsOnHand).minus(D(after!.boardsOnHand)).toFixed(4)).toBe("5.0000");
    // 5 extra boards × 4 m × the 500/m the goods actually left stock at.
    expect((await accountNet(acc.cogs)).minus(cogsBefore).toFixed(2)).toBe("10000.00");
    expect(await ledgerBalanced()).toBe(true);
  });

  it("3. revises the quantity downward — stock returns, COGS falls", async () => {
    const v = await buy("4", "500");
    const inv = await sell({ variantId: v, boards: "10", price: "800" });
    const before = await bal(v);
    const cogsBefore = await accountNet(acc.cogs);

    const p = await payloadFrom(inv);
    p.lines[0]!.quantity = "6.0000";
    expect((await revise(inv, p)).exec!.status).toBeLessThan(300);

    expect(D((await bal(v))!.boardsOnHand).minus(D(before.boardsOnHand)).toFixed(4)).toBe("4.0000");
    expect((await accountNet(acc.cogs)).minus(cogsBefore).toFixed(2)).toBe("-8000.00");
  });

  it("4. adds a line", async () => {
    const v1 = await buy("4", "500");
    const v2 = await buy("5.25", "600");
    const inv = await sell({ variantId: v1, boards: "5", price: "800" });

    const p = await payloadFrom(inv);
    (p.lines as unknown[]).push({ productVariantId: v2, quantity: "3.0000", unitPrice: "900.00", costPrice: "0.00", discountPct: "0.00" });
    expect((await revise(inv, p)).exec!.status).toBeLessThan(300);

    expect(await currentLines(inv)).toHaveLength(2);
    const after = (await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!;
    // 5×4×800 + 3×5.25×900 = 16 000 + 14 175
    expect(D(after.grandTotal).toFixed(2)).toBe("30175.00");
    expect(D((await bal(v2))!.boardsOnHand).toFixed(4)).toBe("37.0000");
  });

  it("5. removes a line and returns its stock", async () => {
    const v1 = await buy("4", "500");
    const v2 = await buy("4", "500");
    const inv = await sell({
      variantId: v1, boards: "0", price: "0",
      lines: [
        { productVariantId: v1, quantity: "5", unitPrice: "800" },
        { productVariantId: v2, quantity: "4", unitPrice: "700" },
      ],
    });
    const beforeV2 = await bal(v2);

    const p = await payloadFrom(inv);
    p.lines = p.lines.filter((l) => l.productVariantId === v1);
    expect((await revise(inv, p)).exec!.status).toBeLessThan(300);

    expect(await currentLines(inv)).toHaveLength(1);
    expect(D((await bal(v2))!.boardsOnHand).minus(D(beforeV2!.boardsOnHand)).toFixed(4)).toBe("4.0000");
  });

  it("6. changes the variant on a line", async () => {
    const v1 = await buy("4", "500");
    const v2 = await buy("4", "520");
    const inv = await sell({ variantId: v1, boards: "5", price: "800" });
    const b1 = await bal(v1), b2 = await bal(v2);

    const p = await payloadFrom(inv);
    p.lines[0]!.productVariantId = v2;
    expect((await revise(inv, p)).exec!.status).toBeLessThan(300);

    expect(D((await bal(v1))!.boardsOnHand).minus(D(b1!.boardsOnHand)).toFixed(4)).toBe("5.0000");
    expect(D(b2!.boardsOnHand).minus(D((await bal(v2))!.boardsOnHand)).toFixed(4)).toBe("5.0000");
  });

  it("7. changes the branch — the old branch is restored, the new one issues", async () => {
    const v = await buy("4", "500", "40", h.branchId);
    // Stock the second branch too, so it can actually satisfy the revised sale.
    await request(srv()).post("/api/v1/purchase-invoices").set(auth()).send({
      invoiceDate: "2026-02-02", supplierId, branchId: branch2Id,
      lines: [{ productVariantId: v, boardsQuantity: "20", unitPrice: "500", taxRate: "0" }],
    }).then(async (r) => request(srv()).post(`/api/v1/purchase-invoices/${r.body.id}/confirm`).set(auth()).send({}));

    const inv = await sell({ variantId: v, boards: "10", price: "800" });
    const a1 = await bal(v, h.branchId), a2 = await bal(v, branch2Id);

    const p = await payloadFrom(inv);
    p.branchId = branch2Id;
    expect((await revise(inv, p)).exec!.status).toBeLessThan(300);

    expect(D((await bal(v, h.branchId))!.boardsOnHand).minus(D(a1!.boardsOnHand)).toFixed(4)).toBe("10.0000");
    expect(D(a2!.boardsOnHand).minus(D((await bal(v, branch2Id))!.boardsOnHand)).toFixed(4)).toBe("10.0000");
  });

  it("8. changes the customer — the receivable moves, the old customer is squared off", async () => {
    const v = await buy("4", "500");
    const inv = await sell({ variantId: v, boards: "5", price: "800" });
    const netFor = async (partyId: string) => {
      const lines = await h.prisma.journalLine.findMany({
        where: { accountId: acc.ar, partyId, journalEntry: { status: "POSTED", reversalOfId: null } },
      });
      return lines.reduce((a, l) => a.plus(D(l.debit)).minus(D(l.credit)), new Decimal(0));
    };
    const before1 = await netFor(customerId), before2 = await netFor(customer2Id);

    const p = await payloadFrom(inv);
    p.customerId = customer2Id;
    expect((await revise(inv, p)).exec!.status).toBeLessThan(300);

    expect((await netFor(customerId)).minus(before1).toFixed(2)).toBe("-16000.00");
    expect((await netFor(customer2Id)).minus(before2).toFixed(2)).toBe("16000.00");
  });

  it("9. changes the document date while preserving the original on the revision record", async () => {
    const v = await buy("4", "500");
    const inv = await sell({ variantId: v, boards: "5", price: "800" });

    const p = await payloadFrom(inv);
    p.invoiceDate = "2026-04-15";
    p.dueDate = "2026-05-15";
    expect((await revise(inv, p)).exec!.status).toBeLessThan(300);

    const after = (await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!;
    expect(after.invoiceDate.toISOString().slice(0, 10)).toBe("2026-04-15");
    const rev = (await h.prisma.salesInvoiceRevision.findFirst({ where: { salesInvoiceId: inv } }))!;
    expect(rev.previousDocumentDate.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(rev.documentDate.toISOString().slice(0, 10)).toBe("2026-04-15");
    expect(rev.crossesClosedPeriod).toBe(false);
  });

  it("10. revises the discount and the tax rate", async () => {
    const v = await buy("4", "500");
    const inv = await sell({ variantId: v, boards: "10", price: "800", taxRate: "14" });

    const p = await payloadFrom(inv);
    p.taxRate = "5.00";
    p.lines[0]!.discountPct = "10.00";
    expect((await revise(inv, p)).exec!.status).toBeLessThan(300);

    const after = (await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!;
    // gross 32 000 − 10% = 28 800; tax 5% = 1 440
    expect(D(after.subtotal).toFixed(2)).toBe("28800.00");
    expect(D(after.discountAmount).toFixed(2)).toBe("3200.00");
    expect(D(after.taxAmount).toFixed(2)).toBe("1440.00");
    expect(D(after.grandTotal).toFixed(2)).toBe("30240.00");
  });

  // ── linked receipts ──────────────────────────────────────────────────────
  const receipt = async (invoiceId: string, amount: string, customer = customerId) => {
    const r = await request(srv()).post("/api/v1/receipt-vouchers").set(auth()).send({
      voucherDate: "2026-03-05", branchId: h.branchId, customerId: customer,
      treasuryAccountId: acc.cash, amount,
      allocations: [{ salesInvoiceId: invoiceId, amount }],
    });
    expect(r.status).toBeLessThan(300);
    const p = await request(srv()).post(`/api/v1/receipt-vouchers/${r.body.id}/post`).set(auth()).send({});
    expect(p.status).toBeLessThan(300);
    return r.body.id as string;
  };

  it("11. keeps the voucher untouched when the revised total is still above what was received", async () => {
    const v = await buy("4", "500");
    const inv = await sell({ variantId: v, boards: "10", price: "500" }); // 20 000
    const voucherId = await receipt(inv, "15000.00");
    const snapshot = (await h.prisma.receiptVoucher.findUnique({ where: { id: voucherId }, include: { allocations: true } }))!;

    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "450.00"; // → 18 000
    const { preview, exec } = await revise(inv, p);
    expect(exec!.status).toBeLessThan(300);
    expect(preview.body.partyImpactAfter.outstandingAfter).toBe("3000.00");
    expect(preview.body.partyImpactAfter.creditAfter).toBe("0.00");

    const voucherAfter = (await h.prisma.receiptVoucher.findUnique({ where: { id: voucherId }, include: { allocations: true } }))!;
    expect(D(voucherAfter.amount).toFixed(2)).toBe(D(snapshot.amount).toFixed(2));
    expect(voucherAfter.status).toBe(snapshot.status);
    expect(voucherAfter.customerId).toBe(snapshot.customerId);
    expect(voucherAfter.allocations.map((a) => D(a.amount).toFixed(2))).toEqual(snapshot.allocations.map((a) => D(a.amount).toFixed(2)));
  });

  it("12. warns and leaves the customer in credit when the revised total drops below the receipt", async () => {
    const v = await buy("4", "500");
    const inv = await sell({ variantId: v, boards: "10", price: "500" }); // 20 000
    await receipt(inv, "15000.00");

    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "300.00"; // → 12 000
    const inv0 = (await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!;
    const pv = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions/preview`).set(auth())
      .send({ expectedRevisionNumber: inv0.revisionNumber, reason: "خصم متفق عليه", payload: p });
    expect(pv.status).toBeLessThan(300);
    expect(pv.body.warnings.map((w: { code: string }) => w.code)).toContain("revision_creates_customer_credit");
    expect(pv.body.partyImpactAfter.creditAfter).toBe("3000.00");

    // Refusing to acknowledge the warning must stop the revision.
    const refused = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions`).set(auth()).send({
      expectedRevisionNumber: inv0.revisionNumber, previewFingerprint: pv.body.previewFingerprint,
      reason: "خصم متفق عليه", idempotencyKey: nextKey(), acknowledgedWarnings: [], payload: p,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.details.reason).toBe("revision_warnings_not_acknowledged");

    const ok = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions`).set(auth()).send({
      expectedRevisionNumber: inv0.revisionNumber, previewFingerprint: pv.body.previewFingerprint,
      reason: "خصم متفق عليه", idempotencyKey: nextKey(),
      acknowledgedWarnings: ["revision_creates_customer_credit"], payload: p,
    });
    expect(ok.status).toBeLessThan(300);
  });

  // ── linked returns ───────────────────────────────────────────────────────
  const makeReturn = async (invoiceId: string, lineId: string, boards: string) => {
    const r = await request(srv()).post("/api/v1/sales-returns").set(auth()).send({
      originalSalesInvoiceId: invoiceId, returnDate: "2026-03-20",
      lines: [{ originalSalesInvoiceLineId: lineId, returnedBoards: boards }],
    });
    expect(r.status).toBeLessThan(300);
    const c = await request(srv()).post(`/api/v1/sales-returns/${r.body.id}/confirm`).set(auth()).send({});
    expect(c.status).toBeLessThan(300);
    return r.body.id as string;
  };

  it("13. allows a revision down to exactly the returned quantity", async () => {
    const v = await buy("4", "500");
    const inv = await sell({ variantId: v, boards: "10", price: "800" });
    const lineId = (await currentLines(inv))[0]!.id;
    await makeReturn(inv, lineId, "4");

    const p = await payloadFrom(inv);
    p.lines[0]!.quantity = "4.0000";
    expect((await revise(inv, p)).exec!.status).toBeLessThan(300);
    expect(D((await currentLines(inv))[0]!.quantity).toFixed(0)).toBe("4");
  });

  it("14. blocks a quantity below the confirmed returned quantity", async () => {
    const v = await buy("4", "500");
    const inv = await sell({ variantId: v, boards: "10", price: "800" });
    const lineId = (await currentLines(inv))[0]!.id;
    await makeReturn(inv, lineId, "4");

    const p = await payloadFrom(inv);
    p.lines[0]!.quantity = "3.0000";
    const { preview } = await revise(inv, p, { expectBlocked: true });
    expect(preview.body.blocking.map((b: { code: string }) => b.code)).toContain("quantity_below_linked_return");
    expect(preview.body.blocking[0].messageAr).toMatch(/المرتجعة/);
  });

  it("15. blocks removing, or re-pointing, a line that carries a return", async () => {
    const v = await buy("4", "500");
    const v2 = await buy("4", "500");
    const inv = await sell({ variantId: v, boards: "10", price: "800" });
    const lineId = (await currentLines(inv))[0]!.id;
    await makeReturn(inv, lineId, "2");

    const removed = await payloadFrom(inv);
    removed.lines = [];
    const r1 = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions/preview`).set(auth())
      .send({ expectedRevisionNumber: 1, reason: "محاولة حذف", payload: { ...removed, lines: [{ productVariantId: v2, quantity: "1", unitPrice: "100" }] } });
    expect(r1.body.blocking.map((b: { code: string }) => b.code)).toContain("line_with_return_removed");

    const swapped = await payloadFrom(inv);
    swapped.lines[0]!.productVariantId = v2;
    const r2 = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions/preview`).set(auth())
      .send({ expectedRevisionNumber: 1, reason: "محاولة تغيير الصنف", payload: swapped });
    expect(r2.body.blocking.map((b: { code: string }) => b.code)).toContain("line_with_return_variant_changed");

    // And the return document itself is untouched by any of that.
    const rets = await h.prisma.salesReturn.findMany({ where: { originalSalesInvoiceId: inv } });
    expect(rets).toHaveLength(1);
    expect(rets[0]!.status).toBe("CONFIRMED");
  });

  it("16. blocks a revised branch that cannot cover the revised quantity", async () => {
    const v = await buy("4", "500", "10");
    const inv = await sell({ variantId: v, boards: "5", price: "800" });

    const p = await payloadFrom(inv);
    p.lines[0]!.quantity = "50.0000"; // only 10 were ever bought
    const { preview } = await revise(inv, p, { expectBlocked: true });
    expect(preview.body.blocking.map((b: { code: string }) => b.code)).toContain("insufficient_stock_in_revised_branch");
  });

  it("17. never turns a purchase cost or a WAC into the selling price", async () => {
    const v = await buy("4", "500");
    const inv = await sell({ variantId: v, boards: "5", price: "800" });
    const p = await payloadFrom(inv);
    p.lines[0]!.quantity = "6.0000";
    const { preview } = await revise(inv, p);
    // The revised line keeps the price the human typed, not the 500/m cost.
    expect(preview.body.revisedLines[0].unitPrice).toBe("800.00");
    const after = (await currentLines(inv))[0]!;
    expect(D(after.unitPrice).toFixed(2)).toBe("800.00");
    expect(D(after.unitPrice).eq(D(after.unitCostPerMeterAtPosting ?? 0))).toBe(false);
  });

  it("18-20. keeps every original movement and journal, and adds explicit reversal + replacement", async () => {
    const v = await buy("4", "500");
    const inv = await sell({ variantId: v, boards: "10", price: "800" });
    const invoice0 = (await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!;
    const originalMovements = await h.prisma.inventoryMovement.findMany({ where: { referenceType: "sales_invoice", referenceId: inv } });
    const originalJournal = invoice0.journalEntryId!;
    const originalCogsJournal = invoice0.cogsJournalEntryId!;
    const originalCustomerTx = invoice0.customerTxId!;
    const originalLinesCount = (await h.prisma.journalLine.count({ where: { journalEntryId: originalJournal } }));

    const p = await payloadFrom(inv);
    p.lines[0]!.quantity = "12.0000";
    const { exec } = await revise(inv, p);
    expect(exec!.status).toBeLessThan(300);

    // 18 — the original SALE movements are still there, unchanged.
    const stillThere = await h.prisma.inventoryMovement.findMany({ where: { id: { in: originalMovements.map((m) => m.id) } } });
    expect(stillThere).toHaveLength(originalMovements.length);
    for (const m of stillThere) {
      const was = originalMovements.find((o) => o.id === m.id)!;
      expect(D(m.boardsQuantity).toFixed(4)).toBe(D(was.boardsQuantity).toFixed(4));
      expect(D(m.metersQuantity).toFixed(4)).toBe(D(was.metersQuantity).toFixed(4));
    }
    // 19 — the original journals still exist with their original lines and amounts.
    const orig = (await h.prisma.journalEntry.findUnique({ where: { id: originalJournal }, include: { lines: true } }))!;
    expect(orig.lines).toHaveLength(originalLinesCount);
    expect(orig.status).toBe("REVERSED"); // marked, never deleted or edited
    expect(await h.prisma.journalEntry.findUnique({ where: { id: originalCogsJournal } })).not.toBeNull();
    // The legacy party row was reversed by a new row, never deleted.
    expect(await h.prisma.customerTransaction.findUnique({ where: { id: originalCustomerTx } })).not.toBeNull();

    // 20 — explicit reversal and replacement exist and are linked to the revision.
    const rev = (await h.prisma.salesInvoiceRevision.findFirst({ where: { salesInvoiceId: inv } }))!;
    expect(rev.reversalJournalEntryId).toBeTruthy();
    expect(rev.replacementJournalEntryId).toBeTruthy();
    expect(rev.reversalCogsJournalEntryId).toBeTruthy();
    expect(rev.replacementCogsJournalEntryId).toBeTruthy();
    expect((rev.reversalMovementIds as string[]).length).toBeGreaterThan(0);
    expect((rev.replacementMovementIds as string[]).length).toBeGreaterThan(0);
    expect((rev.reversalPartyTxIds as string[]).length).toBe(1);
    expect((rev.replacementPartyTxIds as string[]).length).toBe(1);
    expect(await ledgerBalanced()).toBe(true);
  });

  it("21. a second identical request returns the same revision and creates nothing", async () => {
    const v = await buy("4", "500");
    const inv = await sell({ variantId: v, boards: "10", price: "800" });
    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "850.00";

    const pv = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions/preview`).set(auth())
      .send({ expectedRevisionNumber: 1, reason: "تصحيح السعر", payload: p });
    const body = {
      expectedRevisionNumber: 1, previewFingerprint: pv.body.previewFingerprint,
      reason: "تصحيح السعر", idempotencyKey: nextKey(), acknowledgedWarnings: [], payload: p,
    };
    const first = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions`).set(auth()).send(body);
    expect(first.status).toBeLessThan(300);

    const counts = async () => ({
      journals: await h.prisma.journalEntry.count(),
      movements: await h.prisma.inventoryMovement.count(),
      revisions: await h.prisma.salesInvoiceRevision.count(),
      customerTx: await h.prisma.customerTransaction.count(),
    });
    const before = await counts();
    const second = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions`).set(auth()).send(body);
    expect(second.status).toBeLessThan(300);
    expect(second.body.idempotentReplay).toBe(true);
    expect(second.body.revision.id).toBe(first.body.revision.id);
    expect(await counts()).toEqual(before);
    expect((await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!.revisionNumber).toBe(2);
  });

  it("keeps the invoice number and lets a second revision build on the first", async () => {
    const v = await buy("4", "500");
    const inv = await sell({ variantId: v, boards: "10", price: "800" });
    const number0 = (await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!.invoiceNumber;

    const p1 = await payloadFrom(inv);
    p1.lines[0]!.unitPrice = "850.00";
    expect((await revise(inv, p1)).exec!.status).toBeLessThan(300);

    const p2 = await payloadFrom(inv);
    p2.lines[0]!.unitPrice = "900.00";
    expect((await revise(inv, p2)).exec!.status).toBeLessThan(300);

    const after = (await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!;
    expect(after.invoiceNumber).toBe(number0);
    expect(after.revisionNumber).toBe(3);
    expect(D(after.grandTotal).toFixed(2)).toBe("36000.00");

    // Revision 3 reversed revision 2's replacement — not the original again.
    const revs = await h.prisma.salesInvoiceRevision.findMany({ where: { salesInvoiceId: inv }, orderBy: { revisionNumber: "asc" } });
    expect(revs.map((r) => r.revisionNumber)).toEqual([2, 3]);
    expect(revs[1]!.reversalJournalEntryId).not.toBe(revs[0]!.reversalJournalEntryId);
    const reversedEntry = await h.prisma.journalEntry.findUnique({ where: { id: revs[1]!.reversalJournalEntryId! } });
    expect(reversedEntry!.reversalOfId).toBe(revs[0]!.replacementJournalEntryId);
    expect(await ledgerBalanced()).toBe(true);

    // And the ledger reflects only the newest version: AR net = 36 000.
    const arLines = await h.prisma.journalLine.findMany({
      where: { accountId: acc.ar, partyId: customerId, journalEntry: { status: "POSTED", reversalOfId: null, sourceId: inv } },
    });
    expect(arLines.reduce((a, l) => a.plus(D(l.debit)).minus(D(l.credit)), new Decimal(0)).toFixed(2)).toBe("36000.00");
  });

  it("exposes the full history and each individual version", async () => {
    const v = await buy("4", "500");
    const inv = await sell({ variantId: v, boards: "10", price: "800" });
    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "820.00";
    await revise(inv, p, { reason: "تصحيح السعر المتفق عليه مع العميل" });

    const hist = await request(srv()).get(`/api/v1/sales-invoices/${inv}/revisions`).set(auth());
    expect(hist.status).toBe(200);
    expect(hist.body.currentRevision).toBe(2);
    expect(hist.body.revisions).toHaveLength(1);
    expect(hist.body.revisions[0].reason).toBe("تصحيح السعر المتفق عليه مع العميل");
    expect(hist.body.revisions[0].revisedByName).toBeTruthy();
    expect(hist.body.revisions[0].totalDelta).toBe("800.00");

    const one = await request(srv()).get(`/api/v1/sales-invoices/${inv}/revisions/2`).set(auth());
    expect(one.status).toBe(200);
    // The original confirmed version stays readable as history.
    expect(one.body.beforeSnapshot.header.grandTotal).toBe("32000.00");
    expect(one.body.afterSnapshot.header.grandTotal).toBe("32800.00");
    expect(one.body.beforeSnapshot.lines[0].unitPrice).toBe("800.00");
    // Snapshots carry no credentials or unrelated user data.
    const asText = JSON.stringify(one.body);
    expect(asText).not.toMatch(/password|passwordHash|accessToken|DATABASE_URL/i);
  });
});
