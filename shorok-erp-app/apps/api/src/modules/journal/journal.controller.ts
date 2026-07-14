import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { Decimal } from "decimal.js";
import {
  CreateJournalEntryRequestSchema,
  JournalQuerySchema,
  ReverseEntrySchema,
  type CreateJournalEntryRequest,
  type JournalQuery,
  type ReverseEntry,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { randomUUID } from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { ReversalService } from "../posting/reversal.service";
import { PostingEngine } from "../posting/posting.engine";

@Controller("journal")
export class JournalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly reversal: ReversalService,
    private readonly postingEngine: PostingEngine,
  ) {}

  /**
   * POST /journal — OWNER, ACCOUNTANT: create a balanced journal entry.
   */
  @Post()
  @Roles("OWNER", "ACCOUNTANT")
  async create(
    @Body(new ZodValidationPipe(CreateJournalEntryRequestSchema)) body: CreateJournalEntryRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Balanced check (the engine re-checks, but this gives a specific message).
    let sumDebit = new Decimal(0);
    let sumCredit = new Decimal(0);
    for (const line of body.lines) {
      sumDebit = sumDebit.plus(new Decimal(line.debit));
      sumCredit = sumCredit.plus(new Decimal(line.credit));
    }
    if (!sumDebit.equals(sumCredit)) {
      throw new ValidationError({ reason: "unbalanced_entry" });
    }

    // Accounts must be active leaves; AR_CONTROL/AP_CONTROL lines require a party.
    const accountIds = [...new Set(body.lines.map((l) => l.accountId))];
    const accounts = await this.prisma.account.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, isLeaf: true, active: true, systemRole: true },
    });
    const accById = new Map(accounts.map((a) => [a.id, a]));
    for (const line of body.lines) {
      const acc = accById.get(line.accountId);
      if (!acc) throw new NotFoundError({ accountId: line.accountId });
      if (!acc.isLeaf || !acc.active) {
        throw new ValidationError({ reason: "account_not_leaf_or_inactive", accountId: line.accountId });
      }
      if (acc.systemRole === "AR_CONTROL" && (line.partyType !== "CUSTOMER" || !line.partyId)) {
        throw new ValidationError({ reason: "customer_party_required", accountId: line.accountId });
      }
      if (acc.systemRole === "AP_CONTROL" && (line.partyType !== "SUPPLIER" || !line.partyId)) {
        throw new ValidationError({ reason: "supplier_party_required", accountId: line.accountId });
      }
    }

    // Party ids must reference an ACTIVE customer / supplier.
    const customerIds = [...new Set(body.lines.filter((l) => l.partyType === "CUSTOMER" && l.partyId).map((l) => l.partyId!))];
    const supplierIds = [...new Set(body.lines.filter((l) => l.partyType === "SUPPLIER" && l.partyId).map((l) => l.partyId!))];
    if (customerIds.length) {
      const found = new Set((await this.prisma.customer.findMany({ where: { id: { in: customerIds }, active: true }, select: { id: true } })).map((c) => c.id));
      for (const id of customerIds) if (!found.has(id)) throw new NotFoundError({ reason: "customer_not_found", customerId: id });
    }
    if (supplierIds.length) {
      const found = new Set((await this.prisma.supplier.findMany({ where: { id: { in: supplierIds }, active: true }, select: { id: true } })).map((s) => s.id));
      for (const id of supplierIds) if (!found.has(id)) throw new NotFoundError({ reason: "supplier_not_found", supplierId: id });
    }

    // Post through the single PostingEngine — balanced, OPEN period, DB-sequence
    // numbering, POSTED status, party carried onto lines, treasury negative-balance
    // guard, and audit, all in one transaction. No direct journalEntry writes.
    const result = await this.postingEngine.post({
      actor: user,
      sourceType: "MANUAL",
      entryType: body.entryType ?? "JOURNAL",
      entryDate: body.entryDate,
      reference: body.reference,
      description: body.description,
      idempotencyKey: body.idempotencyKey ?? `MANUAL:${randomUUID()}`,
      lines: body.lines.map((l) => ({
        accountId: l.accountId,
        debit: l.debit,
        credit: l.credit,
        note: l.note,
        partyType: l.partyType,
        partyId: l.partyId,
      })),
      acknowledgeNegativeBalance: body.acknowledgeNegativeBalance,
      negativeBalanceReason: body.negativeBalanceReason ?? null,
    });

    const entry = await this.prisma.journalEntry.findUniqueOrThrow({
      where: { id: result.journalEntryId },
      include: { lines: { include: { account: { select: { code: true, nameAr: true, nameEn: true } } } } },
    });
    const totalDebit = entry.lines.reduce((a, l) => a.plus(l.debit.toString()), new Decimal(0));
    return this._formatEntry(entry, totalDebit);
  }

  /**
   * GET /journal?from=&to=&accountId=&cursor=&limit=
   */
  @Get()
  async list(@Query(new ZodValidationPipe(JournalQuerySchema)) query: JournalQuery) {
    const where: Record<string, unknown> = {};

    if (query.from || query.to) {
      where["entryDate"] = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    if (query.accountId) {
      where["lines"] = { some: { accountId: query.accountId } };
    }

    const rows = await this.prisma.journalEntry.findMany({
      where,
      orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        lines: {
          include: {
            account: { select: { code: true, nameAr: true, nameEn: true } },
          },
        },
      },
    });

    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return {
      data: data.map((entry) => {
        const totalDebit = entry.lines.reduce(
          (acc, l) => acc.plus(l.debit.toString()),
          new Decimal(0),
        );
        return this._formatEntry(entry, totalDebit);
      }),
      nextCursor,
    };
  }

  /**
   * GET /journal/:id
   */
  @Get(":id")
  async getOne(@Param("id") id: string) {
    const entry = await this.prisma.journalEntry.findUnique({
      where: { id },
      include: {
        lines: {
          include: {
            account: { select: { code: true, nameAr: true, nameEn: true } },
          },
        },
      },
    });
    if (!entry) throw new NotFoundError({ id });

    const totalDebit = entry.lines.reduce(
      (acc, l) => acc.plus(l.debit.toString()),
      new Decimal(0),
    );
    return this._formatEntry(entry, totalDebit);
  }

  /**
   * POST /journal/:id/reverse — OWNER, ACCOUNTANT: correct a posted entry by
   * reversal (Constitution VII — posted-record immutability). Creates a
   * mirrored entry through the PostingEngine, links it via reversalOfId, and
   * marks the original REVERSED. Idempotent: a repeat call returns the existing
   * reversal without creating a duplicate.
   */
  @Post(":id/reverse")
  @Roles("OWNER", "ACCOUNTANT")
  async reverseEntry(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ReverseEntrySchema)) body: ReverseEntry,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.reversal.reverse({
      entryId: id,
      reason: body.reason,
      reversalDate: body.reversalDate,
      actor: user,
      acknowledgeNegativeBalance: body.acknowledgeNegativeBalance,
      negativeBalanceReason: body.negativeBalanceReason ?? null,
    });
    return result;
  }

  /**
   * DELETE /journal/:id — journals are never hard-deleted (Constitution VII).
   * The route is kept for compatibility but refuses posted/reversed entries;
   * corrections must go through POST /journal/:id/reverse.
   */
  @Delete(":id")
  @Roles("OWNER")
  async remove(@Param("id") id: string) {
    const entry = await this.prisma.journalEntry.findUnique({ where: { id }, select: { id: true } });
    if (!entry) throw new NotFoundError({ id });
    throw new ValidationError({ reason: "use_reverse_instead" });
  }

  private _formatEntry(
    entry: {
      id: string;
      entryNumber: bigint;
      entryType: string;
      reference: string | null;
      entryDate: Date;
      description: string;
      referenceType: string | null;
      referenceId: string | null;
      createdAt: Date;
      lines: Array<{
        id: string;
        accountId: string;
        debit: { toString(): string };
        credit: { toString(): string };
        note: string | null;
        account: { code: string; nameAr: string; nameEn: string };
      }>;
    },
    totalDebit: Decimal,
  ) {
    return {
      id: entry.id,
      entryNumber: Number(entry.entryNumber),
      entryType: entry.entryType,
      reference: entry.reference,
      entryDate: entry.entryDate,
      description: entry.description,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      createdAt: entry.createdAt,
      totalDebit: totalDebit.toFixed(2),
      lines: entry.lines.map((l) => ({
        id: l.id,
        accountId: l.accountId,
        accountCode: l.account.code,
        accountNameAr: l.account.nameAr,
        accountNameEn: l.account.nameEn,
        debit: l.debit.toString(),
        credit: l.credit.toString(),
        note: l.note,
      })),
    };
  }
}
