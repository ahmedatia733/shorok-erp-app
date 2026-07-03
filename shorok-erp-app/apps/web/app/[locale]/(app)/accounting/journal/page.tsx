"use client";

import { useEffect, useState, useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Input } from "../../../../../components/ui/input";
import { Modal } from "../../../../../components/ui/modal";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { useHasRole } from "../../../../../lib/auth";
import {
  listJournal,
  createJournalEntry,
  deleteJournalEntry,
  type JournalEntryRow,
} from "../../../../../lib/journal-client";
import { listAccounts, type AccountRow } from "../../../../../lib/accounts-client";
import { listCustomers, type CustomerRow } from "../../../../../lib/customers-client";
import { listSuppliers, type SupplierRow } from "../../../../../lib/suppliers-client";
import {
  listTemplates,
  type JournalTemplate,
} from "../../../../../lib/journal-templates-client";
import { formatDate, formatCurrency } from "../../../../../lib/format";

// ─── Category definitions (shared with templates page) ────────────────────────

const CATEGORIES = [
  { id: "banks",     label: "البنوك",               special: false },
  { id: "vaults",    label: "الخزن",                special: false },
  { id: "cash",      label: "الصندوق والنقدية",      special: false },
  { id: "ar",        label: "الذمم المدينة",         special: false },
  { id: "ap",        label: "الذمم الدائنة",         special: false },
  { id: "revenue",   label: "الإيرادات",             special: false },
  { id: "cogs",      label: "تكلفة المبيعات",        special: false },
  { id: "expense",   label: "المصروفات",             special: false },
  { id: "fixed",     label: "الأصول الثابتة",        special: false },
  { id: "inventory", label: "المخزون والبضاعة",      special: false },
  { id: "tax",       label: "الضرائب",               special: false },
  { id: "equity",    label: "رأس المال",             special: false },
  { id: "customers", label: "العملاء",               special: true  },
  { id: "suppliers", label: "الموردون",              special: true  },
  { id: "all",       label: "جميع الحسابات",         special: false },
];

function filterAccounts(cat: string, accounts: AccountRow[]): AccountRow[] {
  if (cat === "customers" || cat === "suppliers") return [];
  if (cat === "all") return accounts.filter((a) => a.isLeaf && a.active);
  const both = (a: AccountRow) => (a.nameAr + " " + (a.nameEn ?? "")).toLowerCase();
  const tests: Record<string, (a: AccountRow) => boolean> = {
    banks:     (a) => a.category === "ASSET"       && /بنك|مصرف|bank|cib|nbe|qnb|hsbc|abc/i.test(both(a)),
    vaults:    (a) => a.category === "ASSET"       && /خزن|خزينة|خزان|vault|safe/i.test(both(a)),
    cash:      (a) => a.category === "ASSET"       && /صندوق|نقد|كاش|cash|petty/i.test(both(a)),
    ar:        (a) => a.category === "ASSET"       && /مدين|ذمم|عميل|receivabl|سلف|عهد|prepaid|advance/i.test(both(a)),
    ap:        (a) => a.category === "LIABILITY"   && /دائن|مورد|ذمم|payabl|مستحق|accrued/i.test(both(a)),
    revenue:   (a) => a.category === "REVENUE",
    cogs:      (a) => a.category === "COST_OF_SALES",
    expense:   (a) => a.category === "EXPENSE",
    fixed:     (a) => a.accountType === "FIXED_ASSET",
    inventory: (a) => /مخزون|بضاع|سلع|stock|inventor/i.test(both(a)),
    tax:       (a) => /ضريب|tax|vat/i.test(both(a)),
    equity:    (a) => a.category === "EQUITY",
  };
  const test = tests[cat] ?? (() => true);
  return accounts.filter((a) => a.isLeaf && a.active && test(a));
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface JournalLine {
  category: string;
  accountId: string;
  accountNameAr: string;
  entityLabel: string;
  note: string;
  debit: string;
  credit: string;
}

const ENTRY_TYPE_LABELS: Record<string, string> = {
  JOURNAL:    "يومية",
  RECEIPT:    "قبض",
  PAYMENT:    "صرف",
  ADJUSTMENT: "تسوية",
  OPENING:    "قيد افتتاحي",
};

function emptyLine(): JournalLine {
  return { category: "", accountId: "", accountNameAr: "", entityLabel: "", note: "", debit: "", credit: "" };
}

function lineNet(l: JournalLine): { type: "debit" | "credit"; net: number } {
  const d = parseFloat(l.debit)  || 0;
  const c = parseFloat(l.credit) || 0;
  const net = d - c;
  return { type: net >= 0 ? "debit" : "credit", net: Math.abs(net) };
}

function getAllLeafs(accounts: AccountRow[]): AccountRow[] {
  const out: AccountRow[] = [];
  for (const a of accounts) {
    if (a.isLeaf && a.active) out.push(a);
    if (a.children) out.push(...getAllLeafs(a.children));
  }
  return out;
}

// ─── Badges ───────────────────────────────────────────────────────────────────

function EntryTypeBadge({ type }: { type: string }) {
  const colorMap: Record<string, string> = {
    JOURNAL:    "bg-blue-100 text-blue-800",
    RECEIPT:    "bg-green-100 text-green-800",
    PAYMENT:    "bg-red-100 text-red-800",
    ADJUSTMENT: "bg-yellow-100 text-yellow-800",
    OPENING:    "bg-purple-100 text-purple-800",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colorMap[type] ?? "bg-gray-100 text-gray-700"}`}>
      {ENTRY_TYPE_LABELS[type] ?? type}
    </span>
  );
}

// ─── Source badge (referenceType → human label + link) ────────────────────────

function SourceBadge({ refType, refId, locale }: { refType: string | null; refId: string | null; locale: AppLocale }) {
  if (!refType || !refId) return <span className="text-textSecondary text-xs">—</span>;

  const map: Record<string, { label: string; href: (id: string, loc: string) => string }> = {
    sales_invoice:          { label: "فاتورة مبيعات",  href: (id, l) => `/${l}/sales/invoices/${id}` },
    order_collection:       { label: "تحصيل طلبية",   href: (id, l) => `/${l}/orders` },
    purchase_invoice:       { label: "فاتورة مشتريات", href: (id, l) => `/${l}/purchasing/invoices` },
    factory_ledger_payment: { label: "دفعة مصنع",     href: (id, l) => `/${l}/factory-orders` },
    expense:                { label: "مصروف",           href: (id, l) => `/${l}/expenses` },
    depreciation_entry:     { label: "استهلاك أصل",   href: (id, l) => `/${l}/accounting/fixed-assets` },
    fixed_asset:            { label: "أصل ثابت",      href: (id, l) => `/${l}/accounting/fixed-assets` },
  };

  const def = map[refType];
  if (!def) return <span className="text-xs text-textSecondary font-mono">{refType.slice(0, 12)}</span>;

  return (
    <a
      href={def.href(refId, locale)}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
    >
      {def.label} ↗
    </a>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function JournalPage() {
  const locale     = useLocale() as AppLocale;
  const t          = useTranslations("accounting.journal");
  const tCommon    = useTranslations("common");
  const isOwner    = useHasRole();
  const canCreate  = useHasRole("ACCOUNTANT");

  // ── List state ────────────────────────────────────────────────────────────
  const [entries,         setEntries]         = useState<JournalEntryRow[]>([]);
  const [nextCursor,      setNextCursor]      = useState<string | null>(null);
  const [error,           setError]           = useState<string | null>(null);
  const [loadingMore,     setLoadingMore]     = useState(false);
  const [expandedIds,     setExpandedIds]     = useState<Set<string>>(new Set());
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // ── Create modal state ────────────────────────────────────────────────────
  const [createOpen,    setCreateOpen]    = useState(false);
  const [leafAccounts,  setLeafAccounts]  = useState<AccountRow[]>([]);
  const [customers,     setCustomers]     = useState<CustomerRow[]>([]);
  const [suppliers,     setSuppliers]     = useState<SupplierRow[]>([]);
  const [entryType,     setEntryType]     = useState("JOURNAL");
  const [entryDate,     setEntryDate]     = useState(() => new Date().toISOString().slice(0, 10));
  const [description,   setDescription]   = useState("");
  const [reference,     setReference]     = useState("");
  const [lines,         setLines]         = useState<JournalLine[]>([emptyLine(), emptyLine()]);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError,   setCreateError]   = useState<string | null>(null);

  // ── Template picker ───────────────────────────────────────────────────────
  const [templates,          setTemplates]          = useState<JournalTemplate[]>([]);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

  // ─── Data loading ──────────────────────────────────────────────────────────

  const loadJournal = useCallback(
    async (cursor?: string | null) => {
      try {
        const page = await listJournal({ limit: 20, cursor });
        if (cursor) {
          setEntries((prev) => [...prev, ...page.data]);
        } else {
          setEntries(page.data);
        }
        setNextCursor(page.nextCursor);
      } catch {
        setError(t("loadFailed"));
      }
    },
    [t],
  );

  useEffect(() => { void loadJournal(); }, [loadJournal]);

  useEffect(() => {
    if (!createOpen || leafAccounts.length > 0) return;
    void Promise.all([listAccounts(), listCustomers(), listSuppliers()]).then(
      ([accs, custs, supps]) => {
        setLeafAccounts(getAllLeafs(accs));
        setCustomers(custs.filter((c) => c.active));
        setSuppliers(supps.filter((s) => s.active));
      },
    );
  }, [createOpen, leafAccounts.length]);

  useEffect(() => {
    if (!createOpen || templates.length > 0) return;
    void listTemplates().then(setTemplates).catch(() => undefined);
  }, [createOpen, templates.length]);

  // ─── Derived values ────────────────────────────────────────────────────────

  const totalDebit  = lines.reduce((s, l) => { const { type, net } = lineNet(l); return type === "debit"  ? s + net : s; }, 0);
  const totalCredit = lines.reduce((s, l) => { const { type, net } = lineNet(l); return type === "credit" ? s + net : s; }, 0);
  const diff        = totalDebit - totalCredit;
  const isBalanced  = totalDebit > 0 && Math.abs(diff) < 0.005;
  const canSubmit   =
    lines.length >= 2 &&
    isBalanced &&
    lines.every((l) => l.accountId !== "" && (parseFloat(l.debit) || 0) + (parseFloat(l.credit) || 0) > 0) &&
    totalDebit > 0;

  // ─── Line mutations ────────────────────────────────────────────────────────

  function updateLine(idx: number, patch: Partial<JournalLine>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function handleCategoryChange(idx: number, cat: string) {
    updateLine(idx, { category: cat, accountId: "", accountNameAr: "", entityLabel: "" });
  }

  function handleAccountChange(idx: number, accountId: string) {
    const acc = leafAccounts.find((a) => a.id === accountId);
    updateLine(idx, { accountId, accountNameAr: acc?.nameAr ?? "" });
  }

  function handleCustomerSelect(idx: number, customerId: string) {
    const cust = customers.find((c) => c.id === customerId);
    if (!cust) return;
    const arAcc = leafAccounts.find(
      (a) => a.category === "ASSET" && /ذمم مدين|مدينون|حساب.*عميل/.test(a.nameAr),
    );
    updateLine(idx, {
      entityLabel: `${cust.code} — ${cust.nameAr}`,
      note: lines[idx]?.note || `${cust.code} — ${cust.nameAr}`,
      accountId: arAcc?.id ?? "",
      accountNameAr: arAcc?.nameAr ?? "",
    });
  }

  function handleSupplierSelect(idx: number, supplierId: string) {
    const supp = suppliers.find((s) => s.id === supplierId);
    if (!supp) return;
    const apAcc = leafAccounts.find(
      (a) => a.category === "LIABILITY" && /ذمم دائن|دائنون|حساب.*مورد/.test(a.nameAr),
    );
    updateLine(idx, {
      entityLabel: supp.nameAr,
      note: lines[idx]?.note || supp.nameAr,
      accountId: apAcc?.id ?? "",
      accountNameAr: apAcc?.nameAr ?? "",
    });
  }

  function handleDebitChange(idx: number, val: string) {
    updateLine(idx, { debit: val });
  }

  function handleCreditChange(idx: number, val: string) {
    updateLine(idx, { credit: val });
  }

  // ─── Template application ──────────────────────────────────────────────────

  function applyTemplate(template: JournalTemplate) {
    const newLines: JournalLine[] = template.lines.map((l) => {
      const acc = leafAccounts.find((a) => a.id === l.accountId);
      return {
        category: "all",
        accountId: l.accountId,
        accountNameAr: acc?.nameAr ?? l.accountNameAr,
        entityLabel: "",
        note: l.note ?? "",
        debit:  l.type === "debit"  ? (l.amount ?? "") : "",
        credit: l.type === "credit" ? (l.amount ?? "") : "",
      };
    });
    setLines(newLines.length > 0 ? newLines : [emptyLine(), emptyLine()]);
    setTemplatePickerOpen(false);
  }

  // ─── Submit ────────────────────────────────────────────────────────────────

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setCreateLoading(true);
    setCreateError(null);
    try {
      await createJournalEntry({
        entryType,
        reference: reference.trim() || undefined,
        entryDate,
        description,
        lines: lines.map((l) => {
          const { type, net } = lineNet(l);
          return {
            accountId: l.accountId,
            debit:  type === "debit"  ? net.toFixed(2) : "0.00",
            credit: type === "credit" ? net.toFixed(2) : "0.00",
            note: l.note || undefined,
          };
        }),
      });
      setCreateOpen(false);
      resetModal();
      await loadJournal();
    } catch {
      setCreateError(t("loadFailed"));
    } finally {
      setCreateLoading(false);
    }
  }

  function resetModal() {
    setEntryType("JOURNAL");
    setEntryDate(new Date().toISOString().slice(0, 10));
    setDescription("");
    setReference("");
    setLines([emptyLine(), emptyLine()]);
    setCreateError(null);
  }

  // ─── Delete ────────────────────────────────────────────────────────────────

  async function handleDelete(id: string) {
    try {
      await deleteJournalEntry(id);
      setDeleteConfirmId(null);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch {
      setError(tCommon("actionFailed"));
    }
  }

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ─── CSS helpers (same as templates page) ─────────────────────────────────

  const selectCls =
    "w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary";
  const amountCls =
    "w-full rounded border px-2 py-1.5 text-sm text-end tabular-nums bg-background focus:outline-none focus:ring-1";

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{t("title")}</h1>
        {canCreate && (
          <Button onClick={() => { resetModal(); setCreateOpen(true); }}>
            {t("newEntry")}
          </Button>
        )}
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {/* ── Entries table ─────────────────────────────────────────────────── */}
      <div className="border border-border rounded overflow-hidden">
        <Table>
          <THead>
            <TR>
              <TH>رقم القيد</TH>
              <TH>التاريخ</TH>
              <TH>البيان</TH>
              <TH>نوع القيد</TH>
              <TH>مصدر القيد</TH>
              <TH>إجمالي</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {entries.map((entry) => {
              const expanded       = expandedIds.has(entry.id);
              const confirmDelete  = deleteConfirmId === entry.id;
              return (
                <>
                  <TR key={entry.id}>
                    <TD>
                      <span className="font-mono text-sm font-semibold">#{entry.entryNumber}</span>
                    </TD>
                    <TD>
                      <span className="text-sm">{formatDate(entry.entryDate, locale)}</span>
                    </TD>
                    <TD>
                      <span className="text-sm">{entry.description}</span>
                      {entry.reference && (
                        <span className="ms-1 text-xs text-textSecondary">({entry.reference})</span>
                      )}
                    </TD>
                    <TD>
                      <EntryTypeBadge type={entry.entryType} />
                    </TD>
                    <TD>
                      <SourceBadge refType={entry.referenceType} refId={entry.referenceId} locale={locale} />
                    </TD>
                    <TD>
                      <span className="text-sm font-medium tabular-nums">
                        {formatCurrency(entry.totalDebit, locale)}
                      </span>
                    </TD>
                    <TD>
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          type="button"
                          className="text-textSecondary hover:text-text text-sm px-2 py-0.5"
                          onClick={() => toggleExpand(entry.id)}
                          title={expanded ? "إخفاء" : "عرض الأسطر"}
                        >
                          {expanded ? "▾" : "▸"}
                        </button>
                        {isOwner && (
                          confirmDelete ? (
                            <div className="flex items-center gap-1 text-xs whitespace-nowrap">
                              <span className="text-textSecondary">{t("deleteConfirm")}</span>
                              <Button size="sm" variant="danger" onClick={() => void handleDelete(entry.id)}>
                                {tCommon("yes")}
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setDeleteConfirmId(null)}>
                                {tCommon("no")}
                              </Button>
                            </div>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => setDeleteConfirmId(entry.id)}>
                              {tCommon("delete")}
                            </Button>
                          )
                        )}
                      </div>
                    </TD>
                  </TR>

                  {expanded && (
                    <TR key={`${entry.id}-lines`}>
                      <TD colSpan={7} className="p-0 bg-background">
                        <div className="px-4 py-3">
                          <table className="w-full text-sm border border-border rounded overflow-hidden">
                            <thead>
                              <tr className="bg-surface border-b-2 border-border text-right">
                                <th className="px-3 py-2 text-xs font-semibold text-textSecondary w-8">#</th>
                                <th className="px-3 py-2 text-xs font-semibold text-textSecondary">الحساب</th>
                                <th className="px-3 py-2 text-xs font-semibold text-textSecondary">البيان</th>
                                <th className="px-3 py-2 text-xs font-bold text-red-700 text-end w-32">مدين</th>
                                <th className="px-3 py-2 text-xs font-bold text-green-700 text-end w-32">دائن</th>
                              </tr>
                            </thead>
                            <tbody>
                              {entry.lines.map((line, li) => {
                                const isDebit  = parseFloat(line.debit)  > 0;
                                const isCredit = parseFloat(line.credit) > 0;
                                return (
                                  <tr key={line.id} className="border-b border-border last:border-0 hover:bg-surface/60">
                                    <td className="px-3 py-2 text-xs text-textSecondary text-center select-none">
                                      {li + 1}
                                    </td>
                                    <td className="px-3 py-2">
                                      <span className="font-mono text-xs text-textSecondary me-2">{line.accountCode}</span>
                                      {locale === "ar" ? line.accountNameAr : line.accountNameEn}
                                    </td>
                                    <td className="px-3 py-2 text-textSecondary text-xs">{line.note ?? "—"}</td>
                                    <td className={"px-3 py-2 text-end tabular-nums font-medium text-sm " + (isDebit ? "bg-red-50 text-red-700" : "text-textSecondary")}>
                                      {isDebit ? formatCurrency(line.debit, locale) : ""}
                                    </td>
                                    <td className={"px-3 py-2 text-end tabular-nums font-medium text-sm " + (isCredit ? "bg-green-50 text-green-700" : "text-textSecondary")}>
                                      {isCredit ? formatCurrency(line.credit, locale) : ""}
                                    </td>
                                  </tr>
                                );
                              })}
                              {/* totals row */}
                              <tr className="bg-surface border-t-2 border-border">
                                <td />
                                <td colSpan={2} className="px-3 py-1.5 text-xs font-semibold text-textSecondary text-end">
                                  الإجمالي
                                </td>
                                <td className="px-3 py-1.5 text-end tabular-nums font-bold text-red-700 text-sm">
                                  {formatCurrency(entry.totalDebit, locale)}
                                </td>
                                <td className="px-3 py-1.5 text-end tabular-nums font-bold text-green-700 text-sm">
                                  {formatCurrency(entry.totalDebit, locale)}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </TD>
                    </TR>
                  )}
                </>
              );
            })}
            {entries.length === 0 && (
              <TR>
                <TD colSpan={7} className="text-center py-8 text-textSecondary">
                  لا توجد قيود محاسبية
                </TD>
              </TR>
            )}
          </TBody>
        </Table>
      </div>

      {nextCursor && (
        <div className="text-center">
          <Button
            variant="ghost"
            onClick={async () => { setLoadingMore(true); await loadJournal(nextCursor); setLoadingMore(false); }}
            disabled={loadingMore}
          >
            {loadingMore ? tCommon("loading") : t("loadMore")}
          </Button>
        </div>
      )}

      {/* ── Create Journal Entry Modal ─────────────────────────────────────── */}
      <Modal
        open={createOpen}
        onClose={() => { setCreateOpen(false); resetModal(); }}
        title={t("newEntry")}
        className="max-w-5xl w-[95vw]"
      >
        <form onSubmit={(e) => void handleCreate(e)} className="space-y-5" dir="rtl">
          {createError && <Alert variant="error">{createError}</Alert>}

          {/* ── Header fields ───────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <div>
              <label className="block text-sm font-medium mb-1">نوع القيد</label>
              <select
                className={selectCls}
                value={entryType}
                onChange={(e) => setEntryType(e.target.value)}
              >
                {Object.entries(ENTRY_TYPE_LABELS).map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">{t("entryDate")}</label>
              <Input
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                required
              />
            </div>
            <div className="sm:col-span-1">
              <label className="block text-sm font-medium mb-1">{t("description")}</label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="البيان العام للقيد"
                required
                maxLength={500}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">مرجع خارجي</label>
              <Input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="اختياري"
                maxLength={100}
              />
            </div>
          </div>

          {/* ── Template picker ─────────────────────────────────────────── */}
          <div className="flex items-center gap-2">
            <div className="relative">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setTemplatePickerOpen((v) => !v)}
              >
                استخدام قالب ▾
              </Button>
              {templatePickerOpen && (
                <div className="absolute top-full mt-1 start-0 z-20 min-w-[220px] rounded border border-border bg-surface shadow-lg">
                  {templates.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-textSecondary">لا توجد قوالب محفوظة</div>
                  ) : (
                    <ul>
                      {templates.map((tpl) => (
                        <li key={tpl.id}>
                          <button
                            type="button"
                            className="w-full text-start px-3 py-2 text-sm hover:bg-background transition-colors"
                            onClick={() => applyTemplate(tpl)}
                          >
                            <span className="font-medium">{tpl.name}</span>
                            {tpl.description && (
                              <span className="block text-xs text-textSecondary">{tpl.description}</span>
                            )}
                            <span className="block text-xs text-textSecondary">{tpl.lines.length} سطر</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <span className="text-xs text-textSecondary">يملأ الأسطر تلقائياً من القالب المختار</span>
          </div>

          {/* ── Lines table — same pattern as templates ──────────────────── */}
          <div className="border border-border rounded overflow-hidden">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-surface border-b-2 border-border">
                  <th className="px-2 py-2 text-center text-xs text-textSecondary font-semibold w-8">#</th>
                  <th className="px-2 py-2 text-start text-xs text-textSecondary font-semibold w-36">القائمة</th>
                  <th className="px-2 py-2 text-start text-xs text-textSecondary font-semibold">الحساب</th>
                  <th className="px-2 py-2 text-start text-xs text-textSecondary font-semibold">البيان</th>
                  <th className="px-2 py-2 text-center text-xs font-bold text-red-700 w-28">مدين</th>
                  <th className="px-2 py-2 text-center text-xs font-bold text-green-700 w-28">دائن</th>
                  <th className="w-7" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => {
                  const isCustomers = line.category === "customers";
                  const isSuppliers = line.category === "suppliers";
                  const isSpecial   = isCustomers || isSuppliers;
                  const accountOptions = line.category && !isSpecial
                    ? filterAccounts(line.category, leafAccounts)
                    : [];

                  return (
                    <tr
                      key={idx}
                      className="border-b border-border last:border-0 hover:bg-surface/60 transition-colors"
                    >
                      {/* # */}
                      <td className="px-2 py-2 text-center text-xs text-textSecondary select-none">
                        {idx + 1}
                      </td>

                      {/* القائمة */}
                      <td className="px-1.5 py-1.5">
                        <select
                          className={selectCls}
                          value={line.category}
                          onChange={(e) => handleCategoryChange(idx, e.target.value)}
                        >
                          <option value="">— القائمة —</option>
                          {CATEGORIES.map((c) => (
                            <option key={c.id} value={c.id}>{c.label}</option>
                          ))}
                        </select>
                      </td>

                      {/* الحساب */}
                      <td className="px-1.5 py-1.5">
                        {!line.category ? (
                          <span className="text-xs text-textSecondary italic">اختر القائمة أولاً</span>
                        ) : isCustomers ? (
                          <div className="space-y-1">
                            <select
                              className={selectCls}
                              value=""
                              onChange={(e) => handleCustomerSelect(idx, e.target.value)}
                            >
                              <option value="">— اختر العميل —</option>
                              {customers.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.code} — {c.nameAr}
                                </option>
                              ))}
                            </select>
                            {line.entityLabel && (
                              <div className="text-xs text-primary font-medium px-1">
                                ✓ {line.entityLabel}
                              </div>
                            )}
                            {isSpecial && line.entityLabel && !line.accountId && (
                              <div className="text-xs text-amber-600 px-1">
                                ⚠ لم يُعثر على حساب ذمم — غيّر القائمة لـ «الذمم المدينة» واختر يدوياً
                              </div>
                            )}
                          </div>
                        ) : isSuppliers ? (
                          <div className="space-y-1">
                            <select
                              className={selectCls}
                              value=""
                              onChange={(e) => handleSupplierSelect(idx, e.target.value)}
                            >
                              <option value="">— اختر المورد —</option>
                              {suppliers.map((s) => (
                                <option key={s.id} value={s.id}>{s.nameAr}</option>
                              ))}
                            </select>
                            {line.entityLabel && (
                              <div className="text-xs text-primary font-medium px-1">
                                ✓ {line.entityLabel}
                              </div>
                            )}
                            {isSpecial && line.entityLabel && !line.accountId && (
                              <div className="text-xs text-amber-600 px-1">
                                ⚠ لم يُعثر على حساب موردين — غيّر القائمة لـ «الذمم الدائنة» واختر يدوياً
                              </div>
                            )}
                          </div>
                        ) : (
                          <select
                            className={selectCls}
                            value={line.accountId}
                            onChange={(e) => handleAccountChange(idx, e.target.value)}
                          >
                            <option value="">— اختر الحساب —</option>
                            {accountOptions.length === 0 ? (
                              <option disabled value="">لا توجد حسابات في هذه القائمة</option>
                            ) : (
                              accountOptions.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.code} — {a.nameAr}
                                </option>
                              ))
                            )}
                          </select>
                        )}
                      </td>

                      {/* البيان */}
                      <td className="px-1.5 py-1.5">
                        <input
                          type="text"
                          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                          placeholder="بيان السطر..."
                          value={line.note}
                          onChange={(e) => updateLine(idx, { note: e.target.value })}
                          maxLength={200}
                        />
                      </td>

                      {/* مدين */}
                      <td className="px-1.5 py-1.5">
                        <input
                          type="number"
                          className={amountCls + " border-red-200 focus:ring-red-400" + (line.debit ? " bg-red-50 border-red-300" : " border-border")}
                          placeholder="0.00"
                          min="0"
                          step="0.01"
                          value={line.debit}
                          onChange={(e) => handleDebitChange(idx, e.target.value)}
                        />
                      </td>

                      {/* دائن */}
                      <td className="px-1.5 py-1.5">
                        <input
                          type="number"
                          className={amountCls + " border-green-200 focus:ring-green-400" + (line.credit ? " bg-green-50 border-green-300" : " border-border")}
                          placeholder="0.00"
                          min="0"
                          step="0.01"
                          value={line.credit}
                          onChange={(e) => handleCreditChange(idx, e.target.value)}
                        />
                        {line.debit && line.credit && (() => {
                          const { type, net } = lineNet(line);
                          return (
                            <div className="text-xs text-center mt-0.5 font-mono text-amber-700">
                              صافي {net.toFixed(2)} {type === "debit" ? "م" : "د"}
                            </div>
                          );
                        })()}
                      </td>

                      {/* حذف */}
                      <td className="px-1 py-1.5 text-center">
                        {lines.length > 1 && (
                          <button
                            type="button"
                            className="text-danger text-xs px-1 py-0.5 hover:bg-red-50 rounded transition-colors"
                            onClick={() => setLines((p) => p.filter((_, j) => j !== idx))}
                            title="حذف السطر"
                          >
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {/* Totals row */}
                <tr className="bg-surface border-t-2 border-border">
                  <td />
                  <td colSpan={3} className="px-3 py-2 text-end text-xs text-textSecondary font-semibold">
                    الإجمالي
                  </td>
                  <td className="px-1.5 py-2 text-end tabular-nums font-bold text-red-700 text-sm">
                    {totalDebit > 0 ? totalDebit.toFixed(2) : "—"}
                  </td>
                  <td className="px-1.5 py-2 text-end tabular-nums font-bold text-green-700 text-sm">
                    {totalCredit > 0 ? totalCredit.toFixed(2) : "—"}
                  </td>
                  <td />
                </tr>

                {/* Balance indicator */}
                {(totalDebit > 0 || totalCredit > 0) && (
                  <tr>
                    <td colSpan={7} className="px-3 py-1.5">
                      {isBalanced ? (
                        <span className="text-xs text-green-700 font-medium">✓ القيد متوازن</span>
                      ) : (
                        <span className="text-xs text-red-600 font-medium">
                          ⚠ فرق {Math.abs(diff).toFixed(2)} — القيد غير متوازن
                        </span>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <button
              type="button"
              onClick={() => setLines((p) => [...p, emptyLine()])}
              className="w-full py-2 text-xs text-primary hover:bg-surface border-t border-border transition-colors"
            >
              + إضافة سطر
            </button>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={() => { setCreateOpen(false); resetModal(); }}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit || createLoading}>
              {createLoading ? tCommon("loading") : tCommon("save")}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
