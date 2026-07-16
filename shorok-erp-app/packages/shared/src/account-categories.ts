/**
 * Account categories — the single source of truth shared by the Manual Journal
 * account picker, the journal Templates page, and the Account Statement page
 * (web), and by the consolidated statement endpoint (API). Adding a category
 * here surfaces it everywhere; never re-declare this list locally.
 *
 * Classification is configuration-first: an account's Chart-of-Accounts config
 * (`treasuryType`, `systemRole`) decides membership when it is set. The Arabic/
 * English name patterns are a widening fallback, so accounts that predate the
 * config fields keep appearing where users already expect them.
 */

/** Minimal account shape needed to categorize; both the Prisma row and the web AccountRow satisfy it. */
export interface CategorizableAccount {
  category: string; // ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE | COST_OF_SALES
  accountType: string;
  nameAr: string;
  nameEn?: string | null;
  systemRole?: string | null;
  isCashOrBank?: boolean | null;
  treasuryType?: string | null; // CASH | BANK
  isLeaf?: boolean;
  active?: boolean;
}

/**
 * How a category resolves its entities:
 *  - ACCOUNTS: GL accounts matched by `matches`
 *  - CUSTOMERS/SUPPLIERS: parties on AR_CONTROL/AP_CONTROL journal lines
 */
export type CategoryKind = "ACCOUNTS" | "CUSTOMERS" | "SUPPLIERS";

export interface AccountCategoryDef {
  id: string;
  /** Arabic label for the first ("القائمة") selector. */
  label: string;
  /** Arabic label for the consolidated option in the second selector. */
  allLabel: string;
  kind: CategoryKind;
  /** Account predicate — only meaningful for kind === "ACCOUNTS". */
  matches?: (a: CategorizableAccount) => boolean;
}

const text = (a: CategorizableAccount) => `${a.nameAr} ${a.nameEn ?? ""}`.toLowerCase();

const BANK_RE = /بنك|مصرف|bank|cib|nbe|qnb|hsbc|abc/i;
const VAULT_RE = /خزن|خزينة|خزان|vault|safe/i;
const CASH_RE = /صندوق|نقد|كاش|cash|petty/i;
const AR_RE = /مدين|ذمم|عميل|receivabl|سلف|عهد|prepaid|advance/i;
const AP_RE = /دائن|مورد|ذمم|payabl|مستحق|accrued/i;
const INVENTORY_RE = /مخزون|بضاع|سلع|stock|inventor/i;
const TAX_RE = /ضريب|tax|vat/i;

/**
 * Canonical category list. Order is the display order of the first selector.
 * `all` stays last so it reads as the escape hatch rather than the default.
 */
export const ACCOUNT_CATEGORIES: AccountCategoryDef[] = [
  {
    id: "banks",
    label: "البنوك",
    allLabel: "كل البنوك",
    kind: "ACCOUNTS",
    // treasuryType is authoritative; fall back to the name for unconfigured accounts.
    matches: (a) => a.category === "ASSET" && (a.treasuryType === "BANK" || BANK_RE.test(text(a))),
  },
  {
    id: "vaults",
    label: "الخزن",
    allLabel: "كل الخزن",
    kind: "ACCOUNTS",
    matches: (a) => a.category === "ASSET" && (a.treasuryType === "CASH" || VAULT_RE.test(text(a))),
  },
  {
    id: "cash",
    label: "الصندوق والنقدية",
    allLabel: "كل حسابات النقدية",
    kind: "ACCOUNTS",
    matches: (a) => a.category === "ASSET" && (a.treasuryType === "CASH" || CASH_RE.test(text(a))),
  },
  {
    id: "customers",
    label: "العملاء",
    allLabel: "كل العملاء",
    kind: "CUSTOMERS",
  },
  {
    id: "suppliers",
    label: "الموردون",
    allLabel: "كل الموردين",
    kind: "SUPPLIERS",
  },
  {
    id: "ar",
    label: "الذمم المدينة",
    allLabel: "كل حسابات الذمم المدينة",
    kind: "ACCOUNTS",
    matches: (a) => a.systemRole === "AR_CONTROL" || (a.category === "ASSET" && AR_RE.test(text(a))),
  },
  {
    id: "ap",
    label: "الذمم الدائنة",
    allLabel: "كل حسابات الذمم الدائنة",
    kind: "ACCOUNTS",
    matches: (a) => a.systemRole === "AP_CONTROL" || (a.category === "LIABILITY" && AP_RE.test(text(a))),
  },
  {
    id: "expense",
    label: "المصروفات",
    allLabel: "كل المصروفات",
    kind: "ACCOUNTS",
    matches: (a) => a.category === "EXPENSE",
  },
  {
    id: "revenue",
    label: "الإيرادات",
    allLabel: "كل الإيرادات",
    kind: "ACCOUNTS",
    matches: (a) => a.category === "REVENUE",
  },
  {
    id: "cogs",
    label: "تكلفة المبيعات",
    allLabel: "كل حسابات تكلفة المبيعات",
    kind: "ACCOUNTS",
    matches: (a) => a.category === "COST_OF_SALES",
  },
  {
    id: "inventory",
    label: "المخزون والبضاعة",
    allLabel: "كل حسابات المخزون",
    kind: "ACCOUNTS",
    matches: (a) => a.systemRole === "INVENTORY" || INVENTORY_RE.test(text(a)),
  },
  {
    id: "tax",
    label: "الضرائب",
    allLabel: "كل حسابات الضرائب",
    kind: "ACCOUNTS",
    matches: (a) =>
      a.systemRole === "VAT_INPUT" || a.systemRole === "VAT_OUTPUT" || TAX_RE.test(text(a)),
  },
  {
    id: "fixed",
    label: "الأصول الثابتة",
    allLabel: "كل الأصول الثابتة",
    kind: "ACCOUNTS",
    matches: (a) => a.accountType === "FIXED_ASSET",
  },
  {
    id: "equity",
    label: "حقوق الملكية",
    allLabel: "كل حسابات حقوق الملكية",
    kind: "ACCOUNTS",
    matches: (a) => a.category === "EQUITY",
  },
  {
    id: "all",
    label: "جميع الحسابات",
    allLabel: "كل الحسابات",
    kind: "ACCOUNTS",
    matches: () => true,
  },
];

export function findCategory(id: string): AccountCategoryDef | undefined {
  return ACCOUNT_CATEGORIES.find((c) => c.id === id);
}

/** True when an account may be posted to / selected as an individual statement. */
export function isPostable(a: CategorizableAccount): boolean {
  return a.isLeaf !== false && a.active !== false;
}

/**
 * Active leaf accounts belonging to `categoryId`. Parent accounts are never
 * returned — they are group headings, not posting accounts. Party categories
 * (customers/suppliers) resolve to entities, not accounts, and yield [].
 */
export function accountsInCategory<T extends CategorizableAccount>(
  categoryId: string,
  accounts: T[],
): T[] {
  const def = findCategory(categoryId);
  if (!def || def.kind !== "ACCOUNTS" || !def.matches) return [];
  return accounts.filter((a) => isPostable(a) && def.matches!(a));
}

/** Normal balance side — drives `ending = opening ± (debit − credit)`. */
export function normalSideForCategory(category: string): "DEBIT" | "CREDIT" {
  return category === "LIABILITY" || category === "EQUITY" || category === "REVENUE"
    ? "CREDIT"
    : "DEBIT";
}
