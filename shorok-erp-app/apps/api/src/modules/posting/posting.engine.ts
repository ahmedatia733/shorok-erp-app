import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import type { PostingRequest, PostingResult } from "@shorok/shared";
import { AuditService } from "../audit/audit.service";
import { Prisma, PrismaService } from "../../prisma/prisma.service";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";

export interface PostInput extends PostingRequest {
  /** Authenticated actor; the audit row and created_by are attributed to them. */
  actor: AuthenticatedUser;
  /** Optional outer transaction (document flows in Phase 3 pass their tx). */
  tx?: Prisma.TransactionClient;
}

/**
 * The single application-level path allowed to create journal entries
 * (Constitution VI — Single Posting Path). Every post is:
 *   1. balanced (Σdebit == Σcredit),
 *   2. debit-XOR-credit per line, amounts > 0 at 2dp,
 *   3. inside an OPEN financial period for entryDate,
 *   4. against leaf+active accounts; party required on AR/AP control accounts,
 *   5. numbered by the DB sequence (never count()+1),
 *   6. idempotent on idempotencyKey (no double-post),
 *   7. audited in the SAME transaction as the entry.
 *
 * Phase 2 note: this engine is NOT yet wired into any production document
 * flow — the 8 legacy direct-journal writers are untouched. Phase 3 migrates
 * them onto this engine.
 */
@Injectable()
export class PostingEngine {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async post(input: PostInput): Promise<PostingResult> {
    if (input.tx) return this.postInTx(input.tx, input);
    return this.prisma.runInTransaction((tx) => this.postInTx(tx, input));
  }

  private async postInTx(tx: Prisma.TransactionClient, input: PostInput): Promise<PostingResult> {
    // ── 0. Idempotency: a prior post with this key wins; never double-post. ──
    const existing = await tx.journalEntry.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, entryNumber: true },
    });
    if (existing) {
      return { journalEntryId: existing.id, entryNumber: Number(existing.entryNumber), idempotent: true };
    }

    // ── 1. Line-level validation: debit XOR credit, amounts > 0, 2dp ─────────
    if (input.lines.length < 2) {
      throw new ValidationError({ reason: "posting_needs_at_least_two_lines" });
    }
    let totalDebit = new Decimal(0);
    let totalCredit = new Decimal(0);
    for (const [i, line] of input.lines.entries()) {
      const debit = new Decimal(line.debit || "0");
      const credit = new Decimal(line.credit || "0");
      if (debit.isNegative() || credit.isNegative()) {
        throw new ValidationError({ reason: "negative_amount", lineIndex: i });
      }
      const debitNonZero = debit.gt(0);
      const creditNonZero = credit.gt(0);
      if (debitNonZero === creditNonZero) {
        // both zero, or both non-zero → violates debit-XOR-credit
        throw new ValidationError({ reason: "line_not_debit_xor_credit", lineIndex: i });
      }
      if (debit.decimalPlaces() > 2 || credit.decimalPlaces() > 2) {
        throw new ValidationError({ reason: "amount_exceeds_2dp", lineIndex: i });
      }
      totalDebit = totalDebit.add(debit);
      totalCredit = totalCredit.add(credit);
    }

    // ── 2. Balanced: Σdebit == Σcredit ───────────────────────────────────────
    if (!totalDebit.eq(totalCredit)) {
      throw new ValidationError({
        reason: "unbalanced_journal_entry",
        totalDebit: totalDebit.toFixed(2),
        totalCredit: totalCredit.toFixed(2),
      });
    }

    // ── 3. Period must exist and be OPEN for entryDate ───────────────────────
    const entryDate = new Date(input.entryDate);
    const year = entryDate.getUTCFullYear();
    const month = entryDate.getUTCMonth() + 1;
    const period = await tx.financialPeriod.findUnique({
      where: { year_month: { year, month } },
      select: { id: true, status: true },
    });
    if (!period) {
      throw new ValidationError({ reason: "period_not_open", year, month });
    }
    if (period.status !== "OPEN") {
      throw new ValidationError({ reason: "period_closed", year, month });
    }

    // ── 4. Accounts: leaf + active; party required on AR/AP control ──────────
    const accountIds = [...new Set(input.lines.map((l) => l.accountId))];
    const accounts = await tx.account.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, isLeaf: true, active: true, systemRole: true },
    });
    const accountMap = new Map(accounts.map((a) => [a.id, a]));
    for (const [i, line] of input.lines.entries()) {
      const acc = accountMap.get(line.accountId);
      if (!acc) throw new NotFoundError({ accountId: line.accountId });
      if (!acc.isLeaf || !acc.active) {
        throw new ValidationError({ reason: "account_not_postable", lineIndex: i, accountId: line.accountId });
      }
      if (acc.systemRole === "AR_CONTROL" || acc.systemRole === "AP_CONTROL") {
        if (!line.partyType || !line.partyId) {
          throw new ValidationError({ reason: "party_required_on_control_account", lineIndex: i, accountId: line.accountId });
        }
      }
    }

    // ── 5+6. Create entry — entry_number from the DB sequence (autoincrement)
    const entry = await tx.journalEntry.create({
      data: {
        entryType: input.entryType ?? "JOURNAL",
        entryDate,
        description: input.description,
        reference: input.reference ?? null,
        status: "POSTED",
        periodId: period.id,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        referenceType: input.sourceType.toLowerCase(),
        referenceId: input.sourceId ?? null,
        idempotencyKey: input.idempotencyKey,
        createdBy: input.actor.id,
        lines: {
          create: input.lines.map((l) => ({
            accountId: l.accountId,
            debit: new Decimal(l.debit || "0").toFixed(2),
            credit: new Decimal(l.credit || "0").toFixed(2),
            note: l.note ?? null,
            partyType: l.partyType ?? null,
            partyId: l.partyId ?? null,
            branchId: l.branchId ?? null,
          })),
        },
      },
      select: { id: true, entryNumber: true },
    });

    // ── 7. Audit in the SAME transaction ─────────────────────────────────────
    await this.audit.write({
      tx,
      actorId: input.actor.id,
      action: "CREATE",
      entityType: "journal_entry",
      entityId: entry.id,
      afterSnapshot: {
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        totalDebit: totalDebit.toFixed(2),
        entryNumber: Number(entry.entryNumber),
      },
      summaryAr: `${input.actor.name} رحّل قيد #${Number(entry.entryNumber)} — ${input.description} بمبلغ ${totalDebit.toFixed(2)} ج.م`,
      summaryEn: `${input.actor.name} posted entry #${Number(entry.entryNumber)} — ${input.description} for ${totalDebit.toFixed(2)} EGP`,
    });

    return { journalEntryId: entry.id, entryNumber: Number(entry.entryNumber), idempotent: false };
  }
}
