/**
 * تقرير ربحية الفواتير — the accounting rules, proven.
 *
 * Synthetic local data only. The scenarios exist to pin down the things that
 * would silently misstate profit if they regressed:
 *
 *  - VAT never counted as revenue;
 *  - the header discount never subtracted twice;
 *  - COGS taken from the posting snapshot even after the current average moves;
 *  - drafts, cancellations and revisions never double counted;
 *  - only CONFIRMED linked returns netted, at their own recorded cost;
 *  - a cost the ERP never recorded reported as unavailable, never as zero.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

const D = (v: unknown) => new Decimal((v as { toString(): string })?.toString() ?? "0");
const RANGE = "preset=custom&from=2026-01-01&to=2026-12-31";
const BASE = "/api/v1/reports/sales/invoice-profitability";

describe("invoice profitability report", () => {
  let handle: TestApp;
  let token: string, accountantToken: string, viewerToken: string;
  let branchA: string, branchB: string, repA: string, repB: string;
  let custA: string, custB: string;
  let vSmall: string, vLarge: string;
  let salesReturnsAcc: string;

  // Invoice ids by role in the scenario.
  const inv: Record<string, { id: string; number: string }> = {};

  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });
  const server = () => handle.app.getHttpServer();
  const report = (qs = RANGE, t = token) => request(server()).get(`${BASE}?${qs}`).set(auth(t));
  const aggregates = (qs = RANGE, t = token) => request(server()).get(`${BASE}/aggregates?${qs}`).set(auth(t));

  const seedStock = (variantId: string, branchId: string, boards: string, size: string) =>
    handle.prisma.branchInventoryBalance.create({
      data: { branchId, productVariantId: variantId, boardsOnHand: boards, metersOnHand: new Decimal(boards).mul(size).toFixed(4) },
    });

  /** Create (and optionally confirm) a sale; returns the created invoice. */
  const sale = async (o: {
    branchId?: string; customerId?: string; repId?: string | null; date: string; taxRate?: string; confirm?: boolean;
    lines: Array<{ variantId: string; boards: string; price: string; discountPct?: string; lengthM?: string; widthM?: string }>;
  }) => {
    const body = {
      invoiceDate: o.date,
      customerId: o.customerId ?? custA,
      branchId: o.branchId ?? branchA,
      taxRate: o.taxRate ?? "0",
      salesRepresentativeId: o.repId === undefined ? repA : o.repId,
      lines: o.lines.map((l) => ({
        productVariantId: l.variantId,
        quantity: l.boards,
        unitPrice: l.price,
        costPrice: "0",
        discountPct: l.discountPct ?? "0",
        ...(l.lengthM ? { lengthM: l.lengthM } : {}),
        ...(l.widthM ? { widthM: l.widthM } : {}),
      })),
    };
    const d = await request(server()).post("/api/v1/sales-invoices").set(auth()).send(body);
    expect(d.status).toBeLessThan(300);
    if (o.confirm !== false) {
      const c = await request(server()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(auth()).send({});
      if (c.status >= 300) throw new Error(`confirm failed ${c.status}: ${JSON.stringify(c.body)}`);
    }
    return d.body;
  };

  const rowFor = (body: any, number: string) => body.invoices.find((r: any) => r.invoiceNumber === String(number));

  /** supertest has no xlsx parser; collect the bytes ourselves. */
  const binary = (res: any, cb: (e: Error | null, b: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  };

  beforeAll(async () => {
    handle = await buildTestApp();
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) } });
    token = (await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" })).body.accessToken;

    for (const [phone, role] of [["+201507070701", "ACCOUNTANT"], ["+201507070702", "VIEWER"]] as const) {
      await handle.prisma.user.create({
        data: { name: role, phone, passwordHash: await bcrypt.hash("Pwd@2026!", 10), role, status: "ACTIVE" },
      });
    }
    accountantToken = (await request(server()).post("/api/v1/auth/login").send({ phone: "+201507070701", password: "Pwd@2026!" })).body.accessToken;
    viewerToken = (await request(server()).post("/api/v1/auth/login").send({ phone: "+201507070702", password: "Pwd@2026!" })).body.accessToken;

    branchA = handle.branchId;
    branchB = (await handle.prisma.branch.create({ data: { nameAr: "فرع ب", nameEn: "B", active: true } })).id;
    repA = (await handle.prisma.salesRepresentative.create({ data: { code: "PR-A", nameAr: "مندوب أ" } })).id;
    repB = (await handle.prisma.salesRepresentative.create({ data: { code: "PR-B", nameAr: "مندوب ب" } })).id;
    custA = (await handle.prisma.customer.create({ data: { code: "PC-1", nameAr: "عميل أ" } })).id;
    custB = (await handle.prisma.customer.create({ data: { code: "PC-2", nameAr: "عميل ب" } })).id;

    const u = Date.now().toString().slice(-6);
    const mk = (c: string, n: string, cat: any, t: any, role?: string) =>
      handle.prisma.account.create({
        data: { code: c, nameAr: n, nameEn: n, category: cat, accountType: t, isLeaf: true, active: true, ...(role ? { systemRole: role as never } : {}) },
      });
    const ar = (await mk(`AR${u}`, "عملاء", "ASSET", "CURRENT_ASSET", "AR_CONTROL")).id;
    const rev = (await mk(`RV${u}`, "مبيعات", "REVENUE", "REVENUE")).id;
    salesReturnsAcc = (await mk(`SR${u}`, "مردودات المبيعات", "REVENUE", "REVENUE")).id;
    const vatOut = (await mk(`VO${u}`, "ضريبة", "LIABILITY", "LIABILITY")).id;
    const cogsAcc = (await mk(`CG${u}`, "تكلفة", "COST_OF_SALES", "COST_OF_SALES")).id;
    const invAcc = (await mk(`IN${u}`, "مخزون", "ASSET", "CURRENT_ASSET")).id;
    await handle.prisma.postingProfile.create({
      data: {
        effectiveFrom: new Date("2026-01-01"),
        arAccountId: ar, revenueAccountId: rev, salesReturnsAccountId: salesReturnsAcc,
        vatOutputAccountId: vatOut, cogsAccountId: cogsAcc, inventoryAccountId: invAcc,
        createdBy: handle.ownerId,
      },
    });
    for (let m = 1; m <= 12; m++) await handle.prisma.financialPeriod.create({ data: { year: 2026, month: m, status: "OPEN" } });

    const skuS = await handle.prisma.productSku.create({ data: { code: "PSKU-S", category: "NORMAL", colorNameAr: "صنف صغير", colorNameEn: "s" } });
    const skuL = await handle.prisma.productSku.create({ data: { code: "PSKU-L", category: "NORMAL", colorNameAr: "صنف كبير", colorNameEn: "l" } });
    // Cost is per metre. 475/m at posting time — the number the report must keep.
    vSmall = (await handle.prisma.productVariant.create({
      data: { skuId: skuS.id, sizeMetersPerBoard: "4.0000", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "1900", avgCostPerMeter: "475" },
    })).id;
    vLarge = (await handle.prisma.productVariant.create({
      data: { skuId: skuL.id, sizeMetersPerBoard: "5.2500", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0", avgCost: "2625", avgCostPerMeter: "500" },
    })).id;

    for (const [v, b, size] of [[vSmall, branchA, "4.0000"], [vLarge, branchA, "5.2500"], [vSmall, branchB, "4.0000"]] as const) {
      await seedStock(v, b, "500", size);
    }

    // ── the scenario ────────────────────────────────────────────────────────
    // simple: 2 boards × 4m = 8m @ 700 → net 5600; COGS 8 × 475 = 3800; GP 1800.
    inv.simple = await sale({ date: "2026-03-01", lines: [{ variantId: vSmall, boards: "2", price: "700", lengthM: "4" }] });
    // multiline + discount: 8m@700 −10% = 5040 ; 21m@800 = 16800 → net 21840
    //   COGS 8×475 + 21×500 = 3800 + 10500 = 14300 ; GP 7540
    inv.multi = await sale({
      date: "2026-03-02",
      lines: [
        { variantId: vSmall, boards: "2", price: "700", discountPct: "10", lengthM: "4" },
        { variantId: vLarge, boards: "4", price: "800", lengthM: "5.25" },
      ],
    });
    // VAT 14%: 8m@1000 = 8000 net; tax 1120; grand 9120. COGS 3800; GP 4200.
    inv.vat = await sale({ date: "2026-03-03", taxRate: "14", lines: [{ variantId: vSmall, boards: "2", price: "1000", lengthM: "4" }] });
    // other branch / other customer / other rep, for the aggregation tabs.
    inv.other = await sale({
      date: "2026-03-04", branchId: branchB, customerId: custB, repId: repB,
      lines: [{ variantId: vSmall, boards: "1", price: "900", lengthM: "4" }],
    });
    // returns: 4 boards × 4m = 16m @ 700 → net 11200; COGS 16×475 = 7600.
    inv.returned = await sale({ date: "2026-03-06", lines: [{ variantId: vSmall, boards: "4", price: "700", lengthM: "4" }] });
    inv.fullyReturned = await sale({ date: "2026-03-07", lines: [{ variantId: vSmall, boards: "2", price: "700", lengthM: "4" }] });
    inv.draftReturned = await sale({ date: "2026-03-08", lines: [{ variantId: vSmall, boards: "2", price: "700", lengthM: "4" }] });
    inv.cancelledReturn = await sale({ date: "2026-03-09", lines: [{ variantId: vSmall, boards: "2", price: "700", lengthM: "4" }] });
    // noise that must never count.
    inv.draft = await sale({ date: "2026-03-10", confirm: false, lines: [{ variantId: vSmall, boards: "9", price: "999", lengthM: "4" }] });
    inv.cancelled = await sale({ date: "2026-03-11", lines: [{ variantId: vSmall, boards: "7", price: "888", lengthM: "4" }] });
    await request(server()).post(`/api/v1/sales-invoices/${inv.cancelled.id}/cancel`).set(auth()).send({}).expect((r) => expect(r.status).toBeLessThan(300));
    // a legacy invoice with no cost snapshot at all (pre-costing-migration).
    inv.noCost = await sale({ date: "2026-03-12", lines: [{ variantId: vSmall, boards: "3", price: "600", lengthM: "4" }] });
    await handle.prisma.salesInvoiceLine.updateMany({
      where: { invoiceId: inv.noCost.id },
      data: { lineCogsAtPosting: null, unitCostPerMeterAtPosting: null, unitCostAtPosting: null },
    });
    // an invoice where only ONE of two lines lost its cost → PARTIAL coverage.
    inv.partialCost = await sale({
      date: "2026-03-13",
      lines: [
        { variantId: vSmall, boards: "1", price: "600", lengthM: "4" },
        { variantId: vLarge, boards: "1", price: "600", lengthM: "5.25" },
      ],
    });
    const partialLines = await handle.prisma.salesInvoiceLine.findMany({ where: { invoiceId: inv.partialCost.id }, orderBy: { id: "asc" } });
    await handle.prisma.salesInvoiceLine.update({
      where: { id: partialLines[0]!.id },
      data: { lineCogsAtPosting: null, unitCostPerMeterAtPosting: null, unitCostAtPosting: null },
    });

    // ── returns ─────────────────────────────────────────────────────────────
    const makeReturn = async (invoice: any, boards: string, confirmIt: boolean, cancelIt = false) => {
      const lines = await handle.prisma.salesInvoiceLine.findMany({ where: { invoiceId: invoice.id } });
      const r = await request(server()).post("/api/v1/sales-returns").set(auth()).send({
        originalSalesInvoiceId: invoice.id,
        returnDate: "2026-03-20",
        settlementMode: "KEEP_AS_CUSTOMER_CREDIT",
        lines: [{ originalSalesInvoiceLineId: lines[0]!.id, returnedBoards: boards }],
      });
      expect(r.status).toBeLessThan(300);
      if (confirmIt) {
        const c = await request(server()).post(`/api/v1/sales-returns/${r.body.id}/confirm`).set(auth()).send({});
        expect(c.status).toBeLessThan(300);
      }
      if (cancelIt) {
        const c = await request(server()).post(`/api/v1/sales-returns/${r.body.id}/cancel`).set(auth()).send({ reason: "اختبار" });
        expect(c.status).toBeLessThan(300);
      }
      return r.body;
    };
    await makeReturn(inv.returned, "1", true);           // partial: 1 of 4 boards
    await makeReturn(inv.fullyReturned, "2", true);      // full: 2 of 2
    await makeReturn(inv.draftReturned, "1", false);     // draft — must not count
    await makeReturn(inv.cancelledReturn, "1", true, true); // confirmed then cancelled

    // THE TRAP: move the current average AFTER posting. Every historical figure
    // must stay where it was — 475/m, not 9999/m.
    await handle.prisma.productVariant.update({ where: { id: vSmall }, data: { avgCostPerMeter: "9999", avgCost: "39996" } });
    await handle.prisma.productVariant.update({ where: { id: vLarge }, data: { avgCostPerMeter: "9999", avgCost: "52494" } });

    for (const k of Object.keys(inv)) inv[k] = { id: inv[k].id, number: String(inv[k].invoiceNumber ?? inv[k].number) };
  }, 180_000);

  afterAll(async () => teardownTestApp(handle));

  // ── 1-3. the basic shape ────────────────────────────────────────────────
  it("a single-line confirmed invoice reports net, historical COGS, profit and margin", async () => {
    const res = await report();
    expect(res.status).toBe(200);
    const r = rowFor(res.body, inv.simple.number);
    expect(D(r.netSalesExVat).toFixed(2)).toBe("5600.00");
    expect(D(r.cogs).toFixed(2)).toBe("3800.00");
    expect(D(r.grossProfit).toFixed(2)).toBe("1800.00");
    expect(D(r.marginPct).toFixed(2)).toBe("32.14"); // 1800/5600
    expect(r.costCoverage).toBe("COMPLETE");
  });

  it("a multi-line invoice with a line discount nets correctly and never double-counts the discount", async () => {
    const r = rowFor((await report()).body, inv.multi.number);
    expect(D(r.salesBeforeDiscount).toFixed(2)).toBe("22400.00"); // 5600 + 16800
    expect(D(r.discount).toFixed(2)).toBe("560.00");
    expect(D(r.netSalesExVat).toFixed(2)).toBe("21840.00");
    expect(D(r.cogs).toFixed(2)).toBe("14300.00");
    expect(D(r.grossProfit).toFixed(2)).toBe("7540.00");
    // The persisted header subtotal IS the ex-VAT net; they must agree exactly.
    const invoice = await handle.prisma.salesInvoice.findUnique({ where: { id: inv.multi.id } });
    expect(D(invoice!.subtotal).toFixed(2)).toBe(D(r.netSalesExVat).toFixed(2));
  });

  it("VAT is excluded from profit but still reported alongside it", async () => {
    const r = rowFor((await report()).body, inv.vat.number);
    expect(D(r.netSalesExVat).toFixed(2)).toBe("8000.00");
    expect(D(r.tax).toFixed(2)).toBe("1120.00");
    expect(D(r.grandTotal).toFixed(2)).toBe("9120.00");
    // Profit is net-of-VAT minus cost — NOT grandTotal minus cost.
    expect(D(r.grossProfit).toFixed(2)).toBe("4200.00");
    expect(D(r.grossProfit).toFixed(2)).not.toBe(D(r.grandTotal).minus(r.cogs).toFixed(2));
  });

  // ── 4. historical cost ──────────────────────────────────────────────────
  it("uses the cost snapshotted at posting even after the current average changes", async () => {
    const variant = await handle.prisma.productVariant.findUnique({ where: { id: vSmall } });
    expect(D(variant!.avgCostPerMeter).toFixed(0)).toBe("9999"); // the world moved on
    const r = rowFor((await report()).body, inv.simple.number);
    expect(D(r.cogs).toFixed(2)).toBe("3800.00"); // 8m × 475, not × 9999
  });

  it("the line detail shows the historical unit cost, not today's", async () => {
    const res = await request(server()).get(`${BASE}/${inv.simple.id}?${RANGE}`).set(auth());
    expect(res.status).toBe(200);
    const line = res.body.lines[0];
    expect(D(line.costPerMeterAtPosting).toFixed(2)).toBe("475.00");
    expect(D(line.cogs).toFixed(2)).toBe("3800.00");
    expect(line.costBasis).toBe("METER_SNAPSHOT");
  });

  // ── 5. margins ──────────────────────────────────────────────────────────
  it("reports no margin rather than dividing by zero", async () => {
    // The engine refuses to confirm a zero-value invoice at all, so the real
    // zero denominator is an invoice whose sale came back in full.
    const full = rowFor((await report()).body, inv.fullyReturned.number);
    expect(D(full.finalNetSalesExVat).toFixed(2)).toBe("0.00");
    expect(full.finalMarginPct).toBeNull();
    // And an empty period has nothing to take a margin of either.
    const empty = (await report("preset=custom&from=1999-01-01&to=1999-12-31")).body;
    expect(empty.summary.invoiceCount).toBe(0);
    expect(empty.summary.grossMarginPct).toBeNull();
    expect(empty.summary.finalGrossMarginPct).toBeNull();
    expect(D(empty.summary.netSalesExVat).toFixed(2)).toBe("0.00");
  });

  // ── 6. drafts, cancellations, revisions ─────────────────────────────────
  it("excludes draft and cancelled invoices from the report entirely", async () => {
    const body = (await report()).body;
    expect(rowFor(body, inv.draft.number)).toBeUndefined();
    expect(rowFor(body, inv.cancelled.number)).toBeUndefined();
    // And the cancelled invoice still holds its totals in the database, which is
    // exactly why omitting the status filter would inflate the report.
    const cancelled = await handle.prisma.salesInvoice.findUnique({ where: { id: inv.cancelled.id } });
    expect(cancelled!.status).toBe("CANCELLED");
    expect(D(cancelled!.grandTotal).gt(0)).toBe(true);
  });

  it("a revised invoice is counted once, at its revised value", async () => {
    const before = (await report()).body;
    const beforeRow = rowFor(before, inv.simple.number);
    expect(D(beforeRow.netSalesExVat).toFixed(2)).toBe("5600.00");

    const lines = await handle.prisma.salesInvoiceLine.findMany({ where: { invoiceId: inv.simple.id } });
    const invoice = await handle.prisma.salesInvoice.findUnique({ where: { id: inv.simple.id } });
    const payload = {
      invoiceDate: "2026-03-01",
      customerId: custA,
      branchId: branchA,
      salesRepresentativeId: repA,
      taxRate: "0",
      // Halve the quantity: the sale really is smaller now.
      lines: [{ lineId: lines[0]!.id, productVariantId: vSmall, quantity: "1", unitPrice: "700", costPrice: "0", discountPct: "0", lengthM: "4" }],
    };
    const preview = await request(server()).post(`/api/v1/sales-invoices/${inv.simple.id}/revisions/preview`).set(auth()).send({
      expectedRevisionNumber: invoice!.revisionNumber,
      reason: "تصحيح الكمية المسلَّمة",
      payload,
    });
    expect(preview.status).toBeLessThan(300);
    const rev = await request(server()).post(`/api/v1/sales-invoices/${inv.simple.id}/revisions`).set(auth()).send({
      expectedRevisionNumber: invoice!.revisionNumber,
      previewFingerprint: preview.body.previewFingerprint,
      reason: "تصحيح الكمية المسلَّمة",
      idempotencyKey: `REV-TEST-${inv.simple.id}`,
      acknowledgedWarnings: (preview.body.warnings ?? []).map((w: any) => w.code ?? w),
      payload,
    });
    if (rev.status >= 300) throw new Error(`revision failed ${rev.status}: ${JSON.stringify(rev.body)}`);

    const after = (await report()).body;
    const matching = after.invoices.filter((r: any) => r.invoiceNumber === inv.simple.number);
    expect(matching).toHaveLength(1);                              // once, not twice
    expect(D(matching[0].netSalesExVat).toFixed(2)).toBe("2800.00"); // 4m × 700
    expect(matching[0].revisionNumber).toBeGreaterThan(1);
    // The revision audit rows exist but must not be summed into the report.
    expect(await handle.prisma.salesInvoiceRevision.count({ where: { salesInvoiceId: inv.simple.id } })).toBeGreaterThan(0);
  });

  // ── 7. linked returns ───────────────────────────────────────────────────
  it("subtracts a confirmed partial return at its own recorded cost", async () => {
    const r = rowFor((await report()).body, inv.returned.number);
    expect(D(r.netSalesExVat).toFixed(2)).toBe("11200.00");
    expect(D(r.cogs).toFixed(2)).toBe("7600.00");
    // 1 of 4 boards back: 4m × 700 = 2800 revenue, 4m × 475 = 1900 cost.
    expect(D(r.returnNetExVat).toFixed(2)).toBe("2800.00");
    expect(D(r.returnCogs).toFixed(2)).toBe("1900.00");
    expect(D(r.finalNetSalesExVat).toFixed(2)).toBe("8400.00");
    expect(D(r.finalCogs).toFixed(2)).toBe("5700.00");
    expect(D(r.finalProfit).toFixed(2)).toBe("2700.00");
    // The identity the report promises.
    expect(D(r.finalProfit).toFixed(2)).toBe(D(r.netSalesExVat).minus(r.returnNetExVat).minus(D(r.cogs).minus(r.returnCogs)).toFixed(2));
  });

  it("a fully returned invoice nets to zero profit", async () => {
    const r = rowFor((await report()).body, inv.fullyReturned.number);
    expect(D(r.finalNetSalesExVat).toFixed(2)).toBe("0.00");
    expect(D(r.finalCogs).toFixed(2)).toBe("0.00");
    expect(D(r.finalProfit).toFixed(2)).toBe("0.00");
    expect(r.finalMarginPct).toBeNull(); // nothing left to take a margin of
  });

  it("draft and cancelled returns do not touch profit", async () => {
    const body = (await report()).body;
    for (const key of ["draftReturned", "cancelledReturn"]) {
      const r = rowFor(body, inv[key].number);
      expect(D(r.returnNetExVat).toFixed(2)).toBe("0.00");
      expect(D(r.finalProfit).toFixed(2)).toBe(D(r.grossProfit).toFixed(2));
    }
  });

  it("legacy returns without an invoice link are never attributed to an invoice", async () => {
    // A مردود بدون فاتورة for the same customer must not appear anywhere here.
    const before = (await report()).body.summary.linkedReturnsNetExVat;
    const legacy = await request(server()).post("/api/v1/legacy-returns").set(auth()).send({
      customerId: custA, branchId: branchA,
      paperInvoiceNumber: "PAPER-1", paperInvoiceDate: "2020-01-01", returnDate: "2026-03-25",
      lines: [{ productVariantId: vSmall, returnedBoards: "1", unitPricePerMeter: "700" }],
    });
    expect(legacy.status).toBeLessThan(300);
    await request(server()).post(`/api/v1/legacy-returns/${legacy.body.id}/confirm`).set(auth()).send({});
    expect((await report()).body.summary.linkedReturnsNetExVat).toBe(before);
  });

  // ── 8. missing historical cost ──────────────────────────────────────────
  it("an invoice with no recorded cost reports sales but NOT a fabricated profit", async () => {
    const r = rowFor((await report()).body, inv.noCost.number);
    expect(D(r.netSalesExVat).toFixed(2)).toBe("7200.00"); // sales are known
    expect(r.cogs).toBeNull();                             // cost is not
    expect(r.grossProfit).toBeNull();
    expect(r.marginPct).toBeNull();
    expect(r.costCoverage).toBe("MISSING");
    expect(r.linesMissingCost).toBe(1);
  });

  it("an invoice missing SOME line costs is marked partial, not silently averaged", async () => {
    const r = rowFor((await report()).body, inv.partialCost.number);
    expect(r.costCoverage).toBe("PARTIAL");
    expect(r.linesMissingCost).toBe(1);
    expect(r.lineCount).toBe(2);
    expect(r.grossProfit).toBeNull();
  });

  it("missing-cost invoices are counted and excluded from the profit totals", async () => {
    const s = (await report()).body.summary;
    expect(s.incompleteCostInvoiceCount).toBe(2); // noCost + partialCost
    expect(D(s.incompleteCostNetSales).gt(0)).toBe(true);
    // Revenue covers everything; profit covers only what has a cost.
    expect(D(s.netSalesExVat).gt(s.costedNetSalesExVat)).toBe(true);
    expect(D(s.grossProfit).toFixed(2)).toBe(D(s.costedNetSalesExVat).minus(s.historicalCogs).toFixed(2));
    expect(s.costedInvoiceCount).toBe(s.invoiceCount - s.incompleteCostInvoiceCount);
  });

  it("the cost-coverage filter isolates each population", async () => {
    const complete = (await report(`${RANGE}&costCoverage=COMPLETE`)).body;
    expect(complete.invoices.every((r: any) => r.costCoverage === "COMPLETE")).toBe(true);
    const incomplete = (await report(`${RANGE}&costCoverage=INCOMPLETE`)).body;
    expect(incomplete.invoices.length).toBe(2);
    expect(incomplete.invoices.every((r: any) => r.costCoverage !== "COMPLETE")).toBe(true);
  });

  // ── 9. golden reconciliation ────────────────────────────────────────────
  it("reconciles to the persisted invoice totals, to the cent", async () => {
    const body = (await report(`${RANGE}&pageSize=500`)).body;
    for (const r of body.invoices) {
      const persisted = await handle.prisma.salesInvoice.findFirst({ where: { invoiceNumber: BigInt(r.invoiceNumber) } });
      expect(D(r.netSalesExVat).toFixed(2)).toBe(D(persisted!.subtotal).toFixed(2));
      expect(D(r.tax).toFixed(2)).toBe(D(persisted!.taxAmount).toFixed(2));
      expect(D(r.grandTotal).toFixed(2)).toBe(D(persisted!.grandTotal).toFixed(2));
      if (r.costCoverage === "COMPLETE") {
        const lines = await handle.prisma.salesInvoiceLine.findMany({ where: { invoiceId: persisted!.id } });
        const cogs = lines.reduce((a, l) => a.plus(D(l.lineCogsAtPosting ?? 0)), new Decimal(0));
        expect(D(r.cogs).toFixed(2)).toBe(cogs.toFixed(2));
        expect(D(r.grossProfit).toFixed(2)).toBe(D(r.netSalesExVat).minus(r.cogs).toFixed(2));
      }
    }
  });

  it("the summary is the sum of its invoices", async () => {
    const body = (await report(`${RANGE}&pageSize=500`)).body;
    const net = body.invoices.reduce((a: Decimal, r: any) => a.plus(r.netSalesExVat), new Decimal(0));
    expect(net.toFixed(2)).toBe(D(body.summary.netSalesExVat).toFixed(2));
    expect(body.summary.invoiceCount).toBe(body.invoices.length);
  });

  it("the invoice detail's lines sum to its header", async () => {
    const res = await request(server()).get(`${BASE}/${inv.multi.id}?${RANGE}`).set(auth());
    const lineNet = res.body.lines.reduce((a: Decimal, l: any) => a.plus(l.netSalesExVat), new Decimal(0));
    expect(lineNet.toFixed(2)).toBe(D(res.body.invoice.netSalesExVat).toFixed(2));
    const lineCogs = res.body.lines.reduce((a: Decimal, l: any) => a.plus(l.cogs ?? "0"), new Decimal(0));
    expect(lineCogs.toFixed(2)).toBe(D(res.body.invoice.cogs).toFixed(2));
  });

  // ── 10. aggregation ─────────────────────────────────────────────────────
  it("aggregates by product, customer, branch and representative, all reconciling to the same net", async () => {
    const body = (await report(`${RANGE}&pageSize=500`)).body;
    const agg = (await aggregates()).body;
    for (const dim of ["product", "customer", "branch", "representative"] as const) {
      expect(agg[dim].length).toBeGreaterThan(0);
      const net = agg[dim].reduce((a: Decimal, g: any) => a.plus(g.netSalesExVat), new Decimal(0));
      expect(net.toFixed(2)).toBe(D(body.summary.netSalesExVat).toFixed(2));
    }
    // Distinct products stay distinct — identity is the code, not the name.
    expect(new Set(agg.product.map((g: any) => g.key)).size).toBe(agg.product.length);
    expect(agg.branch.length).toBe(2);
    expect(agg.customer.length).toBe(2);
  });

  it("aggregate COGS never counts an unrecorded cost as zero", async () => {
    const agg = (await aggregates()).body;
    for (const g of agg.product) {
      expect(D(g.grossProfit).toFixed(2)).toBe(D(g.costedNetSalesExVat).minus(g.cogs).toFixed(2));
      if (g.incompleteCostInvoiceCount > 0) expect(D(g.costedNetSalesExVat).lt(g.netSalesExVat)).toBe(true);
    }
  });

  // ── 11. filters and paging ──────────────────────────────────────────────
  it("filters by date, branch, customer, representative, product and invoice number", async () => {
    const only = async (qs: string) => (await report(`${RANGE}&${qs}&pageSize=500`)).body.invoices;

    expect((await only(`branchId=${branchB}`)).every((r: any) => r.branchName === "فرع ب")).toBe(true);
    expect((await only(`customerId=${custB}`)).every((r: any) => r.customerCode === "PC-2")).toBe(true);
    expect((await only(`salesRepresentativeId=${repB}`)).every((r: any) => r.salesRepresentativeName === "مندوب ب")).toBe(true);
    expect(await only(`invoiceNumber=${inv.vat.number}`)).toHaveLength(1);
    expect((await only("productCode=PSKU-L")).length).toBeGreaterThan(0);

    const narrow = (await report("preset=custom&from=2026-03-03&to=2026-03-03&pageSize=500")).body;
    expect(narrow.invoices).toHaveLength(1);
    expect(narrow.invoices[0].invoiceNumber).toBe(inv.vat.number);
  });

  it("pages the invoice list without changing the totals", async () => {
    const all = (await report(`${RANGE}&pageSize=500`)).body;
    const first = (await report(`${RANGE}&page=1&pageSize=2`)).body;
    expect(first.invoices).toHaveLength(2);
    expect(first.totalInvoices).toBe(all.totalInvoices);
    expect(D(first.summary.netSalesExVat).toFixed(2)).toBe(D(all.summary.netSalesExVat).toFixed(2));
    const second = (await report(`${RANGE}&page=2&pageSize=2`)).body;
    expect(second.invoices[0].id).not.toBe(first.invoices[0].id);
  });

  it("rejects invalid filters instead of guessing", async () => {
    expect((await report("preset=custom&from=nonsense&to=2026-12-31")).status).toBe(400);
    expect((await report(`${RANGE}&pageSize=99999`)).status).toBe(400);
    expect((await report(`${RANGE}&costCoverage=MAYBE`)).status).toBe(400);
    expect((await report(`${RANGE}&branchId=not-a-uuid`)).status).toBe(400);
  });

  // ── 12. authorization ───────────────────────────────────────────────────
  it("is limited to the roles allowed to see margins", async () => {
    expect((await report(RANGE, accountantToken)).status).toBe(200);
    expect((await report(RANGE, viewerToken)).status).toBe(403);
    expect((await aggregates(RANGE, viewerToken)).status).toBe(403);
    expect((await request(server()).get(`${BASE}?${RANGE}`)).status).toBe(401);
    expect((await request(server()).get(`${BASE}/${inv.simple.id}?${RANGE}`).set(auth(viewerToken))).status).toBe(403);
    expect((await request(server()).get(`${BASE}/pdf?${RANGE}`).set(auth(viewerToken))).status).toBe(403);
  });

  it("a missing invoice is a 404, not an empty report", async () => {
    const res = await request(server()).get(`${BASE}/11111111-1111-1111-1111-111111111111?${RANGE}`).set(auth());
    expect(res.status).toBe(404);
  });

  // ── 13. exports ─────────────────────────────────────────────────────────
  it("renders a PDF whose totals match the API", async () => {
    const res = await request(server()).get(`${BASE}/pdf?${RANGE}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.body.subarray(0, 4).toString()).toBe("%PDF");
    expect(res.body.length).toBeGreaterThan(1000);
  }, 120_000);

  it("exports a workbook with a sheet per view", async () => {
    const res = await request(server()).get(`${BASE}/export?${RANGE}`).set(auth()).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    expect(res.body.subarray(0, 2).toString()).toBe("PK"); // a zip, i.e. xlsx
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["ملخص", "الفواتير", "الأصناف", "العملاء", "الفروع", "مندوبي المبيعات"]);
    // The invoice sheet must reconcile with the API, and must not turn an
    // unknown cost into a zero.
    const body = (await report(`${RANGE}&pageSize=500`)).body;
    const sheet = wb.getWorksheet("الفواتير")!;
    expect(sheet.rowCount - 1).toBe(body.invoices.length);
    const headers = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
    const colOf = (header: string) => headers.indexOf(header);
    const column = (header: string) => {
      const idx = colOf(header);
      expect(idx).toBeGreaterThan(0);
      const out: unknown[] = [];
      sheet.getColumn(idx).eachCell({ includeEmpty: false }, (cell, row) => { if (row > 1) out.push(cell.value); });
      return out;
    };
    const total = column("صافي المبيعات بدون الضريبة").reduce((a: Decimal, v) => a.plus(String(v)), new Decimal(0));
    expect(total.toFixed(2)).toBe(D(body.summary.netSalesExVat).toFixed(2));
    const cogsValues = column("التكلفة التاريخية");
    expect(cogsValues).toContain("غير متاحة");
    expect(cogsValues.filter((v) => v === 0)).toHaveLength(0);
  }, 120_000);

  it("renders a per-invoice PDF", async () => {
    const res = await request(server()).get(`${BASE}/${inv.multi.id}/pdf?${RANGE}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.subarray(0, 4).toString()).toBe("%PDF");
  }, 120_000);

  // ── 14. it really is read-only ──────────────────────────────────────────
  it("no report request writes anything", async () => {
    const count = async () => ({
      journals: await handle.prisma.journalEntry.count(),
      journalLines: await handle.prisma.journalLine.count(),
      invoices: await handle.prisma.salesInvoice.count(),
      lines: await handle.prisma.salesInvoiceLine.count(),
      returns: await handle.prisma.salesReturn.count(),
      movements: await handle.prisma.inventoryMovement.count(),
      customerTx: await handle.prisma.customerTransaction.count(),
      audit: await handle.prisma.auditLog.count(),
      variants: await handle.prisma.productVariant.count(),
    });
    const before = await count();
    await report(`${RANGE}&pageSize=500`);
    await aggregates();
    await request(server()).get(`${BASE}/${inv.multi.id}?${RANGE}`).set(auth());
    await request(server()).get(`${BASE}/pdf?${RANGE}`).set(auth());
    await request(server()).get(`${BASE}/export?${RANGE}`).set(auth());
    await request(server()).get(`${BASE}/${inv.multi.id}/pdf?${RANGE}`).set(auth());
    expect(await count()).toEqual(before);
  }, 180_000);
});
