import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import type {
  CreateTreasury,
  UpdateTreasury,
  TreasuryQuery,
  TreasuryOpeningBalance,
  TreasuryStatementQuery,
} from "@shorok/shared";
import { Prisma, PrismaService } from "../../prisma/prisma.service";
import { NotFoundError, ValidationError, ConflictError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { AuditService } from "../audit/audit.service";
import { PostingEngine } from "../posting/posting.engine";
import { EffectiveConfigService } from "../configuration/effective-config.service";

type Tx = Prisma.TransactionClient;

/**
 * Multi-treasury management. A Treasury is a thin, branch-scoped wrapper over
 * exactly one cash/bank leaf GL account. The GL account is the accounting
 * anchor — EVERY balance here is derived from journal_lines on that account
 * (Σ debit − credit), matching TreasuryGuardService; Treasury never stores a
 * mutable balance. Opening balances are posted through the single PostingEngine.
 */
@Injectable()
export class TreasuriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly postingEngine: PostingEngine,
    private readonly effectiveConfig: EffectiveConfigService,
  ) {}

  // ── branch scope ─────────────────────────────────────────────────────
  // 404 (not 403) for a non-OWNER reaching a treasury outside allowedBranches:
  // a foreign treasury is indistinguishable from a non-existent one (the
  // repo-wide no-existence-leak policy for direct :id access).
  private assertBranchOrNotFound(user: AuthenticatedUser, branchId: string, id: string) {
    if (user.role !== "OWNER" && !user.allowedBranches.includes(branchId)) throw new NotFoundError({ id });
  }

  private branchFilter(user: AuthenticatedUser): Prisma.TreasuryWhereInput {
    if (user.role === "OWNER") return {};
    return { branchId: { in: user.allowedBranches.length ? user.allowedBranches : ["__none__"] } };
  }

  // ── balance (journal-derived, authoritative) ─────────────────────────
  private async balanceOf(txOrPrisma: Tx | PrismaService, glAccountId: string, upToDate?: string): Promise<Decimal> {
    const rows = upToDate
      ? await txOrPrisma.$queryRaw<Array<{ bal: string }>>`
          SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS bal
          FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
          WHERE jl.account_id = ${glAccountId}::uuid AND je.entry_date <= ${upToDate}::date`
      : await txOrPrisma.$queryRaw<Array<{ bal: string }>>`
          SELECT COALESCE(SUM(debit - credit), 0)::text AS bal
          FROM journal_lines WHERE account_id = ${glAccountId}::uuid`;
    return new Decimal(rows[0]?.bal ?? "0");
  }

  private async balancesFor(glAccountIds: string[]): Promise<Map<string, string>> {
    if (glAccountIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ account_id: string; bal: string }>>`
      SELECT account_id, COALESCE(SUM(debit - credit), 0)::text AS bal
      FROM journal_lines WHERE account_id IN (${Prisma.join(glAccountIds.map((id) => Prisma.sql`${id}::uuid`))})
      GROUP BY account_id`;
    return new Map(rows.map((r) => [r.account_id, new Decimal(r.bal).toFixed(2)]));
  }

  // ── validation helpers ───────────────────────────────────────────────
  private async requireBranch(tx: Tx, branchId: string) {
    const b = await tx.branch.findUnique({ where: { id: branchId } });
    if (!b || !b.active) throw new NotFoundError({ reason: "branch_not_found", branchId });
    return b;
  }

  /** A GL account is a valid treasury anchor: leaf, active, cash/bank, not a control account. */
  private assertValidTreasuryAccount(a: {
    isLeaf: boolean; active: boolean; isCashOrBank: boolean; treasuryType: string | null; systemRole: string | null;
  }, glAccountId: string) {
    if (!a.isLeaf) throw new ValidationError({ reason: "gl_account_not_leaf", glAccountId });
    if (!a.active) throw new ValidationError({ reason: "gl_account_inactive", glAccountId });
    if (a.systemRole === "AR_CONTROL" || a.systemRole === "AP_CONTROL")
      throw new ValidationError({ reason: "gl_account_is_control", glAccountId });
    if (!a.isCashOrBank || (a.treasuryType !== "CASH" && a.treasuryType !== "BANK"))
      throw new ValidationError({ reason: "gl_account_not_cash_or_bank", glAccountId });
  }

  private async uniqueAccountCode(tx: Tx, base: string): Promise<string> {
    let code = base;
    for (let i = 0; i < 1000; i++) {
      const exists = await tx.account.findUnique({ where: { code }, select: { id: true } });
      if (!exists) return code;
      code = `${base}-${i + 1}`;
    }
    throw new ConflictError("errors.conflict", { reason: "could_not_allocate_account_code" });
  }

  private async uniqueTreasuryCode(tx: Tx, base: string): Promise<string> {
    let code = base;
    for (let i = 0; i < 1000; i++) {
      const exists = await tx.treasury.findUnique({ where: { code }, select: { id: true } });
      if (!exists) return code;
      code = `${base}-${i + 1}`;
    }
    throw new ConflictError("errors.conflict", { reason: "could_not_allocate_treasury_code" });
  }

  /** Most common parent of existing cash/bank accounts, so auto-created treasury GL accounts nest sensibly. */
  private async resolveCashParent(tx: Tx): Promise<{ id: string; code: string } | null> {
    const rows = await tx.$queryRaw<Array<{ parent_id: string; code: string }>>`
      SELECT a.parent_id, p.code
      FROM accounts a JOIN accounts p ON p.id = a.parent_id
      WHERE a.is_cash_or_bank = true AND a.treasury_type IN ('CASH','BANK') AND a.parent_id IS NOT NULL
      GROUP BY a.parent_id, p.code ORDER BY COUNT(*) DESC LIMIT 1`;
    return rows[0] ? { id: rows[0].parent_id, code: rows[0].code } : null;
  }

  // ── serialization ────────────────────────────────────────────────────
  private fmt(t: any, balance?: string) {
    return {
      id: t.id,
      code: t.code,
      nameAr: t.nameAr,
      nameEn: t.nameEn ?? null,
      branchId: t.branchId,
      branchNameAr: t.branch?.nameAr ?? "",
      glAccountId: t.glAccountId,
      glAccountCode: t.glAccount?.code ?? "",
      glAccountNameAr: t.glAccount?.nameAr ?? "",
      currencyCode: t.currencyCode,
      allowNegativeBalance: t.allowNegativeBalance,
      isDefault: t.isDefault,
      active: t.active,
      notes: t.notes ?? null,
      balance: balance ?? "0.00",
      createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : String(t.createdAt),
    };
  }

  // ── list ─────────────────────────────────────────────────────────────
  async list(user: AuthenticatedUser, query: TreasuryQuery) {
    const where: Prisma.TreasuryWhereInput = { ...this.branchFilter(user) };
    if (query.branchId) where.branchId = query.branchId;
    if (!query.includeInactive) where.active = true;
    const treasuries = await this.prisma.treasury.findMany({
      where,
      include: { branch: { select: { nameAr: true } }, glAccount: { select: { code: true, nameAr: true } } },
      orderBy: [{ isDefault: "desc" }, { code: "asc" }],
    });
    const balances = await this.balancesFor(treasuries.map((t) => t.glAccountId));
    return { items: treasuries.map((t) => this.fmt(t, balances.get(t.glAccountId) ?? "0.00")) };
  }

  // ── selector: only ACTIVE + authorized treasuries (for txn screens) ───
  async selector(user: AuthenticatedUser) {
    const treasuries = await this.prisma.treasury.findMany({
      where: { active: true, ...this.branchFilter(user) },
      include: { branch: { select: { nameAr: true } }, glAccount: { select: { code: true, nameAr: true } } },
      orderBy: [{ isDefault: "desc" }, { code: "asc" }],
    });
    const balances = await this.balancesFor(treasuries.map((t) => t.glAccountId));
    return { items: treasuries.map((t) => this.fmt(t, balances.get(t.glAccountId) ?? "0.00")) };
  }

  // ── detail ───────────────────────────────────────────────────────────
  private async loadOrNotFound(id: string, user: AuthenticatedUser) {
    const t = await this.prisma.treasury.findUnique({
      where: { id },
      include: { branch: { select: { nameAr: true } }, glAccount: { select: { code: true, nameAr: true } } },
    });
    if (!t) throw new NotFoundError({ id });
    this.assertBranchOrNotFound(user, t.branchId, id);
    return t;
  }

  async getOne(id: string, user: AuthenticatedUser) {
    const t = await this.loadOrNotFound(id, user);
    const balance = (await this.balanceOf(this.prisma, t.glAccountId)).toFixed(2);
    return this.fmt(t, balance);
  }

  // ── create ───────────────────────────────────────────────────────────
  async create(body: CreateTreasury, user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      await this.requireBranch(tx, body.branchId);

      // 1. Resolve or create the linked GL account.
      let glAccountId: string;
      if (body.glAccountId) {
        const a = await tx.account.findUnique({
          where: { id: body.glAccountId },
          select: { id: true, isLeaf: true, active: true, isCashOrBank: true, treasuryType: true, systemRole: true },
        });
        if (!a) throw new ValidationError({ reason: "gl_account_not_found", glAccountId: body.glAccountId });
        this.assertValidTreasuryAccount(a, body.glAccountId);
        const linked = await tx.treasury.findUnique({ where: { glAccountId: body.glAccountId }, select: { id: true } });
        if (linked) throw new ValidationError({ reason: "gl_account_already_linked", glAccountId: body.glAccountId });
        glAccountId = body.glAccountId;
      } else {
        // Auto-create a dedicated cash/bank leaf account under the cash parent.
        const parent = await this.resolveCashParent(tx);
        const baseCode = parent ? `${parent.code}-${body.treasuryType === "BANK" ? "BNK" : "CSH"}` : (body.treasuryType === "BANK" ? "BANK" : "CASH");
        const code = await this.uniqueAccountCode(tx, baseCode);
        if (parent) {
          await tx.account.update({ where: { id: parent.id }, data: { isLeaf: false } });
        }
        const created = await tx.account.create({
          data: {
            code, nameAr: body.nameAr, nameEn: body.nameEn ?? body.nameAr,
            category: "ASSET", accountType: "CURRENT_ASSET", parentId: parent?.id ?? null,
            isLeaf: true, active: true, isCashOrBank: true, treasuryType: body.treasuryType,
          },
        });
        glAccountId = created.id;
      }

      // 2. Default handling: first treasury is forced default; a new default unsets the old one.
      const count = await tx.treasury.count();
      let isDefault = body.isDefault;
      if (count === 0) isDefault = true;
      if (isDefault) await tx.treasury.updateMany({ where: { isDefault: true }, data: { isDefault: false } });

      // 3. Create the treasury.
      const treasuryCode = body.code
        ? await (async () => {
            const dup = await tx.treasury.findUnique({ where: { code: body.code! }, select: { id: true } });
            if (dup) throw new ValidationError({ reason: "treasury_code_exists", code: body.code });
            return body.code!;
          })()
        : await this.uniqueTreasuryCode(tx, `TRZ-${String(count + 1).padStart(3, "0")}`);

      const treasury = await tx.treasury.create({
        data: {
          code: treasuryCode, nameAr: body.nameAr, nameEn: body.nameEn ?? null,
          branchId: body.branchId, glAccountId, currencyCode: body.currencyCode,
          allowNegativeBalance: body.allowNegativeBalance, isDefault, active: true,
          notes: body.notes ?? null, createdBy: user.id,
        },
        include: { branch: { select: { nameAr: true } }, glAccount: { select: { code: true, nameAr: true } } },
      });

      await this.audit.write({
        tx, actorId: user.id, action: "CREATE", entityType: "treasury", entityId: treasury.id,
        afterSnapshot: { code: treasury.code, nameAr: treasury.nameAr, branchId: treasury.branchId, glAccountId, isDefault },
        summaryAr: `${user.name} أنشأ خزنة: ${treasury.code} — ${treasury.nameAr}`,
        summaryEn: `${user.name} created treasury: ${treasury.code} — ${treasury.nameAr}`,
      });

      return this.fmt(treasury, "0.00");
    });
  }

  // ── update metadata ──────────────────────────────────────────────────
  async update(id: string, body: UpdateTreasury, user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.treasury.findUnique({ where: { id } });
      if (!existing) throw new NotFoundError({ id });
      this.assertBranchOrNotFound(user, existing.branchId, id);

      if (body.isDefault === true && !existing.isDefault) {
        await tx.treasury.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      }
      if (body.isDefault === false && existing.isDefault) {
        throw new ValidationError({ reason: "cannot_unset_default_directly" });
      }

      const treasury = await tx.treasury.update({
        where: { id },
        data: {
          nameAr: body.nameAr ?? undefined,
          nameEn: body.nameEn === undefined ? undefined : body.nameEn,
          allowNegativeBalance: body.allowNegativeBalance ?? undefined,
          isDefault: body.isDefault ?? undefined,
          notes: body.notes === undefined ? undefined : body.notes,
        },
        include: { branch: { select: { nameAr: true } }, glAccount: { select: { code: true, nameAr: true } } },
      });
      await this.audit.write({
        tx, actorId: user.id, action: "UPDATE", entityType: "treasury", entityId: id,
        afterSnapshot: { nameAr: treasury.nameAr, allowNegativeBalance: treasury.allowNegativeBalance, isDefault: treasury.isDefault },
        summaryAr: `${user.name} عدّل الخزنة: ${treasury.code}`,
        summaryEn: `${user.name} updated treasury: ${treasury.code}`,
      });
      const balance = (await this.balanceOf(tx, treasury.glAccountId)).toFixed(2);
      return this.fmt(treasury, balance);
    });
  }

  // ── activate / deactivate ────────────────────────────────────────────
  async setActive(id: string, active: boolean, user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.treasury.findUnique({ where: { id } });
      if (!existing) throw new NotFoundError({ id });
      this.assertBranchOrNotFound(user, existing.branchId, id);
      if (existing.active === active) {
        const t = await tx.treasury.findUnique({ where: { id }, include: { branch: { select: { nameAr: true } }, glAccount: { select: { code: true, nameAr: true } } } });
        return this.fmt(t, (await this.balanceOf(tx, existing.glAccountId)).toFixed(2));
      }
      if (!active) {
        // The default treasury cannot be deactivated until another default is chosen.
        if (existing.isDefault) throw new ValidationError({ reason: "cannot_deactivate_default_treasury" });
        // Zero-balance rule before deactivation.
        const bal = await this.balanceOf(tx, existing.glAccountId);
        if (!bal.isZero()) throw new ValidationError({ reason: "treasury_balance_not_zero", balance: bal.toFixed(2) });
      }
      const treasury = await tx.treasury.update({
        where: { id }, data: { active },
        include: { branch: { select: { nameAr: true } }, glAccount: { select: { code: true, nameAr: true } } },
      });
      await this.audit.write({
        tx, actorId: user.id, action: "UPDATE", entityType: "treasury", entityId: id,
        afterSnapshot: { active },
        summaryAr: `${user.name} ${active ? "أعاد تنشيط" : "أوقف"} الخزنة: ${treasury.code}`,
        summaryEn: `${user.name} ${active ? "reactivated" : "deactivated"} treasury: ${treasury.code}`,
      });
      return this.fmt(treasury, (await this.balanceOf(tx, treasury.glAccountId)).toFixed(2));
    });
  }

  // ── opening balance (posted journal) ─────────────────────────────────
  async postOpeningBalance(id: string, body: TreasuryOpeningBalance, user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      const treasury = await tx.treasury.findUnique({ where: { id } });
      if (!treasury) throw new NotFoundError({ id });
      this.assertBranchOrNotFound(user, treasury.branchId, id);
      if (!treasury.active) throw new ValidationError({ reason: "treasury_inactive" });

      // Period must be open.
      const [year, month] = body.entryDate.split("-").map(Number);
      const period = await tx.financialPeriod.findUnique({ where: { year_month: { year, month } } });
      if (!period || period.status !== "OPEN") throw new ValidationError({ reason: "period_not_open", year, month });

      // Counterpart = provided, else opening-equity from the effective profile.
      let counterpartId = body.counterpartAccountId;
      if (!counterpartId) {
        const profile = await this.effectiveConfig.postingProfileAsOf(body.entryDate, tx);
        counterpartId = profile?.openingEquityAccountId ?? profile?.retainedEarningsAccountId ?? undefined;
        if (!counterpartId) throw new ValidationError({ reason: "opening_equity_account_not_configured" });
      }
      const counterpart = await tx.account.findUnique({ where: { id: counterpartId }, select: { id: true, isLeaf: true, active: true } });
      if (!counterpart || !counterpart.isLeaf || !counterpart.active) throw new ValidationError({ reason: "invalid_counterpart_account", counterpartAccountId: counterpartId });

      const branchId = body.branchId ?? treasury.branchId;
      const amount = new Decimal(body.amount).toFixed(2);

      const posted = await this.postingEngine.post({
        tx, actor: user, sourceType: "TREASURY_OPENING", sourceId: treasury.id, entryType: "JOURNAL",
        entryDate: body.entryDate, reference: body.reference ?? `OPEN-${treasury.code}`,
        description: `رصيد افتتاحي للخزنة ${treasury.code}${body.notes ? ` — ${body.notes}` : ""}`,
        idempotencyKey: `TREASURY_OPENING:${treasury.id}:${body.entryDate}:${amount}`,
        lines: [
          { accountId: treasury.glAccountId, debit: amount, credit: "0", branchId, note: `رصيد افتتاحي - ${treasury.code}` },
          { accountId: counterpartId, debit: "0", credit: amount, branchId, note: `رصيد افتتاحي - ${treasury.code}` },
        ],
      });

      await this.audit.write({
        tx, actorId: user.id, action: "CREATE", entityType: "treasury_opening_balance", entityId: treasury.id,
        afterSnapshot: { treasuryId: treasury.id, amount, entryDate: body.entryDate, journalEntryId: posted.journalEntryId, idempotent: posted.idempotent ?? false },
        summaryAr: `${user.name} سجّل رصيداً افتتاحياً ${amount} للخزنة ${treasury.code}`,
        summaryEn: `${user.name} posted an opening balance ${amount} for treasury ${treasury.code}`,
      });

      const balance = (await this.balanceOf(tx, treasury.glAccountId)).toFixed(2);
      return { treasuryId: treasury.id, journalEntryId: posted.journalEntryId, entryNumber: posted.entryNumber, idempotent: posted.idempotent ?? false, balance };
    });
  }

  // ── statement (journal-line derived, running balance) ────────────────
  async statement(id: string, query: TreasuryStatementQuery, user: AuthenticatedUser) {
    const treasury = await this.loadOrNotFound(id, user);
    const gl = treasury.glAccountId;

    // Opening balance = everything strictly before `from` (or 0 if no from).
    const opening = query.from
      ? await this.prisma.$queryRaw<Array<{ bal: string }>>`
          SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS bal
          FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
          WHERE jl.account_id = ${gl}::uuid AND je.entry_date < ${query.from}::date`
      : [{ bal: "0" }];
    const openingBalance = new Decimal(opening[0]?.bal ?? "0");

    // Lines within the window, chronological.
    const dateClauses: Prisma.Sql[] = [Prisma.sql`jl.account_id = ${gl}::uuid`];
    if (query.from) dateClauses.push(Prisma.sql`je.entry_date >= ${query.from}::date`);
    if (query.to) dateClauses.push(Prisma.sql`je.entry_date <= ${query.to}::date`);
    const where = Prisma.join(dateClauses, " AND ");

    const rows = await this.prisma.$queryRaw<Array<{
      id: string; entry_date: Date; entry_number: bigint; description: string; reference: string | null;
      source_type: string | null; source_id: string | null; debit: string; credit: string; note: string | null;
      branch_id: string | null; created_by: string; creator_name: string;
    }>>`
      SELECT jl.id, je.entry_date, je.entry_number, je.description, je.reference,
             je.source_type, je.source_id, jl.debit::text AS debit, jl.credit::text AS credit,
             jl.note, jl.branch_id, je.created_by, u.name AS creator_name
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      JOIN users u ON u.id = je.created_by
      WHERE ${where}
      ORDER BY je.entry_date ASC, je.entry_number ASC, jl.id ASC`;

    let running = openingBalance;
    const items = rows.map((r) => {
      running = running.add(new Decimal(r.debit)).sub(new Decimal(r.credit));
      return {
        journalLineId: r.id,
        entryDate: r.entry_date.toISOString().slice(0, 10),
        entryNumber: String(r.entry_number),
        documentType: r.source_type ?? "MANUAL",
        reference: r.reference ?? null,
        description: r.note ?? r.description,
        debit: new Decimal(r.debit).toFixed(2),
        credit: new Decimal(r.credit).toFixed(2),
        runningBalance: running.toFixed(2),
        branchId: r.branch_id,
        sourceType: r.source_type,
        sourceId: r.source_id,
        userName: r.creator_name,
      };
    });

    return {
      treasury: this.fmt(treasury, running.toFixed(2)),
      openingBalance: openingBalance.toFixed(2),
      closingBalance: running.toFixed(2),
      items,
    };
  }
}
