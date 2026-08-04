/**
 * Confirmed-invoice revision — the guarantees that are not about a particular
 * field: the preview writes nothing, a stale approval cannot commit, two
 * sessions cannot both win, a closed month is never reopened, and the flows
 * that existed before this feature still work exactly as they did.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

const D = (v: unknown) => new Decimal((v as { toString(): string }).toString());

describe("confirmed-invoice revision — cross-cutting guarantees", () => {
  let h: TestApp;
  let token: string, accountantToken: string;
  let customerId: string, supplierId: string;
  const acc: Record<string, string> = {};
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const asAccountant = () => ({ Authorization: `Bearer ${accountantToken}` });
  const srv = () => h.app.getHttpServer();

  beforeAll(async () => {
    h = await buildTestApp();
    await h.prisma.user.update({ where: { id: h.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(srv()).post("/api/v1/auth/login").send({ phone: h.ownerPhone, password: "Pwd@2026!" })).body.accessToken;

    const accountant = await h.prisma.user.create({
      data: {
        name: "محاسب", phone: "+201110000001", passwordHash: await bcrypt.hash("Acc@2026!", 10),
        role: "ACCOUNTANT", status: "ACTIVE",
        branchAccesses: { create: [{ branchId: h.branchId }] },
      },
    });
    expect(accountant.id).toBeTruthy();
    accountantToken = (await request(srv()).post("/api/v1/auth/login").send({ phone: "+201110000001", password: "Acc@2026!" })).body.accessToken;

    customerId = (await h.prisma.customer.create({ data: { code: "GC", nameAr: "عميل" } })).id;
    supplierId = (await h.prisma.supplier.create({ data: { nameAr: "مورد", nameEn: "S" } })).id;

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

  let seq = 0;
  const stocked = async (boards = "40") => {
    const sku = await h.prisma.productSku.create({ data: { code: `GV-${++seq}`, category: "NORMAL", colorNameAr: "لون", colorNameEn: "c" } });
    const variantId = (await h.prisma.productVariant.create({
      data: { skuId: sku.id, sizeMetersPerBoard: "4", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "0", avgCostPerMeter: "0" },
    })).id;
    const p = await request(srv()).post("/api/v1/purchase-invoices").set(auth()).send({
      invoiceDate: "2026-02-01", supplierId, branchId: h.branchId,
      lines: [{ productVariantId: variantId, boardsQuantity: boards, unitPrice: "500", taxRate: "0" }],
    });
    await request(srv()).post(`/api/v1/purchase-invoices/${p.body.id}/confirm`).set(auth()).send({});
    return { variantId, purchaseId: p.body.id as string };
  };

  const sell = async (variantId: string, boards = "10", price = "800", date = "2026-03-01") => {
    const d = await request(srv()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: date, customerId, branchId: h.branchId, taxRate: "0",
      lines: [{ productVariantId: variantId, quantity: boards, unitPrice: price, costPrice: "0" }],
    });
    const c = await request(srv()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(auth()).send({});
    expect(c.status).toBeLessThan(300);
    return d.body.id as string;
  };

  const payloadFrom = async (invoiceId: string) => {
    const inv = (await h.prisma.salesInvoice.findUnique({ where: { id: invoiceId } }))!;
    const lines = await h.prisma.salesInvoiceLine.findMany({ where: { invoiceId }, orderBy: { id: "asc" } });
    return {
      invoiceDate: inv.invoiceDate.toISOString().slice(0, 10),
      dueDate: null as string | null,
      customerId: inv.customerId,
      branchId: inv.branchId,
      salesRepresentativeId: null as string | null,
      taxRate: D(inv.taxRate).toFixed(2),
      notes: inv.notes,
      lines: lines.map((l) => ({
        lineId: l.id, productVariantId: l.productVariantId,
        quantity: D(l.quantity).toFixed(4), unitPrice: D(l.unitPrice).toFixed(2),
        costPrice: D(l.costPrice).toFixed(2), discountPct: D(l.discountPct).toFixed(2),
      })),
    };
  };

  let keySeq = 0;
  const nextKey = () => `gen-${Date.now()}-${++keySeq}`;
  const previewFor = (invoiceId: string, payload: unknown, expected = 1, reason = "سبب التعديل المعتمد") =>
    request(srv()).post(`/api/v1/sales-invoices/${invoiceId}/revisions/preview`).set(auth())
      .send({ expectedRevisionNumber: expected, reason, payload });

  const worldSnapshot = async () => ({
    salesInvoices: await h.prisma.salesInvoice.count(),
    salesInvoiceLines: await h.prisma.salesInvoiceLine.count(),
    purchaseInvoices: await h.prisma.purchaseInvoice.count(),
    journals: await h.prisma.journalEntry.count(),
    journalLines: await h.prisma.journalLine.count(),
    movements: await h.prisma.inventoryMovement.count(),
    balances: await h.prisma.branchInventoryBalance.count(),
    customerTx: await h.prisma.customerTransaction.count(),
    salesRevisions: await h.prisma.salesInvoiceRevision.count(),
    purchaseRevisions: await h.prisma.purchaseInvoiceRevision.count(),
    audit: await h.prisma.auditLog.count(),
    receipts: await h.prisma.receiptVoucher.count(),
    returns: await h.prisma.salesReturn.count(),
    boards: (await h.prisma.branchInventoryBalance.aggregate({ _sum: { boardsOnHand: true } }))._sum.boardsOnHand?.toString() ?? "0",
    wacDigest: (await h.prisma.productVariant.findMany({ orderBy: { id: "asc" }, select: { id: true, avgCostPerMeter: true } }))
      .map((v) => `${v.id}:${v.avgCostPerMeter.toString()}`).join(","),
  });

  const ledgerBalanced = async () => {
    const lines = await h.prisma.journalLine.findMany();
    const g = new Map<string, { d: Decimal; c: Decimal }>();
    for (const l of lines) {
      const cur = g.get(l.journalEntryId) ?? { d: new Decimal(0), c: new Decimal(0) };
      g.set(l.journalEntryId, { d: cur.d.plus(D(l.debit)), c: cur.c.plus(D(l.credit)) });
    }
    return [...g.values()].every((x) => x.d.eq(x.c));
  };

  // ── preview ──────────────────────────────────────────────────────────────
  it("a preview writes absolutely nothing and consumes no number", async () => {
    const { variantId } = await stocked();
    const inv = await sell(variantId);
    const before = await worldSnapshot();
    const seqBefore = await h.prisma.$queryRaw<Array<{ last_value: bigint }>>`SELECT last_value FROM sales_invoices_invoice_number_seq`;
    const jSeqBefore = await h.prisma.$queryRaw<Array<{ last_value: bigint }>>`SELECT last_value FROM journal_entries_entry_number_seq`;

    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "999.00";
    for (let i = 0; i < 3; i += 1) {
      const pv = await previewFor(inv, p);
      expect(pv.status).toBeLessThan(300);
      expect(pv.body.committedChanges).toBe(0);
      expect(pv.body.previewFingerprint).toMatch(/^[a-f0-9]{64}$/);
    }

    expect(await worldSnapshot()).toEqual(before);
    // No invoice number and no journal number was burned by previewing.
    expect((await h.prisma.$queryRaw<Array<{ last_value: bigint }>>`SELECT last_value FROM sales_invoices_invoice_number_seq`)[0]!.last_value)
      .toBe(seqBefore[0]!.last_value);
    expect((await h.prisma.$queryRaw<Array<{ last_value: bigint }>>`SELECT last_value FROM journal_entries_entry_number_seq`)[0]!.last_value)
      .toBe(jSeqBefore[0]!.last_value);
  });

  it("a preview answers 200, not 201 — nothing was created", async () => {
    const { variantId } = await stocked();
    const inv = await sell(variantId);
    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "805.00";
    const pv = await previewFor(inv, p);
    expect(pv.status).toBe(200);
    expect(pv.body.committedChanges).toBe(0);
  });

  it("the same preview run twice returns the same fingerprint", async () => {
    const { variantId } = await stocked();
    const inv = await sell(variantId);
    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "810.00";
    const a = await previewFor(inv, p);
    const b = await previewFor(inv, p);
    expect(a.body.previewFingerprint).toBe(b.body.previewFingerprint);
  });

  // ── staleness and concurrency ────────────────────────────────────────────
  it("rejects a stale preview after the underlying data moved", async () => {
    const { variantId } = await stocked();
    const inv = await sell(variantId);
    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "820.00";
    const pv = await previewFor(inv, p);

    // Something else changes the stock the valuation depended on.
    await sell(variantId, "5", "800");

    const exec = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions`).set(auth()).send({
      expectedRevisionNumber: 1, previewFingerprint: pv.body.previewFingerprint,
      reason: "سبب التعديل المعتمد", idempotencyKey: nextKey(), acknowledgedWarnings: [], payload: p,
    });
    expect(exec.status).toBe(409);
    expect(exec.body.details.reason).toBe("revision_preview_stale");
    expect(exec.body.message_ar).toMatch(/أعد المعاينة/);
    expect((await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!.revisionNumber).toBe(1);
  });

  it("rejects a fabricated fingerprint", async () => {
    const { variantId } = await stocked();
    const inv = await sell(variantId);
    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "830.00";
    await previewFor(inv, p);
    const exec = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions`).set(auth()).send({
      expectedRevisionNumber: 1, previewFingerprint: "0".repeat(64),
      reason: "سبب التعديل المعتمد", idempotencyKey: nextKey(), acknowledgedWarnings: [], payload: p,
    });
    expect(exec.status).toBe(409);
    expect(exec.body.details.reason).toBe("revision_preview_stale");
  });

  it("rejects a stale revision number", async () => {
    const { variantId } = await stocked();
    const inv = await sell(variantId);
    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "840.00";
    const stale = await previewFor(inv, p, 5);
    expect(stale.status).toBe(409);
    expect(stale.body.details.reason).toBe("revision_number_stale");
    expect(stale.body.message_ar).toMatch(/جلسة أخرى/);
  });

  it("two simultaneous revisions of one invoice — exactly one wins", async () => {
    const { variantId } = await stocked();
    const inv = await sell(variantId);
    const p1 = await payloadFrom(inv);
    p1.lines[0]!.unitPrice = "860.00";
    const p2 = await payloadFrom(inv);
    p2.lines[0]!.unitPrice = "870.00";
    const [pv1, pv2] = await Promise.all([previewFor(inv, p1), previewFor(inv, p2)]);

    const [r1, r2] = await Promise.all([
      request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions`).set(auth()).send({
        expectedRevisionNumber: 1, previewFingerprint: pv1.body.previewFingerprint,
        reason: "تعديل من الجلسة الأولى", idempotencyKey: nextKey(), acknowledgedWarnings: [], payload: p1,
      }),
      request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions`).set(auth()).send({
        expectedRevisionNumber: 1, previewFingerprint: pv2.body.previewFingerprint,
        reason: "تعديل من الجلسة الثانية", idempotencyKey: nextKey(), acknowledgedWarnings: [], payload: p2,
      }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBeLessThan(300);
    expect(statuses[1]).toBe(409);
    expect((await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!.revisionNumber).toBe(2);
    expect(await h.prisma.salesInvoiceRevision.count({ where: { salesInvoiceId: inv } })).toBe(1);
    expect(await ledgerBalanced()).toBe(true);
  });

  it("a double-clicked submit with one idempotency key produces one revision", async () => {
    const { variantId } = await stocked();
    const inv = await sell(variantId);
    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "880.00";
    const pv = await previewFor(inv, p);
    const body = {
      expectedRevisionNumber: 1, previewFingerprint: pv.body.previewFingerprint,
      reason: "نقرة مزدوجة", idempotencyKey: nextKey(), acknowledgedWarnings: [], payload: p,
    };
    const [a, b] = await Promise.all([
      request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions`).set(auth()).send(body),
      request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions`).set(auth()).send(body),
    ]);
    const ok = [a, b].filter((r) => r.status < 300);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(await h.prisma.salesInvoiceRevision.count({ where: { salesInvoiceId: inv } })).toBe(1);
    expect((await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!.revisionNumber).toBe(2);
  });

  // ── rollback ─────────────────────────────────────────────────────────────
  it("rolls the whole revision back when the posting engine refuses mid-flight", async () => {
    const { variantId } = await stocked();
    const inv = await sell(variantId);
    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "890.00";
    const pv = await previewFor(inv, p);

    // Close the month AFTER the preview: the reversal will fail inside the
    // write transaction, well past the point where stock has already moved.
    await h.prisma.financialPeriod.updateMany({ where: { year: 2026, month: 3 }, data: { status: "CLOSED" } });
    const before = await worldSnapshot();
    const exec = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions`).set(auth()).send({
      expectedRevisionNumber: 1, previewFingerprint: pv.body.previewFingerprint,
      reason: "سيفشل", idempotencyKey: nextKey(), acknowledgedWarnings: [], payload: p,
    });
    expect(exec.status).toBeGreaterThanOrEqual(400);
    // Nothing at all survived: no movement, no journal, no revision, no balance change.
    expect(await worldSnapshot()).toEqual(before);
    expect((await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!.revisionNumber).toBe(1);
    await h.prisma.financialPeriod.updateMany({ where: { year: 2026, month: 3 }, data: { status: "OPEN" } });
  });

  // ── periods ──────────────────────────────────────────────────────────────
  it("posts the correction into the first open period when the document's month is closed", async () => {
    const { variantId } = await stocked();
    const inv = await sell(variantId, "10", "800", "2026-06-01");
    await h.prisma.financialPeriod.updateMany({ where: { year: 2026, month: 6 }, data: { status: "CLOSED" } });
    const closedJournalsBefore = await h.prisma.journalLine.count({
      where: { journalEntry: { entryDate: { gte: new Date("2026-06-01"), lte: new Date("2026-06-30") } } },
    });

    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "900.00";
    const pv = await previewFor(inv, p);
    expect(pv.status).toBeLessThan(300);
    expect(pv.body.crossesClosedPeriod).toBe(true);
    expect(pv.body.postingDate).toBe("2026-07-01");
    expect(pv.body.documentDate).toBe("2026-06-01");
    expect(pv.body.periodNoteAr).toMatch(/مقفلة/);
    expect(pv.body.warnings.map((w: { code: string }) => w.code)).toContain("posting_moved_to_open_period");

    const exec = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions`).set(auth()).send({
      expectedRevisionNumber: 1, previewFingerprint: pv.body.previewFingerprint,
      reason: "تصحيح بعد إقفال الفترة", idempotencyKey: nextKey(),
      acknowledgedWarnings: ["posting_moved_to_open_period"], payload: p,
    });
    expect(exec.status).toBeLessThan(300);

    // The closed month gained nothing; the correction lives in July.
    expect(await h.prisma.journalLine.count({
      where: { journalEntry: { entryDate: { gte: new Date("2026-06-01"), lte: new Date("2026-06-30") } } },
    })).toBe(closedJournalsBefore);
    const rev = (await h.prisma.salesInvoiceRevision.findFirst({ where: { salesInvoiceId: inv } }))!;
    expect(rev.postingDate.toISOString().slice(0, 10)).toBe("2026-07-01");
    expect(rev.documentDate.toISOString().slice(0, 10)).toBe("2026-06-01");
    expect(rev.crossesClosedPeriod).toBe(true);
    // The document keeps its own commercial date.
    expect((await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!.invoiceDate.toISOString().slice(0, 10)).toBe("2026-06-01");
    expect((await h.prisma.financialPeriod.findUnique({ where: { year_month: { year: 2026, month: 6 } } }))!.status).toBe("CLOSED");
    await h.prisma.financialPeriod.updateMany({ where: { year: 2026, month: 6 }, data: { status: "OPEN" } });
  });

  it("blocks when no open period can take the correction at all", async () => {
    const { variantId } = await stocked();
    const inv = await sell(variantId, "10", "800", "2026-12-01");
    await h.prisma.financialPeriod.updateMany({ where: { year: 2026, month: 12 }, data: { status: "CLOSED" } });
    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "910.00";
    const pv = await previewFor(inv, p);
    expect(pv.body.blocking.map((b: { code: string }) => b.code)).toContain("no_open_posting_period");
    await h.prisma.financialPeriod.updateMany({ where: { year: 2026, month: 12 }, data: { status: "OPEN" } });
  });

  // ── authorization + validation ───────────────────────────────────────────
  it("only the OWNER may preview or execute; an accountant may still read history", async () => {
    const { variantId } = await stocked();
    const inv = await sell(variantId);
    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "920.00";

    const pv = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions/preview`).set(asAccountant())
      .send({ expectedRevisionNumber: 1, reason: "محاولة من محاسب", payload: p });
    expect(pv.status).toBe(403);

    const ex = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions`).set(asAccountant()).send({
      expectedRevisionNumber: 1, previewFingerprint: "0".repeat(64), reason: "محاولة من محاسب",
      idempotencyKey: nextKey(), acknowledgedWarnings: [], payload: p,
    });
    expect(ex.status).toBe(403);

    expect((await request(srv()).get(`/api/v1/sales-invoices/${inv}/revisions`).set(asAccountant())).status).toBe(200);
    // Nothing leaked through the refused attempts.
    expect((await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!.revisionNumber).toBe(1);
  });

  it("requires a revision reason", async () => {
    const { variantId } = await stocked();
    const inv = await sell(variantId);
    const p = await payloadFrom(inv);
    for (const reason of ["", "  ", "ab"]) {
      const r = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions/preview`).set(auth())
        .send({ expectedRevisionNumber: 1, reason, payload: p });
      expect(r.status).toBe(400);
    }
  });

  it("refuses to revise an invoice that is not confirmed", async () => {
    const { variantId } = await stocked();
    const draft = await request(srv()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-03-01", customerId, branchId: h.branchId, taxRate: "0",
      lines: [{ productVariantId: variantId, quantity: "2", unitPrice: "800", costPrice: "0" }],
    });
    const p = await payloadFrom(draft.body.id);
    const r = await previewFor(draft.body.id, p);
    expect(r.status).toBe(409);
    expect(r.body.details.reason).toBe("invoice_not_confirmed");
  });

  it("blocks an inactive customer, variant or branch", async () => {
    const { variantId } = await stocked();
    const inv = await sell(variantId);

    const deadCustomer = await h.prisma.customer.create({ data: { code: "DEADC", nameAr: "عميل موقوف", active: false } });
    const p1 = await payloadFrom(inv);
    p1.customerId = deadCustomer.id;
    expect((await previewFor(inv, p1)).body.blocking.map((b: { code: string }) => b.code)).toContain("customer_inactive");

    const deadBranch = await h.prisma.branch.create({ data: { nameAr: "فرع موقوف", nameEn: "Dead", active: false } });
    const p2 = await payloadFrom(inv);
    p2.branchId = deadBranch.id;
    expect((await previewFor(inv, p2)).body.blocking.map((b: { code: string }) => b.code)).toContain("branch_inactive");

    const { variantId: other } = await stocked();
    await h.prisma.productVariant.update({ where: { id: other }, data: { active: false } });
    const p3 = await payloadFrom(inv);
    p3.lines[0]!.productVariantId = other;
    expect((await previewFor(inv, p3)).body.blocking.map((b: { code: string }) => b.code)).toContain("variant_inactive");
  });

  it("refuses a line that belongs to another invoice", async () => {
    const { variantId } = await stocked();
    const a = await sell(variantId);
    const b = await sell(variantId);
    const foreignLine = (await h.prisma.salesInvoiceLine.findFirst({ where: { invoiceId: b } }))!;
    const p = await payloadFrom(a);
    p.lines[0]!.lineId = foreignLine.id;
    expect((await previewFor(a, p)).body.blocking.map((x: { code: string }) => x.code)).toContain("line_not_part_of_invoice");
  });

  // ── blast radius ─────────────────────────────────────────────────────────
  it("touches nothing outside the invoice being revised", async () => {
    const { variantId: vA } = await stocked();
    const { variantId: vB } = await stocked();
    const target = await sell(vA);
    const bystander = await sell(vB, "6", "700");
    const otherCustomer = await h.prisma.customer.create({ data: { code: "OTH", nameAr: "عميل آخر" } });
    const otherInvoice = await request(srv()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-03-01", customerId: otherCustomer.id, branchId: h.branchId, taxRate: "0",
      lines: [{ productVariantId: vB, quantity: "2", unitPrice: "750", costPrice: "0" }],
    });
    await request(srv()).post(`/api/v1/sales-invoices/${otherInvoice.body.id}/confirm`).set(auth()).send({});

    const before = {
      bystander: await h.prisma.salesInvoice.findUnique({ where: { id: bystander } }),
      bystanderLines: await h.prisma.salesInvoiceLine.findMany({ where: { invoiceId: bystander }, orderBy: { id: "asc" } }),
      other: await h.prisma.salesInvoice.findUnique({ where: { id: otherInvoice.body.id } }),
      otherPartyLines: await h.prisma.journalLine.count({ where: { partyId: otherCustomer.id } }),
      vB: await h.prisma.branchInventoryBalance.findUnique({ where: { branchId_productVariantId: { branchId: h.branchId, productVariantId: vB } } }),
      vBWac: (await h.prisma.productVariant.findUnique({ where: { id: vB } }))!.avgCostPerMeter.toString(),
    };

    const p = await payloadFrom(target);
    p.lines[0]!.quantity = "12.0000";
    const pv = await previewFor(target, p);
    const exec = await request(srv()).post(`/api/v1/sales-invoices/${target}/revisions`).set(auth()).send({
      expectedRevisionNumber: 1, previewFingerprint: pv.body.previewFingerprint,
      reason: "زيادة الكمية المتفق عليها", idempotencyKey: nextKey(), acknowledgedWarnings: [], payload: p,
    });
    expect(exec.status).toBeLessThan(300);

    expect(await h.prisma.salesInvoice.findUnique({ where: { id: bystander } })).toEqual(before.bystander);
    expect(await h.prisma.salesInvoiceLine.findMany({ where: { invoiceId: bystander }, orderBy: { id: "asc" } })).toEqual(before.bystanderLines);
    expect(await h.prisma.salesInvoice.findUnique({ where: { id: otherInvoice.body.id } })).toEqual(before.other);
    expect(await h.prisma.journalLine.count({ where: { partyId: otherCustomer.id } })).toBe(before.otherPartyLines);
    expect(await h.prisma.branchInventoryBalance.findUnique({ where: { branchId_productVariantId: { branchId: h.branchId, productVariantId: vB } } })).toEqual(before.vB);
    expect((await h.prisma.productVariant.findUnique({ where: { id: vB } }))!.avgCostPerMeter.toString()).toBe(before.vBWac);
    expect(await ledgerBalanced()).toBe(true);
  });

  it("writes a complete audit event", async () => {
    const { variantId } = await stocked();
    const inv = await sell(variantId);
    const p = await payloadFrom(inv);
    p.lines[0]!.unitPrice = "930.00";
    const pv = await previewFor(inv, p);
    const exec = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions`).set(auth()).send({
      expectedRevisionNumber: 1, previewFingerprint: pv.body.previewFingerprint,
      reason: "تصحيح موثق للمراجعة", idempotencyKey: nextKey(), acknowledgedWarnings: [], payload: p,
    });
    expect(exec.status).toBeLessThan(300);

    const rows = await h.prisma.auditLog.findMany({ where: { entityType: "sales_invoice_revision" }, orderBy: { createdAt: "desc" } });
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0]!;
    expect(row.actorId).toBe(h.ownerId);
    expect(row.entityId).toBe(exec.body.revision.id);
    const after = row.afterSnapshot as Record<string, unknown>;
    const beforeSnap = row.beforeSnapshot as Record<string, unknown>;
    expect(beforeSnap.revisionNumber).toBe(1);
    expect(after.revisionNumber).toBe(2);
    expect(after.reason).toBe("تصحيح موثق للمراجعة");
    expect(String(beforeSnap.fingerprint)).toMatch(/^[a-f0-9]{64}$/);
    expect(String(after.fingerprint)).toMatch(/^[a-f0-9]{64}$/);
    expect((after.journalEntryIds as string[]).length).toBeGreaterThan(0);
    expect((after.movementIds as string[]).length).toBeGreaterThan(0);
    expect(row.humanReadableSummaryAr).toContain("تصحيح موثق للمراجعة");
    expect(row.humanReadableSummaryEn).toContain("revision 2");
    expect(JSON.stringify(row)).not.toMatch(/password|accessToken|DATABASE_URL/i);
  });

  // ── non-regression ───────────────────────────────────────────────────────
  it("leaves draft editing, confirmation, cancellation and returns working exactly as before", async () => {
    const { variantId } = await stocked("60");

    // Draft create → edit → confirm still works end to end.
    const draft = await request(srv()).post("/api/v1/sales-invoices").set(auth()).send({
      invoiceDate: "2026-03-01", customerId, branchId: h.branchId, taxRate: "0",
      lines: [{ productVariantId: variantId, quantity: "3", unitPrice: "700", costPrice: "0" }],
    });
    expect(draft.status).toBeLessThan(300);
    expect(draft.body.status).toBe("DRAFT");
    const edited = await request(srv()).put(`/api/v1/sales-invoices/${draft.body.id}`).set(auth()).send({
      lines: [{ productVariantId: variantId, quantity: "4", unitPrice: "750", costPrice: "0" }],
    });
    expect(edited.status).toBeLessThan(300);
    expect(edited.body.grandTotal).toBe("12000.00"); // 4 × 4 m × 750
    const confirmed = await request(srv()).post(`/api/v1/sales-invoices/${draft.body.id}/confirm`).set(auth()).send({});
    expect(confirmed.status).toBeLessThan(300);
    expect(confirmed.body.status).toBe("CONFIRMED");
    // A brand-new confirmation starts at revision 1 and has no history.
    expect((await h.prisma.salesInvoice.findUnique({ where: { id: draft.body.id } }))!.revisionNumber).toBe(1);
    expect((await request(srv()).get(`/api/v1/sales-invoices/${draft.body.id}/revisions`).set(auth())).body.revisions).toHaveLength(0);

    // A return against it still works.
    const lineId = (await h.prisma.salesInvoiceLine.findFirst({ where: { invoiceId: draft.body.id } }))!.id;
    const ret = await request(srv()).post("/api/v1/sales-returns").set(auth()).send({
      originalSalesInvoiceId: draft.body.id, returnDate: "2026-03-15",
      lines: [{ originalSalesInvoiceLineId: lineId, returnedBoards: "1" }],
    });
    expect(ret.status).toBeLessThan(300);
    expect((await request(srv()).post(`/api/v1/sales-returns/${ret.body.id}/confirm`).set(auth()).send({})).status).toBeLessThan(300);

    // A receipt voucher against it still works.
    const rv = await request(srv()).post("/api/v1/receipt-vouchers").set(auth()).send({
      voucherDate: "2026-03-20", branchId: h.branchId, customerId, treasuryAccountId: acc.cash, amount: "1000.00",
      allocations: [{ salesInvoiceId: draft.body.id, amount: "1000.00" }],
    });
    expect(rv.status).toBeLessThan(300);
    expect((await request(srv()).post(`/api/v1/receipt-vouchers/${rv.body.id}/post`).set(auth()).send({})).status).toBeLessThan(300);

    // Cancelling a confirmed invoice still works.
    const toCancel = await sell(variantId, "2", "700");
    expect((await request(srv()).post(`/api/v1/sales-invoices/${toCancel}/cancel`).set(auth()).send({})).status).toBeLessThan(300);
    expect((await h.prisma.salesInvoice.findUnique({ where: { id: toCancel } }))!.status).toBe("CANCELLED");

    expect(await ledgerBalanced()).toBe(true);
    expect((await h.prisma.branchInventoryBalance.findMany()).every((b) => D(b.boardsOnHand).gte(0))).toBe(true);
  });

  it("keeps the ledger balanced and stock non-negative after a long mixed sequence", async () => {
    const { variantId } = await stocked("100");
    const inv = await sell(variantId, "20", "800");
    for (const price of ["810.00", "820.00", "805.00"]) {
      const p = await payloadFrom(inv);
      p.lines[0]!.unitPrice = price;
      const rev = (await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!.revisionNumber;
      const pv = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions/preview`).set(auth())
        .send({ expectedRevisionNumber: rev, reason: `تعديل متتابع ${price}`, payload: p });
      const exec = await request(srv()).post(`/api/v1/sales-invoices/${inv}/revisions`).set(auth()).send({
        expectedRevisionNumber: rev, previewFingerprint: pv.body.previewFingerprint,
        reason: `تعديل متتابع ${price}`, idempotencyKey: nextKey(), acknowledgedWarnings: [], payload: p,
      });
      expect(exec.status).toBeLessThan(300);
    }
    const after = (await h.prisma.salesInvoice.findUnique({ where: { id: inv } }))!;
    expect(after.revisionNumber).toBe(4);
    expect(D(after.grandTotal).toFixed(2)).toBe("64400.00"); // 20 × 4 m × 805
    expect(await ledgerBalanced()).toBe(true);
    expect((await h.prisma.branchInventoryBalance.findMany()).every((b) => D(b.boardsOnHand).gte(0) && D(b.metersOnHand).gte(0))).toBe(true);

    const hist = await request(srv()).get(`/api/v1/sales-invoices/${inv}/revisions`).set(auth());
    expect(hist.body.revisions.map((r: { revisionNumber: number }) => r.revisionNumber)).toEqual([2, 3, 4]);
    // Every historical version is still readable.
    for (const n of [2, 3, 4]) {
      const one = await request(srv()).get(`/api/v1/sales-invoices/${inv}/revisions/${n}`).set(auth());
      expect(one.status).toBe(200);
      expect(one.body.beforeSnapshot.header.grandTotal).toBeTruthy();
    }
  });
});
