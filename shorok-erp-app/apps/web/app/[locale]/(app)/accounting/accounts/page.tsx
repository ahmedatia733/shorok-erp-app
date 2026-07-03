"use client";

import { useEffect, useState, useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Badge } from "../../../../../components/ui/badge";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { Modal } from "../../../../../components/ui/modal";
import { useHasRole } from "../../../../../lib/auth";
import {
  listAccounts,
  createAccount,
  updateAccount,
  getAccountBalance,
  type AccountRow,
} from "../../../../../lib/accounts-client";
import { formatCurrency } from "../../../../../lib/format";

const CATEGORIES = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "COST_OF_SALES", "EXPENSE"] as const;
type Category = (typeof CATEGORIES)[number];

const ACCOUNT_TYPES = [
  "FIXED_ASSET",
  "CURRENT_ASSET",
  "LIABILITY",
  "EQUITY",
  "REVENUE",
  "COST_OF_SALES",
  "EXPENSE",
] as const;

function AccountTree({
  accounts,
  depth,
  onEdit,
  balances,
  locale,
}: {
  accounts: AccountRow[];
  depth: number;
  onEdit: (acc: AccountRow) => void;
  balances: Record<string, string>;
  locale: AppLocale;
}) {
  const t = useTranslations("accounting.accounts");
  const isOwner = useHasRole();

  return (
    <>
      {accounts.map((acc) => (
        <div key={acc.id}>
          <div
            className="flex items-center justify-between py-1.5 border-b border-border last:border-0"
            style={{ paddingInlineStart: `${depth * 1}rem` }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-textSecondary text-xs font-mono">{acc.code}</span>
              <span className={acc.isLeaf ? "text-sm" : "text-sm font-medium"}>
                {locale === "ar" ? acc.nameAr : acc.nameEn}
              </span>
              {acc.isLeaf && (
                <Badge variant={acc.active ? "success" : "neutral"}>
                  {acc.active ? t("active") : t("archived")}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {acc.isLeaf && balances[acc.id] !== undefined && (() => {
                const bal = balances[acc.id];
                return bal !== undefined ? (
                  <span className="text-sm font-medium">
                    {formatCurrency(bal, locale)}
                  </span>
                ) : null;
              })()}
              {isOwner && (
                <Button size="sm" variant="ghost" onClick={() => onEdit(acc)}>
                  {t("editTitle")}
                </Button>
              )}
            </div>
          </div>
          {acc.children && acc.children.length > 0 && (
            <AccountTree
              accounts={acc.children}
              depth={depth + 1}
              onEdit={onEdit}
              balances={balances}
              locale={locale}
            />
          )}
        </div>
      ))}
    </>
  );
}

export default function AccountsPage() {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("accounting.accounts");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const isOwner = useHasRole();
  const canAccess = useHasRole("ACCOUNTANT");

  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [expandedCategories, setExpandedCategories] = useState<Set<Category>>(new Set(CATEGORIES));

  // Create modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    code: "",
    nameAr: "",
    nameEn: "",
    category: "ASSET" as string,
    accountType: "CURRENT_ASSET" as string,
    parentId: "",
  });
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Edit modal state
  const [editAcc, setEditAcc] = useState<AccountRow | null>(null);
  const [editForm, setEditForm] = useState({ nameAr: "", nameEn: "", active: true });
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [accountSearch, setAccountSearch] = useState("");

  const loadAccounts = useCallback(async () => {
    try {
      const data = await listAccounts();
      setAccounts(data);
    } catch {
      setError(t("loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    if (!canAccess) {
      router.replace(`/${locale}/dashboard`);
      return;
    }
    void loadAccounts();
  }, [canAccess, router, locale, loadAccounts]);

  // Load balances for leaf accounts in expanded categories
  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    const firstOfMonth = today.slice(0, 7) + "-01";

    const loadBalances = async () => {
      const allLeafs = getAllLeafs(accounts);
      const newBalances: Record<string, string> = {};
      await Promise.all(
        allLeafs.map(async (acc) => {
          try {
            const b = await getAccountBalance(acc.id, firstOfMonth, today);
            newBalances[acc.id] = b.balance;
          } catch {
            // ignore per-account errors
          }
        }),
      );
      setBalances((prev) => ({ ...prev, ...newBalances }));
    };

    if (accounts.length > 0) {
      void loadBalances();
    }
  }, [accounts]);

  function getAllLeafs(accs: AccountRow[]): AccountRow[] {
    const result: AccountRow[] = [];
    for (const acc of accs) {
      if (acc.isLeaf) result.push(acc);
      if (acc.children) result.push(...getAllLeafs(acc.children));
    }
    return result;
  }

  function getAllFlat(accs: AccountRow[]): AccountRow[] {
    const result: AccountRow[] = [];
    for (const acc of accs) {
      result.push(acc);
      if (acc.children) result.push(...getAllFlat(acc.children));
    }
    return result;
  }

  function getByCategory(cat: Category) {
    return accounts.filter((a) => a.category === cat);
  }

  function toggleCategory(cat: Category) {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateLoading(true);
    setCreateError(null);
    try {
      await createAccount({
        code: createForm.code,
        nameAr: createForm.nameAr,
        nameEn: createForm.nameEn,
        category: createForm.category,
        accountType: createForm.accountType,
        parentId: createForm.parentId || undefined,
      });
      setCreateOpen(false);
      setCreateForm({ code: "", nameAr: "", nameEn: "", category: "ASSET", accountType: "CURRENT_ASSET", parentId: "" });
      await loadAccounts();
    } catch {
      setCreateError(t("loadFailed"));
    } finally {
      setCreateLoading(false);
    }
  }

  function openEdit(acc: AccountRow) {
    setEditAcc(acc);
    setEditForm({ nameAr: acc.nameAr, nameEn: acc.nameEn, active: acc.active });
    setEditError(null);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editAcc) return;
    setEditLoading(true);
    setEditError(null);
    try {
      await updateAccount(editAcc.id, {
        nameAr: editForm.nameAr,
        nameEn: editForm.nameEn,
        active: editForm.active,
      });
      setEditAcc(null);
      await loadAccounts();
    } catch {
      setEditError(t("loadFailed"));
    } finally {
      setEditLoading(false);
    }
  }

  const allFlat = getAllFlat(accounts);
  const leafAccounts = allFlat.filter((a) => a.isLeaf && a.active);
  const searchResults = accountSearch
    ? allFlat.filter((a) =>
        (a.code + " " + a.nameAr + " " + (a.nameEn ?? ""))
          .toLowerCase()
          .includes(accountSearch.toLowerCase()),
      )
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-bold">{t("title")}</h1>
        <div className="flex items-center gap-3">
          <Input
            placeholder="بحث بالاسم أو الكود..."
            value={accountSearch}
            onChange={(e) => setAccountSearch(e.target.value)}
            className="w-60 border-2 border-primary/40 bg-background"
          />
          {accountSearch && (
            <button type="button" className="text-xs text-textSecondary hover:text-text" onClick={() => setAccountSearch("")}>
              مسح ✕
            </button>
          )}
          {isOwner && (
            <Button onClick={() => setCreateOpen(true)}>{t("addAccount")}</Button>
          )}
        </div>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {/* Search results flat list */}
      {searchResults && (
        <Card>
          <CardBody className="p-0">
            {searchResults.length === 0 ? (
              <div className="px-4 py-6 text-center text-textSecondary text-sm">لا توجد نتائج مطابقة</div>
            ) : (
              <AccountTree accounts={searchResults} depth={0} onEdit={openEdit} balances={balances} locale={locale} />
            )}
          </CardBody>
        </Card>
      )}

      {/* Normal category tree when no search */}
      {!searchResults && CATEGORIES.map((cat) => {
        const catAccounts = getByCategory(cat);
        if (catAccounts.length === 0) return null;
        const isOpen = expandedCategories.has(cat);
        return (
          <Card key={cat}>
            <CardHeader>
              <button
                type="button"
                className="flex items-center gap-2 text-start w-full"
                onClick={() => toggleCategory(cat)}
              >
                <CardTitle>{t(`categories.${cat}`)}</CardTitle>
                <span className="text-textSecondary text-sm">{isOpen ? "▾" : "▸"}</span>
              </button>
            </CardHeader>
            {isOpen && (
              <CardBody className="p-0">
                <AccountTree
                  accounts={catAccounts}
                  depth={0}
                  onEdit={openEdit}
                  balances={balances}
                  locale={locale}
                />
              </CardBody>
            )}
          </Card>
        );
      })}

      {/* Create Account Modal */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={t("addAccount")}>
        <form onSubmit={(e) => void handleCreate(e)} className="space-y-3">
          {createError && <Alert variant="error">{createError}</Alert>}
          <div>
            <label className="block text-sm mb-1">{t("code")}</label>
            <Input
              value={createForm.code}
              onChange={(e) => setCreateForm((f) => ({ ...f, code: e.target.value }))}
              required
              maxLength={20}
            />
          </div>
          <div>
            <label className="block text-sm mb-1">{t("nameAr")}</label>
            <Input
              value={createForm.nameAr}
              onChange={(e) => setCreateForm((f) => ({ ...f, nameAr: e.target.value }))}
              required
              maxLength={160}
              dir="rtl"
            />
          </div>
          <div>
            <label className="block text-sm mb-1">{t("nameEn")}</label>
            <Input
              value={createForm.nameEn}
              onChange={(e) => setCreateForm((f) => ({ ...f, nameEn: e.target.value }))}
              required
              maxLength={160}
              dir="ltr"
            />
          </div>
          <div>
            <label className="block text-sm mb-1">{t("category")}</label>
            <select
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
              value={createForm.category}
              onChange={(e) => setCreateForm((f) => ({ ...f, category: e.target.value }))}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{t(`categories.${c}`)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm mb-1">{t("accountType")}</label>
            <select
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
              value={createForm.accountType}
              onChange={(e) => setCreateForm((f) => ({ ...f, accountType: e.target.value }))}
            >
              {ACCOUNT_TYPES.map((at) => (
                <option key={at} value={at}>{at.replace(/_/g, " ")}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm mb-1">{t("parent")}</label>
            <select
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
              value={createForm.parentId}
              onChange={(e) => setCreateForm((f) => ({ ...f, parentId: e.target.value }))}
            >
              <option value="">—</option>
              {allFlat
                .filter((a) => !a.isLeaf || a.children?.length === 0)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {locale === "ar" ? a.nameAr : a.nameEn}
                  </option>
                ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={createLoading}>
              {createLoading ? tCommon("loading") : tCommon("save")}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Edit Account Modal */}
      <Modal open={!!editAcc} onClose={() => setEditAcc(null)} title={t("editTitle")}>
        <form onSubmit={(e) => void handleEdit(e)} className="space-y-3">
          {editError && <Alert variant="error">{editError}</Alert>}
          <div>
            <label className="block text-sm mb-1">{t("nameAr")}</label>
            <Input
              value={editForm.nameAr}
              onChange={(e) => setEditForm((f) => ({ ...f, nameAr: e.target.value }))}
              required
              dir="rtl"
            />
          </div>
          <div>
            <label className="block text-sm mb-1">{t("nameEn")}</label>
            <Input
              value={editForm.nameEn}
              onChange={(e) => setEditForm((f) => ({ ...f, nameEn: e.target.value }))}
              required
              dir="ltr"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="active-toggle"
              checked={editForm.active}
              onChange={(e) => setEditForm((f) => ({ ...f, active: e.target.checked }))}
            />
            <label htmlFor="active-toggle" className="text-sm">{t("active")}</label>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setEditAcc(null)}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={editLoading}>
              {editLoading ? tCommon("loading") : tCommon("save")}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
