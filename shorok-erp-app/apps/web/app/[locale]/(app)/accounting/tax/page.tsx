"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { formatDate, formatCurrency } from "../../../../../lib/format";
import {
  listTaxAccounts,
  getTaxLedger,
  listAccounts,
  type TaxAccount,
  type TaxEntry,
  type TaxLedgerResult,
  type AccountRow,
} from "../../../../../lib/tax-client";

function fmt(v: string | number) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(n)) return "—";
  return n.toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function thisMonthRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const last = new Date(y, now.getMonth() + 1, 0).getDate();
  return {
    from: `${y}-${m}-01`,
    to:   `${y}-${m}-${last}`,
  };
}

// ─── Summary cards ────────────────────────────────────────────────────────────

function SummaryCards({ result }: { result: TaxLedgerResult }) {
  const inputVAT  = parseFloat(result.periodTotals.debit)  || 0;  // ضريبة مدخلات
  const outputVAT = parseFloat(result.periodTotals.credit) || 0;  // ضريبة مخرجات
  const net       = parseFloat(result.closing.net);                // output - input

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {/* ضريبة المدخلات */}
      <div className="rounded-lg border border-border bg-blue-50 p-4 space-y-1">
        <div className="text-xs text-blue-600 font-medium">ضريبة المدخلات (مدين)</div>
        <div className="text-xs text-blue-500">ضريبة المشتريات — يُستردّ من الحكومة</div>
        <div className="text-2xl font-bold text-blue-700">{fmt(inputVAT)}</div>
      </div>

      {/* ضريبة المخرجات */}
      <div className="rounded-lg border border-border bg-orange-50 p-4 space-y-1">
        <div className="text-xs text-orange-600 font-medium">ضريبة المخرجات (دائن)</div>
        <div className="text-xs text-orange-500">ضريبة المبيعات — مستحق للحكومة</div>
        <div className="text-2xl font-bold text-orange-700">{fmt(outputVAT)}</div>
      </div>

      {/* صافي الموقف */}
      <div className={
        "rounded-lg border p-4 space-y-1 " + (
          result.closing.status === "liability"   ? "border-red-200 bg-red-50" :
          result.closing.status === "receivable"  ? "border-green-200 bg-green-50" :
                                                    "border-border bg-surface"
        )
      }>
        <div className={
          "text-xs font-medium " + (
            result.closing.status === "liability"  ? "text-red-600" :
            result.closing.status === "receivable" ? "text-green-600" :
                                                     "text-textSecondary"
          )
        }>
          {result.closing.status === "liability"  ? "مبلغ مستحق للحكومة" :
           result.closing.status === "receivable" ? "مبلغ مستردّ من الحكومة" :
                                                    "الرصيد صفر"}
        </div>
        <div className="text-xs text-textSecondary">
          {result.closing.status === "liability"  ? "ضريبة مخرجات > ضريبة مدخلات" :
           result.closing.status === "receivable" ? "ضريبة مدخلات > ضريبة مخرجات" :
                                                    "متوازن"}
        </div>
        <div className={
          "text-2xl font-bold " + (
            result.closing.status === "liability"  ? "text-red-700" :
            result.closing.status === "receivable" ? "text-green-700" :
                                                     "text-foreground"
          )
        }>
          {fmt(Math.abs(net))}
        </div>
      </div>
    </div>
  );
}

// ─── Split tables ─────────────────────────────────────────────────────────────

function SplitPanel({
  title,
  color,
  entries,
  type,
}: {
  title: string;
  color: "blue" | "orange";
  entries: TaxEntry[];
  type: "debit" | "credit";
}) {
  const filtered = entries.filter((e) =>
    type === "debit" ? !!e.debit : !!e.credit,
  );
  const total = filtered.reduce(
    (s, e) => s + parseFloat(type === "debit" ? e.debit || "0" : e.credit || "0"),
    0,
  );

  const border  = color === "blue"   ? "border-blue-200"   : "border-orange-200";
  const bg      = color === "blue"   ? "bg-blue-50"        : "bg-orange-50";
  const text    = color === "blue"   ? "text-blue-700"     : "text-orange-700";
  const subtext = color === "blue"   ? "text-blue-500"     : "text-orange-500";

  return (
    <div className={`rounded-lg border ${border} overflow-hidden`}>
      <div className={`${bg} px-4 py-2 flex items-center justify-between`}>
        <span className={`font-semibold text-sm ${text}`}>{title}</span>
        <span className={`text-lg font-bold ${text}`}>{fmt(total)}</span>
      </div>
      {filtered.length === 0 ? (
        <p className={`text-sm ${subtext} p-4 text-center`}>لا توجد حركات في هذه الفترة</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className={`${bg} text-textSecondary`}>
                <th className="px-3 py-1.5 text-start">التاريخ</th>
                <th className="px-3 py-1.5 text-start">المرجع</th>
                <th className="px-3 py-1.5 text-start">البيان</th>
                <th className="px-3 py-1.5 text-end">المبلغ</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.id} className="border-t border-border hover:bg-surface/50">
                  <td className="px-3 py-1.5 whitespace-nowrap">{e.date}</td>
                  <td className="px-3 py-1.5">
                    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
                      e.referenceType === "sales_invoice"    ? "bg-green-100 text-green-700" :
                      e.referenceType === "purchase_invoice" ? "bg-blue-100 text-blue-700" :
                                                               "bg-gray-100 text-gray-600"
                    }`}>
                      {e.referenceLabel}
                    </span>
                    {e.reference && (
                      <span className="ms-1 font-mono text-xs">{e.reference}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-textSecondary max-w-xs truncate">
                    {e.note || e.description}
                  </td>
                  <td className={`px-3 py-1.5 text-end font-semibold ${text}`} dir="ltr">
                    {fmt(type === "debit" ? e.debit : e.credit)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className={`${bg} font-bold`}>
                <td colSpan={3} className={`px-3 py-1.5 ${text}`}>الإجمالي</td>
                <td className={`px-3 py-1.5 text-end ${text}`} dir="ltr">{fmt(total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Full ledger ──────────────────────────────────────────────────────────────

function FullLedger({ result }: { result: TaxLedgerResult }) {
  const locale = useLocale() as AppLocale;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>كشف الحساب الضريبي الكامل</CardTitle>
        <Button variant="ghost" size="sm" onClick={() => window.print()} className="no-print">
          طباعة
        </Button>
      </CardHeader>
      <CardBody className="overflow-x-auto p-0">
        <Table>
          <THead>
            <TR>
              <TH>التاريخ</TH>
              <TH>رقم القيد</TH>
              <TH>المرجع</TH>
              <TH>البيان / الملاحظة</TH>
              <TH>الحساب</TH>
              <TH>مدين (ضريبة مدخلات)</TH>
              <TH>دائن (ضريبة مخرجات)</TH>
              <TH>الرصيد</TH>
            </TR>
          </THead>
          <TBody>
            {/* Opening row */}
            {(parseFloat(result.opening.debit) > 0 || parseFloat(result.opening.credit) > 0) && (
              <TR>
                <TD colSpan={5}>
                  <span className="text-xs font-medium text-textSecondary">
                    رصيد أول المدة
                  </span>
                </TD>
                <TD className="text-blue-700 font-semibold" dir="ltr">
                  {parseFloat(result.opening.debit) > 0 ? fmt(result.opening.debit) : ""}
                </TD>
                <TD className="text-orange-700 font-semibold" dir="ltr">
                  {parseFloat(result.opening.credit) > 0 ? fmt(result.opening.credit) : ""}
                </TD>
                <TD dir="ltr">
                  <BalanceChip value={result.opening.net} />
                </TD>
              </TR>
            )}

            {result.entries.length === 0 && (
              <TR>
                <TD colSpan={8}>
                  <p className="text-center text-textSecondary py-6">لا توجد حركات في هذه الفترة</p>
                </TD>
              </TR>
            )}

            {result.entries.map((e) => (
              <TR key={e.id}>
                <TD className="whitespace-nowrap text-xs">{e.date}</TD>
                <TD className="font-mono text-xs" dir="ltr">#{e.entryNumber}</TD>
                <TD>
                  <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
                    e.referenceType === "sales_invoice"    ? "bg-green-100 text-green-700" :
                    e.referenceType === "purchase_invoice" ? "bg-blue-100 text-blue-700" :
                                                             "bg-gray-100 text-gray-600"
                  }`}>
                    {e.referenceLabel}
                  </span>
                  {e.reference && (
                    <span className="ms-1 font-mono text-xs">{e.reference}</span>
                  )}
                </TD>
                <TD className="text-xs text-textSecondary max-w-xs">
                  <div className="truncate">{e.note || e.description}</div>
                </TD>
                <TD className="text-xs">{e.accountNameAr}</TD>
                <TD className="text-blue-700 font-medium" dir="ltr">
                  {e.debit ? fmt(e.debit) : ""}
                </TD>
                <TD className="text-orange-700 font-medium" dir="ltr">
                  {e.credit ? fmt(e.credit) : ""}
                </TD>
                <TD dir="ltr">
                  <BalanceChip value={e.runningBalance} />
                </TD>
              </TR>
            ))}

            {/* Period totals */}
            {result.entries.length > 0 && (
              <TR>
                <TD colSpan={5}>
                  <span className="text-xs font-bold">إجمالي الفترة</span>
                </TD>
                <TD className="font-bold text-blue-700" dir="ltr">
                  {parseFloat(result.periodTotals.debit) > 0 ? fmt(result.periodTotals.debit) : ""}
                </TD>
                <TD className="font-bold text-orange-700" dir="ltr">
                  {parseFloat(result.periodTotals.credit) > 0 ? fmt(result.periodTotals.credit) : ""}
                </TD>
                <TD />
              </TR>
            )}

            {/* Closing balance */}
            <TR>
              <TD colSpan={5}>
                <span className="text-xs font-bold">رصيد آخر المدة</span>
              </TD>
              <TD className="font-bold text-blue-700" dir="ltr">
                {parseFloat(result.closing.debit) > 0 ? fmt(result.closing.debit) : ""}
              </TD>
              <TD className="font-bold text-orange-700" dir="ltr">
                {parseFloat(result.closing.credit) > 0 ? fmt(result.closing.credit) : ""}
              </TD>
              <TD dir="ltr">
                <BalanceChip value={
                  // closing.net is credit - debit (positive = liability); negate for display convention
                  String(-parseFloat(result.closing.net))
                } />
              </TD>
            </TR>
          </TBody>
        </Table>
      </CardBody>
    </Card>
  );
}

function BalanceChip({ value }: { value: string }) {
  const n = parseFloat(value);
  if (isNaN(n) || n === 0) return <span className="text-xs text-textSecondary">صفر</span>;
  const isDebit = n > 0;
  return (
    <span className={`text-xs font-semibold ${isDebit ? "text-blue-700" : "text-orange-700"}`}>
      {fmt(Math.abs(n))} {isDebit ? "م" : "د"}
    </span>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function TaxLedgerPage() {
  const range = thisMonthRange();
  const [taxAccounts, setTaxAccounts] = useState<TaxAccount[]>([]);
  const [allAccounts, setAllAccounts] = useState<AccountRow[]>([]);
  const [accountId, setAccountId] = useState<string>("");
  const [from, setFrom] = useState(range.from);
  const [to,   setTo]   = useState(range.to);

  const [result, setResult]   = useState<TaxLedgerResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([listTaxAccounts(), listAccounts()]).then(([tax, all]) => {
      setTaxAccounts(tax);
      setAllAccounts(all.filter((a) => a.isLeaf && a.active));
      if (tax.length > 0 && !accountId) setAccountId(tax[0]!.id);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await getTaxLedger({
        accountId: accountId || undefined,
        from: from || undefined,
        to:   to   || undefined,
      });
      setResult(data);
    } catch {
      setError("فشل تحميل بيانات الضريبة. تأكد من وجود حسابات ضريبية في شجرة الحسابات.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-5" dir="rtl">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { font-family: 'Cairo', Arial, sans-serif; }
        }
      `}</style>

      <div className="flex items-center justify-between no-print">
        <h1 className="text-xl font-bold">حساب الضريبة على القيمة المضافة</h1>
      </div>

      {/* Filters */}
      <Card className="no-print">
        <CardBody>
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <label className="block text-xs text-textSecondary mb-1">الحساب الضريبي</label>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="border border-border rounded px-2 py-1.5 text-sm bg-background min-w-[260px]"
              >
                <option value="">— جميع حسابات الضريبة —</option>
                {taxAccounts.length > 0 && (
                  <optgroup label="حسابات الضريبة المقترحة">
                    {taxAccounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="جميع الحسابات">
                  {allAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
                  ))}
                </optgroup>
              </select>
            </div>
            <div>
              <label className="block text-xs text-textSecondary mb-1">من تاريخ</label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="border border-border rounded px-2 py-1.5 text-sm bg-background"
              />
            </div>
            <div>
              <label className="block text-xs text-textSecondary mb-1">إلى تاريخ</label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="border border-border rounded px-2 py-1.5 text-sm bg-background"
              />
            </div>
            <Button onClick={() => void load()} disabled={loading}>
              {loading ? "جاري التحميل..." : "عرض"}
            </Button>
            {/* Quick ranges */}
            <div className="flex gap-2 text-xs">
              {[
                { label: "هذا الشهر",   ...thisMonthRange() },
                { label: "هذا الربع",   from: quarterStart(), to: range.to },
                { label: "هذا العام",   from: `${new Date().getFullYear()}-01-01`, to: range.to },
              ].map((r) => (
                <button
                  key={r.label}
                  type="button"
                  onClick={() => { setFrom(r.from); setTo(r.to); }}
                  className="px-2 py-1 rounded border border-border hover:bg-surface text-textSecondary"
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </CardBody>
      </Card>

      {error && <Alert variant="error">{error}</Alert>}

      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}

      {!loading && result && (
        <>
          {/* Summary cards */}
          <SummaryCards result={result} />

          {/* Account info */}
          {result.accounts.length > 0 && (
            <div className="flex flex-wrap gap-2 text-xs text-textSecondary">
              <span>الحسابات:</span>
              {result.accounts.map((a) => (
                <span key={a.id} className="rounded-full bg-surface px-2 py-0.5 border border-border">
                  {a.code} — {a.nameAr}
                </span>
              ))}
              {result.from && result.to && (
                <span className="rounded-full bg-surface px-2 py-0.5 border border-border">
                  {result.from} → {result.to}
                </span>
              )}
            </div>
          )}

          {/* Split panels */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <SplitPanel
              title="ضريبة المدخلات (مدين) — ضريبة المشتريات"
              color="blue"
              entries={result.entries}
              type="debit"
            />
            <SplitPanel
              title="ضريبة المخرجات (دائن) — ضريبة المبيعات"
              color="orange"
              entries={result.entries}
              type="credit"
            />
          </div>

          {/* Equation card */}
          <EquationCard result={result} />

          {/* Full ledger */}
          <FullLedger result={result} />
        </>
      )}

      {!loading && !result && !error && (
        <div className="text-center text-textSecondary py-12">
          اختر الفترة الزمنية واضغط عرض
        </div>
      )}
    </div>
  );
}

function EquationCard({ result }: { result: TaxLedgerResult }) {
  const input  = parseFloat(result.periodTotals.debit)  || 0;
  const output = parseFloat(result.periodTotals.credit) || 0;
  const net    = output - input;

  return (
    <Card className="no-print">
      <CardHeader><CardTitle>معادلة الضريبة للفترة</CardTitle></CardHeader>
      <CardBody>
        <div className="flex flex-wrap items-center gap-3 text-sm font-medium" dir="ltr">
          <span className="text-orange-700">
            ضريبة مخرجات: <strong>{fmt(output)}</strong>
          </span>
          <span className="text-textSecondary">−</span>
          <span className="text-blue-700">
            ضريبة مدخلات: <strong>{fmt(input)}</strong>
          </span>
          <span className="text-textSecondary">=</span>
          <span className={`text-lg font-bold ${net >= 0 ? "text-red-600" : "text-green-600"}`}>
            {fmt(Math.abs(net))}
            <span className="text-xs font-normal ms-1">
              {net > 0 ? "(مستحق للحكومة)" : net < 0 ? "(مستردّ من الحكومة)" : "(صفر)"}
            </span>
          </span>
        </div>
      </CardBody>
    </Card>
  );
}

function quarterStart(): string {
  const now = new Date();
  const q   = Math.floor(now.getMonth() / 3);
  const y   = now.getFullYear();
  return `${y}-${String(q * 3 + 1).padStart(2, "0")}-01`;
}
