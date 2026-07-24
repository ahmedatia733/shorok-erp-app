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
import { listSalesInvoices, type SalesInvoiceRow } from "../../../../../../lib/sales-invoices-client";
import { getSalesReturnable, createSalesReturn, type SalesReturnable } from "../../../../../../lib/returns-client";

const D = (v: string) => Number(v || "0");

export default function NewSalesReturnPage() {
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const [invoices, setInvoices] = useState<SalesInvoiceRow[]>([]);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<SalesInvoiceRow | null>(null);
  const [ret, setRet] = useState<SalesReturnable | null>(null);
  const [qty, setQty] = useState<Record<string, { meters: string; boards: string }>>({});
  const [settlementMode, setSettlementMode] = useState("KEEP_AS_CUSTOMER_CREDIT");
  const [returnDate, setReturnDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // SERVER-SIDE search (§14): re-query the API as the user types (debounced),
  // so any confirmed invoice is findable — not just a first client-side page.
  useEffect(() => {
    const handle = setTimeout(() => {
      void listSalesInvoices({ status: "CONFIRMED", q: q.trim() || undefined, limit: 25 })
        .then((r) => setInvoices(r.data))
        .catch((e) => setError((e as Error).message));
    }, 250);
    return () => clearTimeout(handle);
  }, [q]);

  const filtered = invoices;

  const pickInvoice = async (inv: SalesInvoiceRow) => {
    setError(null); setSelected(inv); setRet(null); setQty({});
    try {
      const r = await getSalesReturnable(inv.id);
      setRet(r);
    } catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : (e as Error).message); }
  };

  const preview = useMemo(() => {
    if (!ret) return { net: 0, tax: 0, grand: 0, cogs: 0 };
    let net = 0, tax = 0, cogs = 0;
    for (const l of ret.lines) {
      const m = D(qty[l.originalLineId]?.meters ?? "0");
      if (m <= 0 || D(l.originalMeters) <= 0) continue;
      const ratio = m / D(l.originalMeters);
      const lineNet = D(l.originalNetExTax) * ratio;
      net += lineNet;
      tax += lineNet * D(l.originalTaxRate) / 100;
      cogs += D(l.originalLineCogs) * ratio;
    }
    return { net, tax, grand: net + tax, cogs };
  }, [ret, qty]);

  const save = async () => {
    if (!selected || !ret) return;
    const lines = ret.lines
      .filter((l) => D(qty[l.originalLineId]?.meters ?? "0") > 0)
      .map((l) => ({ originalSalesInvoiceLineId: l.originalLineId, returnedMeters: qty[l.originalLineId]?.meters ?? "0", returnedBoards: qty[l.originalLineId]?.boards || undefined }));
    if (lines.length === 0) { setError("أدخل كمية مرتجعة على سطر واحد على الأقل"); return; }
    setBusy(true); setError(null);
    try {
      const created = await createSalesReturn({ originalSalesInvoiceId: selected.id, returnDate, reason: reason || undefined, settlementMode, lines });
      router.push(`/${locale}/sales/returns/${created.id}`);
    } catch (e) { setError(e instanceof ApiClientError ? e.localizedMessage(locale) : (e as Error).message); setBusy(false); }
  };

  return (
    <div className="space-y-4" dir="rtl">
      <h1 className="text-xl font-semibold">مردود مبيعات جديد</h1>
      {error && <Alert variant="error">{error}</Alert>}

      {!selected && (
        <Card>
          <CardHeader><CardTitle>ابحث عن الفاتورة الأصلية</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <Input placeholder="رقم الفاتورة أو اسم العميل" value={q} onChange={(e) => setQ(e.target.value)} />
            <Table>
              <THead><TR><TH>رقم الفاتورة</TH><TH>العميل</TH><TH>الإجمالي</TH><TH></TH></TR></THead>
              <TBody>
                {filtered.map((i) => (
                  <TR key={i.id}>
                    <TD>{i.invoiceNumber}</TD>
                    <TD>{i.customer?.nameAr ?? "—"}</TD>
                    <TD>{formatCurrency(i.grandTotal, locale)}</TD>
                    <TD><Button size="sm" onClick={() => void pickInvoice(i)}>اختيار</Button></TD>
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
              <CardTitle>الفاتورة {selected.invoiceNumber} — {selected.customer?.nameAr}</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => { setSelected(null); setRet(null); }}>تغيير الفاتورة</Button>
            </CardHeader>
            <CardBody className="space-y-3">
              <p className="text-sm text-muted">حالة الارتجاع: {ret.invoice.returnStatus === "NONE" ? "لا يوجد" : ret.invoice.returnStatus === "PARTIAL" ? "جزئي" : "كامل"}</p>
              <Table>
                <THead>
                  <TR><TH>الكود</TH><TH>اللون</TH><TH>مقاس اللوح (تاريخي)</TH><TH>الأبعاد الأصلية</TH><TH>ألواح أصلية</TH><TH>الأصلي (م²)</TH><TH>مرتجع سابقاً</TH><TH>المتبقي (م²)</TH><TH>سعر المتر</TH><TH>الكمية المرتجعة (م²)</TH><TH>عدد الألواح</TH></TR>
                </THead>
                <TBody>
                  {ret.lines.map((l) => (
                    <TR key={l.originalLineId}>
                      <TD>{l.productCode ?? "—"}</TD>
                      <TD>{l.colorName ?? "—"}</TD>
                      <TD>{l.historicalBoardSize ? D(l.historicalBoardSize).toFixed(2) : "—"}</TD>
                      <TD>{l.lengthM ? `${D(l.lengthM).toFixed(2)}${l.widthM ? " × " + D(l.widthM).toFixed(2) : ""}` : "—"}</TD>
                      <TD>{D(l.originalBoards).toFixed(2)}</TD>
                      <TD>{l.legacyAmbiguous ? "—" : D(l.originalMeters).toFixed(2)}</TD>
                      <TD>{D(l.returnedMeters).toFixed(2)}</TD>
                      <TD>{l.legacyAmbiguous ? "—" : D(l.remainingMeters).toFixed(2)}</TD>
                      <TD>{formatCurrency(l.originalUnitPrice, locale)}</TD>
                      <TD colSpan={l.legacyAmbiguous ? 2 : 1} style={{ maxWidth: 160 }}>
                        {l.legacyAmbiguous
                          ? <span className="text-xs text-amber-600">كمية أمتار غير قابلة للتحديد لهذا السطر (فاتورة قديمة) — لا يمكن إرجاعه</span>
                          : <Input inputMode="decimal" value={qty[l.originalLineId]?.meters ?? ""} placeholder="0"
                              onChange={(e) => setQty((s) => ({ ...s, [l.originalLineId]: { meters: e.target.value, boards: s[l.originalLineId]?.boards ?? "" } }))} />}
                      </TD>
                      {!l.legacyAmbiguous && (
                        <TD style={{ maxWidth: 100 }}>
                          <Input inputMode="decimal" value={qty[l.originalLineId]?.boards ?? ""} placeholder="تلقائي"
                            onChange={(e) => setQty((s) => ({ ...s, [l.originalLineId]: { meters: s[l.originalLineId]?.meters ?? "", boards: e.target.value } }))} />
                        </TD>
                      )}
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
              <div><div className="text-xs text-muted">الضريبة</div><div className="font-semibold">{formatCurrency(preview.tax.toFixed(2), locale)}</div></div>
              <div><div className="text-xs text-muted">الإجمالي / رصيد العميل</div><div className="font-semibold">{formatCurrency(preview.grand.toFixed(2), locale)}</div></div>
              <div><div className="text-xs text-muted">عكس التكلفة (COGS)</div><div className="font-semibold">{formatCurrency(preview.cogs.toFixed(2), locale)}</div></div>
              <label className="col-span-2 text-sm">التسوية
                {/* Cash/bank refunds are not supported yet (no customer-refund voucher) — only credit modes. */}
                <select className="mt-1 w-full rounded-md border px-2 py-1" value={settlementMode} onChange={(e) => setSettlementMode(e.target.value)}>
                  <option value="KEEP_AS_CUSTOMER_CREDIT">رصيد دائن للعميل</option>
                  <option value="OFFSET_OUTSTANDING_BALANCE">تسوية رصيد مستحق</option>
                </select>
              </label>
              <label className="text-sm">تاريخ المردود
                <Input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
              </label>
              <label className="text-sm">السبب
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="اختياري" />
              </label>
            </CardBody>
          </Card>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => router.push(`/${locale}/sales/returns`)}>إلغاء</Button>
            <Button disabled={busy} onClick={() => void save()}>{busy ? "جارٍ الحفظ…" : "حفظ كمسودة"}</Button>
          </div>
        </>
      )}
    </div>
  );
}
