import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { CreateAccountRequest, UpdateAccountRequest } from "@shorok/shared";
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";

/**
 * Creating and editing Chart-of-Accounts master data — the one implementation.
 *
 * It lives in a service rather than in the controller because it now has more
 * than one caller: the Chart of Accounts screen creates any account, and the
 * Expenses area creates expense accounts (from its own page and from the
 * journal-entry quick-add). Those must not be three subtly different rules about
 * what a valid account is, so they are one rule, called three times.
 *
 * Nothing here is expense-specific. The expense caller decides *what* to create;
 * this decides whether it may exist and writes it.
 */

/** The account shape every account-writing endpoint returns. */
export interface AccountDto {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  category: string;
  accountType: string;
  parentId: string | null;
  isLeaf: boolean;
  active: boolean;
  createdAt: Date;
  children: never[];
}

const toDto = (a: {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  category: string;
  accountType: string;
  parentId: string | null;
  isLeaf: boolean;
  active: boolean;
  createdAt: Date;
}): AccountDto => ({
  id: a.id,
  code: a.code,
  nameAr: a.nameAr,
  nameEn: a.nameEn,
  category: a.category,
  accountType: a.accountType,
  parentId: a.parentId,
  isLeaf: a.isLeaf,
  active: a.active,
  createdAt: a.createdAt,
  children: [],
});

/** Prisma's unique-constraint violation. */
const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates one account.
   *
   * The account code is checked twice on purpose. The lookup gives the user a
   * proper Arabic message instead of a raw database error, and the unique index
   * is what actually guarantees uniqueness — two requests carrying the same code
   * can both pass the lookup, and only the index can settle which one wins. The
   * loser is translated back into the same friendly error rather than surfacing
   * as a 500, so a race is indistinguishable from a plain duplicate.
   */
  async create(body: CreateAccountRequest, user: AuthenticatedUser): Promise<AccountDto> {
    const code = body.code.trim();
    const existing = await this.prisma.account.findUnique({ where: { code } });
    if (existing) throw new ValidationError({ reason: "code_already_exists", code });

    try {
      return await this.prisma.runInTransaction(async (tx) => {
        // A parent that has just gained a child is no longer a posting account.
        if (body.parentId) {
          const parent = await tx.account.findUnique({ where: { id: body.parentId } });
          if (!parent) throw new NotFoundError({ parentId: body.parentId });
          if (parent.isLeaf) {
            await tx.account.update({ where: { id: body.parentId }, data: { isLeaf: false } });
          }
        }

        const account = await tx.account.create({
          data: {
            code,
            nameAr: body.nameAr.trim(),
            nameEn: body.nameEn.trim(),
            category: body.category,
            accountType: body.accountType,
            parentId: body.parentId ?? null,
            isLeaf: true,
          },
        });

        await this.audit.write({
          tx,
          actorId: user.id,
          action: "CREATE",
          entityType: "account",
          entityId: account.id,
          afterSnapshot: {
            code: account.code,
            nameAr: account.nameAr,
            nameEn: account.nameEn,
            category: account.category,
            accountType: account.accountType,
            parentId: account.parentId,
          },
          summaryAr: `${user.name} أنشأ حساباً: ${account.code} — ${account.nameAr}`,
          summaryEn: `${user.name} created account: ${account.code} — ${account.nameEn}`,
        });

        return toDto(account);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ValidationError({ reason: "code_already_exists", code });
      throw e;
    }
  }

  /**
   * Updates the name or the active flag.
   *
   * The code is deliberately not updatable: it is quoted on posted journals and
   * printed on reports, so renaming it would silently rewrite how history reads.
   * There is no delete, here or anywhere — an account that has been posted to is
   * part of the record, and deactivating is how it leaves circulation.
   */
  async update(id: string, body: UpdateAccountRequest, user: AuthenticatedUser): Promise<AccountDto> {
    return this.prisma.runInTransaction(async (tx) => {
      const before = await tx.account.findUnique({ where: { id } });
      if (!before) throw new NotFoundError({ id });

      const after = await tx.account.update({
        where: { id },
        data: {
          ...(body.nameAr !== undefined ? { nameAr: body.nameAr.trim() } : {}),
          ...(body.nameEn !== undefined ? { nameEn: body.nameEn.trim() } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "account",
        entityId: id,
        beforeSnapshot: { nameAr: before.nameAr, nameEn: before.nameEn, active: before.active },
        afterSnapshot: { nameAr: after.nameAr, nameEn: after.nameEn, active: after.active },
        summaryAr: `${user.name} عدّل حساب: ${after.code} — ${after.nameAr}`,
        summaryEn: `${user.name} updated account: ${after.code} — ${after.nameEn}`,
      });

      return toDto(after);
    });
  }
}
