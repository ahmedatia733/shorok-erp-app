import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { Decimal } from "decimal.js";
import {
  AccountBalanceQuerySchema,
  CreateAccountRequestSchema,
  UpdateAccountRequestSchema,
  type AccountBalanceQuery,
  type CreateAccountRequest,
  type UpdateAccountRequest,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { PrismaService } from "../../prisma/prisma.service";
import { AccountsService } from "./accounts.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */

interface AccountNode {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  category: string;
  accountType: string;
  parentId: string | null;
  isLeaf: boolean;
  active: boolean;
  systemRole: string | null;
  isCashOrBank: boolean;
  treasuryType: string | null;
  createdAt: Date;
  children: AccountNode[];
}

@Controller("accounts")
export class AccountsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
  ) {}

  /**
   * GET /accounts — return all accounts ordered by code, as a tree.
   */
  @Get()
  async list() {
    const rows = await this.prisma.account.findMany({
      orderBy: { code: "asc" },
    });

    // Build tree in-memory
    const map = new Map<string, AccountNode>();
    for (const r of rows) {
      map.set(r.id, {
        id: r.id,
        code: r.code,
        nameAr: r.nameAr,
        nameEn: r.nameEn,
        category: r.category,
        accountType: r.accountType,
        parentId: r.parentId,
        isLeaf: r.isLeaf,
        active: r.active,
        systemRole: r.systemRole ?? null,
        isCashOrBank: r.isCashOrBank,
        treasuryType: r.treasuryType ?? null,
        createdAt: r.createdAt,
        children: [],
      });
    }

    const roots: AccountNode[] = [];
    for (const node of map.values()) {
      if (node.parentId) {
        const parent = map.get(node.parentId);
        if (parent) {
          parent.children.push(node);
        } else {
          roots.push(node);
        }
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  /**
   * POST /accounts — OWNER only: create a new account.
   *
   * The rules live in AccountsService because the Expenses area creates expense
   * accounts through the same service; there is one definition of a valid
   * account, not one per screen.
   */
  @Post()
  @Roles("OWNER")
  async create(
    @Body(new ZodValidationPipe(CreateAccountRequestSchema)) body: CreateAccountRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.accounts.create(body, user);
  }

  /**
   * PATCH /accounts/:id — OWNER only: update name or active status.
   */
  @Patch(":id")
  @Roles("OWNER")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateAccountRequestSchema)) body: UpdateAccountRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.accounts.update(id, body, user);
  }

  /**
   * GET /accounts/:id/balance?from=&to=
   *
   * Recursively collects all descendant account IDs (in-memory walk),
   * then sums JournalLine debit and credit filtered by date range.
   */
  @Get(":id/balance")
  async getBalance(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(AccountBalanceQuerySchema)) query: AccountBalanceQuery,
  ) {
    // Fetch all accounts to do in-memory tree walk
    const allAccounts = await this.prisma.account.findMany({ select: { id: true, parentId: true } });

    const account = await this.prisma.account.findUnique({ where: { id } });
    if (!account) throw new NotFoundError({ id });

    // Collect all descendant IDs including this account
    const descendantIds = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      descendantIds.add(current);
      for (const acc of allAccounts) {
        if (acc.parentId === current) {
          queue.push(acc.id);
        }
      }
    }

    // Filter journal lines by account IDs and optional date range
    const dateFilter = query.from || query.to
      ? {
          journalEntry: {
            entryDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          },
        }
      : {};

    const lines = await this.prisma.journalLine.findMany({
      where: {
        accountId: { in: Array.from(descendantIds) },
        ...dateFilter,
      },
      select: { debit: true, credit: true },
    });

    let totalDebit = new Decimal(0);
    let totalCredit = new Decimal(0);
    for (const line of lines) {
      totalDebit = totalDebit.plus(line.debit.toString());
      totalCredit = totalCredit.plus(line.credit.toString());
    }
    const balance = totalDebit.minus(totalCredit);

    return {
      accountId: id,
      debit: totalDebit.toFixed(2),
      credit: totalCredit.toFixed(2),
      balance: balance.toFixed(2),
    };
  }
}
