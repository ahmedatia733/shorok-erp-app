"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Badge } from "../../../../../../components/ui/badge";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { EmptyState } from "../../../../../../components/ui/empty-state";
import { Input } from "../../../../../../components/ui/input";
import { Label } from "../../../../../../components/ui/label";
import { Skeleton } from "../../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import { ExpenseItemEditModal } from "../../../../../../components/features/expenses/expense-item-modal";
import { ApiClientError } from "../../../../../../lib/api-client";
import { useHasRole } from "../../../../../../lib/auth";
import { formatCurrency, formatDate } from "../../../../../../lib/format";
import {
  downloadExpenseDetailPdf,
  getExpenseAccount,
  type ExpenseAccountDetail,
} from "../../../../../../lib/expense-accounts-client";

/**
 * One expense item.
 *
 * The figures are the same ledger read the list and the dashboard use, and each
 * movement links back to the journal entry that produced it — the entry is the
 * record, this screen is only a view of it.
 */
export default function ExpenseDetailPage() {
  const locale = useLocale() as AppLocale;
  const params = useParams<{ id: string }>();
  const query = useSearchParams();
  const canEdit = useHasRole("OWNER");

  const id = params?.id ?? "";
  const [from, setFrom] = useState(query.get("from") ?? "");
  const [to, setTo] = useState(query.get("to") ?? "");
  const [data, setData] = useState<ExpenseAccountDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      setData(await getExpenseAccount(id, from || undefined, to || undefined));
    } catch (e) {
      setError(
        e instanceof ApiClientError ? e.localizedMessage(locale) : "تعذّر تحميل بند المصروف.",
      );
    } finally {
      setLoading(false);
    }
  }, [id, from, to, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const money = (v: string) => formatCurrency(v, locale);

  const savePdf = async () => {
    if (!data) return;
    setPdfBusy(true);
    try {
      await downloadExpenseDetailPdf(data.accountId, data.code, data.from, data.to, locale);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : "تعذّر إنشاء ملف PDF.");
    } finally {
      setPdfBusy(false);
    }
  };

  if (loading && !data) return <Skeleton className="h-64 w-full" />;
  if (error && !data) return <Alert variant="error">{error}</Alert>;
  if (!data) return <EmptyState title="لا توجد بيانات." />;

  const cards = [
    { k: "الكود", v: data.code },
    { k: "مصروف الفترة", v: money(data.periodAmount), testId: "detail-period" },
    { k: "إجمالي المصروف", v: money(data.totalAmount), testId: "detail-total" },
    { k: "عدد الحركات", v: String(data.periodMovementCount) },
    {
      k: "آخر حركة",
      v: data.lastMovementDate ? formatDate(data.lastMovementDate, locale) : "—",
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <Link href={`/${locale}/accounting/expenses`}>
            <Button variant="ghost" size="sm">
              رجوع
            </Button>
          </Link>
          <h1 className="text-xl font-bold" data-testid="detail-name">
            {data.nameAr}
          </h1>
          <Badge variant={data.active ? "success" : "neutral"}>
            {data.active ? "نشط" : "غير نشط"}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => void savePdf()} disabled={pdfBusy} data-testid="save-pdf">
            {pdfBusy ? "جارٍ إنشاء الملف…" : "حفظ PDF"}
          </Button>
          {canEdit && (
            <Button variant="secondary" data-testid="detail-edit" onClick={() => setEditing(true)}>
              تعديل
            </Button>
          )}
        </div>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="from">من تاريخ</Label>
            <Input id="from" type="date" value={data.from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="to">إلى تاريخ</Label>
            <Input id="to" type="date" value={data.to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map((c) => (
          <Card key={c.k}>
            <CardBody data-testid={c.testId}>
              <div className="text-sm text-textSecondary">{c.k}</div>
              <div className="mt-1 text-lg font-bold" dir="auto">
                {c.v}
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>حركة البند</CardTitle>
        </CardHeader>
        <CardBody>
          {data.movements.length === 0 ? (
            <EmptyState title="لا توجد حركات في الفترة المحددة." />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>التاريخ</TH>
                  <TH>رقم القيد</TH>
                  <TH>البيان</TH>
                  <TH>الحساب المقابل</TH>
                  <TH>المبلغ</TH>
                </TR>
              </THead>
              <TBody>
                {data.movements.map((m) => (
                  <TR key={m.lineId}>
                    <TD>{formatDate(m.entryDate, locale)}</TD>
                    <TD dir="ltr">
                      <Link
                        href={`/${locale}/accounting/journal/${m.journalEntryId}`}
                        className="text-primary hover:underline"
                      >
                        {m.entryNumber}
                      </Link>
                    </TD>
                    <TD>{m.note || m.entryDescription}</TD>
                    <TD className="text-textSecondary">
                      {m.counterAccounts.length
                        ? m.counterAccounts.map((c) => `${c.nameAr} (${c.code})`).join("، ")
                        : "—"}
                    </TD>
                    <TD dir="ltr">{money(m.amount)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <ExpenseItemEditModal
        item={
          editing
            ? { accountId: data.accountId, code: data.code, nameAr: data.nameAr, active: data.active }
            : null
        }
        onClose={() => setEditing(false)}
        onSaved={() => void load()}
      />
    </div>
  );
}
