import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { CreatePaymentSchema, CreateSupplierPaymentSchema, StatementQuerySchema, type CreatePayment, type CreateSupplierPayment, type StatementQuery } from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { StatementService } from "../accounting-statements/statement.service";

@Controller()
export class PaymentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly statements: StatementService,
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

  /**
   * Supplier statement — derived from the General Ledger: AP_CONTROL journal
   * lines with partyType=SUPPLIER, partyId=:id. Credit increases the payable
   * (purchase invoice), debit reduces it (payment); reversals show as their
   * real opposite movement. Legacy purchase_invoices/payments are NOT summed.
   */
  @Get("statements/supplier/:id")
  @Roles("OWNER", "ACCOUNTANT")
  async supplierStatement(
    @Param("id") supplierId: string,
    @Query(new ZodValidationPipe(StatementQuerySchema)) query: StatementQuery,
  ) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) throw new NotFoundError({ supplierId });

    const result = await this.statements.compute(
      { account: { systemRole: "AP_CONTROL" }, partyType: "SUPPLIER", partyId: supplierId },
      "CREDIT",
      query.from,
      query.to,
    );

    return {
      entity: { id: supplier.id, nameAr: supplier.nameAr, nameEn: supplier.nameEn },
      openingBalance: result.openingBalance,
      periodDebit: result.periodDebit,
      periodCredit: result.periodCredit,
      endingBalance: result.endingBalance,
      rows: result.rows,
      // backward-compatible aliases
      entries: result.rows.map((r) => ({
        id: r.journalLineId,
        date: r.entryDate,
        type: r.sourceType ?? "JOURNAL",
        reference: r.reference,
        description: r.description,
        debit: r.debit,
        credit: r.credit,
        balance: r.runningBalance,
        journalEntryId: r.journalEntryId,
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        isReversal: r.isReversal,
      })),
      totalDebit: result.periodDebit,
      totalCredit: result.periodCredit,
      closingBalance: result.endingBalance,
    };
  }

  @Get("statements/account/:id")
  @Roles("OWNER", "ACCOUNTANT")
  async accountStatement(
    @Param("id") accountId: string,
    @Query(new ZodValidationPipe(StatementQuerySchema)) query: StatementQuery,
  ) {
    // ── GL account first (covers treasury/cash/bank + every ledger account) ──
    // Treasury movements are now derived from journal_lines, not the legacy
    // payments/order_collections tables, so a receipt voucher / expense / manual
    // journal that hits the treasury account appears automatically.
    const glAccount = await this.prisma.account.findUnique({ where: { id: accountId } });
    if (glAccount) {
      const normalSide = StatementService.normalSideForCategory(glAccount.category as unknown as string);
      const result = await this.statements.compute({ accountId }, normalSide, query.from, query.to);
      return {
        entity: {
          id: glAccount.id, name: glAccount.nameAr, code: glAccount.code, type: "gl_account",
          category: glAccount.category, isCashOrBank: glAccount.isCashOrBank,
          treasuryType: glAccount.treasuryType, normalSide,
        },
        openingBalance: result.openingBalance,
        periodDebit: result.periodDebit,
        periodCredit: result.periodCredit,
        endingBalance: result.endingBalance,
        rows: result.rows,
        // aliases: for treasury, debit = inflow, credit = outflow
        totalIn: result.periodDebit,
        totalOut: result.periodCredit,
        closingBalance: result.endingBalance,
        entries: result.rows.map((r) => ({
          id: r.journalLineId,
          date: r.entryDate,
          type: r.sourceType ?? "journal",
          reference: r.reference,
          description: r.description,
          debit: r.debit,
          credit: r.credit,
          balance: r.runningBalance,
          journalEntryId: r.journalEntryId,
          sourceType: r.sourceType,
          sourceId: r.sourceId,
          isReversal: r.isReversal,
        })),
      };
    }

    const dateFilter: any = {};
    if (query.from) dateFilter.gte = new Date(query.from);
    if (query.to) dateFilter.lte = new Date(query.to);

    // ── Legacy payment account (bank / cash) — fallback for pre-GL ids ─────
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

    throw new NotFoundError({ accountId });
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
