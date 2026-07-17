import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { Prisma, PrismaService } from "../../prisma/prisma.service";
import {
  BranchForbiddenError,
  RepresentativeInactiveError,
  RepresentativeNotFoundError,
} from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import {
  StatementService,
  type StatementLineInput,
} from "../accounting-statements/statement.service";

type Tx = Prisma.TransactionClient;

/**
 * The set of branches a statement may read, resolved from the caller.
 * `branchIn === null` means no restriction (OWNER, or a financial role with no
 * branch grants configured). `includeBranchless` keeps branch-agnostic manual
 * GL lines visible so a rep's authoritative balance stays complete — a NULL
 * branch can't be attributed to an unauthorized branch, so it never leaks one.
 */
export interface BranchScope {
  branchIn: string[] | null;
  includeBranchless: boolean;
}

/** One row in the combined representative statement timeline. */
export interface RepStatementRow {
  kind: "SALES_INVOICE" | "JOURNAL";
  date: string; // YYYY-MM-DD
  reference: string | null;
  description: string | null;
  counterparty: string | null; // customer (invoice) or account code — name (journal)
  branchId: string | null;
  branchName: string | null;
  invoiceValue: string | null; // grand total for invoice rows; null for journal rows
  debit: string | null;
  credit: string | null;
  runningBalance: string;
  status: string | null;
  // Drilldown — never parse text; open by id.
  salesInvoiceId: string | null;
  journalEntryId: string | null;
  journalLineId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  isReversal: boolean;
}

export interface RepStatementResult {
  representative: { id: string; code: string; nameAr: string; nameEn: string | null; phone: string | null; active: boolean };
  openingBalance: string;
  periodDebit: string;
  periodCredit: string;
  closingBalance: string;
  salesInvoiceCount: number;
  confirmedSalesTotal: string;
  // Pagination over the combined timeline (header totals above are the FULL
  // filtered set, never limited to the current page).
  page: number;
  limit: number;
  totalRows: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
  pageOpeningBalance: string; // running balance entering the first row of this page
  rows: RepStatementRow[];
}

export interface RepFinancialSummary {
  periodDebit: string;
  periodCredit: string;
  netBalance: string; // debit − credit (all posted movements up to now)
}

/**
 * A sales representative is a reporting/accounting DIMENSION, never a GL
 * account. Its financial balance is derived ONLY from posted journal_lines that
 * carry sales_representative_id — sales invoices are informational activity that
 * never moves the balance. This mirrors how customer/supplier statements are
 * built from the General Ledger; nothing is read from legacy balance tables.
 */
@Injectable()
export class SalesRepresentativesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Next REP-#### code, generated under the caller's transaction/advisory lock. */
  async nextCode(client: Tx | PrismaService = this.prisma): Promise<string> {
    const rows = await client.$queryRaw<Array<{ max_code: string | null }>>`
      SELECT MAX(code) AS max_code FROM sales_representatives WHERE code ~ '^REP-[0-9]+$'
    `;
    const max = rows[0]?.max_code;
    const next = max ? parseInt(max.split("-")[1]!, 10) + 1 : 1;
    return `REP-${String(next).padStart(4, "0")}`;
  }

  /** Loads a representative or throws the typed not-found error. */
  async require(id: string, client: Tx | PrismaService = this.prisma) {
    const rep = await client.salesRepresentative.findUnique({ where: { id } });
    if (!rep) throw new RepresentativeNotFoundError({ salesRepresentativeId: id });
    return rep;
  }

  /**
   * Validates a representative that is being attached to a NEW record: it must
   * exist and be active. Historical records referencing an inactive rep stay
   * readable — this guard only runs on assignment.
   */
  async assertAssignable(id: string, client: Tx | PrismaService = this.prisma): Promise<void> {
    const rep = await this.require(id, client);
    if (!rep.active) throw new RepresentativeInactiveError({ salesRepresentativeId: id, code: rep.code });
  }

  /**
   * Resolves the branch set the caller may read, enforcing branch access BEFORE
   * any total is computed (so a restricted user never sees an unrestricted
   * number). OWNER is unrestricted. A requested branchId is validated against
   * the user's grants and yields a single-branch, branch-only view. Otherwise a
   * non-OWNER is scoped to their granted branches (plus branch-agnostic rows).
   */
  resolveBranchScope(user: AuthenticatedUser, requestedBranchId?: string): BranchScope {
    if (requestedBranchId) {
      if (user.role !== "OWNER" && !user.allowedBranches.includes(requestedBranchId)) {
        throw new BranchForbiddenError({ branchId: requestedBranchId });
      }
      // A specific branch view shows only that branch's activity.
      return { branchIn: [requestedBranchId], includeBranchless: false };
    }
    if (user.role === "OWNER" || user.allowedBranches.length === 0) {
      return { branchIn: null, includeBranchless: true };
    }
    return { branchIn: user.allowedBranches, includeBranchless: true };
  }

  /** journal_lines.branchId filter for a scope (branch-agnostic lines optional). */
  private journalBranchWhere(scope: BranchScope): Prisma.JournalLineWhereInput {
    if (scope.branchIn === null) return {};
    return {
      OR: [
        { branchId: { in: scope.branchIn } },
        ...(scope.includeBranchless ? [{ branchId: null }] : []),
      ],
    };
  }

  /**
   * Details-page financial cards: total posted debit/credit and the net balance
   * for the rep, up to now, computed Decimal-safe from journal_lines (never from
   * invoices). Respects the caller's branch scope.
   */
  async financialSummary(id: string, scope: BranchScope): Promise<RepFinancialSummary> {
    const agg = await this.prisma.journalLine.aggregate({
      where: {
        salesRepresentativeId: id,
        journalEntry: { status: { in: ["POSTED", "REVERSED"] } },
        ...this.journalBranchWhere(scope),
      },
      _sum: { debit: true, credit: true },
    });
    const debit = new Decimal(agg._sum.debit?.toString() ?? "0");
    const credit = new Decimal(agg._sum.credit?.toString() ?? "0");
    return {
      periodDebit: debit.toFixed(2),
      periodCredit: credit.toFixed(2),
      netBalance: debit.sub(credit).toFixed(2),
    };
  }

  /** Builds the combined sales-activity + financial-movement statement. */
  async buildStatement(
    id: string,
    query: { from?: string; to?: string; type?: "all" | "invoice" | "journal"; invoiceStatus?: string; page?: number; limit?: number },
    scope: BranchScope,
  ): Promise<RepStatementResult> {
    const rep = await this.require(id);
    const type = query.type ?? "all";
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));

    // ── Financial movements: posted journal_lines carrying this rep ──────────
    // POSTED and REVERSED entries are both included so a reversal nets correctly
    // (its opposite line cancels the original), exactly like every other GL
    // statement. Drafts, if any, are excluded from the balance.
    const journalRows: RepStatementRow[] = [];
    let opening = "0.00", periodDebit = "0.00", periodCredit = "0.00", closing = "0.00";

    if (type !== "invoice") {
      const lines = (await this.prisma.journalLine.findMany({
        where: {
          salesRepresentativeId: id,
          journalEntry: { status: { in: ["POSTED", "REVERSED"] } },
          ...this.journalBranchWhere(scope),
        },
        include: StatementService.lineInclude,
        orderBy: StatementService.lineOrderBy,
      })) as unknown as StatementLineInput[];

      // Debit-normal: a positive balance is مدين (owed by the rep).
      const reduced = StatementService.reduce(lines, () => "DEBIT", query.from, query.to);
      opening = reduced.openingBalance;
      periodDebit = reduced.periodDebit;
      periodCredit = reduced.periodCredit;
      closing = reduced.endingBalance;

      const accountIds = [...new Set(reduced.rows.map((r) => r.accountId))];
      const accounts = await this.prisma.account.findMany({
        where: { id: { in: accountIds } }, select: { id: true, code: true, nameAr: true },
      });
      const branchIds = [...new Set(reduced.rows.map((r) => r.branchId).filter((b): b is string => !!b))];
      const branches = await this.prisma.branch.findMany({
        where: { id: { in: branchIds } }, select: { id: true, nameAr: true },
      });
      const accById = new Map(accounts.map((a) => [a.id, a]));
      const brById = new Map(branches.map((b) => [b.id, b]));

      for (const r of reduced.rows) {
        const acc = accById.get(r.accountId);
        journalRows.push({
          kind: "JOURNAL",
          date: r.entryDate,
          reference: r.entryNumber,
          description: r.description,
          counterparty: acc ? `${acc.code} — ${acc.nameAr}` : null,
          branchId: r.branchId,
          branchName: r.branchId ? brById.get(r.branchId)?.nameAr ?? null : null,
          invoiceValue: null,
          debit: r.debit,
          credit: r.credit,
          runningBalance: r.runningBalance,
          status: r.isReversal ? "REVERSED" : "POSTED",
          salesInvoiceId: null,
          journalEntryId: r.journalEntryId,
          journalLineId: r.journalLineId,
          sourceType: r.sourceType,
          sourceId: r.sourceId,
          isReversal: r.isReversal,
        });
      }
    }

    // ── Sales activity: invoices assigned to this rep (informational) ────────
    const invoiceRows: RepStatementRow[] = [];
    let salesInvoiceCount = 0;
    let confirmedSalesTotal = new Decimal(0);

    if (type !== "journal") {
      const fromDate = query.from ? new Date(query.from) : undefined;
      const toDate = query.to ? new Date(query.to) : undefined;
      // The invoice-status filter is a DISPLAY filter over rows only. The header
      // stats (count, confirmed total) are computed across all statuses in the
      // branch/date scope, so filtering the displayed rows never distorts them.
      const invoices = await this.prisma.salesInvoice.findMany({
        where: {
          salesRepresentativeId: id,
          // Invoices always carry a branch, so scope filters directly.
          ...(scope.branchIn ? { branchId: { in: scope.branchIn } } : {}),
          ...(fromDate || toDate
            ? { invoiceDate: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } }
            : {}),
        },
        select: {
          id: true, invoiceNumber: true, invoiceDate: true, status: true, grandTotal: true, notes: true,
          customer: { select: { nameAr: true } },
          branch: { select: { id: true, nameAr: true } },
        },
        orderBy: [{ invoiceDate: "asc" }, { invoiceNumber: "asc" }],
      });

      for (const inv of invoices) {
        salesInvoiceCount += 1;
        // Confirmed sales exclude drafts and cancelled invoices.
        if (inv.status === "CONFIRMED" || inv.status === "PAID") {
          confirmedSalesTotal = confirmedSalesTotal.add(new Decimal(inv.grandTotal.toString()));
        }
        // Row display honours the status filter; header stats above do not.
        if (query.invoiceStatus && inv.status !== query.invoiceStatus) continue;
        invoiceRows.push({
          kind: "SALES_INVOICE",
          date: inv.invoiceDate.toISOString().slice(0, 10),
          reference: String(inv.invoiceNumber),
          description: inv.notes ?? null,
          counterparty: inv.customer?.nameAr ?? null,
          branchId: inv.branch?.id ?? null,
          branchName: inv.branch?.nameAr ?? null,
          invoiceValue: new Decimal(inv.grandTotal.toString()).toFixed(2),
          debit: null,
          credit: null,
          runningBalance: "", // filled by the carry-forward pass below
          status: inv.status,
          salesInvoiceId: inv.id,
          journalEntryId: null,
          journalLineId: null,
          sourceType: "SALES_INVOICE",
          sourceId: inv.id,
          isReversal: false,
        });
      }
    }

    // ── Merge into one deterministic timeline ───────────────────────────────
    // Journal rows carry the authoritative running balance; invoice rows never
    // change it, so they inherit the balance in force at their position.
    const kindOrder = (r: RepStatementRow) => (r.kind === "SALES_INVOICE" ? 0 : 1);
    const merged = [...invoiceRows, ...journalRows].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (kindOrder(a) !== kindOrder(b)) return kindOrder(a) - kindOrder(b);
      const ra = a.reference ?? "", rb = b.reference ?? "";
      return ra === rb ? 0 : ra < rb ? -1 : 1;
    });

    let running = opening;
    for (const r of merged) {
      if (r.kind === "JOURNAL") running = r.runningBalance;
      else r.runningBalance = running;
    }

    // Paginate the ONE merged timeline (never invoices/journals separately).
    // Header totals stay full-set; only `rows` is the page. `pageOpeningBalance`
    // is the balance entering the page, so a later page shows correct running
    // balances without restarting from the global opening.
    const totalRows = merged.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / limit));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * limit;
    const pageRows = merged.slice(start, start + limit);
    const pageOpeningBalance = start === 0 ? opening : merged[start - 1]!.runningBalance;

    return {
      representative: { id: rep.id, code: rep.code, nameAr: rep.nameAr, nameEn: rep.nameEn, phone: rep.phone, active: rep.active },
      openingBalance: opening,
      periodDebit,
      periodCredit,
      closingBalance: closing,
      salesInvoiceCount,
      confirmedSalesTotal: confirmedSalesTotal.toFixed(2),
      page: safePage,
      limit,
      totalRows,
      totalPages,
      hasPrev: safePage > 1,
      hasNext: safePage < totalPages,
      pageOpeningBalance,
      rows: pageRows,
    };
  }
}
