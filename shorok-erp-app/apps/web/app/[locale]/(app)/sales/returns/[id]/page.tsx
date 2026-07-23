"use client";

import { useEffect, useState, useCallback } from "react";
import { useLocale } from "next-intl";
import { useParams } from "next/navigation";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import { formatCurrency, formatDate } from "../../../../../../lib/format";
import { ApiClientError } from "../../../../../../lib/api-client";
import { useHasRole } from "../../../../../../lib/auth";
import { getSalesReturn, confirmSalesReturn, cancelSalesReturn, type SalesReturnRow } from "../../../../../../lib/returns-client";

const STATUS_AR: Record<string, string> = { DRAFT: "مسودة", CONFIRMED: "مؤكد", CANCELLED: "ملغي" };

export default function SalesReturnDetailPage() {
  const locale = useLocale() as AppLocale;
  const { id } = useParams<{ id: string }>();
  const canFinancials = useHasRole("OWNER", "ACCOUNTANT");
  const [row, setRow] = useState<SalesReturnRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setRow(await getSalesReturn(id)); }
    catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : (e as Error).message); }
    finally { setBusy(false); }
  };

  if (!row) return <div dir="rtl" className="p-4">{error ? <Alert variant="error">{error}</Alert> : "جارٍ التحميل…"}</div>;

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">مردود مبيعات #{row.returnNumber}</h1>
        <div className="flex gap-2">
          {row.status === "DRAFT" && <Button disabled={busy} onClick={() => void act(() => confirmSalesReturn(row.id))}>تأكيد المردود</Button>}
          {row.status === "CONFIRMED" && <Button variant="danger" disabled={busy} onClick={() => { if (confirm("هل تريد إلغاء هذا المردود؟ سيتم عكس كل القيود والمخزون.")) void act(() => cancelSalesReturn(row.id, "إلغاء من المستخدم")); }}>إلغاء المردود</Button>}
        </div>
      </div>
      {error && <Alert variant="error">{error}</Alert>}

      <Card>
        <CardHeader><CardTitle>بيانات المردود</CardTitle></CardHeader>
        <CardBody className="grid grid-cols-2 gap-3 md:grid-cols-4 text-sm">
          <div><div className="text-xs text-muted">الحالة</div><div className="font-semibold">{STATUS_AR[row.status] ?? row.status}</div></div>
          <div><div className="text-xs text-muted">التاريخ</div><div>{formatDate(row.returnDate, locale)}</div></div>
          <div><div className="text-xs text-muted">الفاتورة الأصلية</div><div><a className="text-primary underline" href={`/${locale}/sales/invoices?open=${row.originalSalesInvoiceId}`}>{row.originalInvoice?.invoiceNumber ?? "عرض"}</a></div></div>
          <div><div className="text-xs text-muted">العميل</div><div>{row.customer?.nameAr ?? "—"}</div></div>
          <div><div className="text-xs text-muted">صافي المرتجع</div><div>{formatCurrency(row.subtotal, locale)}</div></div>
          <div><div className="text-xs text-muted">الضريبة</div><div>{formatCurrency(row.taxTotal, locale)}</div></div>
          <div><div className="text-xs text-muted">الإجمالي</div><div className="font-semibold">{formatCurrency(row.grandTotal, locale)}</div></div>
          {canFinancials && <div><div className="text-xs text-muted">عكس التكلفة</div><div>{formatCurrency(row.cogsReversalTotal, locale)}</div></div>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>الأسطر</CardTitle></CardHeader>
        <CardBody>
          <Table>
            <THead><TR><TH>الألواح</TH><TH>الأمتار (م²)</TH><TH>سعر المتر</TH><TH>الصافي</TH><TH>الضريبة</TH><TH>الإجمالي</TH>{canFinancials && <TH>عكس التكلفة</TH>}</TR></THead>
            <TBody>
              {(row.lines ?? []).map((l) => (
                <TR key={l.id}>
                  <TD>{Number(l.returnedBoards).toFixed(2)}</TD>
                  <TD>{Number(l.returnedMetersQuantity).toFixed(2)}</TD>
                  <TD>{formatCurrency(l.originalSalePricePerMeter, locale)}</TD>
                  <TD>{formatCurrency(l.returnNetExTax, locale)}</TD>
                  <TD>{formatCurrency(l.returnTax, locale)}</TD>
                  <TD>{formatCurrency(l.returnTotal, locale)}</TD>
                  {canFinancials && <TD>{formatCurrency(l.returnCogs, locale)}</TD>}
                </TR>
              ))}
            </TBody>
          </Table>
        </CardBody>
      </Card>
    </div>
  );
}
