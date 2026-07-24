"use client";

import { useEffect, useState, useCallback } from "react";
import { useLocale } from "next-intl";
import { useParams } from "next/navigation";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { Input } from "../../../../../../components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import { formatCurrency, formatDate } from "../../../../../../lib/format";
import { ApiClientError } from "../../../../../../lib/api-client";
import { useHasRole } from "../../../../../../lib/auth";
import { getPurchaseReturn, getPurchaseReturnable, confirmPurchaseReturn, cancelPurchaseReturn, updatePurchaseReturn, type PurchaseReturnRow, type PurchaseReturnable } from "../../../../../../lib/returns-client";

const STATUS_AR: Record<string, string> = { DRAFT: "مسودة", CONFIRMED: "مؤكد", CANCELLED: "ملغي" };
const D = (v: string | number) => Number(v || "0");

export default function PurchaseReturnDetailPage() {
  const locale = useLocale() as AppLocale;
  const { id } = useParams<{ id: string }>();
  const isOwner = useHasRole("OWNER");
  const [row, setRow] = useState<PurchaseReturnRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [ret, setRet] = useState<PurchaseReturnable | null>(null);
  const [qty, setQty] = useState<Record<string, { meters: string; boards: string }>>({});
  const [editDate, setEditDate] = useState("");
  const [editReason, setEditReason] = useState("");

  const load = useCallback(async () => {
    try { setRow(await getPurchaseReturn(id)); } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : (e as Error).message); }
    finally { setBusy(false); }
  };

  const startEdit = async () => {
    if (!row) return;
    setError(null);
    try {
      const r = await getPurchaseReturnable(row.originalPurchaseInvoiceId);
      setRet(r);
      const pre: Record<string, { meters: string; boards: string }> = {};
      for (const l of row.lines ?? []) pre[l.originalPurchaseInvoiceLineId] = { meters: String(D(l.returnedMetersQuantity)), boards: String(D(l.returnedBoards)) };
      setQty(pre);
      setEditDate(row.returnDate.slice(0, 10));
      setEditReason(row.reason ?? "");
      setEditing(true);
    } catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : (e as Error).message); }
  };

  const saveEdit = async () => {
    if (!row || !ret) return;
    const lines = ret.lines
      .filter((l) => D(qty[l.originalLineId]?.meters ?? "0") > 0)
      .map((l) => ({ originalPurchaseInvoiceLineId: l.originalLineId, returnedMeters: qty[l.originalLineId]?.meters ?? "0", returnedBoards: qty[l.originalLineId]?.boards || undefined }));
    if (lines.length === 0) { setError("أدخل كمية مرتجعة على سطر واحد على الأقل"); return; }
    await act(async () => { await updatePurchaseReturn(row.id, { returnDate: editDate, reason: editReason || undefined, lines }); setEditing(false); });
  };

  if (!row) return <div dir="rtl" className="p-4">{error ? <Alert variant="error">{error}</Alert> : "جارٍ التحميل…"}</div>;

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">مردود مشتريات #{row.returnNumber}</h1>
        <div className="flex gap-2">
          {row.status === "DRAFT" && !editing && <Button variant="ghost" disabled={busy} onClick={() => void startEdit()}>تعديل</Button>}
          {row.status === "DRAFT" && !editing && <Button disabled={busy} onClick={() => { if (confirm("تأكيد المردود؟ سيتم عكس القيود وخصم المخزون.")) void act(() => confirmPurchaseReturn(row.id)); }}>تأكيد المردود</Button>}
          {row.status === "CONFIRMED" && isOwner && <Button variant="danger" disabled={busy} onClick={() => { if (confirm("هل تريد إلغاء هذا المردود؟ سيتم عكس القيود وإرجاع المخزون.")) void act(() => cancelPurchaseReturn(row.id, "إلغاء من المستخدم")); }}>إلغاء المردود</Button>}
        </div>
      </div>
      {error && <Alert variant="error">{error}</Alert>}

      {editing && ret ? (
        <Card>
          <CardHeader><CardTitle>تعديل المسودة</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 text-sm">
              <label>تاريخ المردود<Input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} /></label>
              <label className="md:col-span-3">السبب<Input value={editReason} onChange={(e) => setEditReason(e.target.value)} placeholder="اختياري" /></label>
            </div>
            <Table>
              <THead><TR><TH>الكود</TH><TH>اللون</TH><TH>المتبقي (م²)</TH><TH>سعر المتر</TH><TH>الكمية المرتجعة (م²)</TH><TH>عدد الألواح</TH></TR></THead>
              <TBody>
                {ret.lines.map((l) => (
                  <TR key={l.originalLineId}>
                    <TD>{l.productCode ?? "—"}</TD>
                    <TD>{l.colorName ?? "—"}</TD>
                    <TD>{D(l.remainingMeters).toFixed(2)}</TD>
                    <TD>{formatCurrency(l.originalUnitPrice, locale)}</TD>
                    <TD style={{ maxWidth: 140 }}>
                      <Input inputMode="decimal" value={qty[l.originalLineId]?.meters ?? ""} onChange={(e) => setQty((s) => ({ ...s, [l.originalLineId]: { meters: e.target.value, boards: s[l.originalLineId]?.boards ?? "" } }))} />
                    </TD>
                    <TD style={{ maxWidth: 100 }}>
                      <Input inputMode="decimal" value={qty[l.originalLineId]?.boards ?? ""} placeholder="تلقائي" onChange={(e) => setQty((s) => ({ ...s, [l.originalLineId]: { meters: s[l.originalLineId]?.meters ?? "", boards: e.target.value } }))} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(false)}>إلغاء التعديل</Button>
              <Button disabled={busy} onClick={() => void saveEdit()}>{busy ? "جارٍ الحفظ…" : "حفظ التعديلات"}</Button>
            </div>
          </CardBody>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle>بيانات المردود</CardTitle></CardHeader>
            <CardBody className="grid grid-cols-2 gap-3 md:grid-cols-4 text-sm">
              <div><div className="text-xs text-muted">الحالة</div><div className="font-semibold">{STATUS_AR[row.status] ?? row.status}</div></div>
              <div><div className="text-xs text-muted">التاريخ</div><div>{formatDate(row.returnDate, locale)}</div></div>
              <div><div className="text-xs text-muted">فاتورة الشراء</div><div><a className="text-primary underline" href={`/${locale}/purchasing/invoices?open=${row.originalPurchaseInvoiceId}`}>{row.originalInvoice?.invoiceNumber ?? "عرض"}</a></div></div>
              <div><div className="text-xs text-muted">المورد</div><div>{row.supplier?.nameAr ?? "—"}</div></div>
              <div><div className="text-xs text-muted">صافي المرتجع</div><div>{formatCurrency(row.subtotal, locale)}</div></div>
              <div><div className="text-xs text-muted">ض.ق.م</div><div>{formatCurrency(row.taxTotal, locale)}</div></div>
              <div><div className="text-xs text-muted">الإجمالي</div><div className="font-semibold">{formatCurrency(row.grandTotal, locale)}</div></div>
              <div><div className="text-xs text-muted">قيمة المخزون الخارج</div><div>{formatCurrency(row.inventoryValueOut, locale)}</div></div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader><CardTitle>الأسطر</CardTitle></CardHeader>
            <CardBody>
              <Table>
                <THead><TR><TH>الألواح</TH><TH>الأمتار (م²)</TH><TH>سعر المتر</TH><TH>الصافي</TH><TH>ض.ق.م</TH><TH>الإجمالي</TH></TR></THead>
                <TBody>
                  {(row.lines ?? []).map((l) => (
                    <TR key={l.id}>
                      <TD>{Number(l.returnedBoards).toFixed(2)}</TD>
                      <TD>{Number(l.returnedMetersQuantity).toFixed(2)}</TD>
                      <TD>{formatCurrency(l.originalPurchasePricePerMeter, locale)}</TD>
                      <TD>{formatCurrency(l.returnNetExTax, locale)}</TD>
                      <TD>{formatCurrency(l.returnTax, locale)}</TD>
                      <TD>{formatCurrency(l.returnTotal, locale)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
