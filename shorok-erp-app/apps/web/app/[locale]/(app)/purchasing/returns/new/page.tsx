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
import { listPurchaseInvoices, type PurchaseInvoiceRow } from "../../../../../../lib/purchase-invoices-client";
import { getPurchaseReturnable, createPurchaseReturn, type PurchaseReturnable } from "../../../../../../lib/returns-client";

const D = (v: string) => Number(v || "0");

export default function NewPurchaseReturnPage() {
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const [invoices, setInvoices] = useState<PurchaseInvoiceRow[]>([]);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<PurchaseInvoiceRow | null>(null);
  const [ret, setRet] = useState<PurchaseReturnable | null>(null);
  const [qty, setQty] = useState<Record<string, { meters: string; boards: string }>>({});
  const [settlementMode, setSettlementMode] = useState("KEEP_AS_SUPPLIER_CREDIT");
  const [returnDate, setReturnDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void listPurchaseInvoices({ status: "CONFIRMED", limit: 100 })
      .then((r) => setInvoices(r.data))
      .catch((e) => setError((e as Error).message));
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return invoices.slice(0, 20);
    return invoices.filter((i) => i.invoiceNumber.toLowerCase().includes(s) || (i.supplierNameAr ?? "").toLowerCase().includes(s)).slice(0, 20);
  }, [q, invoices]);

  const pick = async (inv: PurchaseInvoiceRow) => {
    setError(null); setSelected(inv); setRet(null); setQty({});
    try { setRet(await getPurchaseReturnable(inv.id)); }
    catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : (e as Error).message); }
  };

  const preview = useMemo(() => {
    if (!ret) return { net: 0, tax: 0, grand: 0 };
    let net = 0, tax = 0;
    for (const l of ret.lines) {
      const m = D(qty[l.originalLineId]?.meters ?? "0");
      if (m <= 0 || D(l.originalMeters) <= 0) continue;
      const lineNet = D(l.originalUnitPrice) * m;
      net += lineNet;
      tax += lineNet * D(l.originalTaxRate) / 100;
    }
    return { net, tax, grand: net + tax };
  }, [ret, qty]);

  const save = async () => {
    if (!selected || !ret) return;
    const lines = ret.lines
      .filter((l) => D(qty[l.originalLineId]?.meters ?? "0") > 0)
      .map((l) => ({ originalPurchaseInvoiceLineId: l.originalLineId, returnedMeters: qty[l.originalLineId]?.meters ?? "0", returnedBoards: qty[l.originalLineId]?.boards || undefined }));
    if (lines.length === 0) { setError("أدخل كمية مرتجعة على سطر واحد على الأقل"); return; }
    setBusy(true); setError(null);
    try {
      const created = await createPurchaseReturn({ originalPurchaseInvoiceId: selected.id, returnDate, reason: reason || undefined, settlementMode, lines });
      router.push(`/${locale}/purchasing/returns/${created.id}`);
    } catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : (e as Error).message); setBusy(false); }
  };

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
                {filtered.map((i) => (
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
              <CardTitle>الفاتورة {selected.invoiceNumber} — {selected.supplierNameAr}</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => { setSelected(null); setRet(null); }}>تغيير الفاتورة</Button>
            </CardHeader>
            <CardBody>
              <p className="mb-2 text-sm text-muted">تأكد من توفر المخزون قبل التأكيد.</p>
              <Table>
                <THead><TR><TH>الأصلي (م²)</TH><TH>مرتجع سابقاً</TH><TH>المتبقي (م²)</TH><TH>سعر المتر</TH><TH>الكمية المرتجعة (م²)</TH><TH>عدد الألواح</TH></TR></THead>
                <TBody>
                  {ret.lines.map((l) => (
                    <TR key={l.originalLineId}>
                      <TD>{D(l.originalMeters).toFixed(2)}</TD>
                      <TD>{D(l.returnedMeters).toFixed(2)}</TD>
                      <TD>{D(l.remainingMeters).toFixed(2)}</TD>
                      <TD>{formatCurrency(l.originalUnitPrice, locale)}</TD>
                      <TD style={{ maxWidth: 120 }}>
                        <Input inputMode="decimal" value={qty[l.originalLineId]?.meters ?? ""} placeholder="0"
                          onChange={(e) => setQty((s) => ({ ...s, [l.originalLineId]: { meters: e.target.value, boards: s[l.originalLineId]?.boards ?? "" } }))} />
                      </TD>
                      <TD style={{ maxWidth: 100 }}>
                        <Input inputMode="decimal" value={qty[l.originalLineId]?.boards ?? ""} placeholder="تلقائي"
                          onChange={(e) => setQty((s) => ({ ...s, [l.originalLineId]: { meters: s[l.originalLineId]?.meters ?? "", boards: e.target.value } }))} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardBody>
          </Card>

          <Card>
            <CardHeader><CardTitle>المعاينة والتسوية</CardTitle></CardHeader>
            <CardBody className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div><div className="text-xs text-muted">صافي المرتجع</div><div className="font-semibold">{formatCurrency(preview.net.toFixed(2), locale)}</div></div>
              <div><div className="text-xs text-muted">ض.ق.م</div><div className="font-semibold">{formatCurrency(preview.tax.toFixed(2), locale)}</div></div>
              <div><div className="text-xs text-muted">الإجمالي / رصيد المورد</div><div className="font-semibold">{formatCurrency(preview.grand.toFixed(2), locale)}</div></div>
              <div><div className="text-xs text-muted">قيمة المخزون الخارج</div><div className="font-semibold">{formatCurrency(preview.net.toFixed(2), locale)}</div></div>
              <label className="col-span-2 text-sm">التسوية
                <select className="mt-1 w-full rounded-md border px-2 py-1" value={settlementMode} onChange={(e) => setSettlementMode(e.target.value)}>
                  <option value="KEEP_AS_SUPPLIER_CREDIT">رصيد دائن لدى المورد</option>
                  <option value="OFFSET_OUTSTANDING_BALANCE">تسوية رصيد مستحق</option>
                  <option value="CASH_REFUND">استرداد نقدي</option>
                  <option value="BANK_REFUND">استرداد بنكي</option>
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
