"use client";

import { useEffect, useState, useCallback } from "react";
import { useLocale } from "next-intl";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { formatCurrency, formatDate } from "../../../../../lib/format";
import { listSalesReturns, type SalesReturnRow } from "../../../../../lib/returns-client";

const STATUS_AR: Record<string, string> = { DRAFT: "مسودة", CONFIRMED: "مؤكد", CANCELLED: "ملغي" };

export default function SalesReturnsPage() {
  const locale = useLocale() as AppLocale;
  const [rows, setRows] = useState<SalesReturnRow[]>([]);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await listSalesReturns({ status: status || undefined, limit: 100 });
      setRows(res.items);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">مردودات المبيعات</h1>
        <a href={`/${locale}/sales/returns/new`}><Button>مردود جديد</Button></a>
      </div>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>قائمة المردودات</CardTitle>
          <select className="rounded-md border px-2 py-1 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">كل الحالات</option>
            <option value="DRAFT">مسودة</option>
            <option value="CONFIRMED">مؤكد</option>
            <option value="CANCELLED">ملغي</option>
          </select>
        </CardHeader>
        <CardBody>
          {error && <Alert variant="error">{error}</Alert>}
          {loading ? <p className="text-sm text-muted">جارٍ التحميل…</p> : (
            <Table>
              <THead>
                <TR>
                  <TH>رقم المردود</TH><TH>التاريخ</TH><TH>الفاتورة الأصلية</TH><TH>العميل</TH>
                  <TH>الإجمالي</TH><TH>عكس التكلفة</TH><TH>الحالة</TH><TH></TH>
                </TR>
              </THead>
              <TBody>
                {rows.length === 0 && <TR><TD colSpan={8}><span className="text-sm text-muted">لا توجد مردودات</span></TD></TR>}
                {rows.map((r) => (
                  <TR key={r.id}>
                    <TD>{r.returnNumber}</TD>
                    <TD>{formatDate(r.returnDate, locale)}</TD>
                    <TD>{r.originalInvoice?.invoiceNumber ?? "—"}</TD>
                    <TD>{r.customer?.nameAr ?? "—"}</TD>
                    <TD>{formatCurrency(r.grandTotal, locale)}</TD>
                    <TD>{formatCurrency(r.cogsReversalTotal, locale)}</TD>
                    <TD>{STATUS_AR[r.status] ?? r.status}</TD>
                    <TD><a className="text-primary underline" href={`/${locale}/sales/returns/${r.id}`}>عرض</a></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
