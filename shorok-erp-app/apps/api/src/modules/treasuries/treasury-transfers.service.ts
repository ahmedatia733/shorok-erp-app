import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import type {
  CreateTreasuryTransfer,
  UpdateTreasuryTransfer,
  ConfirmTreasuryTransfer,
  CancelTreasuryTransfer,
} from "@shorok/shared";
import { Prisma, PrismaService } from "../../prisma/prisma.service";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { AuditService } from "../audit/audit.service";
import { PostingEngine } from "../posting/posting.engine";
import { ReversalService } from "../posting/reversal.service";

type Tx = Prisma.TransactionClient;

/**
 * Treasury-to-treasury transfers. Confirmation posts ONE balanced journal via
 * the single PostingEngine — Dr destination GL / Cr source GL — after a locked
 * sufficiency check on the source (unless it allows negatives). Cancellation
 * posts a reversing journal (never edits history). Confirm/cancel are guarded
 * against double execution; the source GL account lock serializes concurrent
 * outgoing operations so two transfers cannot both overspend.
 */
@Injectable()
export class TreasuryTransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly postingEngine: PostingEngine,
    private readonly reversal: ReversalService,
  ) {}

  private assertBranchOrNotFound(user: AuthenticatedUser, branchIds: string[], id: string) {
    if (user.role === "OWNER") return;
    for (const b of branchIds) if (!user.allowedBranches.includes(b)) throw new NotFoundError({ id });
  }

  private async lockGlAccounts(tx: Tx, glAccountIds: string[]) {
    const sorted = [...new Set(glAccountIds)].sort();
    for (const id of sorted) await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${id}::uuid FOR UPDATE`;
  }

  private async balanceOf(tx: Tx, glAccountId: string): Promise<Decimal> {
    const rows = await tx.$queryRaw<Array<{ bal: string }>>`
      SELECT COALESCE(SUM(debit - credit), 0)::text AS bal FROM journal_lines WHERE account_id = ${glAccountId}::uuid`;
    return new Decimal(rows[0]?.bal ?? "0");
  }

  private async loadTreasury(tx: Tx, id: string) {
    const t = await tx.treasury.findUnique({ where: { id } });
    if (!t) throw new ValidationError({ reason: "treasury_not_found", treasuryId: id });
    return t;
  }

  private fmt(t: any) {
    return {
      id: t.id,
      transferNumber: String(t.transferNumber),
      transferDate: t.transferDate instanceof Date ? t.transferDate.toISOString().slice(0, 10) : String(t.transferDate),
      sourceTreasuryId: t.sourceTreasuryId,
      sourceTreasuryCode: t.source?.code ?? "",
      sourceTreasuryNameAr: t.source?.nameAr ?? "",
      destinationTreasuryId: t.destinationTreasuryId,
      destinationTreasuryCode: t.destination?.code ?? "",
      destinationTreasuryNameAr: t.destination?.nameAr ?? "",
      amount: new Decimal(t.amount.toString()).toFixed(2),
      reference: t.reference ?? null,
      notes: t.notes ?? null,
      status: t.status,
      journalEntryId: t.journalEntryId ?? null,
      reversalJournalEntryId: t.reversalJournalEntryId ?? null,
      createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : String(t.createdAt),
      confirmedAt: t.confirmedAt ? t.confirmedAt.toISOString() : null,
      cancelledAt: t.cancelledAt ? t.cancelledAt.toISOString() : null,
    };
  }

  private include = { source: { select: { code: true, nameAr: true } }, destination: { select: { code: true, nameAr: true } } };

  // ── list / get ───────────────────────────────────────────────────────
  async list(user: AuthenticatedUser, query: { status?: string; treasuryId?: string }) {
    const where: Prisma.TreasuryTransferWhereInput = {};
    if (query.status) where.status = query.status as never;
    if (query.treasuryId) where.OR = [{ sourceTreasuryId: query.treasuryId }, { destinationTreasuryId: query.treasuryId }];
    if (user.role !== "OWNER") {
      const branches = user.allowedBranches.length ? user.allowedBranches : ["__none__"];
      where.AND = [{ OR: [{ source: { branchId: { in: branches } } }, { destination: { branchId: { in: branches } } }] }];
    }
    const rows = await this.prisma.treasuryTransfer.findMany({ where, include: this.include, orderBy: { transferNumber: "desc" }, take: 200 });
    return { items: rows.map((r) => this.fmt(r)) };
  }

  async getOne(id: string, user: AuthenticatedUser) {
    const t = await this.prisma.treasuryTransfer.findUnique({ where: { id }, include: { ...this.include, source: { select: { code: true, nameAr: true, branchId: true } }, destination: { select: { code: true, nameAr: true, branchId: true } } } });
    if (!t) throw new NotFoundError({ id });
    this.assertBranchOrNotFound(user, [t.source.branchId, t.destination.branchId], id);
    return this.fmt(t);
  }

  // ── create draft ──────────────────────────────────────────────────────
  async create(body: CreateTreasuryTransfer, user: AuthenticatedUser) {
    if (body.sourceTreasuryId === body.destinationTreasuryId) throw new ValidationError({ reason: "same_treasury" });
    return this.prisma.runInTransaction(async (tx) => {
      const src = await this.loadTreasury(tx, body.sourceTreasuryId);
      const dst = await this.loadTreasury(tx, body.destinationTreasuryId);
      this.assertBranchOrNotFound(user, [src.branchId, dst.branchId], body.sourceTreasuryId);
      if (!src.active) throw new ValidationError({ reason: "source_treasury_inactive" });
      if (!dst.active) throw new ValidationError({ reason: "destination_treasury_inactive" });

      const transfer = await tx.treasuryTransfer.create({
        data: {
          transferDate: new Date(body.transferDate),
          sourceTreasuryId: src.id, destinationTreasuryId: dst.id,
          amount: new Decimal(body.amount).toFixed(2),
          reference: body.reference ?? null, notes: body.notes ?? null,
          status: "DRAFT", createdBy: user.id,
        },
        include: this.include,
      });
      await this.audit.write({
        tx, actorId: user.id, action: "CREATE", entityType: "treasury_transfer", entityId: transfer.id,
        afterSnapshot: { sourceTreasuryId: src.id, destinationTreasuryId: dst.id, amount: transfer.amount.toString() },
        summaryAr: `${user.name} أنشأ تحويلاً بين الخزائن ${src.code} ← ${dst.code}`,
        summaryEn: `${user.name} created a treasury transfer ${src.code} → ${dst.code}`,
      });
      return this.fmt(transfer);
    });
  }

  // ── update draft ──────────────────────────────────────────────────────
  async update(id: string, body: UpdateTreasuryTransfer, user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM treasury_transfers WHERE id = ${id}::uuid FOR UPDATE`;
      const existing = await tx.treasuryTransfer.findUnique({ where: { id }, include: { source: true, destination: true } });
      if (!existing) throw new NotFoundError({ id });
      this.assertBranchOrNotFound(user, [existing.source.branchId, existing.destination.branchId], id);
      if (existing.status !== "DRAFT") throw new ValidationError({ reason: "transfer_not_draft", status: existing.status });

      const sourceTreasuryId = body.sourceTreasuryId ?? existing.sourceTreasuryId;
      const destinationTreasuryId = body.destinationTreasuryId ?? existing.destinationTreasuryId;
      if (sourceTreasuryId === destinationTreasuryId) throw new ValidationError({ reason: "same_treasury" });
      if (body.sourceTreasuryId) { const s = await this.loadTreasury(tx, body.sourceTreasuryId); if (!s.active) throw new ValidationError({ reason: "source_treasury_inactive" }); this.assertBranchOrNotFound(user, [s.branchId], id); }
      if (body.destinationTreasuryId) { const d = await this.loadTreasury(tx, body.destinationTreasuryId); if (!d.active) throw new ValidationError({ reason: "destination_treasury_inactive" }); this.assertBranchOrNotFound(user, [d.branchId], id); }

      const transfer = await tx.treasuryTransfer.update({
        where: { id },
        data: {
          transferDate: body.transferDate ? new Date(body.transferDate) : undefined,
          sourceTreasuryId, destinationTreasuryId,
          amount: body.amount ? new Decimal(body.amount).toFixed(2) : undefined,
          reference: body.reference === undefined ? undefined : body.reference,
          notes: body.notes === undefined ? undefined : body.notes,
        },
        include: this.include,
      });
      return this.fmt(transfer);
    });
  }

  // ── confirm (post Dr destination / Cr source) ─────────────────────────
  async confirm(id: string, body: ConfirmTreasuryTransfer, user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM treasury_transfers WHERE id = ${id}::uuid FOR UPDATE`;
      const transfer = await tx.treasuryTransfer.findUnique({ where: { id }, include: { source: true, destination: true } });
      if (!transfer) throw new NotFoundError({ id });
      this.assertBranchOrNotFound(user, [transfer.source.branchId, transfer.destination.branchId], id);
      if (transfer.status === "CONFIRMED") throw new ValidationError({ reason: "transfer_already_confirmed" });
      if (transfer.status === "CANCELLED") throw new ValidationError({ reason: "transfer_cancelled" });
      if (!transfer.source.active || !transfer.destination.active) throw new ValidationError({ reason: "treasury_inactive" });

      const amount = new Decimal(transfer.amount.toString());
      if (amount.lte(0)) throw new ValidationError({ reason: "amount_must_be_positive" });

      // Period open.
      const dateStr = transfer.transferDate.toISOString().slice(0, 10);
      const [year, month] = dateStr.split("-").map(Number);
      const period = await tx.financialPeriod.findUnique({ where: { year_month: { year, month } } });
      if (!period || period.status !== "OPEN") throw new ValidationError({ reason: "period_not_open", year, month });

      // Lock both GL accounts (deterministic order) → serialize concurrent outflows.
      await this.lockGlAccounts(tx, [transfer.source.glAccountId, transfer.destination.glAccountId]);

      // Sufficiency: hard-reject when the source would go negative and negatives are disabled.
      if (!transfer.source.allowNegativeBalance) {
        const bal = await this.balanceOf(tx, transfer.source.glAccountId);
        if (bal.sub(amount).lt(0)) {
          throw new ValidationError({ reason: "insufficient_treasury_balance", available: bal.toFixed(2), requested: amount.toFixed(2), treasuryId: transfer.source.id });
        }
      }

      const posted = await this.postingEngine.post({
        tx, actor: user, sourceType: "TREASURY_TRANSFER", sourceId: transfer.id, entryType: "JOURNAL",
        entryDate: dateStr, reference: transfer.reference ?? `TRF-${transfer.transferNumber}`,
        description: `تحويل بين الخزائن ${transfer.source.code} ← ${transfer.destination.code}${transfer.notes ? ` — ${transfer.notes}` : ""}`,
        idempotencyKey: `TREASURY_TRANSFER:${transfer.id}`,
        // A source that explicitly allows negatives acknowledges the engine's
        // warn-only guard; when it does NOT, the hard check above already
        // guaranteed the source cannot go negative, so the guard never fires.
        acknowledgeNegativeBalance: transfer.source.allowNegativeBalance || undefined,
        negativeBalanceReason: transfer.source.allowNegativeBalance ? "treasury_allows_negative_balance" : undefined,
        lines: [
          { accountId: transfer.destination.glAccountId, debit: amount.toFixed(2), credit: "0", branchId: transfer.destination.branchId, note: `تحويل وارد - TRF-${transfer.transferNumber}` },
          { accountId: transfer.source.glAccountId, debit: "0", credit: amount.toFixed(2), branchId: transfer.source.branchId, note: `تحويل صادر - TRF-${transfer.transferNumber}` },
        ],
      });

      const updated = await tx.treasuryTransfer.update({
        where: { id }, data: { status: "CONFIRMED", journalEntryId: posted.journalEntryId, periodId: period.id, confirmedBy: user.id, confirmedAt: new Date() },
        include: this.include,
      });
      await this.audit.write({
        tx, actorId: user.id, action: "CONFIRM", entityType: "treasury_transfer", entityId: id,
        afterSnapshot: { status: "CONFIRMED", journalEntryId: posted.journalEntryId, amount: amount.toFixed(2) },
        summaryAr: `${user.name} أكّد التحويل TRF-${transfer.transferNumber} بمبلغ ${amount.toFixed(2)}`,
        summaryEn: `${user.name} confirmed transfer TRF-${transfer.transferNumber} for ${amount.toFixed(2)}`,
      });
      return this.fmt(updated);
    });
  }

  // ── cancel (reverse) ──────────────────────────────────────────────────
  async cancel(id: string, body: CancelTreasuryTransfer, user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM treasury_transfers WHERE id = ${id}::uuid FOR UPDATE`;
      const transfer = await tx.treasuryTransfer.findUnique({ where: { id }, include: { source: true, destination: true } });
      if (!transfer) throw new NotFoundError({ id });
      this.assertBranchOrNotFound(user, [transfer.source.branchId, transfer.destination.branchId], id);
      if (transfer.status === "CANCELLED") throw new ValidationError({ reason: "transfer_already_cancelled" });

      // A draft cancel just marks it cancelled (nothing posted).
      if (transfer.status === "DRAFT") {
        const updated = await tx.treasuryTransfer.update({ where: { id }, data: { status: "CANCELLED", cancelledBy: user.id, cancelledAt: new Date() }, include: this.include });
        await this.audit.write({ tx, actorId: user.id, action: "CANCEL", entityType: "treasury_transfer", entityId: id, afterSnapshot: { status: "CANCELLED" }, summaryAr: `${user.name} ألغى مسودة تحويل TRF-${transfer.transferNumber}`, summaryEn: `${user.name} cancelled draft transfer TRF-${transfer.transferNumber}` });
        return this.fmt(updated);
      }

      // Confirmed → reverse the journal (never delete history).
      if (!transfer.journalEntryId) throw new ValidationError({ reason: "transfer_missing_journal" });
      // Reversing history must always succeed — acknowledge the warn-only guard.
      const reversal = await this.reversal.reverse({ tx, entryId: transfer.journalEntryId, reason: body.reason, actor: user, acknowledgeNegativeBalance: true, negativeBalanceReason: "transfer_cancellation_reversal" });
      const updated = await tx.treasuryTransfer.update({
        where: { id }, data: { status: "CANCELLED", reversalJournalEntryId: reversal.journalEntryId, cancelledBy: user.id, cancelledAt: new Date() },
        include: this.include,
      });
      await this.audit.write({
        tx, actorId: user.id, action: "CANCEL", entityType: "treasury_transfer", entityId: id,
        afterSnapshot: { status: "CANCELLED", reversalJournalEntryId: reversal.journalEntryId, reason: body.reason },
        summaryAr: `${user.name} ألغى التحويل TRF-${transfer.transferNumber} وعكس القيد`,
        summaryEn: `${user.name} cancelled transfer TRF-${transfer.transferNumber} and reversed the journal`,
      });
      return this.fmt(updated);
    });
  }
}
