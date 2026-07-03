import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { CreatePaymentSchema, CreateSupplierPaymentSchema, StatementQuerySchema, type CreatePayment, type CreateSupplierPayment, type StatementQuery } from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

@Controller()
export class PaymentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Payment Accounts ────────────────────────────────────────────────

  @Get("payment-accounts")
  @Roles("OWNER", "ACCOUNTANT")
  listAccounts() {
    return this.prisma.paymentAccount.findMany({
      where: { active: true },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    });
  }

  // ── Payments ────────────────────────────────────────────────────────

  @Get("payments")
  @Roles("OWNER", "ACCOUNTANT")
  async list(
    @Query("entityType") entityType?: string,
    @Query("entityId") entityId?: string,
    @Query("accountId") accountId?: string,
  ) {
    const where: any = {};
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = entityId;
    if (accountId) where.paymentAccountId = accountId;

    const rows = await this.prisma.payment.findMany({
      where,
      orderBy: { paymentDate: "desc" },
      include: { paymentAccount: true, creator: { select: { id: true, name: true } } },
    });

    return rows.map((p) => ({
      id: p.id,
      entityType: p.entityType,
      entityId: p.entityId,
      amount: p.amount.toString(),
      paymentDate: p.paymentDate,
      referenceNumber: p.referenceNumber ?? null,
      notes: p.notes ?? null,
      paymentAccountId: p.paymentAccountId,
      paymentAccountName: p.paymentAccount.name,
      paymentAccountType: p.paymentAccount.type,
      createdByName: p.creator.name,
      createdAt: p.createdAt,
    }));
  }

  @Post("payments")
  @Roles("OWNER", "ACCOUNTANT")
  async create(
    @Body(new ZodValidationPipe(CreatePaymentSchema)) body: CreatePayment,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const account = await this.prisma.paymentAccount.findUnique({ where: { id: body.paymentAccountId } });
    if (!account || !account.active) throw new NotFoundError({ paymentAccountId: body.paymentAccountId });

    return this.prisma.runInTransaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          entityType: body.entityType,
          entityId: body.entityId,
          paymentAccountId: body.paymentAccountId,
          amount: body.amount,
          paymentDate: new Date(body.paymentDate),
          referenceNumber: body.referenceNumber ?? null,
          notes: body.notes ?? null,
          createdBy: user.id,
        },
        include: { paymentAccount: true, creator: { select: { id: true, name: true } } },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "payment",
        entityId: payment.id,
        afterSnapshot: { entityType: body.entityType, entityId: body.entityId, amount: body.amount },
        summaryAr: `${user.name} سجّل دفعة ${body.amount} ج.م عبر ${account.name}`,
        summaryEn: `${user.name} recorded payment ${body.amount} EGP via ${account.name}`,
      });

      return {
        id: payment.id,
        entityType: payment.entityType,
        entityId: payment.entityId,
        amount: payment.amount.toString(),
        paymentDate: payment.paymentDate,
        referenceNumber: payment.referenceNumber ?? null,
        notes: payment.notes ?? null,
        paymentAccountId: payment.paymentAccountId,
        paymentAccountName: payment.paymentAccount.name,
        createdByName: payment.creator.name,
        createdAt: payment.createdAt,
      };
    });
  }

  @Delete("payments/:id")
  @Roles("OWNER")
  @HttpCode(204)
  async remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    const payment = await this.prisma.payment.findUnique({ where: { id } });
    if (!payment) throw new NotFoundError({ id });

    return this.prisma.runInTransaction(async (tx) => {
      await tx.payment.delete({ where: { id } });
      await this.audit.write({
        tx, actorId: user.id, action: "DELETE", entityType: "payment", entityId: id,
        beforeSnapshot: { amount: payment.amount.toString(), entityType: payment.entityType },
        summaryAr: `${user.name} حذف دفعة بمبلغ ${payment.amount} ج.م`,
        summaryEn: `${user.name} deleted payment of ${payment.amount} EGP`,
      });
    });
  }

  // ── Supplier Payment (GL-based) ─────────────────────────────────────

  @Post("supplier-payments")
  @Roles("OWNER", "ACCOUNTANT")
  async createSupplierPayment(
    @Body(new ZodValidationPipe(CreateSupplierPaymentSchema)) body: CreateSupplierPayment,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const [supplier, apAccount, bankAccount] = await Promise.all([
      this.prisma.supplier.findUnique({ where: { id: body.supplierId } }),
      this.prisma.account.findUnique({ where: { id: body.apAccountId } }),
      this.prisma.account.findUnique({ where: { id: body.bankAccountId } }),
    ]);
    if (!supplier) throw new NotFoundError({ supplierId: body.supplierId });
    if (!apAccount) throw new NotFoundError({ apAccountId: body.apAccountId });
    if (!bankAccount) throw new NotFoundError({ bankAccountId: body.bankAccountId });

    return this.prisma.runInTransaction(async (tx) => {
      const counter = await tx.journalEntry.count();
      const entryNumber = BigInt(counter + 1);

      const description = body.notes
        ? `سداد للمورد ${supplier.nameAr} — ${body.notes}`
        : `سداد للمورد ${supplier.nameAr}`;

      const entry = await tx.journalEntry.create({
        data: {
          entryNumber,
          entryType: "PAYMENT",
          entryDate: new Date(body.paymentDate),
          description,
          reference: body.reference ?? null,
          referenceType: "supplier_payment",
          referenceId: body.supplierId,
          createdBy: user.id,
          lines: {
            create: [
              { accountId: body.apAccountId,   debit: body.amount, credit: "0", note: `سداد للمورد ${supplier.nameAr}` },
              { accountId: body.bankAccountId, debit: "0", credit: body.amount, note: apAccount.nameAr },
            ],
          },
        },
        include: { lines: true },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "supplier_payment",
        entityId: entry.id,
        afterSnapshot: { supplierId: body.supplierId, amount: body.amount, apAccountId: body.apAccountId, bankAccountId: body.bankAccountId },
        summaryAr: `${user.name} سجّل دفعة ${body.amount} ج.م للمورد ${supplier.nameAr}`,
        summaryEn: `${user.name} recorded supplier payment ${body.amount} EGP to ${supplier.nameEn}`,
      });

      return { journalEntryId: entry.id, entryNumber: Number(entry.entryNumber) };
    });
  }

  // ── Statements ──────────────────────────────────────────────────────

  @Get("statements/supplier/:id")
  @Roles("OWNER", "ACCOUNTANT")
  async supplierStatement(
    @Param("id") supplierId: string,
    @Query(new ZodValidationPipe(StatementQuerySchema)) query: StatementQuery,
  ) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) throw new NotFoundError({ supplierId });

    const dateFilter: any = {};
    if (query.from) dateFilter.gte = new Date(query.from);
    if (query.to) dateFilter.lte = new Date(query.to);

    const [invoices, payments, journalPayments] = await Promise.all([
      this.prisma.purchaseInvoice.findMany({
        where: { supplierId, status: "CONFIRMED", ...(Object.keys(dateFilter).length ? { invoiceDate: dateFilter } : {}) },
        orderBy: { invoiceDate: "asc" },
      }),
      this.prisma.payment.findMany({
        where: { entityType: "SUPPLIER", entityId: supplierId, ...(Object.keys(dateFilter).length ? { paymentDate: dateFilter } : {}) },
        include: { paymentAccount: true },
        orderBy: { paymentDate: "asc" },
      }),
      this.prisma.journalEntry.findMany({
        where: {
          referenceType: "supplier_payment",
          referenceId: supplierId,
          ...(Object.keys(dateFilter).length ? { entryDate: dateFilter } : {}),
        },
        include: { lines: { include: { account: { select: { nameAr: true } } } } },
        orderBy: { entryDate: "asc" },
      }),
    ]);

    // In a supplier statement: invoices go to Credit (دائن = you owe the supplier),
    // payments go to Debit (مدين = you paid back). Balance = credit - debit = amount still owed.
    const entries: any[] = [
      ...invoices.map((inv) => ({
        date: inv.invoiceDate,
        type: "invoice",
        reference: inv.invoiceNumber,
        description: "فاتورة مشتريات",
        debit: "0.00",
        credit: inv.grandTotal.toString(),
      })),
      ...payments.map((p) => ({
        id: p.id,
        date: p.paymentDate,
        type: "payment",
        reference: p.referenceNumber ?? "—",
        description: `سداد — ${p.paymentAccount.name}${p.notes ? ` (${p.notes})` : ""}`,
        debit: p.amount.toString(),
        credit: "0.00",
      })),
      ...journalPayments.map((je) => {
        // The AP line (debit side) is the payment amount
        const apLine = je.lines.find((l) => parseFloat(l.debit.toString()) > 0);
        const bankLine = je.lines.find((l) => parseFloat(l.credit.toString()) > 0);
        const amount = apLine ? apLine.debit.toString() : "0.00";
        const bankName = bankLine?.account?.nameAr ?? "";
        return {
          id: je.id,
          date: je.entryDate,
          type: "payment",
          reference: je.reference ?? `قيد #${Number(je.entryNumber)}`,
          description: `سداد — ${bankName}`,
          debit: amount,
          credit: "0.00",
          journalEntryId: je.id,
        };
      }),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    let balance = 0;
    const entriesWithBalance = entries.map((e) => {
      balance += parseFloat(e.credit) - parseFloat(e.debit);
      return { ...e, balance: balance.toFixed(2) };
    });

    const totalDebit = entries.reduce((s, e) => s + parseFloat(e.debit), 0);
    const totalCredit = entries.reduce((s, e) => s + parseFloat(e.credit), 0);

    return {
      entity: { id: supplier.id, nameAr: supplier.nameAr, nameEn: supplier.nameEn },
      entries: entriesWithBalance,
      totalDebit: totalDebit.toFixed(2),
      totalCredit: totalCredit.toFixed(2),
      closingBalance: (totalCredit - totalDebit).toFixed(2),
    };
  }

  @Get("statements/account/:id")
  @Roles("OWNER", "ACCOUNTANT")
  async accountStatement(
    @Param("id") accountId: string,
    @Query(new ZodValidationPipe(StatementQuerySchema)) query: StatementQuery,
  ) {
    const dateFilter: any = {};
    if (query.from) dateFilter.gte = new Date(query.from);
    if (query.to) dateFilter.lte = new Date(query.to);

    // ── Payment account (bank / cash) ─────────────────────────────────────
    const paymentAccount = await this.prisma.paymentAccount.findUnique({ where: { id: accountId } });

    if (paymentAccount) {
      const payments = await this.prisma.payment.findMany({
        where: { paymentAccountId: accountId, ...(Object.keys(dateFilter).length ? { paymentDate: dateFilter } : {}) },
        orderBy: { paymentDate: "asc" },
      });

      const collections = await this.prisma.orderCollection.findMany({
        where: {
          paidToAccount: paymentAccount.name,
          ...(Object.keys(dateFilter).length ? { collectedAt: dateFilter } : {}),
        },
        include: { order: { select: { id: true, customerName: true } } },
        orderBy: { collectedAt: "asc" },
      });

      const entries: any[] = [
        ...payments.map((p) => ({
          date: p.paymentDate,
          type: "payment_out",
          reference: p.referenceNumber ?? "—",
          description: `دفعة لمورد${p.notes ? ` — ${p.notes}` : ""}`,
          debit: p.amount.toString(),
          credit: "0.00",
        })),
        ...collections.map((c) => ({
          date: c.collectedAt,
          type: "collection_in",
          reference: c.id.slice(0, 8),
          description: `تحصيل من ${c.order.customerName}`,
          debit: "0.00",
          credit: c.amount.toString(),
        })),
      ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      let balance = 0;
      const entriesWithBalance = entries.map((e) => {
        balance += parseFloat(e.credit) - parseFloat(e.debit);
        return { ...e, balance: balance.toFixed(2) };
      });

      const totalIn = entries.reduce((s, e) => s + parseFloat(e.credit), 0);
      const totalOut = entries.reduce((s, e) => s + parseFloat(e.debit), 0);

      return {
        entity: { id: paymentAccount.id, name: paymentAccount.name, type: paymentAccount.type },
        entries: entriesWithBalance,
        totalIn: totalIn.toFixed(2),
        totalOut: totalOut.toFixed(2),
        closingBalance: (totalIn - totalOut).toFixed(2),
      };
    }

    // ── General ledger account (AR, Revenue, Tax, COGS, …) ────────────────
    const glAccount = await this.prisma.account.findUnique({ where: { id: accountId } });
    if (!glAccount) throw new NotFoundError({ accountId });

    const lines = await this.prisma.journalLine.findMany({
      where: {
        accountId,
        ...(Object.keys(dateFilter).length ? { journalEntry: { entryDate: dateFilter } } : {}),
      },
      include: {
        journalEntry: {
          select: { id: true, entryNumber: true, entryDate: true, reference: true, description: true, referenceType: true, referenceId: true },
        },
      },
      orderBy: [{ journalEntry: { entryDate: "asc" } }, { id: "asc" }],
    });

    let glBalance = 0;
    const glEntries = lines.map((l) => {
      const dr = parseFloat(l.debit.toString());
      const cr = parseFloat(l.credit.toString());
      glBalance += dr - cr;
      return {
        id: l.id,
        date: l.journalEntry.entryDate,
        type: "journal",
        reference: `قيد #${l.journalEntry.entryNumber}${l.journalEntry.reference ? ` — ${l.journalEntry.reference}` : ""}`,
        description: l.note ?? l.journalEntry.description,
        debit: l.debit.toString(),
        credit: l.credit.toString(),
        balance: glBalance.toFixed(2),
        referenceType: l.journalEntry.referenceType ?? undefined,
        referenceId:   l.journalEntry.referenceId   ?? undefined,
        journalEntryId: l.journalEntry.id,
      };
    });

    const totalIn = lines.reduce((s, l) => s + parseFloat(l.debit.toString()), 0);
    const totalOut = lines.reduce((s, l) => s + parseFloat(l.credit.toString()), 0);

    return {
      entity: { id: glAccount.id, name: glAccount.nameAr, code: glAccount.code, type: "gl_account" },
      entries: glEntries,
      totalIn: totalIn.toFixed(2),
      totalOut: totalOut.toFixed(2),
      closingBalance: glBalance.toFixed(2),
    };
  }

  @Get("inventory/balance")
  @Roles("OWNER", "ACCOUNTANT")
  async inventoryBalance(@Query("branchId") branchId?: string) {
    const where: any = { metersOnHand: { gt: 0 } };
    if (branchId) where.branchId = branchId;

    const rows = await this.prisma.branchInventoryBalance.findMany({
      where,
      include: {
        branch: { select: { id: true, nameAr: true, nameEn: true } },
        productVariant: { include: { sku: { select: { code: true, colorNameAr: true, colorNameEn: true } } } },
      },
      orderBy: [{ branchId: "asc" }],
    });

    return rows.map((r) => ({
      branchId: r.branchId,
      branchNameAr: r.branch.nameAr,
      branchNameEn: r.branch.nameEn,
      productVariantId: r.productVariantId,
      skuCode: r.productVariant.sku.code,
      skuNameAr: r.productVariant.sku.colorNameAr,
      skuNameEn: r.productVariant.sku.colorNameEn,
      sizeMetersPerBoard: r.productVariant.sizeMetersPerBoard.toString(),
      boardsOnHand: r.boardsOnHand.toString(),
      metersOnHand: r.metersOnHand.toString(),
    }));
  }
}
