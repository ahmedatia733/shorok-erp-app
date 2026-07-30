"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import type { AppLocale } from "../../../../../../i18n";
import { Alert } from "../../../../../../components/ui/alert";
import { Button } from "../../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../../components/ui/card";
import { Input } from "../../../../../../components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import { formatCurrency } from "../../../../../../lib/format";
import { ApiClientError } from "../../../../../../lib/api-client";
import { useHasRole } from "../../../../../../lib/auth";
import { listPurchaseInvoices, type PurchaseInvoiceRow } from "../../../../../../lib/purchase-invoices-client";
import { getPurchaseReturnable, createPurchaseReturn, type PurchaseReturnable, type PurchaseReturnableLine } from "../../../../../../lib/returns-client";

const D = (v: string | null) => Number(v || "0");

function lineBlockReason(l: PurchaseReturnableLine): string | null {
  if (l.metersPerBoard == null || l.boardSizeSource == null) return "مقاس اللوح غير متاح لهذا السطر — لا يمكن إرجاعه";
  if (D(l.maximumReturnableBoards) <= 0) {
    return D(l.eligibleWholeBoards) <= 0
      ? "لا توجد ألواح كاملة قابلة للإرجاع (اللوح مقصوص)"
      : "تم إرجاع كل الألواح المتاحة لهذا السطر";
  }
  return null;
}

export default function NewPurchaseReturnPage() {
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const canCreate = useHasRole("OWNER", "ACCOUNTANT"); // §2
  const [invoices, setInvoices] = useState<PurchaseInvoiceRow[]>([]);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<PurchaseInvoiceRow | null>(null);
  const [ret, setRet] = useState<PurchaseReturnable | null>(null);
  const [boards, setBoards] = useState<Record<string, string>>({});
  const [settlementMode, setSettlementMode] = useState("KEEP_AS_SUPPLIER_CREDIT");
  const [returnDate, setReturnDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => {
      void listPurchaseInvoices({ status: "CONFIRMED", q: q.trim() || undefined, limit: 25 })
        .then((r) => setInvoices(r.data))
        .catch((e) => setError((e as Error).message));
    }, 250);
    return () => clearTimeout(handle);
  }, [q]);

  const pick = async (inv: PurchaseInvoiceRow) => {
    setError(null); setSelected(inv); setRet(null); setBoards({});
    try { setRet(await getPurchaseReturnable(inv.id)); }
    catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : (e as Error).message); }
  };

  const lineCalc = (l: PurchaseReturnableLine) => {
    const b = Math.floor(D(boards[l.originalLineId] ?? "0"));
    const mpb = D(l.metersPerBoard);
    const meters = b > 0 && mpb > 0 ? b * mpb : 0;
    const net = D(l.originalUnitPrice) * meters;      // per-metre purchase price × derived metres
    const tax = net * D(l.originalTaxRate) / 100;
    const pricePerBoard = D(l.originalUnitPrice) * mpb;
    return { boards: b, meters, net, tax, total: net + tax, pricePerBoard };
  };

  const preview = useMemo(() => {
    if (!ret) return { net: 0, tax: 0, grand: 0 };
    let net = 0, tax = 0;
    for (const l of ret.lines) {
      if (lineBlockReason(l)) continue;
      const c = lineCalc(l);
      if (c.boards <= 0) continue;
      net += c.net; tax += c.tax;
    }
    return { net, tax, grand: net + tax };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ret, boards]);

  const save = async () => {
    if (!selected || !ret) return;
    const lines = ret.lines
      .filter((l) => !lineBlockReason(l) && Math.floor(D(boards[l.originalLineId] ?? "0")) > 0)
      .map((l) => ({ originalPurchaseInvoiceLineId: l.originalLineId, returnedBoards: String(Math.floor(D(boards[l.originalLineId]!))) }));
    if (lines.length === 0) { setError("أدخل عدد ألواح مرتجعة على سطر واحد على الأقل"); return; }
    setBusy(true); setError(null);
    try {
      const created = await createPurchaseReturn({ originalPurchaseInvoiceId: selected.id, returnDate, reason: reason || undefined, settlementMode, lines });
      router.push(`/${locale}/purchasing/returns/${created.id}`);
    } catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : (e as Error).message); setBusy(false); }
  };

  if (!canCreate) {
    return (
      <div className="space-y-4" dir="rtl">
        <h1 className="text-xl font-semibold">مردود مشتريات جديد</h1>
        <Alert variant="error">غير مصرح لك بإنشاء مردود مشتريات. هذه الصفحة متاحة للعرض فقط لمدير الفرع.</Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4" dir="rtl">
      <h1 className="text-xl font-semibold">مردود مشتريات جديد</h1>
      {error && <Alert variant="error">{error}</Alert>}

      {!selected && (
        <Card>
          <CardHeader><CardTitle>ابحث عن فاتورة الشراء الأصلية</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <Input placeholder="رقم الفاتورة أو اسم المورد" value={q} onChange={(e) => setQ(e.target.value)} />
            <Table>
              <THead><TR><TH>رقم الفاتورة</TH><TH>المورد</TH><TH>الإجمالي</TH><TH></TH></TR></THead>
              <TBody>
                {invoices.map((i) => (
                  <TR key={i.id}>
                    <TD>{i.invoiceNumber}</TD><TD>{i.supplierNameAr}</TD><TD>{formatCurrency(i.grandTotal, locale)}</TD>
                    <TD><Button size="sm" onClick={() => void pick(i)}>اختيار</Button></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardBody>
        </Card>
      )}

      {selected && ret && (
        <>
          <Card>
            <CardHeader className="flex items-center justify-between">
              {/* The supplier comes from the original invoice and cannot be changed. */}
              <CardTitle>الفاتورة {selected.invoiceNumber} — المورد: {selected.supplierNameAr}</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => { setSelected(null); setRet(null); }}>تغيير الفاتورة</Button>
            </CardHeader>
            <CardBody>
              <p className="mb-1 text-sm text-muted">تأكد من توفر المخزون قبل التأكيد.</p>
              <p className="mb-2 text-xs text-muted">الإرجاع بالألواح الكاملة فقط. تُحسب الأمتار تلقائياً من مقاس اللوح ولا يمكن تعديلها.</p>
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>الصنف</TH><TH>اللون</TH>
                      <TH>متر / لوح</TH>
                      <TH>ألواح الفاتورة الأصلية</TH>
                      <TH>ألواح مرتجعة سابقًا</TH>
                      <TH>الحد الأقصى المتاح</TH>
                      <TH>عدد الألواح المرتجعة</TH>
                      <TH>إجمالي الأمتار</TH>
                      <TH>سعر اللوح من الفاتورة الأصلية</TH>
                      <TH>القيمة قبل الضريبة</TH>
                      <TH>نسبة الضريبة</TH>
                      <TH>الضريبة</TH>
                      <TH>الإجمالي</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {ret.lines.map((l) => {
                      const blocked = lineBlockReason(l);
                      const c = lineCalc(l);
                      return (
                        <TR key={l.originalLineId}>
                          <TD>{l.productCode ?? "—"}</TD>
                          <TD>{l.colorName ?? "—"}</TD>
                          <TD>{l.metersPerBoard ? D(l.metersPerBoard).toFixed(2) : "—"}</TD>
                          <TD>{Math.floor(D(l.originalBoards))}</TD>
                          <TD>{Math.floor(D(l.previouslyReturnedBoards))}</TD>
                          <TD>{Math.floor(D(l.maximumReturnableBoards))}</TD>
                          <TD style={{ minWidth: 120 }}>
                            {blocked
                              ? <span className="text-xs text-amber-600">{blocked}</span>
                              : <Input inputMode="numeric" type="number" min={0} step={1} max={D(l.maximumReturnableBoards)}
                                  data-testid={`boards-${l.originalLineId}`}
                                  value={boards[l.originalLineId] ?? ""} placeholder="0"
                                  onChange={(e) => setBoards((s) => ({ ...s, [l.originalLineId]: e.target.value }))} />}
                          </TD>
                          <TD className="tabular-nums" dir="ltr" data-testid={`meters-${l.originalLineId}`}>{blocked ? "—" : c.meters.toFixed(2)}</TD>
                          <TD>{formatCurrency(c.pricePerBoard.toFixed(2), locale)}</TD>
                          <TD>{formatCurrency(c.net.toFixed(2), locale)}</TD>
                          <TD>{D(l.originalTaxRate).toFixed(0)}%</TD>
                          <TD>{formatCurrency(c.tax.toFixed(2), locale)}</TD>
                          <TD className="font-semibold">{formatCurrency(c.total.toFixed(2), locale)}</TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader><CardTitle>المعاينة والتسوية</CardTitle></CardHeader>
            <CardBody className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div><div className="text-xs text-muted">قيمة المرتجع قبل الضريبة</div><div className="font-semibold">{formatCurrency(preview.net.toFixed(2), locale)}</div></div>
              <div><div className="text-xs text-muted">قيمة الضريبة المرتجعة</div><div className="font-semibold">{formatCurrency(preview.tax.toFixed(2), locale)}</div></div>
              <div><div className="text-xs text-muted">إجمالي رصيد المورد</div><div className="font-semibold">{formatCurrency(preview.grand.toFixed(2), locale)}</div></div>
              <div><div className="text-xs text-muted">قيمة المخزون الخارج</div><div className="font-semibold">{formatCurrency(preview.net.toFixed(2), locale)}</div></div>
              <label className="col-span-2 text-sm">التسوية
                {/* Cash/bank supplier refunds are not supported yet — only credit modes. */}
                <select className="mt-1 w-full rounded-md border px-2 py-1" value={settlementMode} onChange={(e) => setSettlementMode(e.target.value)}>
                  <option value="KEEP_AS_SUPPLIER_CREDIT">رصيد دائن لدى المورد</option>
                  <option value="OFFSET_OUTSTANDING_BALANCE">تسوية رصيد مستحق</option>
                </select>
              </label>
              <label className="text-sm">تاريخ المردود<Input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} /></label>
              <label className="text-sm">السبب<Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="اختياري" /></label>
            </CardBody>
          </Card>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => router.push(`/${locale}/purchasing/returns`)}>إلغاء</Button>
            <Button disabled={busy} onClick={() => void save()}>{busy ? "جارٍ الحفظ…" : "حفظ كمسودة"}</Button>
          </div>
        </>
      )}
    </div>
  );
}
