import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import {
  CreateCustomerRequestSchema,
  CreateCustomerTransactionSchema,
  CustomerStatementQuerySchema,
  UpdateCustomerRequestSchema,
  type CreateCustomerRequest,
  type CreateCustomerTransaction,
  type CustomerStatementQuery,
  type UpdateCustomerRequest,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { Decimal } from "decimal.js";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../../prisma/prisma.service";
import { StatementService } from "../accounting-statements/statement.service";

@Controller("customers")
export class CustomersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly statements: StatementService,
  ) {}

  private formatCustomer(c: { id: string; code: string; nameAr: string; phone: string | null; active: boolean; createdAt: Date }) {
    return { id: c.id, code: c.code, nameAr: c.nameAr, phone: c.phone ?? null, active: c.active, createdAt: c.createdAt };
  }

  private async nextCode(): Promise<string> {
    const result = await this.prisma.$queryRaw<Array<{ max_code: string | null }>>`
      SELECT MAX(code) as max_code FROM customers WHERE code ~ '^C-[0-9]+$'
    `;
    const max = result[0]?.max_code;
    const next = max ? parseInt(max.split("-")[1]!, 10) + 1 : 1;
    return `C-${String(next).padStart(4, "0")}`;
  }

  @Get()
  async list() {
    const customers = await this.prisma.customer.findMany({
      orderBy: { code: "asc" },
    });
    return customers.map((c) => this.formatCustomer(c));
  }

  @Get(":id")
  async getOne(@Param("id") id: string) {
    const c = await this.prisma.customer.findUnique({ where: { id } });
    if (!c) throw new NotFoundError({ id });
    return this.formatCustomer(c);
  }

  @Post()
  @Roles("OWNER", "ACCOUNTANT")
  async create(
    @Body(new ZodValidationPipe(CreateCustomerRequestSchema)) body: CreateCustomerRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const code = await this.nextCode();
      const customer = await tx.customer.create({
        data: { code, nameAr: body.nameAr, phone: body.phone ?? null },
      });
      await this.audit.write({
        tx, actorId: user.id, action: "CREATE",
        entityType: "customer", entityId: customer.id,
        afterSnapshot: { code: customer.code, nameAr: customer.nameAr },
        summaryAr: `${user.name} أنشأ العميل «${customer.nameAr}» برقم ${customer.code}`,
        summaryEn: `${user.name} created customer "${customer.nameAr}" code ${customer.code}`,
      });
      return this.formatCustomer(customer);
    });
  }

  @Patch(":id")
  @Roles("OWNER", "ACCOUNTANT")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateCustomerRequestSchema)) body: UpdateCustomerRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const before = await tx.customer.findUnique({ where: { id } });
      if (!before) throw new NotFoundError({ id });
      const after = await tx.customer.update({
        where: { id },
        data: {
          ...(body.nameAr !== undefined ? { nameAr: body.nameAr } : {}),
          ...(body.phone !== undefined ? { phone: body.phone } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        },
      });
      await this.audit.write({
        tx, actorId: user.id, action: "UPDATE",
        entityType: "customer", entityId: id,
        beforeSnapshot: { nameAr: before.nameAr, phone: before.phone, active: before.active },
        afterSnapshot: { nameAr: after.nameAr, phone: after.phone, active: after.active },
        summaryAr: `${user.name} حدّث بيانات العميل «${after.nameAr}»`,
        summaryEn: `${user.name} updated customer "${after.nameAr}"`,
      });
      return this.formatCustomer(after);
    });
  }

  /**
   * Customer statement — derived entirely from the General Ledger: AR_CONTROL
   * journal lines with partyType=CUSTOMER, partyId=:id. Debit increases the
   * receivable (invoice), credit reduces it (receipt); reversals show as their
   * real opposite movement. Legacy customer_transactions are NOT read or summed.
   */
  @Get("statement/:id")
  @Roles("OWNER", "ACCOUNTANT")
  async statement(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(CustomerStatementQuerySchema)) query: CustomerStatementQuery,
  ) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundError({ id });

    const result = await this.statements.compute(
      { account: { systemRole: "AR_CONTROL" }, partyType: "CUSTOMER", partyId: id },
      "DEBIT",
      query.from,
      query.to,
    );

    return {
      customer: { id: customer.id, code: customer.code, nameAr: customer.nameAr },
      // canonical GL fields
      openingBalance: result.openingBalance,
      periodDebit: result.periodDebit,
      periodCredit: result.periodCredit,
      endingBalance: result.endingBalance,
      rows: result.rows,
      // backward-compatible aliases for the current web statement view
      totalDR: result.periodDebit,
      totalCR: result.periodCredit,
      closingBalance: result.endingBalance,
      entries: result.rows.map((r, idx) => ({
        id: r.journalLineId,
        rowNum: idx + 1,
        date: r.entryDate,
        reference: r.reference,
        description: r.description,
        type: r.sourceType ?? "JOURNAL",
        direction: new Decimal(r.debit).gt(0) ? "DR" : "CR",
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

  @Post("transactions")
  @Roles("OWNER", "ACCOUNTANT")
  async createTransaction(
    @Body(new ZodValidationPipe(CreateCustomerTransactionSchema)) body: CreateCustomerTransaction,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const customer = await this.prisma.customer.findUnique({ where: { id: body.customerId } });
    if (!customer) throw new NotFoundError({ customerId: body.customerId });

    return this.prisma.runInTransaction(async (tx) => {
      const transaction = await tx.customerTransaction.create({
        data: {
          customerId: body.customerId,
          type: body.type,
          direction: body.direction,
          amount: body.amount,
          date: new Date(body.date),
          reference: body.reference ?? null,
          description: body.description ?? null,
          paymentAccountId: body.paymentAccountId ?? null,
          createdBy: user.id,
        },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "customer_transaction",
        entityId: transaction.id,
        afterSnapshot: {
          customerId: body.customerId,
          type: body.type,
          direction: body.direction,
          amount: body.amount,
        },
        summaryAr: `${user.name} سجّل حركة (${body.type}) بمبلغ ${body.amount} ج.م للعميل «${customer.nameAr}».`,
        summaryEn: `${user.name} recorded a ${body.type} transaction of ${body.amount} EGP for customer "${customer.nameAr}".`,
      });

      return {
        id: transaction.id,
        customerId: transaction.customerId,
        type: transaction.type,
        direction: transaction.direction,
        amount: transaction.amount.toString(),
        date: transaction.date.toISOString().slice(0, 10),
        reference: transaction.reference ?? null,
        description: transaction.description ?? null,
        paymentAccountId: transaction.paymentAccountId ?? null,
      };
    });
  }

  @Delete("transactions/:id")
  @Roles("OWNER")
  @HttpCode(204)
  async deleteTransaction(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    const transaction = await this.prisma.customerTransaction.findUnique({ where: { id } });
    if (!transaction) throw new NotFoundError({ id });

    return this.prisma.runInTransaction(async (tx) => {
      await tx.customerTransaction.delete({ where: { id } });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "DELETE",
        entityType: "customer_transaction",
        entityId: id,
        beforeSnapshot: {
          customerId: transaction.customerId,
          type: transaction.type,
          direction: transaction.direction,
          amount: transaction.amount.toString(),
        },
        summaryAr: `${user.name} حذف حركة بمبلغ ${transaction.amount} ج.م.`,
        summaryEn: `${user.name} deleted a transaction of ${transaction.amount} EGP.`,
      });
    });
  }
}
