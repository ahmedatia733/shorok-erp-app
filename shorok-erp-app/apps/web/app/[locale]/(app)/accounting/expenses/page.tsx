"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import Link from "next/link";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Badge } from "../../../../../components/ui/badge";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { EmptyState } from "../../../../../components/ui/empty-state";
import { Input } from "../../../../../components/ui/input";
import { Label } from "../../../../../components/ui/label";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import {
  ExpenseItemCreateModal,
  ExpenseItemEditModal,
} from "../../../../../components/features/expenses/expense-item-modal";
import { ApiClientError } from "../../../../../lib/api-client";
import { useHasRole } from "../../../../../lib/auth";
import { formatCurrency, formatDate } from "../../../../../lib/format";
import {
  downloadDashboardPdf,
  downloadItemsPdf,
  downloadMovementsPdf,
  getExpenseDashboard,
  listExpenseItems,
  listExpenseMovements,
  type ExpenseDashboard,
  type ExpenseItem,
  type ExpenseItemStatus,
  type ExpenseMovement,
} from "../../../../../lib/expense-accounts-client";

/**
 * إدارة المصروفات.
 *
 * Three views of one thing. «بنود المصروفات» is the Chart of Accounts filtered
 * to expense accounts; «حركة المصروفات» is the journal lines posted to them; and
 * «نظرة عامة» is those same lines summarised. No number on this page is stored
 * anywhere — each is read from the ledger on request, with the rules the Income
 * Statement uses, which is why the two always agree.
 *
 * Every tab can be saved as PDF, and the export is built from the server's
 * answer to the current filters rather than from the rows on screen, so it is
 * the whole filtered report and not the visible page.
 */

type Tab = "overview" | "items" | "movements";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "نظرة عامة" },
  { id: "items", label: "بنود المصروفات" },
  { id: "movements", label: "حركة المصروفات" },
];

/** Defaults to the current calendar month — the question people actually ask. */
function currentMonth(): { from: string; to: string } {
  const now = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    from: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
    to: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))),
  };
}

const PAGE_SIZE = 50;

export default function ExpensesManagementPage() {
  const locale = useLocale() as AppLocale;
  const canEdit = useHasRole("OWNER");

  const [tab, setTab] = useState<Tab>("overview");
  const [range, setRange] = useState(currentMonth);
  const [error, setError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  // Overview
  const [dashboard, setDashboard] = useState<ExpenseDashboard | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);

  // Items
  const [items, setItems] = useState<ExpenseItem[]>([]);
  const [itemsMeta, setItemsMeta] = useState<{ periodTotal: string; grandTotal: string } | null>(null);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ExpenseItemStatus>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ExpenseItem | null>(null);

  // Movements
  const [movements, setMovements] = useState<ExpenseMovement[]>([]);
  const [movementsMeta, setMovementsMeta] = useState<{ totalCount: number; totalAmount: string } | null>(null);
  const [movementsLoading, setMovementsLoading] = useState(true);
  const [moveAccount, setMoveAccount] = useState("");
  const [moveSearch, setMoveSearch] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [page, setPage] = useState(0);

  const fail = (e: unknown, fallback: string) =>
    setError(e instanceof ApiClientError ? e.localizedMessage(locale) : fallback);

  const loadDashboard = useCallback(async () => {
    setDashboardLoading(true);
    try {
      setDashboard(await getExpenseDashboard(range.from, range.to));
    } catch (e) {
      fail(e, "تعذّر تحميل نظرة عامة على المصروفات.");
    } finally {
      setDashboardLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, locale]);

  const loadItems = useCallback(async () => {
    setItemsLoading(true);
    try {
      const res = await listExpenseItems({ ...range, search, status });
      setItems(res.items);
      setItemsMeta({ periodTotal: res.periodTotal, grandTotal: res.grandTotal });
    } catch (e) {
      fail(e, "تعذّر تحميل بنود المصروفات.");
    } finally {
      setItemsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, search, status, locale]);

  const loadMovements = useCallback(async () => {
    setMovementsLoading(true);
    try {
      const res = await listExpenseMovements({
        ...range,
        accountId: moveAccount || undefined,
        search: moveSearch,
        minAmount,
        maxAmount,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setMovements(res.rows);
      setMovementsMeta({ totalCount: res.totalCount, totalAmount: res.totalAmount });
    } catch (e) {
      fail(e, "تعذّر تحميل حركة المصروفات.");
    } finally {
      setMovementsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, moveAccount, moveSearch, minAmount, maxAmount, page, locale]);

  useEffect(() => {
    setError(null);
    if (tab === "overview") void loadDashboard();
    if (tab === "items") void loadItems();
    if (tab === "movements") void loadMovements();
  }, [tab, loadDashboard, loadItems, loadMovements]);

  // A new filter starts a new result set, not page 4 of the old one.
  useEffect(() => setPage(0), [range.from, range.to, moveAccount, moveSearch, minAmount, maxAmount]);

  const existingCodes = useMemo(() => items.map((i) => i.code), [items]);

  const savePdf = async () => {
    setPdfBusy(true);
    setError(null);
    try {
      if (tab === "overview") await downloadDashboardPdf(range.from, range.to, locale);
      else if (tab === "items") await downloadItemsPdf({ ...range, search, status }, locale);
      else
        await downloadMovementsPdf(
          {
            ...range,
            accountId: moveAccount || undefined,
            search: moveSearch,
            minAmount,
            maxAmount,
          },
          locale,
        );
    } catch (e) {
      fail(e, "تعذّر إنشاء ملف PDF.");
    } finally {
      setPdfBusy(false);
    }
  };

  const money = (v: string) => formatCurrency(v, locale);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">إدارة المصروفات</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => void savePdf()} disabled={pdfBusy} data-testid="save-pdf">
            {pdfBusy ? "جارٍ إنشاء الملف…" : "حفظ PDF"}
          </Button>
          {canEdit && tab === "items" && (
            <Button variant="success" data-testid="add-expense-item" onClick={() => setCreateOpen(true)}>
              + إضافة بند مصروف جديد
            </Button>
          )}
        </div>
      </div>

      {/* The period governs every tab, so it lives above them rather than inside one. */}
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="from">من تاريخ</Label>
            <Input
              id="from"
              data-testid="range-from"
              type="date"
              value={range.from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            />
          </div>
          <div>
            <Label htmlFor="to">إلى تاريخ</Label>
            <Input
              id="to"
              data-testid="range-to"
              type="date"
              value={range.to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            />
          </div>
          <Button variant="ghost" onClick={() => setRange(currentMonth())}>
            الشهر الحالي
          </Button>
        </CardBody>
      </Card>

      <div role="tablist" aria-label="أقسام المصروفات" className="flex flex-wrap gap-2 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            data-testid={`tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={[
              "-mb-px border-b-2 px-4 py-2 text-sm transition-colors",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              tab === t.id
                ? "border-primary font-semibold text-textPrimary"
                : "border-transparent text-textSecondary hover:text-textPrimary",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {tab === "overview" && (
        <OverviewTab data={dashboard} loading={dashboardLoading} money={money} locale={locale} />
      )}

      {tab === "items" && (
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>بنود المصروفات</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="بحث"
                data-testid="items-search"
                placeholder="ابحث بالكود أو الاسم"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-56"
              />
              <select
                aria-label="الحالة"
                data-testid="items-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as ExpenseItemStatus)}
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
              >
                <option value="all">كل الحالات</option>
                <option value="active">نشط</option>
                <option value="inactive">غير نشط</option>
              </select>
            </div>
          </CardHeader>
          <CardBody>
            {itemsLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : items.length === 0 ? (
              <EmptyState title="لا توجد بنود مصروفات مطابقة." />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>الكود</TH>
                    <TH>اسم بند المصروف</TH>
                    <TH>الحالة</TH>
                    <TH>مصروف الفترة</TH>
                    <TH>إجمالي المصروف</TH>
                    <TH>آخر حركة</TH>
                    <TH>التحكم</TH>
                  </TR>
                </THead>
                <TBody>
                  {items.map((i) => (
                    <TR key={i.accountId} data-testid={`expense-item-${i.code}`}>
                      <TD className="font-mono">{i.code}</TD>
                      <TD>
                        <Link
                          href={`/${locale}/accounting/expenses/${i.accountId}?from=${range.from}&to=${range.to}`}
                          className="text-primary hover:underline"
                        >
                          {i.nameAr}
                        </Link>
                      </TD>
                      <TD>
                        <Badge variant={i.active ? "success" : "neutral"}>
                          {i.active ? "نشط" : "غير نشط"}
                        </Badge>
                      </TD>
                      <TD dir="ltr">{money(i.periodAmount)}</TD>
                      <TD dir="ltr">{money(i.totalAmount)}</TD>
                      <TD className="text-textSecondary">
                        {i.lastMovementDate ? formatDate(i.lastMovementDate, locale) : "—"}
                      </TD>
                      <TD>
                        <div className="flex gap-2">
                          <Link
                            href={`/${locale}/accounting/expenses/${i.accountId}?from=${range.from}&to=${range.to}`}
                          >
                            <Button variant="ghost" size="sm">
                              تفاصيل
                            </Button>
                          </Link>
                          {canEdit && (
                            <Button
                              variant="secondary"
                              size="sm"
                              data-testid={`edit-expense-${i.code}`}
                              onClick={() => setEditing(i)}
                            >
                              تعديل
                            </Button>
                          )}
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
            {itemsMeta && !itemsLoading && items.length > 0 && (
              <div className="mt-3 flex flex-wrap justify-end gap-6 text-sm">
                <span>
                  إجمالي الفترة: <b dir="ltr">{money(itemsMeta.periodTotal)}</b>
                </span>
                <span className="text-textSecondary">
                  الإجمالي التراكمي: <b dir="ltr">{money(itemsMeta.grandTotal)}</b>
                </span>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {tab === "movements" && (
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>حركة المصروفات</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="بند المصروف"
                data-testid="movements-account"
                value={moveAccount}
                onChange={(e) => setMoveAccount(e.target.value)}
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
              >
                <option value="">كل البنود</option>
                {items.map((i) => (
                  <option key={i.accountId} value={i.accountId}>
                    {i.code} — {i.nameAr}
                  </option>
                ))}
              </select>
              <Input
                aria-label="بحث في البيان أو رقم القيد"
                data-testid="movements-search"
                placeholder="البيان أو رقم القيد"
                value={moveSearch}
                onChange={(e) => setMoveSearch(e.target.value)}
                className="w-48"
              />
              <Input
                aria-label="من مبلغ"
                dir="ltr"
                placeholder="من مبلغ"
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value.replace(/[^\d.]/g, ""))}
                className="w-28"
              />
              <Input
                aria-label="إلى مبلغ"
                dir="ltr"
                placeholder="إلى مبلغ"
                value={maxAmount}
                onChange={(e) => setMaxAmount(e.target.value.replace(/[^\d.]/g, ""))}
                className="w-28"
              />
            </div>
          </CardHeader>
          <CardBody>
            {movementsLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : movements.length === 0 ? (
              <EmptyState title="لا توجد حركات مطابقة للفلاتر المحددة." />
            ) : (
              <>
                <Table>
                  <THead>
                    <TR>
                      <TH>التاريخ</TH>
                      <TH>بند المصروف</TH>
                      <TH>المبلغ</TH>
                      <TH>البيان</TH>
                      <TH>رقم القيد</TH>
                      <TH>الحساب المقابل</TH>
                      <TH>الفرع</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {movements.map((m) => (
                      <TR key={m.lineId} data-testid={`movement-${m.lineId}`}>
                        <TD>{formatDate(m.entryDate, locale)}</TD>
                        <TD>
                          <Link
                            href={`/${locale}/accounting/expenses/${m.accountId}?from=${range.from}&to=${range.to}`}
                            className="text-primary hover:underline"
                          >
                            {m.accountNameAr}
                          </Link>
                        </TD>
                        <TD dir="ltr">{money(m.amount)}</TD>
                        <TD>{m.note || m.entryDescription}</TD>
                        <TD dir="ltr">
                          <Link
                            href={`/${locale}/accounting/journal/${m.journalEntryId}`}
                            className="text-primary hover:underline"
                            data-testid={`journal-link-${m.entryNumber}`}
                          >
                            {m.entryNumber}
                          </Link>
                        </TD>
                        <TD className="text-textSecondary">
                          {/* Read off the entry's own lines — never a guessed
                              payment method. */}
                          {m.counterAccounts.length
                            ? m.counterAccounts.map((c) => c.nameAr).join("، ")
                            : "—"}
                        </TD>
                        <TD className="text-textSecondary">{m.branchNameAr ?? "—"}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>

                {movementsMeta && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
                    <span className="text-textSecondary">
                      {movementsMeta.totalCount} حركة — إجمالي المطابق:{" "}
                      <b dir="ltr">{money(movementsMeta.totalAmount)}</b>
                    </span>
                    {movementsMeta.totalCount > PAGE_SIZE && (
                      <span className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={page === 0}
                          onClick={() => setPage((p) => Math.max(0, p - 1))}
                        >
                          السابق
                        </Button>
                        <span className="text-textSecondary">
                          صفحة {page + 1} من {Math.ceil(movementsMeta.totalCount / PAGE_SIZE)}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={(page + 1) * PAGE_SIZE >= movementsMeta.totalCount}
                          onClick={() => setPage((p) => p + 1)}
                        >
                          التالي
                        </Button>
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
          </CardBody>
        </Card>
      )}

      <ExpenseItemCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        existingCodes={existingCodes}
        onCreated={() => {
          void loadItems();
          void loadDashboard();
        }}
      />
      <ExpenseItemEditModal
        item={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          void loadItems();
          void loadDashboard();
        }}
      />
    </div>
  );
}

/** The overview. Charts are plain CSS bars so they print identically in the PDF. */
function OverviewTab({
  data,
  loading,
  money,
  locale,
}: {
  data: ExpenseDashboard | null;
  loading: boolean;
  money: (v: string) => string;
  locale: AppLocale;
}) {
  if (loading) return <Skeleton className="h-64 w-full" />;
  if (!data) return <EmptyState title="لا توجد بيانات." />;

  const cards = [
    { k: "إجمالي مصروفات الفترة", v: money(data.periodTotal), testId: "card-period" },
    { k: "مصروفات الشهر حتى اليوم", v: money(data.monthToDateTotal), testId: "card-month" },
    { k: "مصروفات اليوم", v: money(data.todayTotal), testId: "card-today" },
    { k: "عدد بنود المصروفات النشطة", v: String(data.activeItemCount), testId: "card-count" },
    {
      k: "أعلى بند مصروف",
      v: data.topItem ? `${data.topItem.nameAr} — ${money(data.topItem.amount)}` : "—",
      testId: "card-top",
    },
    {
      k: "مقارنة بالفترة السابقة",
      v:
        money(data.changeAmount) +
        (data.changePercent === null ? "" : ` (${data.changePercent}%)`),
      testId: "card-change",
    },
  ];

  const maxMonth = data.byMonth.reduce((m, p) => Math.max(m, Math.abs(Number(p.amount))), 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <Card key={c.k}>
            <CardBody data-testid={c.testId}>
              <div className="text-sm text-textSecondary">{c.k}</div>
              <div className="mt-1 text-xl font-bold" dir="auto">
                {c.v}
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>المصروفات حسب الشهر</CardTitle>
        </CardHeader>
        <CardBody>
          {data.byMonth.length === 0 ? (
            <EmptyState title="لا توجد حركة في الفترة المحددة." />
          ) : (
            <div className="space-y-2">
              {data.byMonth.map((p) => (
                <div key={p.month} className="flex items-center gap-3">
                  <span className="w-20 text-sm text-textSecondary">{p.month}</span>
                  <span className="h-3 flex-1 overflow-hidden rounded bg-background">
                    <span
                      className="block h-full bg-primary/70"
                      style={{
                        width: `${maxMonth ? Math.round((Math.abs(Number(p.amount)) / maxMonth) * 100) : 0}%`,
                      }}
                    />
                  </span>
                  <span className="w-28 text-end text-sm" dir="ltr">
                    {money(p.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>توزيع المصروفات حسب البند</CardTitle>
        </CardHeader>
        <CardBody>
          {data.byItem.length === 0 ? (
            <EmptyState title="لا توجد بنود بها حركة في الفترة المحددة." />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>الكود</TH>
                  <TH>بند المصروف</TH>
                  <TH>المبلغ</TH>
                  <TH>النسبة</TH>
                </TR>
              </THead>
              <TBody>
                {data.byItem.map((p) => (
                  <TR key={p.accountId}>
                    <TD className="font-mono">{p.code}</TD>
                    <TD>
                      <Link
                        href={`/${locale}/accounting/expenses/${p.accountId}?from=${data.from}&to=${data.to}`}
                        className="text-primary hover:underline"
                      >
                        {p.nameAr}
                      </Link>
                    </TD>
                    <TD dir="ltr">{money(p.amount)}</TD>
                    <TD dir="ltr">{p.percent ? `${p.percent}%` : "—"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <p className="mt-3 text-xs text-textSecondary">
            المبالغ محسوبة من القيود المرحّلة غير المعكوسة بنفس قواعد قائمة الدخل، وتشمل جميع الفروع.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
