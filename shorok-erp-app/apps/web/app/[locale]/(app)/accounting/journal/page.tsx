"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
// Card components not used in this redesign (list uses plain table rows)
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
import {
  listTemplates,
  type JournalTemplate,
} from "../../../../../lib/journal-templates-client";
import { formatDate, formatCurrency } from "../../../../../lib/format";

// ─── Types ────────────────────────────────────────────────────────────────────

interface JournalLine {
  accountId: string;
  accountCode: string;
  accountNameAr: string;
  note: string;
  debit: string;
  credit: string;
}

const ENTRY_TYPE_LABELS: Record<string, string> = {
  JOURNAL: "يومية",
  RECEIPT: "قبض",
  PAYMENT: "صرف",
  ADJUSTMENT: "تسوية",
  OPENING: "قيد افتتاحي",
};

const ENTRY_TYPES = Object.entries(ENTRY_TYPE_LABELS);

function emptyLine(): JournalLine {
  return { accountId: "", accountCode: "", accountNameAr: "", note: "", debit: "", credit: "" };
}

function getAllLeafAccounts(accounts: AccountRow[]): AccountRow[] {
  const result: AccountRow[] = [];
  for (const acc of accounts) {
    if (acc.isLeaf && acc.active) result.push(acc);
    if (acc.children) result.push(...getAllLeafAccounts(acc.children));
  }
  return result;
}

// ─── Entry Type Badge ─────────────────────────────────────────────────────────

function EntryTypeBadge({ type }: { type: string }) {
  const label = ENTRY_TYPE_LABELS[type] ?? type;
  const colorMap: Record<string, string> = {
    JOURNAL: "bg-blue-100 text-blue-800",
    RECEIPT: "bg-green-100 text-green-800",
    PAYMENT: "bg-red-100 text-red-800",
    ADJUSTMENT: "bg-yellow-100 text-yellow-800",
    OPENING: "bg-purple-100 text-purple-800",
  };
  const cls = colorMap[type] ?? "bg-gray-100 text-gray-700";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function JournalPage() {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("accounting.journal");
  const tCommon = useTranslations("common");
  const isOwner = useHasRole();
  const canCreate = useHasRole("ACCOUNTANT");

  // ── List state ──
  const [entries, setEntries] = useState<JournalEntryRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // ── Modal state ──
  const [createOpen, setCreateOpen] = useState(false);
  const [leafAccounts, setLeafAccounts] = useState<AccountRow[]>([]);
  const [entryType, setEntryType] = useState("JOURNAL");
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<JournalLine[]>([emptyLine(), emptyLine()]);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // ── Autocomplete state ──
  const [focusedRowIdx, setFocusedRowIdx] = useState<number | null>(null);
  const [acQuery, setAcQuery] = useState<Record<number, string>>({});
  const autocompleteRef = useRef<HTMLDivElement>(null);

  // ── Template picker state ──
  const [templates, setTemplates] = useState<JournalTemplate[]>([]);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const templatePickerRef = useRef<HTMLDivElement>(null);

  // ─── Data loading ────────────────────────────────────────────────────────────

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
    if (createOpen && leafAccounts.length === 0) {
      void listAccounts().then((data) => setLeafAccounts(getAllLeafAccounts(data)));
    }
  }, [createOpen, leafAccounts.length]);

  useEffect(() => {
    if (createOpen && templates.length === 0) {
      void listTemplates().then(setTemplates).catch(() => {/* ignore */});
    }
  }, [createOpen, templates.length]);

  // Close template picker when clicking outside
  useEffect(() => {
    if (!templatePickerOpen) return;
    function handleClick(e: MouseEvent) {
      if (templatePickerRef.current && !templatePickerRef.current.contains(e.target as Node)) {
        setTemplatePickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [templatePickerOpen]);

  // Close autocomplete when clicking outside
  useEffect(() => {
    if (focusedRowIdx === null) return;
    function handleClick(e: MouseEvent) {
      if (autocompleteRef.current && !autocompleteRef.current.contains(e.target as Node)) {
        setFocusedRowIdx(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [focusedRowIdx]);

  // ─── Derived values ───────────────────────────────────────────────────────────

  const totalDebit = lines.reduce((s, l) => s + parseFloat(l.debit || "0"), 0);
  const totalCredit = lines.reduce((s, l) => s + parseFloat(l.credit || "0"), 0);
  const diff = totalDebit - totalCredit;
  const isBalanced = totalDebit > 0 && Math.abs(diff) < 0.005;
  const canSubmit =
    lines.length >= 2 &&
    isBalanced &&
    lines.every((l) => l.accountId !== "") &&
    totalDebit > 0;

  // ─── Autocomplete helpers ─────────────────────────────────────────────────────

  function getMatches(query: string): AccountRow[] {
    if (!query.trim()) return [];
    const q = query.trim().toLowerCase();
    return leafAccounts
      .filter(
        (a) =>
          a.code.toLowerCase().startsWith(q) ||
          a.nameAr.toLowerCase().includes(q),
      )
      .slice(0, 10);
  }

  // ─── Line mutations ───────────────────────────────────────────────────────────

  function updateLine(idx: number, patch: Partial<JournalLine>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function handleCodeInput(idx: number, val: string) {
    setAcQuery((prev) => ({ ...prev, [idx]: val }));
    setFocusedRowIdx(idx);
    // Clear account if user is typing fresh
    updateLine(idx, { accountCode: val, accountId: "", accountNameAr: "" });
  }

  function selectAccount(idx: number, account: AccountRow) {
    updateLine(idx, {
      accountId: account.id,
      accountCode: account.code,
      accountNameAr: account.nameAr,
    });
    setAcQuery((prev) => ({ ...prev, [idx]: account.code }));
    setFocusedRowIdx(null);
  }

  function handleDebitChange(idx: number, val: string) {
    const existing = lines[idx];
    updateLine(idx, { debit: val, credit: val ? "" : (existing?.credit ?? "") });
  }

  function handleCreditChange(idx: number, val: string) {
    const existing = lines[idx];
    updateLine(idx, { credit: val, debit: val ? "" : (existing?.debit ?? "") });
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(idx: number) {
    if (lines.length <= 1) return;
    setLines((prev) => prev.filter((_, i) => i !== idx));
    setAcQuery((prev) => {
      const next = { ...prev };
      delete next[idx];
      return next;
    });
  }

  // ─── Template application ─────────────────────────────────────────────────────

  function applyTemplate(template: JournalTemplate) {
    const newLines: JournalLine[] = template.lines.map((l) => {
      const account = leafAccounts.find((a) => a.id === l.accountId);
      return {
        accountId: l.accountId,
        accountCode: account?.code ?? "",
        accountNameAr: account?.nameAr ?? "",
        note: l.note ?? "",
        debit: l.type === "debit" ? (l.amount ?? "") : "",
        credit: l.type === "credit" ? (l.amount ?? "") : "",
      };
    });
    setLines(newLines.length > 0 ? newLines : [emptyLine(), emptyLine()]);
    setAcQuery({});
    setTemplatePickerOpen(false);
  }

  // ─── Submit ───────────────────────────────────────────────────────────────────

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
        lines: lines.map((l) => ({
          accountId: l.accountId,
          debit: l.debit ? parseFloat(l.debit).toFixed(2) : "0.00",
          credit: l.credit ? parseFloat(l.credit).toFixed(2) : "0.00",
          note: l.note || undefined,
        })),
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
    setAcQuery({});
    setFocusedRowIdx(null);
    setCreateError(null);
  }

  function handleCloseModal() {
    setCreateOpen(false);
    resetModal();
  }

  // ─── Delete ───────────────────────────────────────────────────────────────────

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

  async function loadMore() {
    setLoadingMore(true);
    await loadJournal(nextCursor);
    setLoadingMore(false);
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{t("title")}</h1>
        {canCreate && (
          <Button onClick={() => setCreateOpen(true)}>{t("newEntry")}</Button>
        )}
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {/* ── Entries table ── */}
      <div className="border border-border rounded overflow-hidden">
        <Table>
          <THead>
            <TR>
              <TH>رقم القيد</TH>
              <TH>التاريخ</TH>
              <TH>البيان</TH>
              <TH>نوع القيد</TH>
              <TH>مرجع</TH>
              <TH>إجمالي القيد</TH>
              <TH></TH>
            </TR>
          </THead>
          <TBody>
            {entries.map((entry) => {
              const expanded = expandedIds.has(entry.id);
              const confirmingDelete = deleteConfirmId === entry.id;
              return (
                <>
                  <TR key={entry.id}>
                    <TD>
                      <span className="font-mono text-sm font-semibold">
                        #{entry.entryNumber}
                      </span>
                    </TD>
                    <TD>
                      <span className="text-sm">{formatDate(entry.entryDate, locale)}</span>
                    </TD>
                    <TD>
                      <span className="text-sm">{entry.description}</span>
                    </TD>
                    <TD>
                      <EntryTypeBadge type={entry.entryType} />
                    </TD>
                    <TD>
                      <span className="text-sm text-textSecondary">
                        {entry.reference ?? "—"}
                      </span>
                    </TD>
                    <TD>
                      <span className="text-sm font-medium">
                        {formatCurrency(entry.totalDebit, locale)}
                      </span>
                    </TD>
                    <TD>
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          type="button"
                          className="text-textSecondary hover:text-text text-sm px-2 py-0.5"
                          onClick={() => toggleExpand(entry.id)}
                          title={expanded ? "إخفاء التفاصيل" : "عرض التفاصيل"}
                        >
                          {expanded ? "▾" : "▸"}
                        </button>
                        {isOwner && (
                          confirmingDelete ? (
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
                              <tr className="bg-surface text-right">
                                <th className="px-3 py-2 text-xs font-semibold text-textSecondary border-b border-border">الحساب</th>
                                <th className="px-3 py-2 text-xs font-semibold text-textSecondary border-b border-border text-end">مدين</th>
                                <th className="px-3 py-2 text-xs font-semibold text-textSecondary border-b border-border text-end">دائن</th>
                                <th className="px-3 py-2 text-xs font-semibold text-textSecondary border-b border-border">بيان</th>
                              </tr>
                            </thead>
                            <tbody>
                              {entry.lines.map((line) => (
                                <tr key={line.id} className="border-b border-border last:border-0">
                                  <td className="px-3 py-2">
                                    <span className="font-mono text-xs text-textSecondary me-2">{line.accountCode}</span>
                                    {locale === "ar" ? line.accountNameAr : line.accountNameEn}
                                  </td>
                                  <td className="px-3 py-2 text-end">
                                    {parseFloat(line.debit) > 0 ? formatCurrency(line.debit, locale) : "—"}
                                  </td>
                                  <td className="px-3 py-2 text-end">
                                    {parseFloat(line.credit) > 0 ? formatCurrency(line.credit, locale) : "—"}
                                  </td>
                                  <td className="px-3 py-2 text-textSecondary">{line.note ?? "—"}</td>
                                </tr>
                              ))}
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
          <Button variant="ghost" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? tCommon("loading") : t("loadMore")}
          </Button>
        </div>
      )}

      {/* ── Create Journal Entry Modal ── */}
      <Modal
        open={createOpen}
        onClose={handleCloseModal}
        title={t("newEntry")}
        className="max-w-5xl w-[95vw]"
      >
        <form onSubmit={(e) => void handleCreate(e)} className="space-y-4" dir="rtl">
          {createError && <Alert variant="error">{createError}</Alert>}

          {/* Header fields grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            {/* نوع القيد */}
            <div>
              <label className="block text-sm font-medium mb-1">نوع القيد</label>
              <select
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
                value={entryType}
                onChange={(e) => setEntryType(e.target.value)}
              >
                {ENTRY_TYPES.map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
            </div>

            {/* التاريخ */}
            <div>
              <label className="block text-sm font-medium mb-1">{t("entryDate")}</label>
              <Input
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                required
              />
            </div>

            {/* البيان العام */}
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

            {/* مرجع */}
            <div>
              <label className="block text-sm font-medium mb-1">مرجع</label>
              <Input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="اختياري"
                maxLength={100}
              />
            </div>
          </div>

          {/* Template picker */}
          <div className="flex items-center gap-2">
            <div className="relative" ref={templatePickerRef}>
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
                    <div className="px-3 py-2 text-sm text-textSecondary">
                      لا توجد قوالب محفوظة
                    </div>
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
                            <span className="block text-xs text-textSecondary">
                              {tpl.lines.length} سطر
                            </span>
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

          {/* ── Unified journal lines table ── */}
          <div className="border border-border rounded overflow-visible" ref={autocompleteRef}>
            <table className="w-full text-sm table-fixed">
              <colgroup>
                <col style={{ width: "3%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "24%" }} />
                <col style={{ width: "23%" }} />
                <col style={{ width: "17%" }} />
                <col style={{ width: "17%" }} />
                <col style={{ width: "3%" }} />  {/* delete */}
              </colgroup>
              <thead>
                <tr className="bg-surface border-b border-border text-right">
                  <th className="px-2 py-2 text-xs font-semibold text-textSecondary">#</th>
                  <th className="px-2 py-2 text-xs font-semibold text-textSecondary">كود الحساب</th>
                  <th className="px-2 py-2 text-xs font-semibold text-textSecondary">اسم الحساب</th>
                  <th className="px-2 py-2 text-xs font-semibold text-textSecondary">البيان</th>
                  <th className="px-2 py-2 text-xs font-semibold text-textSecondary text-end">مدين</th>
                  <th className="px-2 py-2 text-xs font-semibold text-textSecondary text-end">دائن</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => {
                  const query = acQuery[idx] ?? line.accountCode;
                  const matches = focusedRowIdx === idx ? getMatches(query) : [];
                  const showDropdown = focusedRowIdx === idx && matches.length > 0;

                  return (
                    <tr key={idx} className="border-b border-border last:border-0 hover:bg-background/50">
                      {/* # */}
                      <td className="px-2 py-1 text-xs text-textSecondary text-center align-middle">
                        {idx + 1}
                      </td>

                      {/* كود الحساب — with autocomplete */}
                      <td className="px-1 py-1 align-middle relative">
                        <input
                          type="text"
                          className="text-sm py-1 px-1 w-full bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded"
                          placeholder="كود أو اسم"
                          value={focusedRowIdx === idx ? query : line.accountCode}
                          onChange={(e) => handleCodeInput(idx, e.target.value)}
                          onFocus={() => {
                            setFocusedRowIdx(idx);
                            setAcQuery((prev) => ({ ...prev, [idx]: line.accountCode }));
                          }}
                          autoComplete="off"
                        />
                        {showDropdown && (
                          <div className="absolute top-full start-0 z-30 bg-surface border border-border rounded shadow-lg min-w-[280px] max-h-48 overflow-y-auto">
                            {matches.map((acc) => (
                              <button
                                key={acc.id}
                                type="button"
                                className="w-full text-start px-3 py-1.5 text-sm hover:bg-background transition-colors flex items-center gap-2"
                                onMouseDown={(e) => {
                                  e.preventDefault(); // prevent blur before click
                                  selectAccount(idx, acc);
                                }}
                              >
                                <span className="font-mono text-xs text-textSecondary shrink-0">{acc.code}</span>
                                <span className="truncate">{acc.nameAr}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </td>

                      {/* اسم الحساب — read-only */}
                      <td className="px-2 py-1 align-middle">
                        <span className="text-sm text-text truncate block max-w-full">
                          {line.accountNameAr || (
                            <span className="text-textSecondary italic text-xs">— اختر حساباً —</span>
                          )}
                        </span>
                      </td>

                      {/* البيان */}
                      <td className="px-1 py-1 align-middle">
                        <input
                          type="text"
                          className="text-sm py-1 px-1 w-full bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded"
                          placeholder="بيان السطر"
                          value={line.note}
                          onChange={(e) => updateLine(idx, { note: e.target.value })}
                          maxLength={200}
                        />
                      </td>

                      {/* مدين */}
                      <td className="px-1 py-1 align-middle">
                        <input
                          type="number"
                          className="text-sm py-1 px-1 w-full bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded text-end"
                          placeholder="0.00"
                          min="0"
                          step="0.01"
                          value={line.debit}
                          onChange={(e) => handleDebitChange(idx, e.target.value)}
                        />
                      </td>

                      {/* دائن */}
                      <td className="px-1 py-1 align-middle">
                        <input
                          type="number"
                          className="text-sm py-1 px-1 w-full bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded text-end"
                          placeholder="0.00"
                          min="0"
                          step="0.01"
                          value={line.credit}
                          onChange={(e) => handleCreditChange(idx, e.target.value)}
                        />
                      </td>

                      {/* Delete */}
                      <td className="px-1 py-1 align-middle text-center">
                        <button
                          type="button"
                          className="text-danger text-sm px-1 disabled:opacity-30 disabled:cursor-not-allowed"
                          onClick={() => removeLine(idx)}
                          disabled={lines.length <= 1}
                          title="حذف السطر"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Add row + Totals footer */}
            <div className="border-t border-border bg-surface">
              {/* Add line button */}
              <div className="px-3 py-1.5 border-b border-border">
                <button
                  type="button"
                  onClick={addLine}
                  className="text-sm text-primary hover:underline"
                >
                  + إضافة سطر
                </button>
              </div>

              {/* Totals row */}
              <div className="flex items-center justify-end gap-6 px-4 py-2 text-sm">
                <span className="text-textSecondary">الإجماليات:</span>
                <span className="flex items-center gap-1">
                  <span className="text-textSecondary text-xs">مدين</span>
                  <span className="font-semibold font-mono">{totalDebit.toFixed(2)}</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="text-textSecondary text-xs">دائن</span>
                  <span className="font-semibold font-mono">{totalCredit.toFixed(2)}</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="text-textSecondary text-xs">الفرق</span>
                  <span
                    className={`font-semibold font-mono ${
                      Math.abs(diff) < 0.005 && totalDebit > 0
                        ? "text-green-600"
                        : "text-red-600"
                    }`}
                  >
                    {Math.abs(diff).toFixed(2)}
                  </span>
                </span>
              </div>
            </div>
          </div>

          {/* Balance warning */}
          {!isBalanced && totalDebit > 0 && (
            <Alert variant="warning">{t("unbalanced")}</Alert>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={handleCloseModal}>
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
