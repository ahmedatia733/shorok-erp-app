import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import {
  accountsInCategory,
  findCategory,
  normalSideForCategory,
  type AccountCategoryDef,
} from "@shorok/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import {
  StatementService,
  type NormalSide,
  type StatementLineInput,
  type StatementRow,
} from "./statement.service";

export interface BreakdownEntry {
  entityId: string;
  code: string;
  name: string;
  openingBalance: string;
  debit: string;
  credit: string;
  endingBalance: string;
}

/** A statement row enriched with the account it belongs to (needed once rows span accounts). */
export interface ConsolidatedRow extends StatementRow {
  accountCode: string;
  accountName: string;
}

export interface ConsolidatedStatementResult {
  selectionType: "consolidated" | "specific";
  category: string;
  entityId: string | null;
  entityLabel: string;
  openingBalance: string;
  periodDebit: string;
  periodCredit: string;
  endingBalance: string;
  breakdown: BreakdownEntry[];
  rows: ConsolidatedRow[];
}

interface AccountLite {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  category: string;
  accountType: string;
  systemRole: string | null;
  isCashOrBank: boolean | null;
  treasuryType: string | null;
  isLeaf: boolean;
  active: boolean;
}

/**
 * Builds unified statements for the Account Statement page, for a whole category
 * ("كل البنوك") or one entity ("بنك مصر"), always straight from the General
 * Ledger (journal_entries + journal_lines). No legacy table — payment_accounts,
 * order_collections, customer_transactions, factory ledger — is read, and no
 * balance is cached: every response is recomputed from journal lines.
 *
 * Both modes fold the same lines through {@link StatementService.reduce}, so a
 * category total is always exactly the sum of its members and can never
 * double-count or drift from the specific statement.
 */
@Injectable()
export class ConsolidatedStatementService {
  constructor(private readonly prisma: PrismaService) {}

  private async leafAccounts(): Promise<AccountLite[]> {
    return this.prisma.account.findMany({
      where: { isLeaf: true, active: true },
      select: {
        id: true, code: true, nameAr: true, nameEn: true, category: true, accountType: true,
        systemRole: true, isCashOrBank: true, treasuryType: true, isLeaf: true, active: true,
      },
      orderBy: { code: "asc" },
    });
  }

  private async linesForAccounts(accountIds: string[]): Promise<StatementLineInput[]> {
    if (accountIds.length === 0) return [];
    return this.prisma.journalLine.findMany({
      where: { accountId: { in: accountIds } },
      include: StatementService.lineInclude,
      orderBy: StatementService.lineOrderBy,
    }) as unknown as Promise<StatementLineInput[]>;
  }

  async build(params: {
    category: string;
    entityId?: string;
    from?: string;
    to?: string;
    includeZero?: boolean;
  }): Promise<ConsolidatedStatementResult> {
    const def = findCategory(params.category);
    if (!def) throw new ValidationError({ reason: "unknown_category", category: params.category });

    const specific = params.entityId && params.entityId !== "all" ? params.entityId : null;
    return def.kind === "ACCOUNTS"
      ? this.buildForAccounts(def, specific, params)
      : this.buildForParties(def, specific, params);
  }

  // ── GL account categories (banks, treasuries, expenses, …) ────────────────

  private async buildForAccounts(
    def: AccountCategoryDef,
    specific: string | null,
    params: { from?: string; to?: string; includeZero?: boolean },
  ): Promise<ConsolidatedStatementResult> {
    const all = await this.leafAccounts();
    const members = accountsInCategory(def.id, all);

    let selected = members;
    if (specific) {
      const one = members.find((a) => a.id === specific);
      if (!one) {
        // Either it doesn't exist, is inactive/parent, or belongs to another
        // category — all mean "not selectable here", so say so explicitly.
        throw new NotFoundError({ reason: "account_not_in_category", accountId: specific, category: def.id });
      }
      selected = [one];
    }

    const byId = new Map(selected.map((a) => [a.id, a]));
    const sideOf = (accountId: string): NormalSide => {
      const a = byId.get(accountId);
      return a ? normalSideForCategory(a.category) : "DEBIT";
    };

    const lines = await this.linesForAccounts(selected.map((a) => a.id));
    const linesByAccount = new Map<string, StatementLineInput[]>();
    for (const l of lines) {
      const list = linesByAccount.get(l.accountId);
      if (list) list.push(l);
      else linesByAccount.set(l.accountId, [l]);
    }

    // Per-account totals, each on its own normal side.
    const breakdown: BreakdownEntry[] = [];
    for (const a of selected) {
      const side = normalSideForCategory(a.category);
      const r = StatementService.reduce(linesByAccount.get(a.id) ?? [], () => side, params.from, params.to);
      const empty =
        isZero(r.openingBalance) && isZero(r.periodDebit) && isZero(r.periodCredit) && isZero(r.endingBalance);
      // Hide only accounts that are entirely untouched; anything with movement
      // or a balance stays visible even when it nets to zero.
      if (empty && !params.includeZero && !specific) continue;
      breakdown.push({
        entityId: a.id,
        code: a.code,
        name: a.nameAr,
        openingBalance: r.openingBalance,
        debit: r.periodDebit,
        credit: r.periodCredit,
        endingBalance: r.endingBalance,
      });
    }

    const merged = StatementService.reduce(lines, (l) => sideOf(l.accountId), params.from, params.to);

    return {
      selectionType: specific ? "specific" : "consolidated",
      category: def.id,
      entityId: specific,
      entityLabel: specific ? `${byId.get(specific)!.code} — ${byId.get(specific)!.nameAr}` : def.allLabel,
      openingBalance: merged.openingBalance,
      periodDebit: merged.periodDebit,
      periodCredit: merged.periodCredit,
      endingBalance: merged.endingBalance,
      breakdown,
      rows: this.enrich(merged.rows, byId),
    };
  }

  // ── Party categories (customers → AR_CONTROL, suppliers → AP_CONTROL) ─────

  private async buildForParties(
    def: AccountCategoryDef,
    specific: string | null,
    params: { from?: string; to?: string; includeZero?: boolean },
  ): Promise<ConsolidatedStatementResult> {
    const isCustomers = def.kind === "CUSTOMERS";
    const partyType = isCustomers ? "CUSTOMER" : "SUPPLIER";
    // AR is an asset (debit-normal); AP is a liability (credit-normal).
    const side: NormalSide = isCustomers ? "DEBIT" : "CREDIT";

    // Resolve the control accounts through the same shared predicate the selector
    // uses, so this stays correct on installations where systemRole was never
    // configured. Widening the account set is safe: only lines carrying the
    // party type below are ever counted.
    const all = await this.leafAccounts();
    const controlAccounts = accountsInCategory(isCustomers ? "ar" : "ap", all);
    const accountById = new Map(controlAccounts.map((a) => [a.id, a]));

    if (specific) await this.assertPartyExists(isCustomers, specific);

    const lines = (await this.prisma.journalLine.findMany({
      where: {
        accountId: { in: controlAccounts.map((a) => a.id) },
        partyType: partyType as never,
        // A partyless control line is a data defect; it is never silently
        // folded into a party's statement or the consolidated total.
        partyId: specific ? specific : { not: null },
      },
      include: StatementService.lineInclude,
      orderBy: StatementService.lineOrderBy,
    })) as unknown as StatementLineInput[];

    const merged = StatementService.reduce(lines, () => side, params.from, params.to);

    let breakdown: BreakdownEntry[] = [];
    if (specific) {
      const label = await this.partyLabel(isCustomers, specific);
      breakdown = [{
        entityId: specific,
        code: label.code,
        name: label.name,
        openingBalance: merged.openingBalance,
        debit: merged.periodDebit,
        credit: merged.periodCredit,
        endingBalance: merged.endingBalance,
      }];
      return this.partyResult(def, specific, `${label.code ? label.code + " — " : ""}${label.name}`, merged, breakdown, accountById);
    }

    const byParty = new Map<string, StatementLineInput[]>();
    for (const l of lines) {
      if (!l.partyId) continue;
      const list = byParty.get(l.partyId);
      if (list) list.push(l);
      else byParty.set(l.partyId, [l]);
    }
    const labels = await this.partyLabels(isCustomers, [...byParty.keys()]);
    for (const [partyId, partyLines] of byParty) {
      const r = StatementService.reduce(partyLines, () => side, params.from, params.to);
      const empty =
        isZero(r.openingBalance) && isZero(r.periodDebit) && isZero(r.periodCredit) && isZero(r.endingBalance);
      if (empty && !params.includeZero) continue;
      const label = labels.get(partyId) ?? { code: "", name: partyId };
      breakdown.push({
        entityId: partyId,
        code: label.code,
        name: label.name,
        openingBalance: r.openingBalance,
        debit: r.periodDebit,
        credit: r.periodCredit,
        endingBalance: r.endingBalance,
      });
    }
    breakdown.sort((a, b) => a.name.localeCompare(b.name, "ar"));

    return this.partyResult(def, null, def.allLabel, merged, breakdown, accountById);
  }

  private partyResult(
    def: AccountCategoryDef,
    specific: string | null,
    entityLabel: string,
    merged: { openingBalance: string; periodDebit: string; periodCredit: string; endingBalance: string; rows: StatementRow[] },
    breakdown: BreakdownEntry[],
    accountById: Map<string, { id: string; code: string; nameAr: string }>,
  ): ConsolidatedStatementResult {
    return {
      selectionType: specific ? "specific" : "consolidated",
      category: def.id,
      entityId: specific,
      entityLabel,
      openingBalance: merged.openingBalance,
      periodDebit: merged.periodDebit,
      periodCredit: merged.periodCredit,
      endingBalance: merged.endingBalance,
      breakdown,
      rows: this.enrich(merged.rows, accountById),
    };
  }

  private async assertPartyExists(isCustomers: boolean, id: string): Promise<void> {
    const found = isCustomers
      ? await this.prisma.customer.findUnique({ where: { id }, select: { id: true } })
      : await this.prisma.supplier.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw new NotFoundError({ reason: isCustomers ? "customer_not_found" : "supplier_not_found", entityId: id });
  }

  private async partyLabel(isCustomers: boolean, id: string): Promise<{ code: string; name: string }> {
    return (await this.partyLabels(isCustomers, [id])).get(id) ?? { code: "", name: id };
  }

  private async partyLabels(isCustomers: boolean, ids: string[]): Promise<Map<string, { code: string; name: string }>> {
    const out = new Map<string, { code: string; name: string }>();
    if (ids.length === 0) return out;
    if (isCustomers) {
      const rows = await this.prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, nameAr: true } });
      for (const c of rows) out.set(c.id, { code: c.code, name: c.nameAr });
    } else {
      const rows = await this.prisma.supplier.findMany({ where: { id: { in: ids } }, select: { id: true, nameAr: true } });
      for (const s of rows) out.set(s.id, { code: "", name: s.nameAr });
    }
    return out;
  }

  private enrich(
    rows: StatementRow[],
    accountById: Map<string, { code: string; nameAr: string }>,
  ): ConsolidatedRow[] {
    return rows.map((r) => {
      const a = accountById.get(r.accountId);
      return { ...r, accountCode: a?.code ?? "", accountName: a?.nameAr ?? "" };
    });
  }
}

const isZero = (v: string) => new Decimal(v).isZero();
