import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import type {
  CreateReceiptVoucher,
  UpdateReceiptVoucher,
  ReceiptVoucherReverse,
  ReceiptVoucherQuery,
  PostingLine,
} from "@shorok/shared";
import { Prisma, PrismaService } from "../../prisma/prisma.service";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { AuditService } from "../audit/audit.service";
import { PostingEngine } from "../posting/posting.engine";
import { ReversalService } from "../posting/reversal.service";
import { EffectiveConfigService } from "../configuration/effective-config.service";

type Tx = Prisma.TransactionClient;
type AllocInput = { salesInvoiceId: string; amount: string };

/**
 * Receipt vouchers (Phase 4B-2): customer receipts posted through the single
 * PostingEngine path — Dr Treasury / Cr AR_CONTROL [CUSTOMER party]. Draft
 * lifecycle (DRAFT → POSTED → REVERSED); posted/reversed are immutable and
 * corrected only by reversal. AR resolves from the effective PostingProfile;
 * the treasury GL account is used directly. No legacy ledger writes.
 */
@Injectable()
export class ReceiptVouchersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly postingEngine: PostingEngine,
    private readonly reversal: ReversalService,
    private readonly effectiveConfig: EffectiveConfigService,
  ) {}

  // ── validation helpers ───────────────────────────────────────────────
  private async requireBranch(tx: Tx, branchId: string) {
    const b = await tx.branch.findUnique({ where: { id: branchId } });
    if (!b || !b.active) throw new NotFoundError({ reason: "branch_not_found", branchId });
    return b;
  }

  private async requireCustomer(tx: Tx, customerId: string) {
    const c = await tx.customer.findUnique({ where: { id: customerId } });
    if (!c || !c.active) throw new NotFoundError({ reason: "customer_not_found", customerId });
    return c;
  }

  private async requireTreasury(tx: Tx, treasuryAccountId: string) {
    const a = await tx.account.findUnique({
      where: { id: treasuryAccountId },
      select: { id: true, code: true, nameAr: true, isLeaf: true, active: true, isCashOrBank: true, treasuryType: true, systemRole: true },
    });
    if (!a) throw new ValidationError({ reason: "invalid_treasury_account", treasuryAccountId });
    if (a.systemRole === "AR_CONTROL" || a.systemRole === "AP_CONTROL")
      throw new ValidationError({ reason: "invalid_treasury_account", treasuryAccountId });
    if (!a.isLeaf) throw new ValidationError({ reason: "treasury_account_not_leaf", treasuryAccountId });
    if (!a.active) throw new ValidationError({ reason: "treasury_account_inactive", treasuryAccountId });
    if (!a.isCashOrBank || (a.treasuryType !== "CASH" && a.treasuryType !== "BANK"))
      throw new ValidationError({ reason: "invalid_treasury_account", treasuryAccountId });
    return a;
  }

  /**
   * Validate allocations against the voucher's amount/customer/branch and each
   * invoice's remaining allocatable balance. `excludeVoucherId` excludes the
   * current voucher's own existing allocations from the "allocated elsewhere"
   * sum (so an update/post is measured against OTHER vouchers only).
   */
  private async validateAllocations(
    tx: Tx,
    args: { allocations: AllocInput[]; amount: Decimal; customerId: string; branchId: string; excludeVoucherId?: string },
  ) {
    const { allocations } = args;
    if (allocations.length === 0) return;

    const ids = allocations.map((a) => a.salesInvoiceId);
    if (new Set(ids).size !== ids.length) throw new ValidationError({ reason: "duplicate_allocation" });

    const total = allocations.reduce((s, a) => s.add(a.amount), new Decimal(0));
    if (total.gt(args.amount)) throw new ValidationError({ reason: "allocation_total_exceeds_voucher" });

    for (const alloc of allocations) {
      const inv = await tx.salesInvoice.findUnique({
        where: { id: alloc.salesInvoiceId },
        select: { id: true, customerId: true, branchId: true, status: true, grandTotal: true },
      });
      if (!inv) throw new ValidationError({ reason: "allocation_invoice_not_found", salesInvoiceId: alloc.salesInvoiceId });
      if (inv.customerId !== args.customerId) throw new ValidationError({ reason: "allocation_customer_mismatch", salesInvoiceId: alloc.salesInvoiceId });
      if (inv.branchId !== args.branchId) throw new ValidationError({ reason: "allocation_branch_mismatch", salesInvoiceId: alloc.salesInvoiceId });
      if (inv.status === "CANCELLED" || inv.status === "DRAFT")
        throw new ValidationError({ reason: "allocation_document_not_eligible", salesInvoiceId: alloc.salesInvoiceId, status: inv.status });

      const otherAgg = await tx.receiptVoucherAllocation.aggregate({
        _sum: { amount: true },
        where: { salesInvoiceId: alloc.salesInvoiceId, ...(args.excludeVoucherId ? { receiptVoucherId: { not: args.excludeVoucherId } } : {}) },
      });
      const allocatedElsewhere = new Decimal(otherAgg._sum.amount?.toString() ?? "0");
      const remaining = new Decimal(inv.grandTotal.toString()).sub(allocatedElsewhere);
      if (new Decimal(alloc.amount).gt(remaining))
        throw new ValidationError({ reason: "allocation_exceeds_invoice_balance", salesInvoiceId: alloc.salesInvoiceId });
    }
  }

  // ── serialization ────────────────────────────────────────────────────
  private fmtAllocation(a: { id: string; salesInvoiceId: string; amount: unknown; salesInvoice?: { invoiceNumber: bigint } | null }) {
    return {
      id: a.id,
      salesInvoiceId: a.salesInvoiceId,
      invoiceNumber: a.salesInvoice ? String(a.salesInvoice.invoiceNumber) : null,
      amount: new Decimal((a.amount as { toString(): string }).toString()).toFixed(2),
    };
  }

  private fmtSummary(v: any) {
    return {
      id: v.id,
      voucherNumber: String(v.voucherNumber),
      voucherDate: v.voucherDate instanceof Date ? v.voucherDate.toISOString().slice(0, 10) : String(v.voucherDate),
      status: v.status,
      branchId: v.branchId,
      branchNameAr: v.branch?.nameAr ?? "",
      customerId: v.customerId,
      customerNameAr: v.customer?.nameAr ?? "",
      treasuryAccountId: v.treasuryAccountId,
      treasuryAccountCode: v.treasuryAccount?.code ?? "",
      amount: new Decimal(v.amount.toString()).toFixed(2),
      reference: v.reference ?? null,
      allocationCount: v._count?.allocations ?? (v.allocations ? v.allocations.length : 0),
      journalEntryId: v.journalEntryId ?? null,
      createdAt: v.createdAt.toISOString(),
    };
  }

  private fmtDetail(v: any) {
    return {
      ...this.fmtSummary(v),
      memo: v.memo ?? null,
      treasuryAccountNameAr: v.treasuryAccount?.nameAr ?? "",
      periodId: v.periodId ?? null,
      reversalJournalEntryId: v.reversalJournalEntryId ?? null,
      postedBy: v.postedBy ?? null,
      reversedBy: v.reversedBy ?? null,
      postedAt: v.postedAt ? v.postedAt.toISOString() : null,
      reversedAt: v.reversedAt ? v.reversedAt.toISOString() : null,
      updatedAt: v.updatedAt.toISOString(),
      allocations: (v.allocations ?? []).map((a: any) => this.fmtAllocation(a)),
    };
  }

  // ── create draft ─────────────────────────────────────────────────────
  async create(body: CreateReceiptVoucher, user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      await this.requireBranch(tx, body.branchId);
      await this.requireCustomer(tx, body.customerId);
      await this.requireTreasury(tx, body.treasuryAccountId);
      const amount = new Decimal(body.amount);
      const allocations = body.allocations ?? [];
      await this.validateAllocations(tx, { allocations, amount, customerId: body.customerId, branchId: body.branchId });

      const voucher = await tx.receiptVoucher.create({
        data: {
          voucherDate: new Date(body.voucherDate),
          branchId: body.branchId,
          customerId: body.customerId,
          treasuryAccountId: body.treasuryAccountId,
          amount: amount.toFixed(2),
          reference: body.reference ?? null,
          memo: body.memo ?? null,
          status: "DRAFT",
          createdBy: user.id,
          allocations: { create: allocations.map((a) => ({ salesInvoiceId: a.salesInvoiceId, amount: new Decimal(a.amount).toFixed(2) })) },
        },
      });

      await this.audit.write({
        tx, actorId: user.id, action: "CREATE", entityType: "receipt_voucher", entityId: voucher.id,
        afterSnapshot: { status: "DRAFT", amount: amount.toFixed(2), customerId: body.customerId, branchId: body.branchId, allocations: allocations.length },
        summaryAr: `${user.name} أنشأ سند قبض بمبلغ ${amount.toFixed(2)} ج.م`,
        summaryEn: `${user.name} created receipt voucher for ${amount.toFixed(2)} EGP`,
      });

      return this.getById(voucher.id, tx);
    });
  }

  // ── update draft ─────────────────────────────────────────────────────
  async update(id: string, body: UpdateReceiptVoucher, user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.receiptVoucher.findUnique({ where: { id } });
      if (!existing) throw new NotFoundError({ reason: "receipt_voucher_not_found", id });
      if (existing.status !== "DRAFT") throw new ValidationError({ reason: "receipt_voucher_not_draft", status: existing.status });

      const branchId = body.branchId ?? existing.branchId;
      const customerId = body.customerId ?? existing.customerId;
      const treasuryAccountId = body.treasuryAccountId ?? existing.treasuryAccountId;
      const amount = new Decimal(body.amount ?? existing.amount.toString());
      if (body.branchId) await this.requireBranch(tx, branchId);
      if (body.customerId) await this.requireCustomer(tx, customerId);
      if (body.treasuryAccountId) await this.requireTreasury(tx, treasuryAccountId);

      // Allocations to persist: the new set if provided, else the existing rows.
      const allocations: AllocInput[] = body.allocations
        ? body.allocations.map((a) => ({ salesInvoiceId: a.salesInvoiceId, amount: a.amount }))
        : (await tx.receiptVoucherAllocation.findMany({ where: { receiptVoucherId: id } })).map((a) => ({ salesInvoiceId: a.salesInvoiceId, amount: a.amount.toString() }));
      await this.validateAllocations(tx, { allocations, amount, customerId, branchId, excludeVoucherId: id });

      await tx.receiptVoucher.update({
        where: { id },
        data: {
          ...(body.voucherDate ? { voucherDate: new Date(body.voucherDate) } : {}),
          ...(body.branchId ? { branchId } : {}),
          ...(body.customerId ? { customerId } : {}),
          ...(body.treasuryAccountId ? { treasuryAccountId } : {}),
          ...(body.amount ? { amount: amount.toFixed(2) } : {}),
          ...(body.reference !== undefined ? { reference: body.reference } : {}),
          ...(body.memo !== undefined ? { memo: body.memo } : {}),
          ...(body.allocations
            ? { allocations: { deleteMany: {}, create: body.allocations.map((a) => ({ salesInvoiceId: a.salesInvoiceId, amount: new Decimal(a.amount).toFixed(2) })) } }
            : {}),
        },
      });

      await this.audit.write({
        tx, actorId: user.id, action: "UPDATE", entityType: "receipt_voucher", entityId: id,
        afterSnapshot: { amount: amount.toFixed(2), customerId, branchId, allocations: allocations.length },
        summaryAr: `${user.name} عدّل سند القبض`, summaryEn: `${user.name} updated the receipt voucher`,
      });

      return this.getById(id, tx);
    });
  }

  // ── delete draft ─────────────────────────────────────────────────────
  async remove(id: string, user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.receiptVoucher.findUnique({ where: { id } });
      if (!existing) throw new NotFoundError({ reason: "receipt_voucher_not_found", id });
      if (existing.status !== "DRAFT") throw new ValidationError({ reason: "use_reverse_instead", status: existing.status });

      await tx.receiptVoucher.delete({ where: { id } }); // allocations cascade
      await this.audit.write({
        tx, actorId: user.id, action: "DELETE", entityType: "receipt_voucher", entityId: id,
        beforeSnapshot: { status: existing.status, amount: existing.amount.toString(), voucherNumber: String(existing.voucherNumber) },
        summaryAr: `${user.name} حذف سند قبض (مسودة)`, summaryEn: `${user.name} deleted a draft receipt voucher`,
      });
      return { success: true };
    });
  }

  // ── post ─────────────────────────────────────────────────────────────
  async post(id: string, user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      const v = await tx.receiptVoucher.findUnique({ where: { id }, include: { customer: true } });
      if (!v) throw new NotFoundError({ reason: "receipt_voucher_not_found", id });
      if (v.status !== "DRAFT") throw new ValidationError({ reason: "receipt_voucher_not_draft", status: v.status });

      await this.requireBranch(tx, v.branchId);
      await this.requireTreasury(tx, v.treasuryAccountId);
      const amount = new Decimal(v.amount.toString());

      const voucherDateStr = v.voucherDate.toISOString().slice(0, 10);
      const profile = await this.effectiveConfig.postingProfileAsOf(voucherDateStr, tx);
      const arAccountId = profile?.arAccountId ?? null;
      if (!arAccountId) throw new ValidationError({ reason: "ar_account_required" });

      // Revalidate allocations against current state inside the transaction.
      const allocs = (await tx.receiptVoucherAllocation.findMany({ where: { receiptVoucherId: id } })).map((a) => ({ salesInvoiceId: a.salesInvoiceId, amount: a.amount.toString() }));
      await this.validateAllocations(tx, { allocations: allocs, amount, customerId: v.customerId, branchId: v.branchId, excludeVoucherId: id });

      const num = String(v.voucherNumber);
      const lines: PostingLine[] = [
        { accountId: v.treasuryAccountId, debit: amount.toFixed(2), credit: "0", note: `تحصيل نقدي — RV-${num}` },
        { accountId: arAccountId, debit: "0", credit: amount.toFixed(2), note: `تحصيل من ${v.customer.nameAr} — RV-${num}`, partyType: "CUSTOMER", partyId: v.customerId },
      ];
      const posted = await this.postingEngine.post({
        tx, actor: user, sourceType: "RECEIPT_VOUCHER", sourceId: v.id, entryType: "RECEIPT_VOUCHER",
        entryDate: voucherDateStr, reference: `RV-${num}`,
        description: `سند قبض رقم ${num} — ${v.customer.nameAr}`,
        idempotencyKey: `RECEIPT_VOUCHER:${v.id}`, lines,
      });
      const je = await tx.journalEntry.findUnique({ where: { id: posted.journalEntryId }, select: { periodId: true } });

      await tx.receiptVoucher.update({
        where: { id },
        data: { status: "POSTED", journalEntryId: posted.journalEntryId, periodId: je?.periodId ?? null, postedBy: user.id, postedAt: new Date() },
      });
      await this.audit.write({
        tx, actorId: user.id, action: "CONFIRM", entityType: "receipt_voucher", entityId: id,
        afterSnapshot: { status: "POSTED", journalEntryId: posted.journalEntryId, amount: amount.toFixed(2) },
        summaryAr: `${user.name} رحّل سند القبض رقم ${num}`, summaryEn: `${user.name} posted receipt voucher #${num}`,
      });
      return this.getById(id, tx);
    });
  }

  // ── reverse ──────────────────────────────────────────────────────────
  async reverseVoucher(id: string, body: ReceiptVoucherReverse, user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      const v = await tx.receiptVoucher.findUnique({ where: { id } });
      if (!v) throw new NotFoundError({ reason: "receipt_voucher_not_found", id });
      if (v.status === "REVERSED" && v.reversalJournalEntryId) return this.getById(id, tx); // idempotent
      if (v.status !== "POSTED" || !v.journalEntryId) throw new ValidationError({ reason: "receipt_voucher_not_posted", status: v.status });

      const result = await this.reversal.reverse({ entryId: v.journalEntryId, reason: body.reason, reversalDate: body.reversalDate, actor: user, tx });

      await tx.receiptVoucher.update({
        where: { id },
        data: { status: "REVERSED", reversalJournalEntryId: result.journalEntryId, reversedBy: user.id, reversedAt: new Date() },
      });
      await this.audit.write({
        tx, actorId: user.id, action: "CANCEL", entityType: "receipt_voucher", entityId: id,
        beforeSnapshot: { status: "POSTED", journalEntryId: v.journalEntryId },
        afterSnapshot: { status: "REVERSED", reversalJournalEntryId: result.journalEntryId, reason: body.reason },
        summaryAr: `${user.name} عكس سند القبض رقم ${String(v.voucherNumber)}`, summaryEn: `${user.name} reversed receipt voucher #${String(v.voucherNumber)}`,
      });
      return this.getById(id, tx);
    });
  }

  // ── list / get ───────────────────────────────────────────────────────
  async list(query: ReceiptVoucherQuery) {
    const where: Prisma.ReceiptVoucherWhereInput = {
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.treasuryAccountId ? { treasuryAccountId: query.treasuryAccountId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.dateFrom || query.dateTo
        ? { voucherDate: { ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}), ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}) } }
        : {}),
      ...(query.search ? { OR: [{ reference: { contains: query.search, mode: "insensitive" } }, { memo: { contains: query.search, mode: "insensitive" } }] } : {}),
    };
    const rows = await this.prisma.receiptVoucher.findMany({
      where,
      orderBy: [{ voucherDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        customer: { select: { id: true, nameAr: true } },
        branch: { select: { id: true, nameAr: true } },
        treasuryAccount: { select: { id: true, code: true, nameAr: true } },
        _count: { select: { allocations: true } },
      },
    });
    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    return { data: data.map((v) => this.fmtSummary(v)), nextCursor: hasMore ? data[data.length - 1]?.id ?? null : null };
  }

  async getById(id: string, tx?: Tx) {
    const db = tx ?? this.prisma;
    const v = await db.receiptVoucher.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, nameAr: true } },
        branch: { select: { id: true, nameAr: true } },
        treasuryAccount: { select: { id: true, code: true, nameAr: true } },
        allocations: { include: { salesInvoice: { select: { invoiceNumber: true } } }, orderBy: { createdAt: "asc" } },
      },
    });
    if (!v) throw new NotFoundError({ reason: "receipt_voucher_not_found", id });
    return this.fmtDetail(v);
  }
}
