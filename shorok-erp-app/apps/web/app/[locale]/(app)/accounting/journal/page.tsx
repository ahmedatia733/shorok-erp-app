"use client";

import { useEffect, useState, useCallback } from "react";
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
import { formatDate, formatCurrency } from "../../../../../lib/format";

interface JournalLineInput {
  accountId: string;
  debit: string;
  credit: string;
  note: string;
}

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
  const [lines, setLines] = useState<JournalLineInput[]>([
    { accountId: "", debit: "0.00", credit: "0.00", note: "" },
    { accountId: "", debit: "0.00", credit: "0.00", note: "" },
  ]);
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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

  useEffect(() => {
    void loadJournal();
  }, [loadJournal]);

  useEffect(() => {
    if (createOpen && leafAccounts.length === 0) {
      void listAccounts().then((data) => {
        setLeafAccounts(getAllLeafAccounts(data));
      });
    }
  }, [createOpen, leafAccounts.length]);

  function sumDebit(): number {
    return lines.reduce((acc, l) => acc + parseFloat(l.debit || "0"), 0);
  }
  function sumCredit(): number {
    return lines.reduce((acc, l) => acc + parseFloat(l.credit || "0"), 0);
  }

  const totalDebitNum = sumDebit();
  const totalCreditNum = sumCredit();
  const isBalanced = Math.abs(totalDebitNum - totalCreditNum) < 0.005;
  const canSubmit = isBalanced && lines.length >= 2 && lines.every((l) => l.accountId);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setCreateLoading(true);
    setCreateError(null);
    try {
      await createJournalEntry({
        entryDate,
        description,
        lines: lines.map((l) => ({
          accountId: l.accountId,
          debit: parseFloat(l.debit || "0").toFixed(2),
          credit: parseFloat(l.credit || "0").toFixed(2),
          note: l.note || undefined,
        })),
      });
      setCreateOpen(false);
      setLines([
        { accountId: "", debit: "0.00", credit: "0.00", note: "" },
        { accountId: "", debit: "0.00", credit: "0.00", note: "" },
      ]);
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

  function addLine() {
    setLines((prev) => [...prev, { accountId: "", debit: "0.00", credit: "0.00", note: "" }]);
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateLine(idx: number, field: keyof JournalLineInput, value: string) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  }

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function loadMore() {
    setLoadingMore(true);
    await loadJournal(nextCursor);
    setLoadingMore(false);
  }

  const totalDebitDisplay = totalDebitNum.toFixed(2);
  const totalCreditDisplay = totalCreditNum.toFixed(2);

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
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => void handleDelete(entry.id)}
                        >
                          {tCommon("yes")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteConfirmId(null)}
                        >
                          {tCommon("no")}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleteConfirmId(entry.id)}
                      >
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
                          <TD>{formatCurrency(line.debit, locale)}</TD>
                          <TD>{formatCurrency(line.credit, locale)}</TD>
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
        className="max-w-3xl"
      >
        <form onSubmit={(e) => void handleCreate(e)} className="space-y-4">
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

          {/* Lines table */}
          <div className="overflow-x-auto border border-border rounded">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-background">
                <tr>
                  <th className="px-3 py-2 text-start">{t("account")}</th>
                  <th className="px-3 py-2 text-start">{t("debit")}</th>
                  <th className="px-3 py-2 text-start">{t("credit")}</th>
                  <th className="px-3 py-2 text-start">{t("note")}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => (
                  <tr key={idx} className="border-b border-border last:border-0">
                    <td className="px-2 py-1">
                      <select
                        className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
                        value={line.accountId}
                        onChange={(e) => updateLine(idx, "accountId", e.target.value)}
                        required
                      >
                        <option value="">—</option>
                        {leafAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.code} — {locale === "ar" ? a.nameAr : a.nameEn}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <Input
                        className="w-28"
                        value={line.debit}
                        onChange={(e) => updateLine(idx, "debit", e.target.value)}
                        inputMode="decimal"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <Input
                        className="w-28"
                        value={line.credit}
                        onChange={(e) => updateLine(idx, "credit", e.target.value)}
                        inputMode="decimal"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <Input
                        value={line.note}
                        onChange={(e) => updateLine(idx, "note", e.target.value)}
                        maxLength={300}
                      />
                    </td>
                    <td className="px-2 py-1">
                      {lines.length > 2 && (
                        <button
                          type="button"
                          className="text-danger text-xs"
                          onClick={() => removeLine(idx)}
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-border bg-background">
                <tr>
                  <td className="px-3 py-2 font-medium text-sm">{t("totalDebit")}</td>
                  <td className={`px-3 py-2 font-medium ${!isBalanced ? "text-red-600" : "text-green-600"}`}>
                    {totalDebitDisplay}
                  </td>
                  <td className={`px-3 py-2 font-medium ${!isBalanced ? "text-red-600" : "text-green-600"}`}>
                    {totalCreditDisplay}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>

          {!isBalanced && (
            <Alert variant="warning">{t("unbalanced")}</Alert>
          )}

          <div className="flex items-center justify-between pt-2">
            <Button type="button" variant="ghost" onClick={addLine}>
              {t("addLine")}
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
                {tCommon("cancel")}
              </Button>
              <Button type="submit" disabled={!canSubmit || createLoading}>
                {createLoading ? tCommon("loading") : tCommon("save")}
              </Button>
            </div>
          </div>
        </form>
      </Modal>
    </div>
  );
}
