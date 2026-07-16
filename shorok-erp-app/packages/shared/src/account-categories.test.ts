/**
 * Categories are the shared contract between the Manual Journal picker and the
 * Account Statement selector, so these fix the classification against the real
 * production chart of accounts.
 */
import {
  ACCOUNT_CATEGORIES,
  accountsInCategory,
  findCategory,
  normalSideForCategory,
  type CategorizableAccount,
} from "./account-categories";

type A = CategorizableAccount & { code: string };

const acc = (
  code: string,
  nameAr: string,
  category: string,
  accountType: string,
  extra: Partial<A> = {},
): A => ({ code, nameAr, category, accountType, isLeaf: true, active: true, ...extra });

// Mirrors the production chart of accounts (codes/names/config as configured).
const COA: A[] = [
  acc("1000", "الأصول", "ASSET", "FIXED_ASSET", { isLeaf: false }),
  acc("1110", "الأراضي", "ASSET", "FIXED_ASSET"),
  acc("1120", "المباني", "ASSET", "FIXED_ASSET"),
  acc("1210", "الخزن والنقدية", "ASSET", "CURRENT_ASSET", { isLeaf: false }),
  acc("1211", "خزنة رئيسية", "ASSET", "CURRENT_ASSET", { isCashOrBank: true, treasuryType: "CASH" }),
  acc("1220", "البنوك", "ASSET", "CURRENT_ASSET", { isLeaf: false }),
  acc("1221", "بنك مصر", "ASSET", "CURRENT_ASSET", { isCashOrBank: true, treasuryType: "BANK" }),
  acc("1222", "مصرف أبو ظبي الإسلامي", "ASSET", "CURRENT_ASSET", { isCashOrBank: true, treasuryType: "BANK" }),
  acc("1223", "CIB", "ASSET", "CURRENT_ASSET", { isCashOrBank: true, treasuryType: "BANK" }),
  acc("1240", "العملاء والمدينون", "ASSET", "CURRENT_ASSET", { systemRole: "AR_CONTROL" }),
  acc("1250", "المخزون", "ASSET", "CURRENT_ASSET", { systemRole: "INVENTORY" }),
  acc("2100", "الموردون والدائنون", "LIABILITY", "LIABILITY", { systemRole: "AP_CONTROL" }),
  acc("2300", "ضريبة القيمة المضافة", "LIABILITY", "LIABILITY", { systemRole: "VAT_INPUT" }),
  acc("3100", "رأس المال", "EQUITY", "EQUITY"),
  acc("4100", "إيرادات المبيعات", "REVENUE", "REVENUE", { systemRole: "REVENUE" }),
  acc("5100", "تكلفة البضاعة المباعة", "COST_OF_SALES", "COST_OF_SALES", { systemRole: "COGS" }),
  acc("6100", "النقل والشحن", "EXPENSE", "EXPENSE"),
  acc("6400", "الإيجارات", "EXPENSE", "EXPENSE"),
  acc("6500", "المصروفات البنكية", "EXPENSE", "EXPENSE"),
  acc("TEST-CASH", "خزينة اختبار", "ASSET", "CURRENT_ASSET", { treasuryType: "CASH", active: false }),
];

const codes = (id: string) => accountsInCategory(id, COA).map((a) => a.code).sort();

describe("account categories (shared by Journal + Statement)", () => {
  it("banks resolve to exactly the BANK treasury accounts", () => {
    expect(codes("banks")).toEqual(["1221", "1222", "1223"]);
  });

  it("vaults resolve to exactly the CASH treasury accounts", () => {
    expect(codes("vaults")).toEqual(["1211"]);
  });

  it("a bank-named EXPENSE account is not a bank, and the bank parent is not selectable", () => {
    const banks = codes("banks");
    expect(banks).not.toContain("6500"); // المصروفات البنكية — expense, not a bank
    expect(banks).not.toContain("1220"); // parent group heading, not a posting account
  });

  it("excludes inactive accounts", () => {
    expect(codes("vaults")).not.toContain("TEST-CASH");
  });

  it("expenses include every active leaf expense account", () => {
    expect(codes("expense")).toEqual(["6100", "6400", "6500"]);
  });

  it("control accounts resolve by systemRole", () => {
    expect(codes("ar")).toContain("1240");
    expect(codes("ap")).toContain("2100");
    expect(codes("inventory")).toContain("1250");
    expect(codes("tax")).toContain("2300");
  });

  it("revenue / cogs / equity / fixed assets resolve by category", () => {
    expect(codes("revenue")).toEqual(["4100"]);
    expect(codes("cogs")).toEqual(["5100"]);
    expect(codes("equity")).toEqual(["3100"]);
    expect(codes("fixed")).toEqual(["1110", "1120"]); // 1000 is a parent
  });

  it("'all' returns every active leaf and no parents", () => {
    const all = accountsInCategory("all", COA);
    expect(all.every((a) => a.isLeaf !== false && a.active !== false)).toBe(true);
    expect(all.map((a) => a.code)).not.toContain("1220");
    expect(all.map((a) => a.code)).not.toContain("TEST-CASH");
  });

  it("party categories resolve to entities, not accounts", () => {
    expect(findCategory("customers")!.kind).toBe("CUSTOMERS");
    expect(findCategory("suppliers")!.kind).toBe("SUPPLIERS");
    expect(accountsInCategory("customers", COA)).toEqual([]);
    expect(accountsInCategory("suppliers", COA)).toEqual([]);
  });

  it("every category has an id, label and an 'all' label", () => {
    for (const c of ACCOUNT_CATEGORIES) {
      expect(c.id).toBeTruthy();
      expect(c.label).toBeTruthy();
      expect(c.allLabel).toBeTruthy();
    }
    expect(findCategory("nope")).toBeUndefined();
  });

  it("normal side follows the accounting equation", () => {
    expect(normalSideForCategory("ASSET")).toBe("DEBIT");
    expect(normalSideForCategory("EXPENSE")).toBe("DEBIT");
    expect(normalSideForCategory("COST_OF_SALES")).toBe("DEBIT");
    expect(normalSideForCategory("LIABILITY")).toBe("CREDIT");
    expect(normalSideForCategory("EQUITY")).toBe("CREDIT");
    expect(normalSideForCategory("REVENUE")).toBe("CREDIT");
  });
});
