"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import type { AppLocale } from "../../../../i18n";
import { Alert } from "../../../../components/ui/alert";
import { Button } from "../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../components/ui/card";
import { EmptyState } from "../../../../components/ui/empty-state";
import { Input } from "../../../../components/ui/input";
import { Label } from "../../../../components/ui/label";
import { Modal } from "../../../../components/ui/modal";
import { Skeleton } from "../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { BranchPicker } from "../../../../components/features/inventory/branch-picker";
import { ApiClientError } from "../../../../lib/api-client";
import {
  listExpenses,
  updateExpense,
  deleteExpense,
  type ExpenseRow,
} from "../../../../lib/expenses-client";
import { formatCurrency, formatDate } from "../../../../lib/format";
import { useCurrentUser } from "../../../../lib/auth";

export default function ExpensesPage() {
  const t = useTranslations("expenses");
  const tCommon = useTranslations("common");
  const locale = useLocale() as AppLocale;
  const user = useCurrentUser();

  const [branchId, setBranchId] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // delete state
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // edit state
  const [editRow, setEditRow] = useState<ExpenseRow | null>(null);
  const [editFields, setEditFields] = useState({
    expenseDate: "",
    description: "",
    amount: "",
    paidFromAccount: "",
  });
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [listSearch, setListSearch] = useState("");

  const displayedRows = listSearch
    ? rows.filter((r) =>
        (r.description + " " + (r.paidFromAccount ?? ""))
          .toLowerCase()
          .includes(listSearch.toLowerCase()),
      )
    : rows;

  const canWrite =
    user?.role && ["OWNER", "BRANCH_MANAGER", "ACCOUNTANT"].includes(user.role);
  const isOwner = user?.role === "OWNER";

  useEffect(() => {
    if (!branchId) {
      setRows([]);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    void listExpenses({ branchId, from: from || undefined, to: to || undefined })
      .then((page) => { if (alive) setRows(page.data); })
      .catch((err) => {
        if (alive && err instanceof ApiClientError) setError(err.localizedMessage(locale));
        else if (alive) setError(null);
      })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [branchId, from, to, locale]);

  const handleDelete = async () => {
    if (!deletingId) return;
    setDeleteLoading(true);
    try {
      await deleteExpense(deletingId);
      setRows((prev) => prev.filter((r) => r.id !== deletingId));
      setDeletingId(null);
    } catch {
      setError(tCommon("actionFailed"));
    } finally {
      setDeleteLoading(false);
    }
  };

  const openEdit = (row: ExpenseRow) => {
    setEditRow(row);
    setEditFields({
      expenseDate: row.expenseDate.split("T")[0] ?? "",
      description: row.description,
      amount: row.amount,
      paidFromAccount: row.paidFromAccount,
    });
    setEditError(null);
  };

  const handleEditSave = async () => {
    if (!editRow) return;
    setEditLoading(true);
    setEditError(null);
    try {
      const updated = await updateExpense(editRow.id, {
        expenseDate: editFields.expenseDate,
        description: editFields.description,
        amount: editFields.amount,
        paidFromAccount: editFields.paidFromAccount,
      });
      setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      setEditRow(null);
    } catch (err) {
      setEditError(
        err instanceof ApiClientError
          ? err.localizedMessage(locale)
          : tCommon("actionFailed"),
      );
    } finally {
      setEditLoading(false);
    }
  };

  return (
    <div className="space-y-section">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-page-title">{t("title")}</h1>
        <div className="flex items-center gap-3">
          <BranchPicker value={branchId} onChange={setBranchId} />
          {canWrite && branchId ? (
            <Link href={`/${locale}/expenses/new?branchId=${branchId}`}>
              <Button>{t("create")}</Button>
            </Link>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardBody>
          <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
              <Label htmlFor="from">{t("filters.from")}</Label>
              <Input id="from" type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="to">{t("filters.to")}</Label>
              <Input id="to" type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div>
              <Label>بحث</Label>
              <div className="flex items-center gap-1">
                <Input
                  placeholder="بحث بالبيان أو الحساب..."
                  value={listSearch}
                  onChange={(e) => setListSearch(e.target.value)}
                />
                {listSearch && (
                  <button type="button" className="text-xs text-textSecondary hover:text-text whitespace-nowrap" onClick={() => setListSearch("")}>
                    ✕
                  </button>
                )}
              </div>
            </div>
          </div>

          {error ? <Alert variant="error" className="mb-3">{error}</Alert> : null}

          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !branchId ? (
            <EmptyState title={t("branchPicker")} />
          ) : displayedRows.length === 0 ? (
            <EmptyState title={listSearch ? "لا توجد نتائج مطابقة" : t("empty")} />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH dir="ltr">{t("columns.date")}</TH>
                  <TH>{t("columns.description")}</TH>
                  <TH>{t("columns.paidFromAccount")}</TH>
                  <TH dir="ltr" className="text-end">{t("columns.amount")}</TH>
                  <TH>{t("columns.actor")}</TH>
                  {isOwner ? <TH className="w-24"></TH> : null}
                </TR>
              </THead>
              <TBody>
                {displayedRows.map((e) => {
                  const isCorrection = e.amount.startsWith("-");
                  const isDeleting = deletingId === e.id;
                  return (
                    <TR key={e.id}>
                      <TD dir="ltr">{formatDate(e.expenseDate, locale)}</TD>
                      <TD>{e.description}</TD>
                      <TD dir="ltr">{e.paidFromAccount}</TD>
                      <TD dir="ltr" className={`text-end font-medium ${isCorrection ? "text-warning" : ""}`}>
                        {formatCurrency(e.amount, locale)}
                      </TD>
                      <TD>{e.creator.name}</TD>
                      {isOwner ? (
                        <TD>
                          {isDeleting ? (
                            <span className="flex items-center gap-2 text-sm">
                              <span className="text-error text-xs">{tCommon("deleteConfirm")}</span>
                              <button
                                onClick={() => void handleDelete()}
                                disabled={deleteLoading}
                                className="text-error font-medium hover:underline disabled:opacity-50 text-xs"
                              >
                                {tCommon("yes")}
                              </button>
                              <button
                                onClick={() => setDeletingId(null)}
                                className="text-textSecondary hover:underline text-xs"
                              >
                                {tCommon("no")}
                              </button>
                            </span>
                          ) : (
                            <span className="flex items-center gap-3">
                              <button
                                title={tCommon("edit")}
                                onClick={() => openEdit(e)}
                                className="text-info hover:text-info/80 text-base"
                              >
                                ✏️
                              </button>
                              <button
                                title={tCommon("delete")}
                                onClick={() => setDeletingId(e.id)}
                                className="text-error hover:text-error/80 text-base"
                              >
                                🗑️
                              </button>
                            </span>
                          )}
                        </TD>
                      ) : null}
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {/* Edit Modal */}
      <Modal open={!!editRow} onClose={() => setEditRow(null)} title={tCommon("edit")}>
        {editRow && (
          <div className="space-y-3">
            {editError && <Alert variant="error">{editError}</Alert>}
            <div>
              <Label htmlFor="edit-date">{t("form.date")}</Label>
              <Input
                id="edit-date"
                type="date"
                dir="ltr"
                value={editFields.expenseDate}
                onChange={(e) => setEditFields((f) => ({ ...f, expenseDate: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="edit-desc">{t("form.description")}</Label>
              <Input
                id="edit-desc"
                value={editFields.description}
                onChange={(e) => setEditFields((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="edit-amount">{t("form.amount")}</Label>
              <Input
                id="edit-amount"
                type="number"
                dir="ltr"
                value={editFields.amount}
                onChange={(e) => setEditFields((f) => ({ ...f, amount: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="edit-account">{t("form.paidFromAccount")}</Label>
              <Input
                id="edit-account"
                value={editFields.paidFromAccount}
                onChange={(e) => setEditFields((f) => ({ ...f, paidFromAccount: e.target.value }))}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEditRow(null)} disabled={editLoading}>
                {tCommon("cancel")}
              </Button>
              <Button onClick={() => void handleEditSave()} disabled={editLoading}>
                {editLoading ? tCommon("loading") : tCommon("save")}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
