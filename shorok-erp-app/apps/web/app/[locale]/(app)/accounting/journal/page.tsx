"use client";

import { useEffect, useState, useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Input } from "../../../../../components/ui/input";
import { Modal } from "../../../../../components/ui/modal";
import { NegativeBalanceModal } from "../../../../../components/features/negative-balance-modal";
import { parseTreasuryWarning, type TreasuryWarning } from "../../../../../lib/treasury-warning";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { useHasRole } from "../../../../../lib/auth";
import {
  listJournal,
  createJournalEntry,
  deleteJournalEntry,
  type JournalEntryRow,
} from "../../../../../lib/journal-client";
import { listAccounts, type AccountRow } from "../../../../../lib/accounts-client";
import { listCustomers, createCustomer, type CustomerRow } from "../../../../../lib/customers-client";
import { listRepresentatives, type SalesRepresentative } from "../../../../../lib/sales-representatives-client";
import { RepresentativeFormModal } from "../../../../../components/sales-representatives/representative-form-modal";
import { listSuppliers, type SupplierRow } from "../../../../../lib/suppliers-client";
import { ApiClientError } from "../../../../../lib/api-client";
import {
  listTemplates,
  type JournalTemplate,
} from "../../../../../lib/journal-templates-client";
import { formatDate, formatCurrency } from "../../../../../lib/format";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The line's "القائمة" (list) selector is a single mutually-exclusive dimension:
 * a line may carry a Customer party, a Supplier party, a Sales Representative,
 * or nothing. It is a FRONTEND-ONLY discriminator mapped to the existing backend
 * fields (partyType/partyId for customer/supplier; salesRepresentativeId for the
 * rep) — the DB PartyType enum is unchanged.
 */
type JournalListType = "NONE" | "CUSTOMER" | "SUPPLIER" | "SALES_REPRESENTATIVE";

interface JournalLine {
  listType: JournalListType;
  accountId: string;
  accountNameAr: string;
  entityLabel: string; // display label of the selected customer/supplier/rep
  note: string;
  debit: string;
  credit: string;
  // Customer/Supplier party (AR_CONTROL → CUSTOMER, AP_CONTROL → SUPPLIER).
  partyType?: "CUSTOMER" | "SUPPLIER";
  partyId?: string;
  // Sales-representative dimension — mutually exclusive with the party above.
  salesRepresentativeId?: string;
}

const ENTRY_TYPE_LABELS: Record<string, string> = {
  JOURNAL:    "يومية",
  RECEIPT:    "قبض",
  PAYMENT:    "صرف",
  ADJUSTMENT: "تسوية",
  OPENING:    "قيد افتتاحي",
};

function emptyLine(): JournalLine {
  return { listType: "NONE", accountId: "", accountNameAr: "", entityLabel: "", note: "", debit: "", credit: "", partyType: undefined, partyId: undefined, salesRepresentativeId: undefined };
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
  const [negWarning,      setNegWarning]      = useState<TreasuryWarning | null>(null);

  // ── Create modal state ────────────────────────────────────────────────────
  const [createOpen,    setCreateOpen]    = useState(false);
  const [leafAccounts,  setLeafAccounts]  = useState<AccountRow[]>([]);
  const [customers,     setCustomers]     = useState<CustomerRow[]>([]);
  const [suppliers,     setSuppliers]     = useState<SupplierRow[]>([]);
  const [reps,          setReps]          = useState<SalesRepresentative[]>([]);
  const [entryType,     setEntryType]     = useState("JOURNAL");
  const [entryDate,     setEntryDate]     = useState(() => new Date().toISOString().slice(0, 10));
  const [description,   setDescription]   = useState("");
  const [reference,     setReference]     = useState("");
  const [lines,         setLines]         = useState<JournalLine[]>([emptyLine(), emptyLine()]);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError,   setCreateError]   = useState<string | null>(null);
  const [openComboIdx,  setOpenComboIdx]  = useState<number | null>(null);
  const [comboSearch,   setComboSearch]   = useState<Record<number, string>>({});
  const [listSearch,    setListSearch]    = useState("");
  const [masterDataError, setMasterDataError] = useState<string | null>(null);
  // Which line opened a quick-create modal (so the new entity auto-selects there).
  const [quickCustomerIdx, setQuickCustomerIdx] = useState<number | null>(null);
  const [quickRepIdx,      setQuickRepIdx]      = useState<number | null>(null);
  const [quickCustName,    setQuickCustName]    = useState("");
  const [quickCustPhone,   setQuickCustPhone]   = useState("");
  const [quickCustSaving,  setQuickCustSaving]  = useState(false);
  const [quickCustError,   setQuickCustError]   = useState<string | null>(null);

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

  // Live master-data refresh — reused on open, after quick-create, and on window
  // focus so options stay current without a full page reload. Failures surface a
  // localized error with a retry action rather than being swallowed.
  const refreshMasterData = useCallback(async () => {
    setMasterDataError(null);
    try {
      const [accs, custs, supps, repList] = await Promise.all([
        listAccounts(),
        listCustomers(),
        listSuppliers(),
        listRepresentatives({ status: "active" }),
      ]);
      setLeafAccounts(getAllLeafs(accs));
      setCustomers(custs.filter((c) => c.active));
      setSuppliers(supps.filter((s) => s.active));
      setReps(repList);
    } catch {
      setMasterDataError(t("masterDataError"));
    }
  }, [t]);

  const refreshCustomers = useCallback(async () => {
    try { setCustomers((await listCustomers()).filter((c) => c.active)); }
    catch { setMasterDataError(t("customersLoadError")); }
  }, [t]);
  const refreshRepresentatives = useCallback(async () => {
    try { setReps(await listRepresentatives({ status: "active" })); }
    catch { setMasterDataError(t("repsLoadError")); }
  }, [t]);

  useEffect(() => {
    if (!createOpen) return;
    void refreshMasterData();
  }, [createOpen, refreshMasterData]);

  // Refresh options when the window regains focus (e.g. after creating a
  // customer/representative in another tab), only while the editor is open.
  useEffect(() => {
    if (!createOpen) return;
    const onFocus = () => void refreshMasterData();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [createOpen, refreshMasterData]);

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
    // Control-account lines must have a party selected.
    lines.every((l) => !l.partyType || !!l.partyId) &&
    totalDebit > 0;

  const displayedEntries = listSearch
    ? entries.filter((e) =>
        (`#${e.entryNumber} ${e.description} ${e.reference ?? ""}`)
          .toLowerCase()
          .includes(listSearch.toLowerCase()),
      )
    : entries;

  // ─── Line mutations ────────────────────────────────────────────────────────

  function updateLine(idx: number, patch: Partial<JournalLine>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  /**
   * Switching the list type clears every incompatible selection so no stale
   * hidden id survives in the payload (Customer↔Rep↔Supplier↔None).
   */
  function handleListTypeChange(idx: number, listType: JournalListType) {
    updateLine(idx, {
      listType,
      partyType: undefined,
      partyId: undefined,
      salesRepresentativeId: undefined,
      entityLabel: "",
    });
  }

  /** Selects the customer/supplier/rep for the line, per its current list type. */
  function handleEntitySelect(idx: number, entityId: string) {
    const line = lines[idx];
    if (!line) return;
    if (!entityId) {
      updateLine(idx, { partyId: undefined, salesRepresentativeId: undefined, entityLabel: "" });
      return;
    }
    if (line.listType === "CUSTOMER") {
      const c = customers.find((x) => x.id === entityId);
      updateLine(idx, { partyType: "CUSTOMER", partyId: entityId, salesRepresentativeId: undefined, entityLabel: c ? `${c.code} — ${c.nameAr}` : "" });
    } else if (line.listType === "SUPPLIER") {
      const s = suppliers.find((x) => x.id === entityId);
      updateLine(idx, { partyType: "SUPPLIER", partyId: entityId, salesRepresentativeId: undefined, entityLabel: s ? s.nameAr : "" });
    } else if (line.listType === "SALES_REPRESENTATIVE") {
      const r = reps.find((x) => x.id === entityId);
      updateLine(idx, { salesRepresentativeId: entityId, partyType: undefined, partyId: undefined, entityLabel: r ? `${r.code} — ${r.nameAr}` : "" });
    }
  }

  function handleAccountChange(idx: number, accountId: string) {
    const acc = leafAccounts.find((a) => a.id === accountId);
    // The account is chosen independently; the party/rep comes from القائمة.
    updateLine(idx, { accountId, accountNameAr: acc?.nameAr ?? "" });
  }

  // ── Quick-create (customer / representative) — preserves all unsaved lines ──

  function openQuickCustomer(idx: number) {
    setQuickCustomerIdx(idx); setQuickCustName(""); setQuickCustPhone(""); setQuickCustError(null);
  }

  async function submitQuickCustomer(e: React.FormEvent) {
    e.preventDefault();
    if (quickCustSaving) return; // guard double-submit
    if (!quickCustName.trim()) { setQuickCustError(t("nameRequired")); return; }
    setQuickCustSaving(true); setQuickCustError(null);
    try {
      const created = await createCustomer({ nameAr: quickCustName.trim(), phone: quickCustPhone.trim() || undefined });
      // Insert into options immediately, de-duplicated by id.
      setCustomers((prev) => [created, ...prev.filter((c) => c.id !== created.id)]);
      const idx = quickCustomerIdx;
      if (idx !== null) {
        updateLine(idx, { listType: "CUSTOMER", partyType: "CUSTOMER", partyId: created.id, salesRepresentativeId: undefined, entityLabel: `${created.code} — ${created.nameAr}` });
      }
      setQuickCustomerIdx(null);
      void refreshCustomers(); // reconcile with the server list
    } catch (err) {
      setQuickCustError(err instanceof ApiClientError ? err.localizedMessage(locale) : t("customersLoadError"));
    } finally {
      setQuickCustSaving(false);
    }
  }

  function onQuickRepCreated(created: SalesRepresentative) {
    setReps((prev) => [created, ...prev.filter((r) => r.id !== created.id)]);
    const idx = quickRepIdx;
    if (idx !== null) {
      updateLine(idx, { listType: "SALES_REPRESENTATIVE", salesRepresentativeId: created.id, partyType: undefined, partyId: undefined, entityLabel: `${created.code} — ${created.nameAr}` });
    }
    setQuickRepIdx(null);
    void refreshRepresentatives();
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
        listType: "NONE" as JournalListType,
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
    await submitJournal(false);
  }

  async function submitJournal(acknowledge: boolean) {
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
            partyType: l.partyType,
            partyId: l.partyId,
            salesRepresentativeId: l.salesRepresentativeId || null,
          };
        }),
        ...(acknowledge ? { acknowledgeNegativeBalance: true } : {}),
      });
      setNegWarning(null);
      setCreateOpen(false);
      resetModal();
      await loadJournal();
    } catch (err) {
      const w = parseTreasuryWarning(err);
      if (w) setNegWarning(w); // open the confirmation modal; keep the form intact
      else if (err instanceof ApiClientError) setCreateError(err.localizedMessage(locale));
      else setCreateError(t("loadFailed"));
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

      {/* ── List search ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <Input
          placeholder="بحث بالبيان أو المرجع أو رقم القيد..."
          value={listSearch}
          onChange={(e) => setListSearch(e.target.value)}
          className="max-w-sm border-2 border-primary/40 bg-background"
        />
        {listSearch && (
          <span className="text-sm text-textSecondary">{displayedEntries.length} نتيجة</span>
        )}
        {listSearch && (
          <button
            type="button"
            className="text-xs text-textSecondary hover:text-text"
            onClick={() => setListSearch("")}
          >
            مسح ✕
          </button>
        )}
      </div>

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
            {displayedEntries.map((entry) => {
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
                                <th className="px-3 py-2 text-xs font-semibold text-textSecondary">{t("accountLabel")}</th>
                                <th className="px-3 py-2 text-xs font-semibold text-textSecondary">{t("selection")}</th>
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
                                    <td className="px-3 py-2 text-xs">
                                      {line.salesRepresentative
                                        ? <span className="text-primary">{t("listReps")}: {line.salesRepresentative.code} — {line.salesRepresentative.nameAr}</span>
                                        : line.partyType === "CUSTOMER"
                                        ? <span className="text-primary">{t("listCustomers")}: {line.partyLabel ?? "—"}</span>
                                        : line.partyType === "SUPPLIER"
                                        ? <span className="text-primary">{t("listSuppliers")}: {line.partyLabel ?? "—"}</span>
                                        : <span className="text-textSecondary">—</span>}
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
                                <td colSpan={3} className="px-3 py-1.5 text-xs font-semibold text-textSecondary text-end">
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
            {displayedEntries.length === 0 && (
              <TR>
                <TD colSpan={7} className="text-center py-8 text-textSecondary">
                  {listSearch ? "لا توجد قيود تطابق البحث" : "لا توجد قيود محاسبية"}
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
          {masterDataError && (
            <Alert variant="error">
              <span className="flex items-center justify-between gap-3">
                <span>{masterDataError}</span>
                <button type="button" className="underline text-sm shrink-0" onClick={() => void refreshMasterData()}>
                  {t("retry")}
                </button>
              </span>
            </Alert>
          )}

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
                  <th className="px-2 py-2 text-start text-xs text-textSecondary font-semibold w-32">{t("listLabel")}</th>
                  <th className="px-2 py-2 text-start text-xs text-textSecondary font-semibold w-56">{t("selection")}</th>
                  <th className="px-2 py-2 text-start text-xs text-textSecondary font-semibold">{t("accountLabel")}</th>
                  <th className="px-2 py-2 text-start text-xs text-textSecondary font-semibold">البيان</th>
                  <th className="px-2 py-2 text-center text-xs font-bold text-red-700 w-28">مدين</th>
                  <th className="px-2 py-2 text-center text-xs font-bold text-green-700 w-28">دائن</th>
                  <th className="w-7" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => {
                  // القائمة no longer filters accounts — الحساب searches every
                  // active leaf account; the party/rep comes from القائمة/الاختيار.
                  const pool = leafAccounts;
                  const q = (comboSearch[idx] ?? "").toLowerCase();
                  const visible = q
                    ? pool.filter((a) => (a.nameAr + " " + (a.nameEn ?? "") + " " + a.code).toLowerCase().includes(q))
                    : pool;
                  const selectedAcc = line.accountId ? leafAccounts.find((a) => a.id === line.accountId) : null;
                  const entityValue = line.listType === "SALES_REPRESENTATIVE" ? (line.salesRepresentativeId ?? "") : (line.partyId ?? "");

                  return (
                    <tr
                      key={idx}
                      className="border-b border-border last:border-0 hover:bg-surface/60 transition-colors"
                    >
                      {/* # */}
                      <td className="px-2 py-2 text-center text-xs text-textSecondary select-none">
                        {idx + 1}
                      </td>

                      {/* القائمة — the line's single mutually-exclusive dimension */}
                      <td className="px-1.5 py-1.5 align-top">
                        <select
                          className={selectCls}
                          value={line.listType}
                          onChange={(e) => handleListTypeChange(idx, e.target.value as JournalListType)}
                        >
                          <option value="NONE">{t("listNone")}</option>
                          <option value="CUSTOMER">{t("listCustomers")}</option>
                          <option value="SUPPLIER">{t("listSuppliers")}</option>
                          <option value="SALES_REPRESENTATIVE">{t("listReps")}</option>
                        </select>
                      </td>

                      {/* الاختيار — dynamic entity picker + contextual quick-create */}
                      <td className="px-1.5 py-1.5 align-top">
                        {line.listType === "NONE" ? (
                          <div className="text-xs text-textSecondary px-1 py-1.5 select-none">—</div>
                        ) : (
                          <div className="space-y-1">
                            <div className="flex gap-1">
                              <select
                                className={selectCls}
                                value={entityValue}
                                onChange={(e) => handleEntitySelect(idx, e.target.value)}
                              >
                                <option value="">
                                  {line.listType === "CUSTOMER" ? t("selectCustomer")
                                    : line.listType === "SUPPLIER" ? t("selectSupplier")
                                    : t("selectRep")}
                                </option>
                                {line.listType === "CUSTOMER" && customers.map((c) => (
                                  <option key={c.id} value={c.id}>{c.code} — {c.nameAr}</option>
                                ))}
                                {line.listType === "SUPPLIER" && suppliers.map((s) => (
                                  <option key={s.id} value={s.id}>{s.nameAr}</option>
                                ))}
                                {line.listType === "SALES_REPRESENTATIVE" && reps.map((r) => (
                                  <option key={r.id} value={r.id}>{r.code} — {r.nameAr}</option>
                                ))}
                              </select>
                              {line.listType === "CUSTOMER" && (
                                <button type="button" onClick={() => openQuickCustomer(idx)} title={t("newCustomer")}
                                  className="shrink-0 rounded border border-primary px-2 text-xs text-primary hover:bg-primary hover:text-white transition-colors">+</button>
                              )}
                              {line.listType === "SALES_REPRESENTATIVE" && (
                                <button type="button" onClick={() => setQuickRepIdx(idx)} title={t("newRep")}
                                  className="shrink-0 rounded border border-primary px-2 text-xs text-primary hover:bg-primary hover:text-white transition-colors">+</button>
                              )}
                            </div>
                            {line.entityLabel && (
                              <div className="text-xs text-primary font-medium px-1 truncate">✓ {line.entityLabel}</div>
                            )}
                          </div>
                        )}
                      </td>

                      {/* الحساب — searches every active leaf account */}
                      <td className="px-1.5 py-1.5 align-top">
                        <div className="relative">
                          {line.accountId && openComboIdx !== idx ? (
                            <div
                              className="flex items-center gap-1 rounded border border-border bg-background px-2 py-1.5 text-sm cursor-pointer hover:border-primary"
                              onClick={() => setOpenComboIdx(idx)}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setOpenComboIdx(idx); }}
                            >
                              <span className="font-mono text-xs text-textSecondary me-1">{selectedAcc?.code}</span>
                              <span className="flex-1 truncate min-w-0">{selectedAcc?.nameAr ?? line.accountNameAr}</span>
                              <button
                                type="button"
                                className="text-textSecondary hover:text-danger ms-1 shrink-0 text-xs"
                                onClick={(e) => { e.stopPropagation(); handleAccountChange(idx, ""); }}
                              >✕</button>
                            </div>
                          ) : (
                            <input
                              type="text"
                              className={selectCls}
                              placeholder={t("searchAccounts")}
                              value={comboSearch[idx] ?? ""}
                              onChange={(e) => {
                                setOpenComboIdx(idx);
                                setComboSearch((p) => ({ ...p, [idx]: e.target.value }));
                              }}
                              onFocus={() => setOpenComboIdx(idx)}
                              onBlur={() => setTimeout(() => {
                                setOpenComboIdx((c) => (c === idx ? null : c));
                                setComboSearch((p) => { const n = { ...p }; delete n[idx]; return n; });
                              }, 200)}
                            />
                          )}
                          {openComboIdx === idx && (
                            <div className="absolute top-full mt-0.5 start-0 z-30 min-w-full w-64 max-h-52 overflow-y-auto rounded border border-border bg-surface shadow-lg">
                              {visible.length === 0 ? (
                                <div className="px-3 py-2 text-xs text-textSecondary">لا توجد نتائج مطابقة</div>
                              ) : (
                                visible.slice(0, 30).map((a) => (
                                  <button
                                    key={a.id}
                                    type="button"
                                    className="w-full text-start px-2 py-1.5 text-sm hover:bg-background transition-colors"
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      handleAccountChange(idx, a.id);
                                      setOpenComboIdx(null);
                                      setComboSearch((p) => { const n = { ...p }; delete n[idx]; return n; });
                                    }}
                                  >
                                    <span className="font-mono text-xs text-textSecondary me-1">{a.code}</span>
                                    {a.nameAr}
                                  </button>
                                ))
                              )}
                              {visible.length > 30 && (
                                <div className="px-2 py-1 text-xs text-textSecondary border-t border-border">
                                  {visible.length - 30} نتيجة أخرى — اكتب للتضييق
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </td>

                      {/* البيان */}
                      <td className="px-1.5 py-1.5 align-top">
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
                  <td colSpan={4} className="px-3 py-2 text-end text-xs text-textSecondary font-semibold">
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
                    <td colSpan={8} className="px-3 py-1.5">
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

      <NegativeBalanceModal
        warning={negWarning}
        reference={reference.trim() || description}
        submitting={createLoading}
        onCancel={() => setNegWarning(null)}
        onConfirm={() => void submitJournal(true)}
      />

      {/* Quick-create customer — canonical API; preserves all unsaved lines */}
      <Modal open={quickCustomerIdx !== null} onClose={() => !quickCustSaving && setQuickCustomerIdx(null)} title={t("newCustomer")} className="max-w-md w-full">
        <form onSubmit={(e) => void submitQuickCustomer(e)} className="space-y-3" dir={locale === "ar" ? "rtl" : "ltr"}>
          {quickCustError && <Alert variant="error">{quickCustError}</Alert>}
          <div>
            <label className="block text-xs text-textSecondary mb-1">{t("customerNameAr")} <span className="text-red-500">*</span></label>
            <Input value={quickCustName} onChange={(e) => setQuickCustName(e.target.value)} autoFocus maxLength={200} />
          </div>
          <div>
            <label className="block text-xs text-textSecondary mb-1">{t("phoneOptional")}</label>
            <Input value={quickCustPhone} onChange={(e) => setQuickCustPhone(e.target.value)} maxLength={30} dir="ltr" />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setQuickCustomerIdx(null)} disabled={quickCustSaving}>{t("cancel")}</Button>
            <Button type="submit" disabled={quickCustSaving || !quickCustName.trim()}>{quickCustSaving ? t("saving") : t("save")}</Button>
          </div>
        </form>
      </Modal>

      {/* Quick-create representative — reuses the canonical rep form modal */}
      {quickRepIdx !== null && (
        <RepresentativeFormModal rep={null} onClose={() => setQuickRepIdx(null)} onSaved={onQuickRepCreated} />
      )}
    </div>
  );
}
