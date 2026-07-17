/**
 * Section R — complete double-entry synchronization.
 *
 * Every posted journal has at least two lines, and each line must reach its own
 * account's statement — specific AND consolidated — through the same journal.
 * These tests assert BOTH sides of every scenario, that the two sides share one
 * journalEntryId/source, that unrelated accounts and parties never move, and
 * that a rejected posting leaves no line on either side.
 *
 * Nothing here copies a line into the opposite account: each side is asserted by
 * reading that account's own statement, which is the only thing that proves the
 * GL — not the reader — carries both halves.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("double-entry propagation to statements (Section R)", () => {
  let handle: TestApp;
  let ownerToken: string;
  let bankA: string, bankB: string, cashA: string, cashEmpty: string;
  let expOps: string, expTransport: string, revenue: string, equity: string;
  let arCtl: string, apCtl: string, inventory: string, vatOut: string, vatIn: string, cogs: string;
  let custA: string, custB: string, supA: string, supB: string;

  const server = () => handle.app.getHttpServer();
  const H = (t = ownerToken) => ({ Authorization: `Bearer ${t}` });

  let seq = 0;
  const uniq = () => `${Date.now().toString().slice(-5)}${++seq}`;

  const mkAccount = async (o: {
    nameAr: string; category: string; accountType: string;
    systemRole?: string; treasuryType?: "CASH" | "BANK";
  }) =>
    (await handle.prisma.account.create({
      data: {
        code: `R${uniq()}`, nameAr: o.nameAr, nameEn: o.nameAr,
        category: o.category as never, accountType: o.accountType as never,
        isLeaf: true, active: true,
        ...(o.systemRole ? { systemRole: o.systemRole as never } : {}),
        ...(o.treasuryType ? { treasuryType: o.treasuryType, isCashOrBank: true } : {}),
      },
    })).id;

  interface Row {
    journalEntryId: string; journalLineId: string; accountId: string; entryNumber: string;
    debit: string; credit: string; sourceType: string | null; sourceId: string | null;
    partyType: string | null; partyId: string | null; isReversal: boolean;
  }
  interface Stmt {
    selectionType: string; openingBalance: string; periodDebit: string; periodCredit: string;
    endingBalance: string; breakdown: { entityId: string; endingBalance: string; debit: string; credit: string }[];
    rows: Row[];
  }

  /** Reads a statement exactly as the unified page does. */
  const stmt = async (category: string, entityId?: string, extra = ""): Promise<Stmt> => {
    const q = `category=${category}${entityId ? `&entityId=${entityId}` : ""}${extra}`;
    const res = await request(server()).get(`/api/v1/statements/consolidated?${q}`).set(H());
    expect(res.status).toBe(200);
    return res.body as Stmt;
  };
  const ending = async (category: string, entityId?: string) => (await stmt(category, entityId)).endingBalance;
  const delta = (after: string, before: string) => new Decimal(after).sub(before).toFixed(2);
  const rowsOf = (s: Stmt, journalEntryId: string, accountId?: string) =>
    s.rows.filter((r) => r.journalEntryId === journalEntryId && (!accountId || r.accountId === accountId));

  /** Posts a balanced journal through the engine's real HTTP path. */
  const post = async (o: {
    lines: Array<Record<string, unknown>>; date?: string; acknowledge?: boolean;
    idempotencyKey?: string; description?: string;
  }) =>
    request(server()).post("/api/v1/journal").set(H()).send({
      entryDate: o.date ?? "2026-07-15",
      entryType: "JOURNAL",
      description: o.description ?? "قيد اختبار الطرفين",
      ...(o.acknowledge ? { acknowledgeNegativeBalance: true, negativeBalanceReason: "اختبار" } : {}),
      ...(o.idempotencyKey ? { idempotencyKey: o.idempotencyKey } : {}),
      lines: o.lines,
    });

  const postOk = async (o: Parameters<typeof post>[0]) => {
    const res = await post(o);
    expect(res.status).toBeLessThan(300);
    return res.body.id as string;
  };

  const dr = (accountId: string, amount: string, party?: { partyType: string; partyId: string }) =>
    ({ accountId, debit: amount, credit: "0", ...(party ?? {}) });
  const cr = (accountId: string, amount: string, party?: { partyType: string; partyId: string }) =>
    ({ accountId, debit: "0", credit: amount, ...(party ?? {}) });

  beforeAll(async () => {
    handle = await buildTestApp();
    const pw = "Pwd@2026!";
    await handle.prisma.user.update({
      where: { id: handle.ownerId }, data: { passwordHash: await bcrypt.hash(pw, 10) },
    });
    ownerToken = (
      await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: pw })
    ).body.accessToken;

    bankA = await mkAccount({ nameAr: "بنك الطرفين أ", category: "ASSET", accountType: "CURRENT_ASSET", treasuryType: "BANK" });
    bankB = await mkAccount({ nameAr: "بنك الطرفين ب", category: "ASSET", accountType: "CURRENT_ASSET", treasuryType: "BANK" });
    cashA = await mkAccount({ nameAr: "خزنة الطرفين أ", category: "ASSET", accountType: "CURRENT_ASSET", treasuryType: "CASH" });
    cashEmpty = await mkAccount({ nameAr: "خزنة بلا رصيد", category: "ASSET", accountType: "CURRENT_ASSET", treasuryType: "CASH" });
    expOps = await mkAccount({ nameAr: "مصاريف التشغيل", category: "EXPENSE", accountType: "EXPENSE" });
    expTransport = await mkAccount({ nameAr: "مصاريف النقل", category: "EXPENSE", accountType: "EXPENSE" });
    revenue = await mkAccount({ nameAr: "إيرادات الطرفين", category: "REVENUE", accountType: "REVENUE" });
    equity = await mkAccount({ nameAr: "رأس المال", category: "EQUITY", accountType: "EQUITY" });
    arCtl = await mkAccount({ nameAr: "عملاء الطرفين", category: "ASSET", accountType: "CURRENT_ASSET", systemRole: "AR_CONTROL" });
    apCtl = await mkAccount({ nameAr: "موردو الطرفين", category: "LIABILITY", accountType: "LIABILITY", systemRole: "AP_CONTROL" });
    inventory = await mkAccount({ nameAr: "مخزون الطرفين", category: "ASSET", accountType: "CURRENT_ASSET" });
    vatOut = await mkAccount({ nameAr: "ضريبة مبيعات", category: "LIABILITY", accountType: "LIABILITY" });
    vatIn = await mkAccount({ nameAr: "ضريبة مشتريات", category: "ASSET", accountType: "CURRENT_ASSET" });
    cogs = await mkAccount({ nameAr: "تكلفة مبيعات الطرفين", category: "COST_OF_SALES", accountType: "COST_OF_SALES" });

    custA = (await handle.prisma.customer.create({ data: { code: `CA${uniq()}`, nameAr: "عميل أ" } })).id;
    custB = (await handle.prisma.customer.create({ data: { code: `CB${uniq()}`, nameAr: "عميل ب" } })).id;
    supA = (await handle.prisma.supplier.create({ data: { nameAr: `مورد أ ${uniq()}`, nameEn: `Supplier A ${uniq()}` } })).id;
    supB = (await handle.prisma.supplier.create({ data: { nameAr: `مورد ب ${uniq()}`, nameEn: `Supplier B ${uniq()}` } })).id;

    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 6, status: "OPEN" } });

    // Fund the treasuries so ordinary spends don't trip the negative guard.
    // cashEmpty is deliberately left unfunded for the warning test.
    await postOk({ date: "2026-06-01", lines: [dr(bankA, "100000"), cr(equity, "100000")] });
    await postOk({ date: "2026-06-01", lines: [dr(bankB, "100000"), cr(equity, "100000")] });
    await postOk({ date: "2026-06-01", lines: [dr(cashA, "50000"), cr(equity, "50000")] });
  });

  afterAll(async () => teardownTestApp(handle));

  // ── R1 — Dr Bank / Cr AR[Customer] (customer pays into a bank) ────────────

  it("R1) a customer payment into a bank lands on both sides under one journal, and moves nothing else", async () => {
    const before = {
      bankA: await ending("banks", bankA), banksAll: await ending("banks"), bankB: await ending("banks", bankB),
      custA: await ending("customers", custA), custAll: await ending("customers"),
      custB: await ending("customers", custB), ar: await ending("ar", arCtl),
    };

    const id = await postOk({
      lines: [dr(bankA, "1000"), cr(arCtl, "1000", { partyType: "CUSTOMER", partyId: custA })],
    });

    // Bank side: debit increases the asset balance.
    const bankStmt = await stmt("banks", bankA);
    expect(delta(bankStmt.endingBalance, before.bankA)).toBe("1000.00");
    const bankRow = rowsOf(bankStmt, id)[0];
    expect(bankRow.debit).toBe("1000.00");
    expect(bankRow.credit).toBe("0.00");

    // …and the consolidated category moves with it, while the other bank doesn't.
    expect(delta(await ending("banks"), before.banksAll)).toBe("1000.00");
    expect(await ending("banks", bankB)).toBe(before.bankB);

    // Customer side: credit reduces the receivable.
    const custStmt = await stmt("customers", custA);
    expect(delta(custStmt.endingBalance, before.custA)).toBe("-1000.00");
    const custRow = rowsOf(custStmt, id)[0];
    expect(custRow.credit).toBe("1000.00");
    expect(custRow.partyId).toBe(custA);

    expect(delta(await ending("customers"), before.custAll)).toBe("-1000.00");
    expect(await ending("customers", custB)).toBe(before.custB);
    // The AR control account itself moves too — same lines, account view.
    expect(delta(await ending("ar", arCtl), before.ar)).toBe("-1000.00");

    // Linkage: the two sides are the same journal, not two copies.
    expect(bankRow.journalEntryId).toBe(custRow.journalEntryId);
    expect(bankRow.entryNumber).toBe(custRow.entryNumber);
    expect(bankRow.journalLineId).not.toBe(custRow.journalLineId);
    expect(bankRow.sourceType).toBe(custRow.sourceType);
    expect(bankRow.sourceId).toBe(custRow.sourceId);
  });

  // ── R2 — Dr AR[Customer] / Cr Bank (charge back to the customer) ──────────

  it("R2) the mirror direction moves both sides the opposite way", async () => {
    const before = {
      bankA: await ending("banks", bankA), banksAll: await ending("banks"),
      custA: await ending("customers", custA), custAll: await ending("customers"),
    };

    const id = await postOk({
      lines: [dr(arCtl, "1000", { partyType: "CUSTOMER", partyId: custA }), cr(bankA, "1000")],
    });

    // Customer receivable increases; bank asset decreases.
    expect(delta(await ending("customers", custA), before.custA)).toBe("1000.00");
    expect(delta(await ending("customers"), before.custAll)).toBe("1000.00");
    expect(delta(await ending("banks", bankA), before.bankA)).toBe("-1000.00");
    expect(delta(await ending("banks"), before.banksAll)).toBe("-1000.00");

    expect(rowsOf(await stmt("customers", custA), id)[0].debit).toBe("1000.00");
    expect(rowsOf(await stmt("banks", bankA), id)[0].credit).toBe("1000.00");
  });

  // ── R2 (warning path) ────────────────────────────────────────────────────

  it("R2) an unacknowledged overdraw warns and posts nothing to either side; acknowledging posts both", async () => {
    const before = { cash: await ending("vaults", cashEmpty), exp: await ending("expense", expOps) };

    const warned = await post({ lines: [dr(expOps, "500"), cr(cashEmpty, "500")] });
    expect(warned.status).toBe(409);
    expect(warned.body.code).toBe("treasury_negative_balance_warning");

    // Cancel == never retrying: no journal, so neither side moved.
    expect(await ending("vaults", cashEmpty)).toBe(before.cash);
    expect(await ending("expense", expOps)).toBe(before.exp);

    const id = await postOk({ lines: [dr(expOps, "500"), cr(cashEmpty, "500")], acknowledge: true });

    expect(delta(await ending("vaults", cashEmpty), before.cash)).toBe("-500.00");
    expect(delta(await ending("expense", expOps), before.exp)).toBe("500.00");
    expect(rowsOf(await stmt("vaults", cashEmpty), id)[0].credit).toBe("500.00");
    expect(rowsOf(await stmt("expense", expOps), id)[0].debit).toBe("500.00");
  });

  // ── R3 / R4 — expense funded by treasury and by bank ──────────────────────

  it("R3) an expense paid from cash moves the expense and the treasury under one journal", async () => {
    const before = {
      exp: await ending("expense", expOps), expAll: await ending("expense"),
      cash: await ending("vaults", cashA), vaultsAll: await ending("vaults"),
    };

    const id = await postOk({ lines: [dr(expOps, "1000"), cr(cashA, "1000")] });

    expect(delta(await ending("expense", expOps), before.exp)).toBe("1000.00");
    expect(delta(await ending("expense"), before.expAll)).toBe("1000.00");
    expect(delta(await ending("vaults", cashA), before.cash)).toBe("-1000.00");
    expect(delta(await ending("vaults"), before.vaultsAll)).toBe("-1000.00");

    const expRow = rowsOf(await stmt("expense", expOps), id)[0];
    const cashRow = rowsOf(await stmt("vaults", cashA), id)[0];
    expect(expRow.journalEntryId).toBe(cashRow.journalEntryId);
    expect(expRow.debit).toBe("1000.00");
    expect(cashRow.credit).toBe("1000.00");
  });

  it("R4) a transport expense paid from a bank moves that bank and the category, not the other bank", async () => {
    const before = {
      exp: await ending("expense", expTransport), bankA: await ending("banks", bankA),
      banksAll: await ending("banks"), bankB: await ending("banks", bankB),
    };

    await postOk({ lines: [dr(expTransport, "500"), cr(bankA, "500")] });

    expect(delta(await ending("expense", expTransport), before.exp)).toBe("500.00");
    expect(delta(await ending("banks", bankA), before.bankA)).toBe("-500.00");
    expect(delta(await ending("banks"), before.banksAll)).toBe("-500.00");
    expect(await ending("banks", bankB)).toBe(before.bankB);
  });

  // ── R5 — sales invoice: every account gets its own qualifying line ────────

  it("R5) a confirmed sales invoice reaches AR, revenue, VAT, COGS and inventory, plus the customer aggregate", async () => {
    await handle.prisma.postingProfile.deleteMany({});
    await handle.prisma.postingProfile.create({
      data: {
        effectiveFrom: new Date("2026-01-01"), arAccountId: arCtl, revenueAccountId: revenue,
        vatOutputAccountId: vatOut, cogsAccountId: cogs, inventoryAccountId: inventory,
        createdBy: handle.ownerId,
      },
    });

    const sku = await handle.prisma.productSku.create({
      data: { code: `RS-${uniq()}`, category: "NORMAL", colorNameAr: "ص", colorNameEn: "c" },
    });
    const variant = await handle.prisma.productVariant.create({
      data: {
        skuId: sku.id, sizeMetersPerBoard: "1", defaultSalePricePerMeter: "1000",
        defaultPurchasePricePerMeter: "560", avgCost: "560",
      },
    });
    await handle.prisma.branchInventoryBalance.create({
      data: { branchId: handle.branchId, productVariantId: variant.id, boardsOnHand: "10", metersOnHand: "10" },
    });

    const before = {
      custA: await ending("customers", custA), custAll: await ending("customers"),
      ar: await ending("ar", arCtl), rev: await ending("revenue", revenue),
      vat: await ending("tax", vatOut), cogs: await ending("cogs", cogs),
      custB: await ending("customers", custB),
    };

    const draft = await request(server()).post("/api/v1/sales-invoices").set(H()).send({
      invoiceDate: "2026-07-15", customerId: custA, branchId: handle.branchId, taxRate: "14",
      lines: [{ productVariantId: variant.id, quantity: "4", unitPrice: "1000" }],
    });
    expect(draft.status).toBeLessThan(300);
    const confirmed = await request(server()).post(`/api/v1/sales-invoices/${draft.body.id}/confirm`).set(H()).send({});
    expect(confirmed.status).toBeLessThan(300);

    // 4 × 1000 = 4000 subtotal, 560 VAT, 4560 grand; COGS 4 × 560 = 2240.
    expect(delta(await ending("customers", custA), before.custA)).toBe("4560.00");
    expect(delta(await ending("customers"), before.custAll)).toBe("4560.00");
    expect(delta(await ending("ar", arCtl), before.ar)).toBe("4560.00");
    expect(delta(await ending("revenue", revenue), before.rev)).toBe("4000.00");
    expect(delta(await ending("tax", vatOut), before.vat)).toBe("560.00");
    expect(delta(await ending("cogs", cogs), before.cogs)).toBe("2240.00");
    // A different customer is untouched by another customer's invoice.
    expect(await ending("customers", custB)).toBe(before.custB);

    // Each side carries the invoice as its source — one document, many accounts.
    const inv = await handle.prisma.salesInvoice.findUnique({ where: { id: draft.body.id } });
    const arRow = (await stmt("customers", custA)).rows.find((r) => r.journalEntryId === inv!.journalEntryId)!;
    const revRow = (await stmt("revenue", revenue)).rows.find((r) => r.journalEntryId === inv!.journalEntryId)!;
    expect(arRow.sourceType).toBe("SALES_INVOICE");
    expect(revRow.sourceType).toBe("SALES_INVOICE");
    expect(arRow.sourceId).toBe(revRow.sourceId);
    expect(arRow.partyId).toBe(custA);
  });

  // ── R6 — purchase invoice ────────────────────────────────────────────────

  it("R6) a confirmed purchase invoice reaches inventory, VAT and AP, plus only that supplier's aggregate", async () => {
    await handle.prisma.postingProfile.deleteMany({});
    await handle.prisma.postingProfile.create({
      data: {
        effectiveFrom: new Date("2026-01-01"), inventoryAccountId: inventory, apAccountId: apCtl,
        vatInputAccountId: vatIn, createdBy: handle.ownerId,
      },
    });

    const sku = await handle.prisma.productSku.create({
      data: { code: `RP-${uniq()}`, category: "NORMAL", colorNameAr: "ص", colorNameEn: "c" },
    });
    const variant = await handle.prisma.productVariant.create({
      data: { skuId: sku.id, sizeMetersPerBoard: "1", defaultSalePricePerMeter: "600", defaultPurchasePricePerMeter: "560" },
    });

    const before = {
      supA: await ending("suppliers", supA), supAll: await ending("suppliers"),
      supB: await ending("suppliers", supB), ap: await ending("ap", apCtl),
      inv: await ending("inventory", inventory), vat: await ending("tax", vatIn),
    };

    const draft = await request(server()).post("/api/v1/purchase-invoices").set(H()).send({
      invoiceDate: "2026-07-15", supplierId: supA, branchId: handle.branchId,
      lines: [{ productVariantId: variant.id, boardsQuantity: "4", lengthM: "1", unitPrice: "560", taxRate: "14" }],
    });
    expect(draft.status).toBeLessThan(300);
    const confirmed = await request(server()).post(`/api/v1/purchase-invoices/${draft.body.id}/confirm`).set(H()).send({});
    expect(confirmed.status).toBeLessThan(300);

    // 4 × 560 = 2240 subtotal, 313.60 VAT, 2553.60 payable.
    expect(delta(await ending("suppliers", supA), before.supA)).toBe("2553.60");
    expect(delta(await ending("suppliers"), before.supAll)).toBe("2553.60");
    expect(delta(await ending("ap", apCtl), before.ap)).toBe("2553.60");
    expect(delta(await ending("inventory", inventory), before.inv)).toBe("2240.00");
    expect(delta(await ending("tax", vatIn), before.vat)).toBe("313.60");
    expect(await ending("suppliers", supB)).toBe(before.supB);

    const pi = await handle.prisma.purchaseInvoice.findUnique({ where: { id: draft.body.id } });
    const apRow = (await stmt("suppliers", supA)).rows.find((r) => r.journalEntryId === pi!.journalEntryId)!;
    const invRow = (await stmt("inventory", inventory)).rows.find((r) => r.journalEntryId === pi!.journalEntryId)!;
    expect(apRow.sourceType).toBe("PURCHASE_INVOICE");
    expect(apRow.sourceId).toBe(invRow.sourceId);
    expect(apRow.partyId).toBe(supA);
  });

  // ── R7 — supplier payment ────────────────────────────────────────────────

  it("R7) paying a supplier from a bank moves the supplier and the bank in one journal", async () => {
    const before = {
      supA: await ending("suppliers", supA), supAll: await ending("suppliers"), ap: await ending("ap", apCtl),
      bankA: await ending("banks", bankA), banksAll: await ending("banks"),
    };

    const id = await postOk({
      lines: [dr(apCtl, "1000", { partyType: "SUPPLIER", partyId: supA }), cr(bankA, "1000")],
    });

    // AP is credit-normal: a debit reduces the payable.
    expect(delta(await ending("suppliers", supA), before.supA)).toBe("-1000.00");
    expect(delta(await ending("suppliers"), before.supAll)).toBe("-1000.00");
    expect(delta(await ending("ap", apCtl), before.ap)).toBe("-1000.00");
    expect(delta(await ending("banks", bankA), before.bankA)).toBe("-1000.00");
    expect(delta(await ending("banks"), before.banksAll)).toBe("-1000.00");

    const supRow = rowsOf(await stmt("suppliers", supA), id)[0];
    const bankRow = rowsOf(await stmt("banks", bankA), id)[0];
    expect(supRow.journalEntryId).toBe(bankRow.journalEntryId);
  });

  // ── R8 — reversal ────────────────────────────────────────────────────────

  it("R8) a reversal reaches every original account, preserves parties, and nets both sides back", async () => {
    const before = { bankA: await ending("banks", bankA), custA: await ending("customers", custA) };

    const id = await postOk({
      lines: [dr(bankA, "700"), cr(arCtl, "700", { partyType: "CUSTOMER", partyId: custA })],
    });
    const rev = await request(server()).post(`/api/v1/journal/${id}/reverse`).set(H()).send({ reason: "إلغاء اختبار" });
    expect(rev.status).toBeLessThan(300);
    const reversalId = rev.body.journalEntryId as string;

    // Both sides return to where they started.
    expect(await ending("banks", bankA)).toBe(before.bankA);
    expect(await ending("customers", custA)).toBe(before.custA);

    // Original and reversal both remain visible — nothing is deleted.
    const bankStmt = await stmt("banks", bankA);
    expect(rowsOf(bankStmt, id)[0].debit).toBe("700.00");
    const bankReversal = rowsOf(bankStmt, reversalId)[0];
    expect(bankReversal.credit).toBe("700.00");
    expect(bankReversal.isReversal).toBe(true);

    // The reversal reaches the party side too, with the party preserved.
    const custStmt = await stmt("customers", custA);
    const custReversal = rowsOf(custStmt, reversalId)[0];
    expect(custReversal.debit).toBe("700.00");
    expect(custReversal.partyType).toBe("CUSTOMER");
    expect(custReversal.partyId).toBe(custA);
  });

  // ── R9 — idempotency ─────────────────────────────────────────────────────

  it("R9) retrying with the same idempotency key adds no duplicate line to either side", async () => {
    const key = `R9-${uniq()}-${Date.now()}`;
    const lines = [dr(bankA, "300"), cr(arCtl, "300", { partyType: "CUSTOMER", partyId: custA })];

    const first = await postOk({ lines, idempotencyKey: key });
    const afterFirst = { bankA: await ending("banks", bankA), custA: await ending("customers", custA) };

    const retry = await post({ lines, idempotencyKey: key });
    expect(retry.status).toBeLessThan(300);
    expect(retry.body.id).toBe(first);

    // Balances unchanged, and exactly one row per side.
    expect(await ending("banks", bankA)).toBe(afterFirst.bankA);
    expect(await ending("customers", custA)).toBe(afterFirst.custA);
    expect(rowsOf(await stmt("banks", bankA), first)).toHaveLength(1);
    expect(rowsOf(await stmt("customers", custA), first)).toHaveLength(1);
  });

  // ── R10 — filters must not hide one side ─────────────────────────────────

  it("R10) a date window keeps both sides together and pushes earlier lines into opening", async () => {
    const id = await postOk({
      date: "2026-06-15",
      lines: [dr(bankB, "800"), cr(arCtl, "800", { partyType: "CUSTOMER", partyId: custB })],
    });

    // In-window: both sides carry the row.
    const inWindow = "&from=2026-06-01&to=2026-06-30";
    expect(rowsOf(await stmt("banks", bankB, inWindow), id)).toHaveLength(1);
    expect(rowsOf(await stmt("customers", custB, inWindow), id)).toHaveLength(1);

    // Out of window: neither side shows the row, and both fold it into opening.
    const later = "&from=2026-07-01&to=2026-07-31";
    const bankLater = await stmt("banks", bankB, later);
    const custLater = await stmt("customers", custB, later);
    expect(rowsOf(bankLater, id)).toHaveLength(0);
    expect(rowsOf(custLater, id)).toHaveLength(0);
    expect(new Decimal(bankLater.openingBalance).gte(800)).toBe(true);
    expect(new Decimal(custLater.openingBalance).lte(-800)).toBe(true);
  });

  // ── R11 / R12 — a rejected journal creates no line at all ────────────────

  it("R11) an unbalanced journal is rejected atomically — no account receives a line", async () => {
    const before = { bankA: await ending("banks", bankA), exp: await ending("expense", expOps) };

    const res = await post({ lines: [dr(bankA, "100"), cr(expOps, "90")] });
    expect(res.status).toBeGreaterThanOrEqual(400);

    expect(await ending("banks", bankA)).toBe(before.bankA);
    expect(await ending("expense", expOps)).toBe(before.exp);
  });

  it("R12) an AR line without a party is rejected, and the valid opposite side is never created", async () => {
    const before = { bankA: await ending("banks", bankA), ar: await ending("ar", arCtl) };

    // Missing party on an AR_CONTROL line — the whole journal must fail.
    const res = await post({ lines: [dr(bankA, "100"), cr(arCtl, "100")] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await ending("banks", bankA)).toBe(before.bankA);
    expect(await ending("ar", arCtl)).toBe(before.ar);

    // A party that doesn't exist is rejected the same way.
    const bogus = await post({
      lines: [dr(bankA, "100"), cr(arCtl, "100", { partyType: "CUSTOMER", partyId: "00000000-0000-0000-0000-000000000000" })],
    });
    expect(bogus.status).toBeGreaterThanOrEqual(400);
    expect(await ending("banks", bankA)).toBe(before.bankA);
  });

  // ── R13 — arbitrary active leaf accounts ─────────────────────────────────

  it("R13) any active leaf account works as a side, including rent and equity", async () => {
    const rent = await mkAccount({ nameAr: "مصروف الإيجار", category: "EXPENSE", accountType: "EXPENSE" });

    const id = await postOk({ lines: [dr(rent, "250"), cr(cashA, "250")] });
    expect(rowsOf(await stmt("expense", rent), id)[0].debit).toBe("250.00");
    expect(rowsOf(await stmt("vaults", cashA), id)[0].credit).toBe("250.00");

    // The equity funding entries from setup are readable on their own side too.
    expect(new Decimal(await ending("equity", equity)).gt(0)).toBe(true);
  });

  // ── R14 — canonical GL only: no legacy writes, no double counting ─────────

  it("R14) posting writes no legacy balance row, and consolidated totals equal the raw journal_lines", async () => {
    const legacyBefore = {
      customerTransaction: await handle.prisma.customerTransaction.count(),
      payment: await handle.prisma.payment.count(),
      orderCollection: await handle.prisma.orderCollection.count(),
      paymentAccount: await handle.prisma.paymentAccount.count(),
      factoryLedger: await handle.prisma.factoryLedgerEntry.count(),
    };

    await postOk({ lines: [dr(bankA, "150"), cr(arCtl, "150", { partyType: "CUSTOMER", partyId: custA })] });

    // A GL posting must not dual-write into any legacy ledger.
    expect(await handle.prisma.customerTransaction.count()).toBe(legacyBefore.customerTransaction);
    expect(await handle.prisma.payment.count()).toBe(legacyBefore.payment);
    expect(await handle.prisma.orderCollection.count()).toBe(legacyBefore.orderCollection);
    expect(await handle.prisma.paymentAccount.count()).toBe(legacyBefore.paymentAccount);
    expect(await handle.prisma.factoryLedgerEntry.count()).toBe(legacyBefore.factoryLedger);

    // Consolidated banks == the sum of the underlying journal_lines, computed
    // independently here. Equal means the reader neither drops nor double-counts.
    const banks = await stmt("banks");
    const bankIds = banks.breakdown.map((b) => b.entityId);
    const raw = await handle.prisma.journalLine.groupBy({
      by: ["accountId"], where: { accountId: { in: bankIds } }, _sum: { debit: true, credit: true },
    });
    const expected = raw.reduce(
      (acc, r) => acc.add(new Decimal(r._sum.debit?.toString() ?? "0")).sub(new Decimal(r._sum.credit?.toString() ?? "0")),
      new Decimal(0),
    );
    expect(banks.endingBalance).toBe(expected.toFixed(2));

    // The specific statements must sum to the consolidated one — no double count.
    let perAccount = new Decimal(0);
    for (const id of bankIds) perAccount = perAccount.add(await ending("banks", id));
    expect(perAccount.toFixed(2)).toBe(banks.endingBalance);
  });

  it("R14) reading a statement creates no database movement", async () => {
    const before = await handle.prisma.journalLine.count();
    await stmt("banks");
    await stmt("customers", custA);
    await stmt("all");
    expect(await handle.prisma.journalLine.count()).toBe(before);
  });
});
