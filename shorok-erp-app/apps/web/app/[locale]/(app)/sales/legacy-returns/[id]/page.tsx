"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Badge } from "../../../../../../components/ui/badge";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { EmptyState } from "../../../../../../components/ui/empty-state";
import { Input } from "../../../../../../components/ui/input";
import { Label } from "../../../../../../components/ui/label";
import { Modal } from "../../../../../../components/ui/modal";
import { Skeleton } from "../../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import { ApiClientError } from "../../../../../../lib/api-client";
import { returnErrorMessage } from "../../../../../../lib/returns-error";
import { useHasRole } from "../../../../../../lib/auth";
import { formatCurrency, formatDate, formatDateTime } from "../../../../../../lib/format";
import {
  cancelLegacyReturn,
  confirmLegacyReturn,
  downloadLegacyReturnPdf,
  getLegacyReturn,
  type LegacyReturnDetail,
} from "../../../../../../lib/legacy-returns-client";

const STATUS_AR: Record<string, string> = { DRAFT: "مسودة", CONFIRMED: "مؤكد", CANCELLED: "ملغي" };

/**
 * One مردود بدون فاتورة.
 *
 * A confirmed document is shown, never edited — it has moved stock and credited
 * a customer, and the way to correct it is to cancel it and enter a new one.
 * The cost column is the honest part of the story: it says what the goods were
 * valued at when they came back, which is the only cost this document can know.
 */
export default function LegacyReturnDetailPage() {
  const locale = useLocale() as AppLocale;
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const canConfirm = useHasRole("ACCOUNTANT");
  const canCancel = useHasRole("OWNER");

  const [doc, setDoc] = useState<LegacyReturnDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      setDoc(await getLegacyReturn(id));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? returnErrorMessage(e, locale) : "تعذّر تحميل المستند.");
    } finally {
      setLoading(false);
    }
  }, [id, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      // Business rules arrive as validation_failed with the real cause in
      // details.reason. The generic envelope message would flatten every one
      // of them into «البيانات المدخلة غير صحيحة».
      setError(e instanceof ApiClientError ? returnErrorMessage(e, locale) : "تعذّر تنفيذ العملية.");
    } finally {
      setBusy(false);
    }
  };

  if (loading && !doc) return <Skeleton className="h-64 w-full" />;
  if (error && !doc) return <Alert variant="error">{error}</Alert>;
  if (!doc) return <EmptyState title="لا يوجد مستند." />;

  const money = (v: string) => formatCurrency(v, locale);

  const facts: Array<{ k: string; v: string }> = [
    { k: "رقم المرتجع", v: `LRN-${doc.returnNumber}` },
    { k: "تاريخ المرتجع", v: formatDate(doc.returnDate, locale) },
    { k: "العميل", v: doc.customerCode ? `${doc.customerCode} — ${doc.customerNameAr}` : doc.customerNameAr },
    { k: "رقم الفاتورة الورقية", v: doc.paperInvoiceNumber },
    { k: "تاريخ الفاتورة الأصلية", v: formatDate(doc.paperInvoiceDate, locale) },
    { k: "المخزن", v: doc.branchNameAr },
    { k: "أنشأ بواسطة", v: doc.createdByName },
    { k: "تاريخ الإنشاء", v: formatDateTime(doc.createdAt, locale) },
    ...(doc.confirmedByName ? [{ k: "أكّد بواسطة", v: doc.confirmedByName }] : []),
    ...(doc.confirmedAt ? [{ k: "تاريخ التأكيد", v: formatDateTime(doc.confirmedAt, locale) }] : []),
    ...(doc.cancelledByName ? [{ k: "ألغى بواسطة", v: doc.cancelledByName }] : []),
    ...(doc.cancellationReason ? [{ k: "سبب الإلغاء", v: doc.cancellationReason }] : []),
    ...(doc.journalEntryNumber ? [{ k: "قيد المرتجع", v: `#${doc.journalEntryNumber}` }] : []),
    ...(doc.cogsJournalEntryNumber ? [{ k: "قيد التكلفة", v: `#${doc.cogsJournalEntryNumber}` }] : []),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <Link href={`/${locale}/sales/legacy-returns`}>
            <Button variant="ghost" size="sm">
              رجوع
            </Button>
          </Link>
          <h1 className="text-xl font-bold" data-testid="lrd-number">
            مردود بدون فاتورة LRN-{doc.returnNumber}
          </h1>
          <Badge variant={doc.status === "CONFIRMED" ? "success" : doc.status === "CANCELLED" ? "neutral" : "warning"}>
            {STATUS_AR[doc.status]}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            data-testid="lrd-save-pdf"
            disabled={pdfBusy}
            onClick={async () => {
              setPdfBusy(true);
              try {
                await downloadLegacyReturnPdf(doc.id, doc.returnNumber, locale);
              } catch (e) {
                setError(e instanceof ApiClientError ? returnErrorMessage(e, locale) : "تعذّر إنشاء PDF.");
              } finally {
                setPdfBusy(false);
              }
            }}
          >
            {pdfBusy ? "جارٍ إنشاء الملف…" : "حفظ PDF"}
          </Button>
          {doc.status === "DRAFT" && canConfirm && (
            <Button
              variant="success"
              data-testid="lrd-confirm"
              disabled={busy}
              onClick={() => void act(() => confirmLegacyReturn(doc.id))}
            >
              تأكيد المرتجع
            </Button>
          )}
          {doc.status === "CONFIRMED" && canCancel && (
            <Button variant="danger" data-testid="lrd-cancel" disabled={busy} onClick={() => setCancelOpen(true)}>
              إلغاء المرتجع
            </Button>
          )}
        </div>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {facts.map((f) => (
          <Card key={f.k}>
            <CardBody>
              <div className="text-sm text-textSecondary">{f.k}</div>
              <div className="mt-1 font-medium" dir="auto">
                {f.v}
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>الأصناف المرتجعة</CardTitle>
        </CardHeader>
        <CardBody>
          <Table>
            <THead>
              <TR>
                <TH>الكود</TH>
                <TH>الصنف</TH>
                <TH>المقاس</TH>
                <TH>الألواح</TH>
                <TH>الأمتار</TH>
                <TH>سعر المتر</TH>
                <TH>الإجمالي</TH>
                <TH>تكلفة المخزون</TH>
              </TR>
            </THead>
            <TBody>
              {doc.lines.map((l) => (
                <TR key={l.id}>
                  <TD className="font-mono">{l.productCode}</TD>
                  <TD>{l.productNameAr}</TD>
                  <TD>
                    <Badge variant="neutral">{l.sizeBadgeAr}</Badge>{" "}
                    <span dir="ltr">{Number(l.sizeMetersPerBoard)} م</span>
                    {l.lengthM && (
                      <span className="text-textSecondary" dir="ltr">
                        {" "}
                        ({Number(l.lengthM)}
                        {l.widthM ? ` × ${Number(l.widthM)}` : ""} م)
                      </span>
                    )}
                  </TD>
                  <TD dir="ltr">{Number(l.returnedBoards)}</TD>
                  <TD dir="ltr">{Number(l.returnedMeters)}</TD>
                  <TD dir="ltr">{money(l.unitPricePerMeter)}</TD>
                  <TD dir="ltr">{money(l.lineTotal)}</TD>
                  <TD dir="ltr" className="text-textSecondary">
                    {l.costPerMeterSnapshot ? `${money(l.lineCogs)}` : "—"}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>

          <div className="mt-3 flex flex-wrap justify-end gap-6 text-sm">
            <span>
              الإجمالي قبل الخصم: <b dir="ltr">{money(doc.subtotal)}</b>
            </span>
            {Number(doc.discountTotal) > 0 && (
              <span>
                الخصم: <b dir="ltr">{money(doc.discountTotal)}</b>
              </span>
            )}
            {Number(doc.taxTotal) > 0 && (
              <span>
                الضريبة: <b dir="ltr">{money(doc.taxTotal)}</b>
              </span>
            )}
            <span className="font-bold">
              إجمالي قيمة المرتجع: <b dir="ltr">{money(doc.grandTotal)}</b>
            </span>
          </div>

          <div className="mt-3 rounded-md border border-border bg-background p-3 text-sm">
            {doc.status === "CONFIRMED" ? (
              <>تم إضافة قيمة المرتجع ({money(doc.grandTotal)}) إلى حساب العميل. لا يوجد أي صرف نقدي أو بنكي.</>
            ) : doc.status === "CANCELLED" ? (
              <>أُلغي هذا المرتجع وعُكست كل آثاره على المخزون وحساب العميل والقيود.</>
            ) : (
              <>مسودة — لم يتأثر المخزون ولم تُضف أي قيمة إلى حساب العميل بعد.</>
            )}
            {doc.status === "CONFIRMED" && (
              <div className="mt-1 text-xs text-textSecondary">
                تكلفة المخزون محسوبة من متوسط التكلفة وقت التأكيد ومثبّتة على المستند، فلا تتغير بتغيّر المتوسط
                لاحقاً.
              </div>
            )}
          </div>

          {doc.notes && <p className="mt-3 text-sm">ملاحظات: {doc.notes}</p>}
        </CardBody>
      </Card>

      <Modal open={cancelOpen} onClose={() => !busy && setCancelOpen(false)} title="إلغاء المرتجع">
        <div className="space-y-3" dir="rtl">
          <p className="text-sm text-textSecondary">
            سيُعكس أثر المستند على المخزون وحساب العميل والقيود المحاسبية بنفس القيم المسجّلة عند التأكيد. لا يمكن
            الإلغاء إذا كانت البضاعة المرتجعة قد صُرفت بالفعل.
          </p>
          <div>
            <Label htmlFor="lrd-reason">سبب الإلغاء</Label>
            <Input
              id="lrd-reason"
              data-testid="lrd-cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              maxLength={300}
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setCancelOpen(false)} disabled={busy}>
              تراجع
            </Button>
            <Button
              type="button"
              variant="danger"
              data-testid="lrd-cancel-submit"
              disabled={busy || !cancelReason.trim()}
              onClick={async () => {
                await act(() => cancelLegacyReturn(doc.id, cancelReason.trim()));
                setCancelOpen(false);
                setCancelReason("");
              }}
            >
              تأكيد الإلغاء
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
