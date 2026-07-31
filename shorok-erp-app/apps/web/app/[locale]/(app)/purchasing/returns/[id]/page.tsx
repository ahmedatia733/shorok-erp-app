"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useLocale } from "next-intl";
import { useParams } from "next/navigation";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { Input } from "../../../../../../components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import { formatCurrency, formatDate } from "../../../../../../lib/format";
import { returnErrorMessage } from "../../../../../../lib/returns-error";
import { useHasRole } from "../../../../../../lib/auth";
import { downloadReturnPdf } from "../../../../../../lib/returns-pdf-client";
import { getPurchaseReturn, getPurchaseReturnable, confirmPurchaseReturn, cancelPurchaseReturn, updatePurchaseReturn, type PurchaseReturnRow, type PurchaseReturnable } from "../../../../../../lib/returns-client";

const STATUS_AR: Record<string, string> = { DRAFT: "مسودة", CONFIRMED: "مؤكد", CANCELLED: "ملغي" };
const D = (v: string | number | null) => Number(v || "0");

type LineEntry = { boards: string; reason: string; note: string };
const blockReason = (l: PurchaseReturnable["lines"][number]): string | null => {
  if (l.metersPerBoard == null || l.boardSizeSource == null) return "مقاس اللوح غير متاح — غير قابل للإرجاع";
  return null;
};

export default function PurchaseReturnDetailPage() {
  const locale = useLocale() as AppLocale;
  const { id } = useParams<{ id: string }>();
  const canCreateOrConfirm = useHasRole("OWNER", "ACCOUNTANT");
  const canCancel = useHasRole("OWNER");
  const [row, setRow] = useState<PurchaseReturnRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [ret, setRet] = useState<PurchaseReturnable | null>(null);
  const [qty, setQty] = useState<Record<string, LineEntry>>({});
  const [editDate, setEditDate] = useState("");
  const [editReason, setEditReason] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [pdfLoading, setPdfLoading] = useState(false);

  const load = useCallback(async () => {
    try { setRow(await getPurchaseReturn(id)); } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  // Read-only PDF download (DRAFT or CONFIRMED) — never mutates the return.
  async function handlePdf() {
    if (!row || pdfLoading) return; // guards duplicate rapid clicks
    setPdfLoading(true); setError(null);
    try {
      await downloadReturnPdf("purchase", row.id, locale, `PR-${row.returnNumber}`);
    } catch (e) {
      setError(returnErrorMessage(e, locale));
    } finally {
      setPdfLoading(false);
    }
  }

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(returnErrorMessage(e, locale)); }
    finally { setBusy(false); }
  };

  const startEdit = async () => {
    if (!row) return;
    setError(null);
    try {
      const r = await getPurchaseReturnable(row.originalPurchaseInvoiceId);
      setRet(r);
      const pre: Record<string, LineEntry> = {};
      for (const l of row.lines ?? []) pre[l.originalPurchaseInvoiceLineId] = { boards: String(Math.floor(D(l.returnedBoards))), reason: l.reason ?? "", note: l.note ?? "" };
      setQty(pre);
      setEditDate(row.returnDate.slice(0, 10));
      setEditReason(row.reason ?? "");
      setEditNotes(row.notes ?? "");
      setEditing(true);
    } catch (e) { setError(returnErrorMessage(e, locale)); }
  };

  const lineError = (rl: PurchaseReturnable["lines"][number]): string | null => {
    const e = qty[rl.originalLineId];
    if (!e || e.boards === "") return null;
    const b = Number(e.boards);
    if (isNaN(b) || b < 0 || !Number.isInteger(b)) return "عدد ألواح غير صالح (أعداد صحيحة فقط)";
    if (b > D(rl.maximumReturnableBoards)) return `عدد الألواح يتجاوز الحد الأقصى (${Math.floor(D(rl.maximumReturnableBoards))})`;
    return null;
  };

  const enteredLines = useMemo(() => (ret?.lines ?? []).filter((l) => Math.floor(Number(qty[l.originalLineId]?.boards || "0")) > 0), [ret, qty]);
  const anyLineError = useMemo(() => (ret?.lines ?? []).some((l) => lineError(l) != null), [ret, qty]); // eslint-disable-line react-hooks/exhaustive-deps
  const canSave = editing && enteredLines.length > 0 && !anyLineError;

  const saveEdit = async () => {
    if (!row || !ret || !canSave) return;
    const lines = enteredLines.map((l) => ({
      originalPurchaseInvoiceLineId: l.originalLineId,
      returnedBoards: String(Math.floor(Number(qty[l.originalLineId]!.boards))),
      // Text fields are sent VERBATIM (empty string = deliberate clear, §3).
      reason: qty[l.originalLineId]?.reason ?? "",
      note: qty[l.originalLineId]?.note ?? "",
    }));
    await act(async () => { await updatePurchaseReturn(row.id, { returnDate: editDate, reason: editReason, notes: editNotes, lines }); setEditing(false); });
  };

  if (!row) return <div dir="rtl" className="p-4">{error ? <Alert variant="error">{error}</Alert> : "جارٍ التحميل…"}</div>;
  const isDraft = row.status === "DRAFT";

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">مردود مشتريات #{row.returnNumber}</h1>
        <div className="flex gap-2">
          {/* Read-only PDF — always available to a viewer, DRAFT or CONFIRMED. */}
          <Button variant="ghost" data-testid="purchase-return-pdf" disabled={pdfLoading} onClick={() => void handlePdf()}>
            {pdfLoading ? (locale === "ar" ? "جارٍ التحضير…" : "Preparing…") : (locale === "ar" ? "حفظ PDF" : "Download PDF")}
          </Button>
          {isDraft && !editing && canCreateOrConfirm && <Button variant="ghost" disabled={busy} onClick={() => void startEdit()}>تعديل</Button>}
          {isDraft && !editing && canCreateOrConfirm && <Button disabled={busy} onClick={() => { if (confirm("تأكيد المردود؟ سيتم عكس القيود وخصم المخزون.")) void act(() => confirmPurchaseReturn(row.id)); }}>تأكيد المردود</Button>}
          {row.status === "CONFIRMED" && canCancel && <Button variant="danger" disabled={busy} onClick={() => { if (confirm("هل تريد إلغاء هذا المردود؟ سيتم عكس القيود وإرجاع المخزون.")) void act(() => cancelPurchaseReturn(row.id, "إلغاء من المستخدم")); }}>إلغاء المردود</Button>}
        </div>
      </div>
      {error && <Alert variant="error">{error}</Alert>}

      {editing && ret ? (
        <Card>
          <CardHeader><CardTitle>تعديل المسودة</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3 text-sm">
              <label>تاريخ المردود<Input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} /></label>
              <label>السبب<Input value={editReason} onChange={(e) => setEditReason(e.target.value)} placeholder="اختياري" /></label>
              <label>ملاحظات<Input value={editNotes} onChange={(e) => setEditNotes(e.target.value)} placeholder="اختياري" /></label>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <THead><TR><TH>الكود</TH><TH>اللون</TH><TH>متر / لوح</TH><TH>الحد الأقصى (ألواح)</TH><TH>سعر المتر</TH><TH>عدد الألواح المرتجعة</TH><TH>إجمالي الأمتار</TH><TH>سبب السطر</TH><TH>ملاحظة السطر</TH></TR></THead>
                <TBody>
                  {ret.lines.map((l) => {
                    const err = lineError(l);
                    const blocked = blockReason(l);
                    const b = Math.floor(Number(qty[l.originalLineId]?.boards || "0"));
                    const meters = !blocked && b > 0 ? b * D(l.metersPerBoard) : 0;
                    return (
                      <TR key={l.originalLineId}>
                        <TD>{l.productCode ?? "—"}</TD>
                        <TD>{l.colorName ?? "—"}</TD>
                        <TD>{l.metersPerBoard ? D(l.metersPerBoard).toFixed(2) : "—"}</TD>
                        <TD>{blocked ? "—" : Math.floor(D(l.maximumReturnableBoards))}</TD>
                        <TD>{formatCurrency(l.originalUnitPrice, locale)}</TD>
                        <TD style={{ maxWidth: 130 }}>
                          {blocked
                            ? <span className="text-xs text-amber-600">{blocked}</span>
                            : <>
                                <Input inputMode="numeric" type="number" min={0} step={1} max={D(l.maximumReturnableBoards)}
                                  data-testid={`boards-${l.originalLineId}`}
                                  value={qty[l.originalLineId]?.boards ?? ""} onChange={(e) => setQty((s) => ({ ...s, [l.originalLineId]: { ...(s[l.originalLineId] ?? { reason: "", note: "" }), boards: e.target.value } }))} />
                                {err && <div className="mt-1 text-xs text-red-600">{err}</div>}
                              </>}
                        </TD>
                        <TD className="tabular-nums" dir="ltr">{blocked ? "—" : meters.toFixed(2)}</TD>
                        <TD style={{ maxWidth: 160 }}>
                          <Input value={qty[l.originalLineId]?.reason ?? ""} placeholder="سبب اختياري" onChange={(e) => setQty((s) => ({ ...s, [l.originalLineId]: { ...(s[l.originalLineId] ?? { boards: "", note: "" }), reason: e.target.value } }))} />
                        </TD>
                        <TD style={{ maxWidth: 160 }}>
                          <Input value={qty[l.originalLineId]?.note ?? ""} placeholder="ملاحظة اختيارية" onChange={(e) => setQty((s) => ({ ...s, [l.originalLineId]: { ...(s[l.originalLineId] ?? { boards: "", reason: "" }), note: e.target.value } }))} />
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
            {enteredLines.length === 0 && <p className="text-xs text-amber-600">أدخل كمية مرتجعة على سطر واحد على الأقل.</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(false)}>إلغاء التعديل</Button>
              <Button disabled={busy || !canSave} onClick={() => void saveEdit()}>{busy ? "جارٍ الحفظ…" : "حفظ التعديلات"}</Button>
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
              {row.reason && <div className="md:col-span-2"><div className="text-xs text-muted">السبب</div><div>{row.reason}</div></div>}
              {row.notes && <div className="md:col-span-2"><div className="text-xs text-muted">ملاحظات</div><div>{row.notes}</div></div>}
            </CardBody>
          </Card>

          <Card>
            <CardHeader><CardTitle>الأسطر</CardTitle></CardHeader>
            <CardBody className="overflow-x-auto">
              <Table>
                <THead><TR><TH>الألواح</TH><TH>الأمتار (م²)</TH><TH>سعر المتر</TH><TH>الصافي</TH><TH>ض.ق.م</TH><TH>الإجمالي</TH><TH>السبب</TH><TH>ملاحظة</TH></TR></THead>
                <TBody>
                  {(row.lines ?? []).map((l) => (
                    <TR key={l.id}>
                      <TD>{Number(l.returnedBoards).toFixed(2)}</TD>
                      <TD>{Number(l.returnedMetersQuantity).toFixed(2)}</TD>
                      <TD>{formatCurrency(l.originalPurchasePricePerMeter, locale)}</TD>
                      <TD>{formatCurrency(l.returnNetExTax, locale)}</TD>
                      <TD>{formatCurrency(l.returnTax, locale)}</TD>
                      <TD>{formatCurrency(l.returnTotal, locale)}</TD>
                      <TD>{l.reason ?? "—"}</TD>
                      <TD>{l.note ?? "—"}</TD>
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
