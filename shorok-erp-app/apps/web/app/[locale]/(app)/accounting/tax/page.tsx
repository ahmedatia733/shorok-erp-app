"use client";

import { useEffect, useState } from "react";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import {
  listTaxAccounts,
  getTaxLedger,
  listAccounts,
  type TaxAccount,
  type TaxEntry,
  type TaxLedgerResult,
  type AccountRow,
} from "../../../../../lib/tax-client";
import { splitByDirection, taxSummary } from "../../../../../lib/tax-summary";

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
  // Netted by transaction origin: a cancelled purchase's input VAT reverses to
  // zero here instead of leaking into output VAT (raw debit/credit would).
  const summary   = taxSummary(result);
  const inputVAT  = summary.inputVat;   // ضريبة مدخلات (صافي)
  const outputVAT = summary.outputVat;  // ضريبة مخرجات (صافي)
  const net       = summary.net;        // output - input

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
  direction,
}: {
  title: string;
  color: "blue" | "orange";
  entries: TaxEntry[];
  direction: "input" | "output";
}) {
  // Classify by VAT direction (origin), not raw debit/credit — a cancellation
  // reversal lands on the SAME side as its original with a negative amount, so
  // it nets the total down instead of appearing on the opposite side.
  const rows  = splitByDirection(entries, direction);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const filtered = rows.map((r) => r.entry);

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
              {filtered.map((e) => {
                const amt = parseFloat(e.vatAmount || "0");
                const isNeg = amt < 0;
                return (
                <tr key={e.id} className={`border-t border-border hover:bg-surface/50 ${e.reversed ? "opacity-60" : ""}`}>
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
                    {e.isReversal && (
                      <span className="ms-1 inline-block rounded px-1.5 py-0.5 text-xs font-medium bg-red-100 text-red-700">إلغاء / عكس</span>
                    )}
                    {e.reversed && !e.isReversal && (
                      <span className="ms-1 inline-block rounded px-1.5 py-0.5 text-xs font-medium bg-red-50 text-red-600 line-through">ملغاة</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-textSecondary max-w-xs truncate">
                    {e.note || e.description}
                  </td>
                  <td className={`px-3 py-1.5 text-end font-semibold ${isNeg ? "text-red-600" : text}`} dir="ltr">
                    {isNeg ? `(${fmt(Math.abs(amt))})` : fmt(amt)}
                  </td>
                </tr>
                );
              })}
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

// ─── Invoice detail card ──────────────────────────────────────────────────────

function InvoiceDetailCard({ detail }: { detail: NonNullable<TaxEntry["invoiceDetail"]> }) {
  const isSales = detail.type === "sales";
  const accent  = isSales ? "green" : "blue";

  return (
    <div className={`mx-4 mb-3 rounded-lg border ${isSales ? "border-green-200 bg-green-50" : "border-blue-200 bg-blue-50"} overflow-hidden text-xs`}>
      {/* Header */}
      <div className={`flex items-center justify-between px-4 py-2 ${isSales ? "bg-green-100" : "bg-blue-100"}`}>
        <span className={`font-bold text-sm ${isSales ? "text-green-800" : "text-blue-800"}`}>
          {isSales ? "فاتورة مبيعات" : "فاتورة مشتريات"} #{detail.invoiceNumber}
        </span>
        <span className="text-textSecondary">{detail.invoiceDate}</span>
      </div>

      {/* Entity + branch */}
      <div className="grid grid-cols-2 gap-px bg-border">
        <div className="bg-white px-4 py-2.5 space-y-0.5">
          <div className="text-textSecondary">{detail.entityLabel}</div>
          <div className={`font-semibold ${isSales ? "text-green-800" : "text-blue-800"}`}>
            {detail.entityNameAr ?? "—"}
            {detail.entityCode && (
              <span className="ms-1.5 text-xs font-normal text-textSecondary">({detail.entityCode})</span>
            )}
          </div>
        </div>
        <div className="bg-white px-4 py-2.5 space-y-0.5">
          <div className="text-textSecondary">الفرع</div>
          <div className="font-semibold text-foreground">{detail.branchNameAr ?? "—"}</div>
        </div>
      </div>

      {/* Amounts row */}
      <div className={`grid gap-px bg-border ${detail.totalCost ? "grid-cols-5" : "grid-cols-4"}`}>
        <div className="bg-white px-4 py-2.5 space-y-0.5">
          <div className="text-textSecondary">المجموع (قبل ض)</div>
          <div className="font-semibold text-foreground" dir="ltr">{fmt(detail.subtotal)}</div>
        </div>
        {detail.taxRate && (
          <div className="bg-white px-4 py-2.5 space-y-0.5">
            <div className="text-textSecondary">نسبة الضريبة</div>
            <div className="font-semibold text-foreground">{parseFloat(detail.taxRate).toFixed(0)}%</div>
          </div>
        )}
        {!detail.taxRate && <div className="bg-white px-4 py-2.5" />}
        <div className={`bg-white px-4 py-2.5 space-y-0.5 ${isSales ? "border-s-2 border-orange-200" : "border-s-2 border-blue-200"}`}>
          <div className={`${isSales ? "text-orange-600" : "text-blue-600"}`}>الضريبة (VAT)</div>
          <div className={`font-bold ${isSales ? "text-orange-700" : "text-blue-700"}`} dir="ltr">
            {fmt(detail.taxAmount)}
          </div>
        </div>
        <div className="bg-white px-4 py-2.5 space-y-0.5">
          <div className="text-textSecondary">الإجمالي النهائي</div>
          <div className="font-bold text-foreground" dir="ltr">{fmt(detail.grandTotal)}</div>
        </div>
        {detail.totalCost && (
          <div className="bg-white px-4 py-2.5 space-y-0.5">
            <div className="text-textSecondary">التكلفة</div>
            <div className="font-semibold text-red-600" dir="ltr">{fmt(detail.totalCost)}</div>
          </div>
        )}
      </div>

      {/* Notes */}
      {detail.notes && (
        <div className="bg-white px-4 py-2 text-textSecondary border-t border-border">
          <span className="font-medium text-foreground">ملاحظات: </span>{detail.notes}
        </div>
      )}
    </div>
  );
}

// ─── Full ledger ──────────────────────────────────────────────────────────────

function FullLedger({ result }: { result: TaxLedgerResult }) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // Auto-expand all invoice rows on first render
  useEffect(() => {
    const ids = result.entries
      .filter(e => e.invoiceDetail)
      .map(e => e.id);
    setExpandedIds(new Set(ids));
  }, [result]);

  const COLS = 9; // total columns including expand toggle

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>كشف الحساب الضريبي الكامل</CardTitle>
        <div className="flex items-center gap-2 no-print">
          <button
            type="button"
            onClick={() => {
              const all = result.entries.filter(e => e.invoiceDetail).map(e => e.id);
              setExpandedIds(prev => prev.size === all.length ? new Set() : new Set(all));
            }}
            className="text-xs text-textSecondary hover:text-foreground underline"
          >
            {expandedIds.size > 0 ? "طي الكل" : "فتح الكل"}
          </button>
          <Button variant="ghost" size="sm" onClick={() => window.print()} className="no-print">
            طباعة
          </Button>
        </div>
      </CardHeader>
      <CardBody className="overflow-x-auto p-0">
        <Table>
          <THead>
            <TR>
              <TH className="w-8"></TH>
              <TH>التاريخ</TH>
              <TH>رقم القيد</TH>
              <TH>نوع المستند</TH>
              <TH>العميل / المورد</TH>
              <TH>الفرع</TH>
              <TH>مدين (ضريبة مدخلات)</TH>
              <TH>دائن (ضريبة مخرجات)</TH>
              <TH>الرصيد</TH>
            </TR>
          </THead>
          <TBody>
            {/* Opening row */}
            {(parseFloat(result.opening.debit) > 0 || parseFloat(result.opening.credit) > 0) && (
              <TR>
                <TD />
                <TD colSpan={5}>
                  <span className="text-xs font-medium text-textSecondary">رصيد أول المدة</span>
                </TD>
                <TD className="text-blue-700 font-semibold" dir="ltr">
                  {parseFloat(result.opening.debit) > 0 ? fmt(result.opening.debit) : ""}
                </TD>
                <TD className="text-orange-700 font-semibold" dir="ltr">
                  {parseFloat(result.opening.credit) > 0 ? fmt(result.opening.credit) : ""}
                </TD>
                <TD dir="ltr"><BalanceChip value={result.opening.net} /></TD>
              </TR>
            )}

            {result.entries.length === 0 && (
              <TR>
                <TD colSpan={COLS}>
                  <p className="text-center text-textSecondary py-6">لا توجد حركات في هذه الفترة</p>
                </TD>
              </TR>
            )}

            {result.entries.map((e) => {
              const isExpanded = expandedIds.has(e.id);
              const hasDetail  = !!e.invoiceDetail;
              const inv        = e.invoiceDetail;

              return (
                <tbody key={e.id}>
                  {/* Main row */}
                  <TR
                    className={`${hasDetail ? "cursor-pointer hover:bg-surface/60" : ""} ${e.reversed ? "opacity-60" : ""}`}
                    onClick={hasDetail ? () => toggle(e.id) : undefined}
                  >
                    {/* Expand toggle */}
                    <TD className="w-8 text-center">
                      {hasDetail && (
                        <span className={`inline-block text-xs transition-transform duration-150 ${isExpanded ? "rotate-90" : ""} text-textSecondary`}>
                          ▶
                        </span>
                      )}
                    </TD>
                    <TD className="whitespace-nowrap text-xs">{e.date}</TD>
                    <TD className="font-mono text-xs" dir="ltr">#{e.entryNumber}</TD>
                    <TD>
                      <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
                        e.referenceType === "sales_invoice"    ? "bg-green-100 text-green-700" :
                        e.referenceType === "purchase_invoice" ? "bg-blue-100 text-blue-700" :
                                                                 "bg-gray-100 text-gray-600"
                      }`}>
                        {e.referenceLabel}
                        {e.reference && <span className="ms-1 font-mono">{e.reference}</span>}
                      </span>
                      {e.isReversal && (
                        <span className="ms-1 inline-block rounded px-1.5 py-0.5 text-xs font-medium bg-red-100 text-red-700">إلغاء / عكس</span>
                      )}
                      {e.reversed && !e.isReversal && (
                        <span className="ms-1 inline-block rounded px-1.5 py-0.5 text-xs font-medium bg-red-50 text-red-600 line-through">ملغاة</span>
                      )}
                    </TD>
                    {/* Customer/Supplier name from invoiceDetail */}
                    <TD className="text-xs font-medium">
                      {inv?.entityNameAr ?? <span className="text-textSecondary">{e.note || e.description}</span>}
                    </TD>
                    <TD className="text-xs text-textSecondary">{inv?.branchNameAr ?? ""}</TD>
                    <TD className="text-blue-700 font-medium" dir="ltr">
                      {e.debit ? fmt(e.debit) : ""}
                    </TD>
                    <TD className="text-orange-700 font-medium" dir="ltr">
                      {e.credit ? fmt(e.credit) : ""}
                    </TD>
                    <TD dir="ltr"><BalanceChip value={e.runningBalance} /></TD>
                  </TR>

                  {/* Expanded invoice detail */}
                  {hasDetail && isExpanded && inv && (
                    <tr>
                      <td colSpan={COLS} className="p-0 bg-white">
                        <InvoiceDetailCard detail={inv} />
                      </td>
                    </tr>
                  )}
                </tbody>
              );
            })}

            {/* Period totals */}
            {result.entries.length > 0 && (
              <TR>
                <TD />
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
              <TD />
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
                <BalanceChip value={String(-parseFloat(result.closing.net))} />
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
    // Read URL param client-side (avoids SSR/hydration mismatch)
    const urlAccountId = new URLSearchParams(window.location.search).get("accountId") ?? "";

    void Promise.all([listTaxAccounts(), listAccounts()]).then(([tax, all]) => {
      setTaxAccounts(tax);
      const leafActive = all.filter((a) => a.isLeaf && a.active);
      setAllAccounts(leafActive);

      // Priority: URL param → account matching "موردون/دائنون" → first tax account
      const chosen =
        urlAccountId ||
        tax.find((a) => /موردون|دائنون/i.test(a.nameAr))?.id ||
        leafActive.find((a) => /موردون|دائنون/i.test(a.nameAr))?.id ||
        tax[0]?.id ||
        "";

      if (chosen) {
        setAccountId(chosen);
        void loadWithId(chosen);
      } else {
        void loadWithId("");
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadWithId(id: string) {
    setLoading(true);
    setError(null);
    try {
      const data = await getTaxLedger({
        accountId: id || undefined,
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

  async function load() {
    await loadWithId(accountId);
  }

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
              direction="input"
            />
            <SplitPanel
              title="ضريبة المخرجات (دائن) — ضريبة المبيعات"
              color="orange"
              entries={result.entries}
              direction="output"
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
  const { inputVat: input, outputVat: output } = taxSummary(result);
  const net = output - input;

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
