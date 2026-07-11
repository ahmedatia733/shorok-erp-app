/**
 * Phase 3C (T035) — expenses posting through the PostingEngine.
 * Transitional: posts when accounts resolve (category/body), else stays
 * record-only (journalEntryId null) for backward compatibility. Covers
 * legacy record-only, paid non-taxable, taxable (input VAT), on-credit AP
 * (supplier party), OWNER negative correction (record-only), period guard,
 * delete of a posted expense, and missing-account typed errors.
 */
import { Decimal } from "decimal.js";
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("expense posting (Phase 3C)", () => {
  let handle: TestApp;
  let ownerToken: string;
  let expenseAccountId: string;
  let cashAccountId: string;
  let vatInputAccountId: string;
  let apAccountId: string;
  let supplierId: string;
  let categoryId: string;

  const auth = () => ({ Authorization: `Bearer ${ownerToken}` });
  const server = () => handle.app.getHttpServer();

  beforeAll(async () => {
    handle = await buildTestApp();
    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    ownerToken = (
      await request(server()).post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" })
    ).body.accessToken;

    const uniq = Date.now().toString().slice(-6);
    const mk = (
      code: string,
      nameAr: string,
      category: "ASSET" | "LIABILITY" | "EXPENSE",
      accountType: "CURRENT_ASSET" | "LIABILITY" | "EXPENSE",
      systemRole?: "AP_CONTROL" | "VAT_INPUT",
    ) =>
      handle.prisma.account.create({
        data: {
          code,
          nameAr,
          nameEn: nameAr,
          category,
          accountType,
          isLeaf: true,
          active: true,
          ...(systemRole ? { systemRole: systemRole as never } : {}),
        },
      });
    expenseAccountId = (await mk(`EXP${uniq}`, "مصروفات", "EXPENSE", "EXPENSE")).id;
    cashAccountId = (await mk(`CASH${uniq}`, "الخزينة", "ASSET", "CURRENT_ASSET")).id;
    vatInputAccountId = (await mk(`VATIN${uniq}`, "ضريبة مدخلات", "ASSET", "CURRENT_ASSET", "VAT_INPUT")).id;
    apAccountId = (await mk(`AP${uniq}`, "الموردون", "LIABILITY", "LIABILITY", "AP_CONTROL")).id;

    supplierId = (
      await handle.prisma.supplier.create({ data: { nameAr: "مورد مصروف", nameEn: "Expense Supplier" } })
    ).id;
    categoryId = (
      await handle.prisma.expenseCategory.create({
        data: { nameAr: "كهرباء", nameEn: "Electricity", accountId: expenseAccountId, taxableDefault: false },
      })
    ).id;

    await handle.prisma.financialPeriod.create({ data: { year: 2026, month: 7, status: "OPEN" } });
  });

  afterAll(async () => teardownTestApp(handle));

  const post = (body: Record<string, unknown>) =>
    request(server()).post("/api/v1/expenses").set(auth()).send({
      branchId: handle.branchId,
      expenseDate: "2026-07-15",
      description: "TEST expense",
      paidFromAccount: "cash",
      ...body,
    });

  const sum = (lines: Array<{ debit: unknown; credit: unknown }>, k: "debit" | "credit") =>
    lines.reduce((a, l) => a.add((l[k] as { toString(): string }).toString()), new Decimal(0));

  it("legacy record-only: no accounts, no category → 201, journalEntryId null", async () => {
    const res = await post({ amount: "150.00" });
    expect(res.status).toBe(201);
    expect(res.body.journalEntryId).toBeNull();
    expect(
      await handle.prisma.journalEntry.count({ where: { sourceType: "EXPENSE", sourceId: res.body.id } }),
    ).toBe(0);
  });

  it("paid non-taxable: Dr Expense / Cr Cash, balanced, sourceType EXPENSE", async () => {
    const res = await post({ amount: "500.00", glAccountId: expenseAccountId, paymentGlAccountId: cashAccountId });
    expect(res.status).toBe(201);
    expect(res.body.journalEntryId).not.toBeNull();
    const je = await handle.prisma.journalEntry.findUnique({ where: { id: res.body.journalEntryId }, include: { lines: true } });
    expect(je!.sourceType).toBe("EXPENSE");
    const dr = je!.lines.find((l) => l.accountId === expenseAccountId)!;
    const cr = je!.lines.find((l) => l.accountId === cashAccountId)!;
    expect(new Decimal(dr.debit.toString()).toString()).toBe("500");
    expect(new Decimal(cr.credit.toString()).toString()).toBe("500");
    expect(sum(je!.lines, "debit").eq(sum(je!.lines, "credit"))).toBe(true);
  });

  it("taxable paid: Dr Expense / Dr VAT-Input / Cr Cash total, taxRateAtPosting stamped", async () => {
    const res = await post({
      amount: "500.00",
      glAccountId: expenseAccountId,
      paymentGlAccountId: cashAccountId,
      taxable: true,
      taxRate: "14",
      vatInputAccountId,
    });
    expect(res.status).toBe(201);
    const je = await handle.prisma.journalEntry.findUnique({ where: { id: res.body.journalEntryId }, include: { lines: true } });
    const exp = je!.lines.find((l) => l.accountId === expenseAccountId)!;
    const vat = je!.lines.find((l) => l.accountId === vatInputAccountId)!;
    const cash = je!.lines.find((l) => l.accountId === cashAccountId)!;
    expect(new Decimal(exp.debit.toString()).toString()).toBe("500");
    expect(new Decimal(vat.debit.toString()).toString()).toBe("70");
    expect(new Decimal(cash.credit.toString()).toString()).toBe("570");
    expect(sum(je!.lines, "debit").eq(sum(je!.lines, "credit"))).toBe(true);
    const exp2 = await handle.prisma.expense.findUnique({ where: { id: res.body.id } });
    expect(new Decimal(exp2!.taxRateAtPosting!.toString()).toString()).toBe("14");
    expect(exp2!.taxable).toBe(true);
  });

  it("on-credit supplier: category expense account, Cr AP with SUPPLIER party", async () => {
    const res = await post({ amount: "500.00", expenseCategoryId: categoryId, supplierId, apAccountId });
    expect(res.status).toBe(201);
    const je = await handle.prisma.journalEntry.findUnique({ where: { id: res.body.journalEntryId }, include: { lines: true } });
    const exp = je!.lines.find((l) => l.accountId === expenseAccountId)!;
    const ap = je!.lines.find((l) => l.accountId === apAccountId)!;
    expect(new Decimal(exp.debit.toString()).toString()).toBe("500");
    expect(new Decimal(ap.credit.toString()).toString()).toBe("500");
    expect(ap.partyType).toBe("SUPPLIER");
    expect(ap.partyId).toBe(supplierId);
    expect(sum(je!.lines, "debit").eq(sum(je!.lines, "credit"))).toBe(true);
  });

  it("negative correction (OWNER): record-only, no PostingEngine call", async () => {
    const res = await post({
      amount: "-50.00",
      glAccountId: expenseAccountId,
      paymentGlAccountId: cashAccountId,
    });
    expect(res.status).toBe(201);
    expect(res.body.journalEntryId).toBeNull();
    expect(
      await handle.prisma.journalEntry.count({ where: { sourceType: "EXPENSE", sourceId: res.body.id } }),
    ).toBe(0);
  });

  it("period not open: accounts present but date has no OPEN period → 409, nothing posted", async () => {
    const res = await post({
      expenseDate: "2026-03-10",
      amount: "100.00",
      glAccountId: expenseAccountId,
      paymentGlAccountId: cashAccountId,
    });
    expect(res.status).toBe(409);
    expect(res.body.details?.reason === "period_not_open" || res.body.details?.reason === "period_closed").toBe(true);
    expect(await handle.prisma.expense.count({ where: { expenseDate: new Date("2026-03-10") } })).toBe(0);
  });

  it("delete posted expense: clears FK then deletes journal entry, no P2003", async () => {
    const created = await post({ amount: "300.00", glAccountId: expenseAccountId, paymentGlAccountId: cashAccountId });
    expect(created.status).toBe(201);
    const jeId = created.body.journalEntryId as string;
    expect(jeId).not.toBeNull();

    const del = await request(server()).delete(`/api/v1/expenses/${created.body.id}`).set(auth());
    expect(del.status).toBe(204);
    expect(await handle.prisma.expense.findUnique({ where: { id: created.body.id } })).toBeNull();
    expect(await handle.prisma.journalEntry.findUnique({ where: { id: jeId } })).toBeNull();
  });

  it("typed error: taxable but no VAT account → vat_input_account_required", async () => {
    const res = await post({
      amount: "500.00",
      glAccountId: expenseAccountId,
      paymentGlAccountId: cashAccountId,
      taxable: true,
      taxRate: "14",
      // no vatInputAccountId, no profile/taxProfile → unresolved
    });
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("vat_input_account_required");
  });

  it("typed error: supplierId but no AP account → ap_account_required", async () => {
    const res = await post({ amount: "500.00", glAccountId: expenseAccountId, supplierId });
    expect(res.status).toBe(409);
    expect(res.body.details?.reason).toBe("ap_account_required");
  });
});
