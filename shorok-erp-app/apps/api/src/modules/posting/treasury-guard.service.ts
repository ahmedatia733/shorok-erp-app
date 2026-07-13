import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { Prisma } from "../../prisma/prisma.service";
import { TreasuryNegativeBalanceWarning } from "../../common/errors/api-errors";
import { AuditService } from "../audit/audit.service";
import type { AuthenticatedUser } from "../../common/types/request-user";

type Tx = Prisma.TransactionClient;
export interface TreasuryCheckLine {
  accountId: string;
  debit?: string | null;
  credit?: string | null;
}

/**
 * Negative treasury/bank balance protection (Increment C — WARN-ONLY policy).
 *
 * Called inside the posting transaction, before the journal entry is created.
 * For each configured treasury account (is_cash_or_bank + treasury_type
 * CASH|BANK) that the operation reduces on net, it:
 *   1. takes an account-level lock (SELECT … FOR UPDATE, deterministic id order),
 *   2. recomputes the authoritative GL balance = Σ(debit − credit) from
 *      journal_lines (never a client/legacy value),
 *   3. if the projected balance would be < 0 and the caller did NOT acknowledge,
 *      throws TreasuryNegativeBalanceWarning (409) — NOTHING is posted,
 *   4. if acknowledged, records an audit row per offending account and returns
 *      so the caller may post (negative balances are allowed after confirmation).
 *
 * Inflows and net-increase operations are never warned. Deadlocks are avoided
 * by locking accounts in sorted id order.
 */
@Injectable()
export class TreasuryGuardService {
  constructor(private readonly audit: AuditService) {}

  async check(
    tx: Tx,
    args: {
      lines: TreasuryCheckLine[];
      acknowledge?: boolean;
      reason?: string | null;
      actor: AuthenticatedUser;
      sourceType: string;
      sourceId?: string | null;
    },
  ): Promise<void> {
    const accountIds = [...new Set(args.lines.map((l) => l.accountId))];
    const treasuryAccounts = await tx.account.findMany({
      where: { id: { in: accountIds }, isCashOrBank: true, treasuryType: { in: ["CASH", "BANK"] } },
      select: { id: true, code: true, nameAr: true, treasuryType: true },
    });
    if (treasuryAccounts.length === 0) return;
    const treasuryMap = new Map(treasuryAccounts.map((a) => [a.id, a]));

    // Net effect of THIS operation per treasury account.
    const net = new Map<string, { debit: Decimal; credit: Decimal }>();
    for (const l of args.lines) {
      if (!treasuryMap.has(l.accountId)) continue;
      const e = net.get(l.accountId) ?? { debit: new Decimal(0), credit: new Decimal(0) };
      e.debit = e.debit.add(new Decimal(l.debit || "0"));
      e.credit = e.credit.add(new Decimal(l.credit || "0"));
      net.set(l.accountId, e);
    }
    // Only accounts with a net OUTFLOW (debit − credit < 0) can go negative.
    const outflowIds = [...net.entries()]
      .filter(([, e]) => e.debit.sub(e.credit).lt(0))
      .map(([id]) => id)
      .sort();
    if (outflowIds.length === 0) return;

    const offending: Array<Record<string, unknown>> = [];
    for (const accId of outflowIds) {
      // Account-level lock → serializes concurrent operations on this treasury.
      await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${accId}::uuid FOR UPDATE`;
      const rows = await tx.$queryRaw<Array<{ bal: string }>>`
        SELECT COALESCE(SUM(debit - credit), 0)::text AS bal FROM journal_lines WHERE account_id = ${accId}::uuid
      `;
      const current = new Decimal(rows[0]?.bal ?? "0");
      const e = net.get(accId)!;
      const projected = current.add(e.debit).sub(e.credit);
      if (projected.lt(0)) {
        const a = treasuryMap.get(accId)!;
        offending.push({
          treasuryAccountId: accId,
          accountCode: a.code,
          accountName: a.nameAr,
          treasuryType: a.treasuryType,
          currentBalance: current.toFixed(2),
          operationDebit: e.debit.toFixed(2),
          operationCredit: e.credit.toFixed(2),
          projectedBalance: projected.toFixed(2),
        });
      }
    }
    if (offending.length === 0) return;

    if (!args.acknowledge) {
      // No journal, no partial write — the caller's transaction rolls back.
      throw new TreasuryNegativeBalanceWarning({ acknowledgementRequired: true, accounts: offending, ...offending[0] });
    }

    // Acknowledged: record the override (audit only — never a financial journal).
    for (const o of offending) {
      await this.audit.write({
        tx,
        actorId: args.actor.id,
        action: "APPROVE",
        entityType: "treasury_negative_balance",
        entityId: String(o.treasuryAccountId),
        afterSnapshot: {
          ...o,
          sourceType: args.sourceType,
          sourceId: args.sourceId ?? null,
          actorRole: args.actor.role,
          reasonProvided: Boolean(args.reason),
          reason: args.reason ?? null,
        },
        summaryAr: `${args.actor.name} أكّد الترحيل رغم أن رصيد ${o.accountName} (${o.accountCode}) سيصبح ${o.projectedBalance}`,
        summaryEn: `${args.actor.name} acknowledged posting though ${o.accountName} (${o.accountCode}) will be ${o.projectedBalance}`,
      });
    }
  }
}
