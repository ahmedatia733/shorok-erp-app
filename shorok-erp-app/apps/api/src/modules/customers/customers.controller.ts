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
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../../prisma/prisma.service";

@Controller("customers")
export class CustomersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
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

  @Get("statement/:id")
  @Roles("OWNER", "ACCOUNTANT")
  async statement(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(CustomerStatementQuerySchema)) query: CustomerStatementQuery,
  ) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundError({ id });

    const allTransactions = await this.prisma.customerTransaction.findMany({
      where: { customerId: id },
      orderBy: [{ date: "asc" }, { id: "asc" }],
    });

    const fromDate = query.from ? new Date(query.from) : null;
    const toDate = query.to ? new Date(query.to) : null;

    const before: typeof allTransactions = [];
    const period: typeof allTransactions = [];

    for (const tx of allTransactions) {
      const txDate = tx.date;
      if (fromDate && txDate < fromDate) {
        before.push(tx);
        continue;
      }
      if (toDate && txDate > toDate) {
        continue;
      }
      period.push(tx);
    }

    let openingBalance = 0;
    for (const tx of before) {
      const amount = parseFloat(tx.amount.toString());
      openingBalance += tx.direction === "DR" ? amount : -amount;
    }

    let runningBalance = openingBalance;
    let totalDR = 0;
    let totalCR = 0;

    const entries = period.map((tx, idx) => {
      const amount = parseFloat(tx.amount.toString());
      if (tx.direction === "DR") {
        runningBalance += amount;
        totalDR += amount;
      } else {
        runningBalance -= amount;
        totalCR += amount;
      }
      return {
        id: tx.id,
        rowNum: idx + 1,
        date: tx.date.toISOString().slice(0, 10),
        reference: tx.reference ?? null,
        description: tx.description ?? null,
        type: tx.type,
        direction: tx.direction,
        debit: tx.direction === "DR" ? amount.toFixed(2) : "0.00",
        credit: tx.direction === "CR" ? amount.toFixed(2) : "0.00",
        balance: runningBalance.toFixed(2),
      };
    });

    return {
      customer: { id: customer.id, code: customer.code, nameAr: customer.nameAr },
      openingBalance: openingBalance.toFixed(2),
      totalDR: totalDR.toFixed(2),
      totalCR: totalCR.toFixed(2),
      closingBalance: runningBalance.toFixed(2),
      entries,
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
