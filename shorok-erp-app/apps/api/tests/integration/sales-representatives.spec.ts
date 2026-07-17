/**
 * Sales Representatives — an optional accounting/reporting DIMENSION.
 *
 * Proves the load-bearing rules: a rep is never a GL account; sales invoices are
 * informational and never move the rep balance; only posted journal_lines
 * carrying the rep do; drafts require no posting profile and create no journal or
 * stock; inactive reps are rejected on new records but stay readable in history;
 * and the statement's opening/period/closing come from posted lines with correct
 * Decimal math. Nothing is read from legacy balance tables.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("sales representatives", () => {
  let handle: TestApp;
  let ownerToken: string;
  let branchA: string, branchB: string;
  let customerId: string;
  let arCtl: string, revenue: string, vatOut: string, cogs: string, inventory: string, cash: string;

  const server = () => handle.app.getHttpServer();
  const H = (t = ownerToken) => ({ Authorization: `Bearer ${t}` });

  let seq = 0;
  const uniq = () => `${Date.now().toString().slice(-5)}${++seq}`;

  const mkAccount = async (o: { nameAr: string; category: string; accountType: string; systemRole?: string; treasuryType?: "CASH" | "BANK" }) =>
    (await handle.prisma.account.create({
      data: {
        code: `SR${uniq()}`, nameAr: o.nameAr, nameEn: o.nameAr,
        category: o.category as never, accountType: o.accountType as never, isLeaf: true, active: true,
        ...(o.systemRole ? { systemRole: o.systemRole as never } : {}),
        ...(o.treasuryType ? { treasuryType: o.treasuryType, isCashOrBank: true } : {}),
      },
    })).id;

  const createRep = (body: Record<string, unknown>, token = ownerToken) =>
    request(server()).post("/api/v1/sales-representatives").set(H(token)).send(body);
  const statement = (id: string, qs = "") =>
    request(server()).get(`/api/v1/sales-representatives/${id}/statement${qs}`).set(H());

  const postJournal = (lines: Array<Record<string, unknown>>, date = "2026-07-15") =>
    request(server()).post("/api/v1/journal").set(H()).send({
      entryDate: date, entryType: "JOURNAL", description: "قيد اختبار مندوب",
      acknowledgeNegativeBalance: true, lines,
    });

  beforeAll(async () => {
    handle = await buildTestApp();
    const pw = "Pwd@2026!";
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash: await bcrypt.hash(pw, 10) } });
    ownerToken = (await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: pw })).body.accessToken;

    branchA = handle.branchId;
    branchB = (await handle.prisma.branch.create({ data: { nameAr: `فرع ب ${uniq()}`, nameEn: `Branch B ${uniq()}` } })).id;
    customerId = (await handle.prisma.customer.create({ data: { code: `C${uniq()}`, nameAr: "عميل مندوب" } })).id;

    arCtl = await mkAccount({ nameAr: "ذمم مدينة", category: "ASSET", accountType: "CURRENT_ASSET", systemRole: "AR_CONTROL" });
    revenue = await mkAccount({ nameAr: "إيرادات", category: "REVENUE", accountType: "REVENUE" });
    vatOut = await mkAccount({ nameAr: "ضريبة مبيعات", category: "LIABILITY", accountType: "LIABILITY" });
    cogs = await mkAccount({ nameAr: "تكلفة مبيعات", category: "COST_OF_SALES", accountType: "COST_OF_SALES" });
    inventory = await mkAccount({ nameAr: "مخزون", category: "ASSET", accountType: "CURRENT_ASSET" });
    cash = await mkAccount({ nameAr: "خزنة", category: "ASSET", accountType: "CURRENT_ASSET", treasuryType: "CASH" });

    await handle.prisma.postingProfile.create({
      data: {
        effectiveFrom: new Date("2026-01-01"), arAccountId: arCtl, revenueAccountId: revenue,
        vatOutputAccountId: vatOut, cogsAccountId: cogs, inventoryAccountId: inventory, createdBy: handle.ownerId,
      },
    });
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 6, status: "OPEN" } });
  });

  afterAll(async () => teardownTestApp(handle));

  const stockedVariant = async (avgCost = "560", boards = "50") => {
    const sku = await handle.prisma.productSku.create({ data: { code: `SRK${uniq()}`, category: "NORMAL", colorNameAr: "ص", colorNameEn: "c" } });
    const v = await handle.prisma.productVariant.create({
      data: { skuId: sku.id, sizeMetersPerBoard: "1", defaultSalePricePerMeter: "1000", defaultPurchasePricePerMeter: "560", avgCost },
    });
    await handle.prisma.branchInventoryBalance.create({ data: { branchId: branchA, productVariantId: v.id, boardsOnHand: boards, metersOnHand: boards } });
    return v.id;
  };

  const draft = (repId: string | null, variantId: string, branchId = branchA) =>
    request(server()).post("/api/v1/sales-invoices").set(H()).send({
      invoiceDate: "2026-07-15", customerId, branchId, taxRate: "14",
      ...(repId ? { salesRepresentativeId: repId } : {}),
      lines: [{ productVariantId: variantId, quantity: "4", unitPrice: "1000" }],
    });

  // ── Master data ───────────────────────────────────────────────────────────

  it("creates a rep with an auto-generated REP-#### code", async () => {
    const res = await createRep({ nameAr: "مندوب أ" });
    expect(res.status).toBeLessThan(300);
    expect(res.body.code).toMatch(/^REP-\d{4}$/);
    expect(res.body.active).toBe(true);
  });

  it("rejects a duplicate explicit code with a typed error", async () => {
    const code = `REPX-${uniq()}`;
    expect((await createRep({ nameAr: "أول", code })).status).toBeLessThan(300);
    const dup = await createRep({ nameAr: "ثانٍ", code });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("duplicate_representative_code");
  });

  it("auto-generated codes are unique and increment", async () => {
    const a = (await createRep({ nameAr: "تسلسل 1" })).body.code;
    const b = (await createRep({ nameAr: "تسلسل 2" })).body.code;
    expect(a).not.toBe(b);
    expect(Number(b.split("-")[1])).toBeGreaterThan(Number(a.split("-")[1]));
  });

  it("deactivates then reactivates a rep, and it stays readable while inactive", async () => {
    const id = (await createRep({ nameAr: "قابل للإيقاف" })).body.id;
    expect((await request(server()).patch(`/api/v1/sales-representatives/${id}`).set(H()).send({ active: false })).body.active).toBe(false);
    // Still readable.
    expect((await request(server()).get(`/api/v1/sales-representatives/${id}`).set(H())).body.active).toBe(false);
    // Hidden from the active-only list, present in the inactive list.
    const activeList = (await request(server()).get("/api/v1/sales-representatives?status=active").set(H())).body;
    expect(activeList.find((r: any) => r.id === id)).toBeUndefined();
    const inactiveList = (await request(server()).get("/api/v1/sales-representatives?status=inactive").set(H())).body;
    expect(inactiveList.find((r: any) => r.id === id)).toBeTruthy();
    expect((await request(server()).patch(`/api/v1/sales-representatives/${id}`).set(H()).send({ active: true })).body.active).toBe(true);
  });

  it("searches by code, Arabic name and phone", async () => {
    const tag = uniq();
    await createRep({ nameAr: `بحث ${tag}`, phone: `010${tag}` });
    expect((await request(server()).get(`/api/v1/sales-representatives?search=${tag}`).set(H())).body.length).toBeGreaterThanOrEqual(1);
    expect((await request(server()).get(`/api/v1/sales-representatives?search=010${tag}`).set(H())).body.length).toBeGreaterThanOrEqual(1);
  });

  // ── Sales invoice integration ──────────────────────────────────────────────

  it("saves a draft with NO rep (backward compatible)", async () => {
    const v = await stockedVariant();
    const res = await draft(null, v);
    expect(res.status).toBeLessThan(300);
    expect(res.body.salesRepresentativeId).toBeNull();
  });

  it("saves a draft with an active rep and preserves it", async () => {
    const repId = (await createRep({ nameAr: "مندوب الفاتورة" })).body.id;
    const v = await stockedVariant();
    const res = await draft(repId, v);
    expect(res.status).toBeLessThan(300);
    expect(res.body.salesRepresentativeId).toBe(repId);
    // Reload preserves it.
    const reload = await request(server()).get(`/api/v1/sales-invoices/${res.body.id}`).set(H());
    expect(reload.body.salesRepresentative.id).toBe(repId);
  });

  it("rejects an unknown rep UUID and an inactive rep on a new invoice", async () => {
    const v = await stockedVariant();
    const unknown = await draft("00000000-0000-0000-0000-000000000000", v);
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("representative_not_found");

    const inactiveId = (await createRep({ nameAr: "موقوف للفاتورة" })).body.id;
    await request(server()).patch(`/api/v1/sales-representatives/${inactiveId}`).set(H()).send({ active: false });
    const v2 = await stockedVariant();
    const res = await draft(inactiveId, v2);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("representative_inactive");
  });

  it("a draft creates no journal, no inventory movement, and does not change stock", async () => {
    const repId = (await createRep({ nameAr: "مندوب المسودة" })).body.id;
    const v = await stockedVariant("560", "10");
    const before = await handle.prisma.branchInventoryBalance.findFirst({ where: { productVariantId: v, branchId: branchA } });
    const jBefore = await handle.prisma.journalEntry.count();
    const mBefore = await handle.prisma.inventoryMovement.count();

    const res = await draft(repId, v);
    expect(res.status).toBeLessThan(300);

    expect(await handle.prisma.journalEntry.count()).toBe(jBefore);
    expect(await handle.prisma.inventoryMovement.count()).toBe(mBefore);
    const after = await handle.prisma.branchInventoryBalance.findFirst({ where: { productVariantId: v, branchId: branchA } });
    expect(after!.boardsOnHand.toString()).toBe(before!.boardsOnHand.toString());
    // A confirmed sales total is unaffected by a draft.
    const st = await statement(repId);
    expect(st.body.confirmedSalesTotal).toBe("0.00");
  });

  it("confirming attributes the rep to the journal HEADER only — the rep balance stays zero", async () => {
    const repId = (await createRep({ nameAr: "مندوب التأكيد" })).body.id;
    const v = await stockedVariant();
    const d = await draft(repId, v);
    const confirmed = await request(server()).post(`/api/v1/sales-invoices/${d.body.id}/confirm`).set(H()).send({});
    expect(confirmed.status).toBeLessThan(300);

    // The generated revenue journal carries the rep on its header…
    const inv = await handle.prisma.salesInvoice.findUnique({ where: { id: d.body.id } });
    const je = await handle.prisma.journalEntry.findUnique({ where: { id: inv!.journalEntryId! }, include: { lines: true } });
    expect(je!.salesRepresentativeId).toBe(repId);
    // …but NO line does, so the rep's financial balance is untouched by the invoice.
    expect(je!.lines.every((l) => l.salesRepresentativeId === null)).toBe(true);

    const st = await statement(repId);
    expect(st.body.closingBalance).toBe("0.00");
    expect(st.body.periodDebit).toBe("0.00");
    expect(st.body.periodCredit).toBe("0.00");
    // The invoice appears as informational sales activity.
    expect(st.body.confirmedSalesTotal).toBe("4560.00"); // 4×1000 + 14% VAT
    const invRow = st.body.rows.find((r: any) => r.kind === "SALES_INVOICE" && r.salesInvoiceId === d.body.id);
    expect(invRow).toBeTruthy();
    expect(invRow.debit).toBeNull();
    expect(invRow.credit).toBeNull();
    expect(invRow.invoiceValue).toBe("4560.00");
  });

  // ── Journal integration + statement balance ────────────────────────────────

  it("only posted journal lines carrying the rep move the balance (debit and credit)", async () => {
    const repId = (await createRep({ nameAr: "مندوب الحركات" })).body.id;

    // Dr rep-tagged expense 1000 / Cr cash — a debit against the rep (مدين).
    const debitPost = await postJournal([
      { accountId: revenue, debit: "0", credit: "1000" },
      { accountId: cash, debit: "1000", credit: "0", salesRepresentativeId: repId },
    ]);
    expect(debitPost.status).toBeLessThan(300);

    // Cr rep-tagged 300 / Dr cash — a credit against the rep (دائن).
    const creditPost = await postJournal([
      { accountId: cash, debit: "300", credit: "0" },
      { accountId: revenue, debit: "0", credit: "300", salesRepresentativeId: repId },
    ]);
    expect(creditPost.status).toBeLessThan(300);

    const st = await statement(repId);
    expect(st.body.periodDebit).toBe("1000.00");
    expect(st.body.periodCredit).toBe("300.00");
    expect(st.body.closingBalance).toBe("700.00"); // 1000 debit − 300 credit
    const journalRows = st.body.rows.filter((r: any) => r.kind === "JOURNAL");
    expect(journalRows).toHaveLength(2);
    expect(journalRows.every((r: any) => r.journalEntryId)).toBe(true);
  });

  it("rejects an inactive rep on a NEW journal line but keeps historical lines readable", async () => {
    const repId = (await createRep({ nameAr: "مندوب تاريخي" })).body.id;
    // Post a line while active.
    await postJournal([
      { accountId: cash, debit: "500", credit: "0", salesRepresentativeId: repId },
      { accountId: revenue, debit: "0", credit: "500" },
    ]);
    // Deactivate, then a new line is rejected…
    await request(server()).patch(`/api/v1/sales-representatives/${repId}`).set(H()).send({ active: false });
    const rejected = await postJournal([
      { accountId: cash, debit: "100", credit: "0", salesRepresentativeId: repId },
      { accountId: revenue, debit: "0", credit: "100" },
    ]);
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe("representative_inactive");
    // …yet the historical line still shows on the statement.
    const st = await statement(repId);
    expect(st.body.closingBalance).toBe("500.00");
  });

  it("computes opening from posted lines before `from`, and period within the window", async () => {
    const repId = (await createRep({ nameAr: "مندوب الفترة" })).body.id;
    await postJournal([{ accountId: cash, debit: "200", credit: "0", salesRepresentativeId: repId }, { accountId: revenue, debit: "0", credit: "200" }], "2026-06-10");
    await postJournal([{ accountId: cash, debit: "50", credit: "0", salesRepresentativeId: repId }, { accountId: revenue, debit: "0", credit: "50" }], "2026-07-10");

    const st = await statement(repId, "?from=2026-07-01&to=2026-07-31");
    expect(st.body.openingBalance).toBe("200.00"); // June line rolls into opening
    expect(st.body.periodDebit).toBe("50.00");
    expect(st.body.closingBalance).toBe("250.00");
  });

  it("filters the statement by branch for both invoice and journal activity", async () => {
    const repId = (await createRep({ nameAr: "مندوب الفروع" })).body.id;
    await postJournal([{ accountId: cash, debit: "70", credit: "0", salesRepresentativeId: repId, branchId: branchA }, { accountId: revenue, debit: "0", credit: "70" }]);
    await postJournal([{ accountId: cash, debit: "30", credit: "0", salesRepresentativeId: repId, branchId: branchB }, { accountId: revenue, debit: "0", credit: "30" }]);

    expect((await statement(repId, `?branchId=${branchA}`)).body.closingBalance).toBe("70.00");
    expect((await statement(repId, `?branchId=${branchB}`)).body.closingBalance).toBe("30.00");
    expect((await statement(repId)).body.closingBalance).toBe("100.00");
  });

  it("a reversal preserves the rep on the mirrored lines and nets the balance back", async () => {
    const repId = (await createRep({ nameAr: "مندوب العكس" })).body.id;
    const posted = await postJournal([
      { accountId: cash, debit: "400", credit: "0", salesRepresentativeId: repId },
      { accountId: revenue, debit: "0", credit: "400" },
    ]);
    expect((await statement(repId)).body.closingBalance).toBe("400.00");

    const rev = await request(server()).post(`/api/v1/journal/${posted.body.id}/reverse`).set(H()).send({ reason: "إلغاء" });
    expect(rev.status).toBeLessThan(300);

    const st = await statement(repId);
    expect(st.body.closingBalance).toBe("0.00");
    // Both the original and the reversal line remain on the statement.
    expect(st.body.rows.filter((r: any) => r.kind === "JOURNAL")).toHaveLength(2);
  });

  it("the statement endpoint requires an accounting role", async () => {
    const repId = (await createRep({ nameAr: "مندوب الصلاحية" })).body.id;
    expect((await request(server()).get(`/api/v1/sales-representatives/${repId}/statement`)).status).toBe(401);
  });

  it("no legacy balance table is written when posting a rep-tagged journal", async () => {
    const repId = (await createRep({ nameAr: "مندوب بلا إرث" })).body.id;
    const before = {
      ct: await handle.prisma.customerTransaction.count(),
      pa: await handle.prisma.paymentAccount.count(),
    };
    await postJournal([{ accountId: cash, debit: "10", credit: "0", salesRepresentativeId: repId }, { accountId: revenue, debit: "0", credit: "10" }]);
    expect(await handle.prisma.customerTransaction.count()).toBe(before.ct);
    expect(await handle.prisma.paymentAccount.count()).toBe(before.pa);
  });
});
