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
import { Input } from "../../../../../../components/ui/input";
import { Label } from "../../../../../../components/ui/label";
import { Modal } from "../../../../../../components/ui/modal";
import { Skeleton } from "../../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../../components/ui/table";
import { useHasRole } from "../../../../../../lib/auth";
import { ApiClientError } from "../../../../../../lib/api-client";
import { getTreasuryStatement, postOpeningBalance, type TreasuryStatement } from "../../../../../../lib/treasuries-client";

function money(v: string | number) {
  return Number(v).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const DOC_AR: Record<string, string> = {
  TREASURY_OPENING: "رصيد افتتاحي", TREASURY_TRANSFER: "تحويل خزائن", RECEIPT_VOUCHER: "سند قبض",
  PAYMENT_VOUCHER: "سند صرف", EXPENSE: "مصروف", SALES_INVOICE: "فاتورة مبيعات", PURCHASE_INVOICE: "فاتورة مشتريات", MANUAL: "قيد يدوي",
};

export default function TreasuryDetailPage() {
  const locale = useLocale() as AppLocale;
  const params = useParams();
  const id = String(params.id);
  const canManage = useHasRole("OWNER");
  const [data, setData] = useState<TreasuryStatement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [openBal, setOpenBal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getTreasuryStatement(id, { from: from || undefined, to: to || undefined }));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : "تعذّر تحميل كشف الحركة.");
    } finally {
      setLoading(false);
    }
  }, [id, from, to, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) return <Skeleton className="h-64 w-full" />;
  if (error && !data) return <Alert variant="error">{error}</Alert>;
  if (!data) return null;
  const t = data.treasury;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{t.nameAr}</h1>
            <Badge variant="neutral">{t.code}</Badge>
            {t.isDefault && <Badge variant="success">افتراضية</Badge>}
            {!t.active && <Badge variant="neutral">موقوفة</Badge>}
          </div>
          <p className="text-sm text-textSecondary">
            الفرع: {t.branchNameAr} — حساب الأستاذ: <span className="font-mono">{t.glAccountCode}</span> {t.glAccountNameAr}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/${locale}/accounting/treasuries`}><Button variant="ghost">رجوع</Button></Link>
          {canManage && <Button onClick={() => setOpenBal(true)} data-testid="opening-balance-btn">تسجيل رصيد افتتاحي</Button>}
        </div>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <div className="grid grid-cols-3 gap-3">
        <Card><CardBody><p className="text-sm text-textSecondary">الرصيد الافتتاحي (قبل الفترة)</p><p className="text-lg font-semibold tabular-nums">{money(data.openingBalance)}</p></CardBody></Card>
        <Card><CardBody><p className="text-sm text-textSecondary">الرصيد الحالي</p><p className="text-lg font-semibold tabular-nums" data-testid="treasury-balance">{money(data.closingBalance)}</p></CardBody></Card>
        <Card><CardBody><p className="text-sm text-textSecondary">عدد الحركات</p><p className="text-lg font-semibold tabular-nums">{data.items.length}</p></CardBody></Card>
      </div>

      <Card>
        <CardHeader className="flex flex-wrap items-end justify-between gap-3">
          <CardTitle>كشف حركة الخزنة</CardTitle>
          <div className="flex items-end gap-2">
            <div className="space-y-1"><Label>من</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="space-y-1"><Label>إلى</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            <Button variant="secondary" onClick={() => void load()}>تصفية</Button>
          </div>
        </CardHeader>
        <CardBody>
          {data.items.length === 0 ? (
            <p className="py-8 text-center text-textSecondary">لا توجد حركات في هذه الفترة.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>التاريخ</TH><TH>رقم القيد</TH><TH>نوع الحركة</TH><TH>البيان</TH>
                    <TH>مدين</TH><TH>دائن</TH><TH>الرصيد الجاري</TH><TH>المستخدم</TH><TH>المستند</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.items.map((r) => (
                    <TR key={r.journalLineId}>
                      <TD>{r.entryDate}</TD>
                      <TD className="font-mono text-xs">#{r.entryNumber}</TD>
                      <TD>{DOC_AR[r.documentType] ?? r.documentType}</TD>
                      <TD className="max-w-[240px] truncate" title={r.description}>{r.description}</TD>
                      <TD className="tabular-nums">{Number(r.debit) ? money(r.debit) : "—"}</TD>
                      <TD className="tabular-nums">{Number(r.credit) ? money(r.credit) : "—"}</TD>
                      <TD className="tabular-nums font-medium">{money(r.runningBalance)}</TD>
                      <TD className="text-xs">{r.userName}</TD>
                      <TD>
                        <Link href={`/${locale}/accounting/journal?entry=${r.entryNumber}`} className="text-primary hover:underline text-xs">القيد</Link>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </CardBody>
      </Card>

      {openBal && (
        <OpeningBalanceModal
          treasuryId={id}
          onClose={() => setOpenBal(false)}
          onPosted={async () => { setOpenBal(false); await load(); }}
        />
      )}
    </div>
  );
}

function OpeningBalanceModal({ treasuryId, onClose, onPosted }: { treasuryId: string; onClose: () => void; onPosted: () => void }) {
  const locale = useLocale() as AppLocale;
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!amount || Number(amount) <= 0) return setError("أدخل مبلغاً أكبر من صفر.");
    setSaving(true);
    try {
      await postOpeningBalance(treasuryId, { entryDate, amount: Number(amount).toFixed(2), notes: notes.trim() || undefined });
      onPosted();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : "تعذّر تسجيل الرصيد الافتتاحي.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="تسجيل رصيد افتتاحي">
      <div className="space-y-3">
        {error && <Alert variant="error">{error}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1"><Label>التاريخ *</Label><Input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} /></div>
          <div className="space-y-1"><Label>المبلغ *</Label><Input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="opening-amount" /></div>
        </div>
        <div className="space-y-1"><Label>ملاحظات</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <p className="text-xs text-textSecondary">يُنشأ قيد متوازن: مدين حساب الخزنة / دائن حساب الأرصدة الافتتاحية (رأس المال).</p>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>إلغاء</Button>
          <Button onClick={() => void submit()} disabled={saving} data-testid="opening-save">{saving ? "جارٍ الترحيل…" : "ترحيل"}</Button>
        </div>
      </div>
    </Modal>
  );
}
