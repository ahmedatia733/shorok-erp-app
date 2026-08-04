"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Alert } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Table, TBody, TD, TH, THead, TR } from "../ui/table";
import { formatCurrency, formatDate } from "../../lib/format";
import type {
  InvoiceRevisionDetail,
  InvoiceRevisionHistory,
  InvoiceRevisionSummary,
} from "../../lib/invoice-revisions-client";

/**
 * سجل التعديلات — every version of a confirmed invoice, oldest first.
 *
 * Revision 1 is the original confirmation and has no row of its own; it is the
 * `before` side of the first revision, which is why the original figures stay
 * readable here forever even after several revisions.
 */
export function RevisionHistory({
  load,
  loadOne,
}: {
  load: () => Promise<InvoiceRevisionHistory>;
  loadOne: (revisionNumber: number) => Promise<InvoiceRevisionDetail>;
}) {
  const t = useTranslations("invoiceRevision");
  const [history, setHistory] = useState<InvoiceRevisionHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState<InvoiceRevisionDetail | null>(null);

  useEffect(() => {
    let alive = true;
    load()
      .then((h) => alive && setHistory(h))
      .catch(() => alive && setError("تعذّر تحميل سجل التعديلات."));
    return () => {
      alive = false;
    };
  }, [load]);

  const toggle = async (n: number) => {
    if (open === n) {
      setOpen(null);
      setDetail(null);
      return;
    }
    setOpen(n);
    setDetail(null);
    try {
      setDetail(await loadOne(n));
    } catch {
      setError("تعذّر تحميل تفاصيل النسخة.");
    }
  };

  if (error) return <Alert variant="error">{error}</Alert>;
  if (!history) return <p className="text-sm text-textSecondary">جارٍ التحميل…</p>;
  if (history.revisions.length === 0) {
    return <p className="text-sm text-textSecondary">{t("noRevisions")}</p>;
  }

  return (
    <div className="space-y-3" dir="rtl">
      <p className="text-sm text-textSecondary">
        النسخة ١ هي الفاتورة الأصلية عند التأكيد. النسخة الحالية:{" "}
        <strong>{history.currentRevision}</strong>.
      </p>
      <Table>
        <THead>
          <TR>
            <TH>النسخة</TH><TH>التاريخ والوقت</TH><TH>المستخدم</TH><TH>السبب</TH>
            <TH>فرق الإجمالي</TH><TH>تاريخ الترحيل</TH><TH></TH>
          </TR>
        </THead>
        <TBody>
          {history.revisions.map((r: InvoiceRevisionSummary) => (
            <TR key={r.id}>
              <TD><Badge variant="info">{r.revisionNumber}</Badge></TD>
              <TD>{formatDate(r.createdAt, "ar")}</TD>
              <TD>{r.revisedByName ?? "—"}</TD>
              <TD className="max-w-xs truncate" title={r.reason}>{r.reason}</TD>
              <TD>{formatCurrency(r.totalDelta, "ar")}</TD>
              <TD>
                {formatDate(r.postingDate, "ar")}
                {r.crossesClosedPeriod && <Badge variant="warning" className="ms-1">فترة مقفلة</Badge>}
              </TD>
              <TD>
                <Button size="sm" variant="ghost" onClick={() => toggle(r.revisionNumber)}>
                  {open === r.revisionNumber ? "إخفاء" : "عرض المقارنة"}
                </Button>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>

      {open != null && (
        <div className="rounded-lg border border-border p-4">
          {!detail ? (
            <p className="text-sm text-textSecondary">جارٍ التحميل…</p>
          ) : (
            <div className="space-y-4">
              <h4 className="text-sm font-semibold">النسخة {detail.revisionNumber} — مقارنة قبل / بعد</h4>
              <div className="grid gap-3 text-sm sm:grid-cols-2">
                <div className="rounded border border-border p-3">
                  <div className="mb-1 text-xs font-semibold text-textSecondary">قبل</div>
                  <pre className="overflow-x-auto whitespace-pre-wrap text-xs" dir="ltr">
                    {JSON.stringify(detail.beforeSnapshot.header, null, 1)}
                  </pre>
                </div>
                <div className="rounded border border-border p-3">
                  <div className="mb-1 text-xs font-semibold text-textSecondary">بعد</div>
                  <pre className="overflow-x-auto whitespace-pre-wrap text-xs" dir="ltr">
                    {JSON.stringify(detail.afterSnapshot.header, null, 1)}
                  </pre>
                </div>
              </div>

              <div>
                <h5 className="mb-1 text-xs font-semibold text-textSecondary">بنود النسخة السابقة</h5>
                <Table>
                  <THead>
                    <TR><TH>الكود</TH><TH>الألواح</TH><TH>الأمتار</TH><TH>السعر</TH><TH>الإجمالي</TH></TR>
                  </THead>
                  <TBody>
                    {detail.beforeSnapshot.lines.map((l, i) => (
                      <TR key={i}>
                        <TD>{l.productCode ?? "—"}</TD><TD>{l.boards ?? "—"}</TD><TD>{l.meters ?? "—"}</TD>
                        <TD>{l.unitPrice ?? "—"}</TD><TD>{l.lineTotal ?? "—"}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>

              {detail.stockDelta.length > 0 && (
                <div>
                  <h5 className="mb-1 text-xs font-semibold text-textSecondary">فرق المخزون</h5>
                  <ul className="space-y-1 text-sm">
                    {detail.stockDelta.map((s, i) => (
                      <li key={i}>{s.branchNameAr}: {s.productCode ?? "—"} — {s.boardsDelta} لوح / {s.metersDelta} م</li>
                    ))}
                  </ul>
                </div>
              )}

              {detail.partyDelta?.after && (
                <p className="text-sm">
                  أثر الحساب: {detail.partyDelta.after.partyNameAr} — المتبقي{" "}
                  {formatCurrency(detail.partyDelta.after.outstandingAfter, "ar")} ج.م، رصيد دائن{" "}
                  {formatCurrency(detail.partyDelta.after.creditAfter, "ar")} ج.م.
                </p>
              )}

              {detail.valuation && detail.valuation.variants.length > 0 && (
                <div>
                  <h5 className="mb-1 text-xs font-semibold text-textSecondary">تسويات التقييم</h5>
                  <Table>
                    <THead>
                      <TR><TH>الصنف</TH><TH>التكلفة قبل</TH><TH>بعد</TH><TH>فرق المخزون</TH><TH>فرق التكلفة</TH></TR>
                    </THead>
                    <TBody>
                      {detail.valuation.variants.map((v) => (
                        <TR key={v.productVariantId}>
                          <TD>{v.productCode ?? "—"}</TD><TD>{v.currentWacPerMeter}</TD><TD>{v.projectedWacPerMeter}</TD>
                          <TD>{v.inventoryValueDelta}</TD><TD>{v.cogsDelta}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              )}

              <div className="text-xs text-textSecondary">
                <div>قيود العكس: {detail.reversalJournalEntryIds.join("، ") || "—"}</div>
                <div>قيود إعادة الترحيل: {detail.replacementJournalEntryIds.join("، ") || "—"}</div>
                <div>قيود تسوية التقييم: {detail.valuationJournalEntryIds.join("، ") || "—"}</div>
                <div>
                  حركات المخزون: {detail.reversalMovementIds.length} عكس /{" "}
                  {detail.replacementMovementIds.length} إعادة
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
