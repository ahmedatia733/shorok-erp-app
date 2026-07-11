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
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { ReversalService } from "../posting/reversal.service";

@Controller("journal")
export class JournalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly reversal: ReversalService,
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
    // Validate that sum(debit) === sum(credit)
    let sumDebit = new Decimal(0);
    let sumCredit = new Decimal(0);
    for (const line of body.lines) {
      sumDebit = sumDebit.plus(new Decimal(line.debit));
      sumCredit = sumCredit.plus(new Decimal(line.credit));
    }
    if (!sumDebit.equals(sumCredit)) {
      throw new ValidationError({ reason: "unbalanced_entry" });
    }

    // Validate all accountIds are active leaf accounts
    const accountIds = body.lines.map((l) => l.accountId);
    const accounts = await this.prisma.account.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, isLeaf: true, active: true, nameAr: true, nameEn: true },
    });

    for (const line of body.lines) {
      const acc = accounts.find((a) => a.id === line.accountId);
      if (!acc) throw new NotFoundError({ accountId: line.accountId });
      if (!acc.isLeaf || !acc.active) {
        throw new ValidationError({ reason: "account_not_leaf_or_inactive", accountId: line.accountId });
      }
    }

    return this.prisma.runInTransaction(async (tx) => {
      const entry = await tx.journalEntry.create({
        data: {
          entryType: body.entryType ?? "JOURNAL",
          reference: body.reference ?? null,
          entryDate: new Date(body.entryDate),
          description: body.description,
          referenceType: body.referenceType ?? null,
          referenceId: body.referenceId ?? null,
          createdBy: user.id,
          lines: {
            create: body.lines.map((line) => ({
              accountId: line.accountId,
              debit: new Decimal(line.debit).toFixed(2),
              credit: new Decimal(line.credit).toFixed(2),
              note: line.note ?? null,
            })),
          },
        },
        include: {
          lines: {
            include: {
              account: { select: { code: true, nameAr: true, nameEn: true } },
            },
          },
        },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "journal_entry",
        entityId: entry.id,
        afterSnapshot: {
          entryDate: body.entryDate,
          description: body.description,
          totalDebit: sumDebit.toFixed(2),
          lineCount: body.lines.length,
        },
        summaryAr: `${user.name} أنشأ قيد يومي: ${body.description} — ${sumDebit.toFixed(2)} ج.م`,
        summaryEn: `${user.name} created journal entry: ${body.description} — ${sumDebit.toFixed(2)} EGP`,
      });

      return this._formatEntry(entry, sumDebit);
    });
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
