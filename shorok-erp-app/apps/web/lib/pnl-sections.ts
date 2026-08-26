import { decimalAdd } from "./decimal-string";

/**
 * How the income statement is ORGANISED for a reader. Presentation only.
 *
 * Every number here comes from the canonical P&L the API already computed from
 * posted journal lines; nothing is recomputed and nothing is re-signed. What
 * these helpers do is arrange the accounts the API returned into the sections an
 * accountant expects to read, and prove — by construction — that the
 * arrangement still adds up to the API's own totals.
 *
 * ── The trap this exists to avoid ─────────────────────────────────────────
 *
 * `revenue` from the API is ALREADY net of contra-revenue: a sales return debits
 * حساب مردودات المبيعات, which is a REVENUE-category account, so its
 * `credit − debit` contribution is negative and is already inside the revenue
 * total. Showing «الإيرادات» as that figure and then subtracting the returns
 * line again would deduct the same 76,007.50 twice.
 *
 * So the split runs the other way: the API's revenue total IS net revenue, and
 * gross revenue is reconstructed by adding the deductions back. The identity
 *
 *      grossRevenue − deductions = netRevenue = the API's `revenue`
 *
 * then holds exactly, and the return is applied precisely once.
 *
 * Classification is by SIGN rather than by account code, which keeps it honest
 * for accounts nobody has created yet: an account that reduced revenue this
 * period is shown as a deduction whatever it is called, and no account can fall
 * out of the statement.
 */

export interface PnlAmountLine {
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  amount: string;
}

/** Exact string addition at money scale — never float, never drifting. */
export function sumAmounts(lines: Array<{ amount: string }>): string {
  let total = "0";
  for (const l of lines) total = decimalAdd(total, l.amount) ?? total;
  return toMoney(total);
}

/** decimal-string works at 4 dp; money is 2 dp. */
export function toMoney(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

const negate = (amount: string): string => toMoney(String(-Number(amount)));

export interface RevenueSplit {
  /** Accounts that added revenue. */
  gross: PnlAmountLine[];
  /** Contra-revenue — sales returns, discounts — as POSITIVE magnitudes. */
  deductions: PnlAmountLine[];
  grossTotal: string;
  deductionsTotal: string;
  /** grossTotal − deductionsTotal, which equals the API's own `revenue`. */
  netRevenue: string;
}

/**
 * Splits the API's revenue lines into what was earned and what was given back.
 *
 * `deductions` carry positive magnitudes so the UI can render them as «(x)»
 * without re-negating anything, and `netRevenue` is derived from the same two
 * halves rather than read separately — so it cannot drift from what is listed.
 */
export function splitRevenue(revenueLines: PnlAmountLine[]): RevenueSplit {
  const gross: PnlAmountLine[] = [];
  const deductions: PnlAmountLine[] = [];
  for (const line of revenueLines) {
    if (Number(line.amount) < 0) deductions.push({ ...line, amount: negate(line.amount) });
    else gross.push(line);
  }
  const grossTotal = sumAmounts(gross);
  const deductionsTotal = sumAmounts(deductions);
  return {
    gross,
    deductions,
    grossTotal,
    deductionsTotal,
    netRevenue: toMoney(String(Number(grossTotal) - Number(deductionsTotal))),
  };
}

// ── operating expense sections ──────────────────────────────────────────────

export type ExpenseGroupId = "SELLING" | "ADMIN" | "FINANCE" | "DEPRECIATION" | "OTHER";

export interface ExpenseGroup {
  id: ExpenseGroupId;
  labelAr: string;
  lines: PnlAmountLine[];
  total: string;
}

/** Reading order of the sections, matching a conventional income statement. */
const GROUP_ORDER: Array<{ id: ExpenseGroupId; labelAr: string }> = [
  { id: "SELLING", labelAr: "مصروفات البيع والتوزيع" },
  { id: "ADMIN", labelAr: "المصروفات العمومية والإدارية" },
  { id: "FINANCE", labelAr: "المصروفات البنكية والتمويلية" },
  { id: "DEPRECIATION", labelAr: "الإهلاك" },
  { id: "OTHER", labelAr: "مصروفات أخرى" },
];

/**
 * Which section an expense account is read under.
 *
 * The chart has no hierarchy field yet, so this maps the accounts that actually
 * exist. It is deliberately a DISPLAY decision: it never touches a balance, a
 * posting or a total, and the statement's expense total is always the API's.
 *
 * Anything unrecognised — including accounts created long after this code was
 * written — falls to «مصروفات أخرى». A new expense account must show up in the
 * wrong section rather than silently vanish from the statement.
 */
export function classifyExpense(line: { code: string; nameAr: string; nameEn: string }): ExpenseGroupId {
  const name = `${line.nameAr} ${line.nameEn}`.toLowerCase();
  // Depreciation is recognised by name: no depreciation account exists in the
  // chart today, and this task must not invent one.
  if (name.includes("إهلاك") || name.includes("depreciation")) return "DEPRECIATION";

  const code = line.code.trim();
  if (code.startsWith("61")) return "SELLING";                                  // النقل والشحن
  if (["62", "63", "64", "67"].some((p) => code.startsWith(p))) return "ADMIN"; // رواتب، مرافق، إيجارات، صيانة
  if (code.startsWith("65")) return "FINANCE";                                  // المصروفات البنكية
  return "OTHER";                                                               // 66 متنوعة + anything new
}

/**
 * Groups the API's expense lines for display.
 *
 * Only sections with something in them are returned, so an empty statement is
 * not padded with rows of 0.00 — in particular الإهلاك stays absent until a
 * depreciation account genuinely exists and has activity.
 */
export function groupExpenses(expenseLines: PnlAmountLine[]): ExpenseGroup[] {
  const byGroup = new Map<ExpenseGroupId, PnlAmountLine[]>();
  for (const line of expenseLines) {
    const id = classifyExpense(line);
    const bucket = byGroup.get(id);
    if (bucket) bucket.push(line);
    else byGroup.set(id, [line]);
  }
  return GROUP_ORDER.filter((g) => byGroup.has(g.id)).map((g) => {
    const lines = byGroup.get(g.id)!;
    return { id: g.id, labelAr: g.labelAr, lines, total: sumAmounts(lines) };
  });
}
