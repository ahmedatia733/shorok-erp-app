"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
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

interface LineInput {
  accountId: string;
  amount: string;
  note: string;
}

const emptyLine = (): LineInput => ({ accountId: "", amount: "", note: "" });

function getAllLeafAccounts(accounts: AccountRow[]): AccountRow[] {
  const result: AccountRow[] = [];
  for (const acc of accounts) {
    if (acc.isLeaf && acc.active) result.push(acc);
    if (acc.children) result.push(...getAllLeafAccounts(acc.children));
  }
  return result;
}

export default function JournalPage() {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("accounting.journal");
  const tCommon = useTranslations("common");
  const isOwner = useHasRole();
  const canCreate = useHasRole("ACCOUNTANT");

  const [entries, setEntries] = useState<JournalEntryRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Create modal
  const [createOpen, setCreateOpen] = useState(false);
  const [leafAccounts, setLeafAccounts] = useState<AccountRow[]>([]);
  const [debitLines, setDebitLines] = useState<LineInput[]>([emptyLine()]);
  const [creditLines, setCreditLines] = useState<LineInput[]>([emptyLine()]);
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Template picker state
  const [templates, setTemplates] = useState<JournalTemplate[]>([]);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const templatePickerRef = useRef<HTMLDivElement>(null);

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

  // Load templates when modal opens
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

  function applyTemplate(template: JournalTemplate) {
    const newDebitLines = template.lines
      .filter((l) => l.type === "debit")
      .map((l) => ({
        accountId: l.accountId,
        amount: l.amount ?? "",
        note: l.note ?? "",
      }));
    const newCreditLines = template.lines
      .filter((l) => l.type === "credit")
      .map((l) => ({
        accountId: l.accountId,
        amount: l.amount ?? "",
        note: l.note ?? "",
      }));

    setDebitLines(newDebitLines.length > 0 ? newDebitLines : [emptyLine()]);
    setCreditLines(newCreditLines.length > 0 ? newCreditLines : [emptyLine()]);
    setTemplatePickerOpen(false);
  }

  const totalDebit  = debitLines.reduce((s, l) => s + parseFloat(l.amount || "0"), 0);
  const totalCredit = creditLines.reduce((s, l) => s + parseFloat(l.amount || "0"), 0);
  const isBalanced  = totalDebit > 0 && Math.abs(totalDebit - totalCredit) < 0.005;
  const canSubmit   =
    isBalanced &&
    debitLines.every((l) => l.accountId && parseFloat(l.amount || "0") > 0) &&
    creditLines.every((l) => l.accountId && parseFloat(l.amount || "0") > 0);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setCreateLoading(true);
    setCreateError(null);
    try {
      await createJournalEntry({
        entryDate,
        description,
        lines: [
          ...debitLines.map((l) => ({
            accountId: l.accountId,
            debit: parseFloat(l.amount).toFixed(2),
            credit: "0.00",
            note: l.note || undefined,
          })),
          ...creditLines.map((l) => ({
            accountId: l.accountId,
            debit: "0.00",
            credit: parseFloat(l.amount).toFixed(2),
            note: l.note || undefined,
          })),
        ],
      });
      setCreateOpen(false);
      setDebitLines([emptyLine()]);
      setCreditLines([emptyLine()]);
      setDescription("");
      await loadJournal();
    } catch {
      setCreateError(t("loadFailed"));
    } finally {
      setCreateLoading(false);
    }
  }

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

  function updateDebit(idx: number, field: keyof LineInput, val: string) {
    setDebitLines((prev) => prev.map((l, i) => i === idx ? { ...l, [field]: val } : l));
  }
  function updateCredit(idx: number, field: keyof LineInput, val: string) {
    setCreditLines((prev) => prev.map((l, i) => i === idx ? { ...l, [field]: val } : l));
  }

  const selectCls = "w-full rounded border border-border bg-background px-2 py-1.5 text-sm";

  function SideTable({
    lines,
    onUpdate,
    onAdd,
    onRemove,
    total,
    colorCls,
    label,
  }: {
    lines: LineInput[];
    onUpdate: (idx: number, field: keyof LineInput, val: string) => void;
    onAdd: () => void;
    onRemove: (idx: number) => void;
    total: number;
    colorCls: string;
    label: string;
  }) {
    return (
      <div className="flex flex-col h-full">
        <div className={`py-2 text-center font-bold text-base border-b border-border ${colorCls}`}>
          {label}
        </div>
        <div className="flex-1 overflow-y-auto">
          {lines.map((line, idx) => (
            <div key={idx} className="grid grid-cols-[1fr_auto_auto] gap-1 p-2 border-b border-border last:border-0 items-center">
              <select
                className={selectCls}
                value={line.accountId}
                onChange={(e) => onUpdate(idx, "accountId", e.target.value)}
                required
              >
                <option value="">— الحساب —</option>
                {leafAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {locale === "ar" ? a.nameAr : a.nameEn}
                  </option>
                ))}
              </select>
              <input
                className="w-28 rounded border border-border bg-background px-2 py-1.5 text-sm text-end"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={line.amount}
                onChange={(e) => onUpdate(idx, "amount", e.target.value)}
                required
              />
              {lines.length > 1 ? (
                <button
                  type="button"
                  className="text-danger text-sm px-1"
                  onClick={() => onRemove(idx)}
                >✕</button>
              ) : (
                <span className="w-5" />
              )}
            </div>
          ))}
        </div>
        <div className="border-t border-border">
          <button
            type="button"
            onClick={onAdd}
            className="w-full py-1.5 text-xs text-primary hover:bg-background transition-colors"
          >
            + إضافة سطر
          </button>
        </div>
        <div className={`px-3 py-2 text-sm font-semibold flex justify-between border-t border-border ${colorCls}`}>
          <span>الإجمالي</span>
          <span>{total.toFixed(2)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{t("title")}</h1>
        {canCreate && (
          <Button onClick={() => setCreateOpen(true)}>{t("newEntry")}</Button>
        )}
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <div className="space-y-3">
        {entries.map((entry) => {
          const expanded = expandedIds.has(entry.id);
          const confirmingDelete = deleteConfirmId === entry.id;
          return (
            <Card key={entry.id}>
              <CardHeader>
                <button
                  type="button"
                  className="flex items-center gap-4 text-start flex-1 min-w-0"
                  onClick={() => toggleExpand(entry.id)}
                >
                  <span className="text-textSecondary text-sm shrink-0">
                    {formatDate(entry.entryDate, locale)}
                  </span>
                  <CardTitle className="truncate">{entry.description}</CardTitle>
                  <span className="text-sm font-medium shrink-0">
                    {formatCurrency(entry.totalDebit, locale)}
                  </span>
                  <span className="text-textSecondary text-sm">{expanded ? "▾" : "▸"}</span>
                </button>
                <div className="flex items-center gap-2 shrink-0">
                  {isOwner && (
                    confirmingDelete ? (
                      <div className="flex items-center gap-1 text-sm">
                        <span>{t("deleteConfirm")}</span>
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
              </CardHeader>
              {expanded && (
                <CardBody className="p-0 overflow-x-auto">
                  <Table>
                    <THead>
                      <TR>
                        <TH>{t("account")}</TH>
                        <TH>{t("debit")}</TH>
                        <TH>{t("credit")}</TH>
                        <TH>{t("note")}</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {entry.lines.map((line) => (
                        <TR key={line.id}>
                          <TD>
                            <span className="font-mono text-xs text-textSecondary me-2">
                              {line.accountCode}
                            </span>
                            {locale === "ar" ? line.accountNameAr : line.accountNameEn}
                          </TD>
                          <TD>{parseFloat(line.debit) > 0 ? formatCurrency(line.debit, locale) : "—"}</TD>
                          <TD>{parseFloat(line.credit) > 0 ? formatCurrency(line.credit, locale) : "—"}</TD>
                          <TD>{line.note ?? "—"}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </CardBody>
              )}
            </Card>
          );
        })}
      </div>

      {nextCursor && (
        <div className="text-center">
          <Button variant="ghost" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? tCommon("loading") : t("loadMore")}
          </Button>
        </div>
      )}

      {/* Create Journal Entry Modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t("newEntry")}
        className="max-w-5xl w-[95vw]"
      >
        <form onSubmit={(e) => void handleCreate(e)} className="space-y-4" dir="rtl">
          {createError && <Alert variant="error">{createError}</Alert>}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm mb-1">{t("entryDate")}</label>
              <Input
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="block text-sm mb-1">{t("description")}</label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
                maxLength={500}
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
                <div className="absolute top-full mt-1 end-0 z-20 min-w-[220px] rounded border border-border bg-surface shadow-lg">
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

          {/* Two-column debit / credit layout */}
          <div className="grid grid-cols-2 border border-border rounded overflow-hidden divide-x divide-border">
            {/* RIGHT: مدين */}
            <SideTable
              lines={debitLines}
              onUpdate={updateDebit}
              onAdd={() => setDebitLines((p) => [...p, emptyLine()])}
              onRemove={(i) => setDebitLines((p) => p.filter((_, j) => j !== i))}
              total={totalDebit}
              colorCls="bg-red-50 text-red-700"
              label="مدين"
            />
            {/* LEFT: دائن */}
            <SideTable
              lines={creditLines}
              onUpdate={updateCredit}
              onAdd={() => setCreditLines((p) => [...p, emptyLine()])}
              onRemove={(i) => setCreditLines((p) => p.filter((_, j) => j !== i))}
              total={totalCredit}
              colorCls="bg-green-50 text-green-700"
              label="دائن"
            />
          </div>

          {!isBalanced && totalDebit > 0 && (
            <Alert variant="warning">{t("unbalanced")}</Alert>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
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
