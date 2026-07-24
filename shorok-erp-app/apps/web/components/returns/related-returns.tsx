"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import type { AppLocale } from "../../i18n";
import { formatCurrency, formatDate } from "../../lib/format";
import { listSalesReturns, listPurchaseReturns, type SalesReturnRow, type PurchaseReturnRow } from "../../lib/returns-client";

const STATUS_AR: Record<string, string> = { DRAFT: "مسودة", CONFIRMED: "مؤكد", CANCELLED: "ملغي" };

/**
 * Related Documents — the returns booked against an original invoice (§12).
 * Read-only; each row links to its return document.
 */
export function RelatedReturns({ invoiceId, kind }: { invoiceId: string; kind: "sales" | "purchase" }) {
  const locale = useLocale() as AppLocale;
  const [rows, setRows] = useState<Array<SalesReturnRow | PurchaseReturnRow>>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const run = kind === "sales"
      ? listSalesReturns({ originalInvoiceId: invoiceId, limit: 50 }).then((r) => r.items as Array<SalesReturnRow | PurchaseReturnRow>)
      : listPurchaseReturns({ originalInvoiceId: invoiceId, limit: 50 }).then((r) => r.items as Array<SalesReturnRow | PurchaseReturnRow>);
    void run.then((items) => setRows(items)).catch(() => setRows([])).finally(() => setLoaded(true));
  }, [invoiceId, kind]);

  if (!loaded) return <p className="text-xs text-muted">جارٍ تحميل المستندات المرتبطة…</p>;
  const base = kind === "sales" ? "sales" : "purchasing";

  return (
    <div className="mt-3">
      <h4 className="mb-1 text-sm font-semibold">المستندات المرتبطة — المردودات</h4>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">لا توجد مردودات على هذه الفاتورة</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-muted">
              <th className="p-1 text-right">رقم المردود</th><th className="p-1 text-right">التاريخ</th>
              <th className="p-1 text-right">الحالة</th><th className="p-1 text-right">أمتار</th>
              <th className="p-1 text-right">ألواح</th><th className="p-1 text-right">الإجمالي</th><th></th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-1">{r.returnNumber}</td>
                  <td className="p-1">{formatDate(r.returnDate, locale)}</td>
                  <td className="p-1">{STATUS_AR[r.status] ?? r.status}</td>
                  <td className="p-1">{Number(r.totalMeters ?? 0).toFixed(2)}</td>
                  <td className="p-1">{Number(r.totalBoards ?? 0).toFixed(2)}</td>
                  <td className="p-1">{formatCurrency(r.grandTotal, locale)}</td>
                  <td className="p-1"><a className="text-primary underline" href={`/${locale}/${base}/returns/${r.id}`}>عرض</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
