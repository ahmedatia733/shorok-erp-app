"use client";

import { Fragment, useState, useEffect } from "react";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Input } from "../../../../../components/ui/input";
import { useHasRole } from "../../../../../lib/auth";
import {
  getIncomeStatement,
  type IncomeStatementData,
  type ISAccountLine,
} from "../../../../../lib/journal-client";
import { formatCurrency } from "../../../../../lib/format";
import { CREDIT_HINT_AR, CREDIT_LABEL_AR, deductionDisplay } from "../../../../../lib/pnl-format";
import {
  groupExpenses,
  splitRevenue,
  type ExpenseGroup,
  type PnlAmountLine,
  type RevenueSplit,
} from "../../../../../lib/pnl-sections";

// ── Date helpers ──────────────────────────────────────────────────────────────

function toISO(d: Date) {
  return d.toISOString().slice(0, 10);
}

function todayISO() {
  return toISO(new Date());
}

type Preset = "this-month" | "this-quarter" | "this-year" | "last-month" | "last-year";

function applyPreset(type: Preset): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (type) {
    case "this-month":
      return { from: `${y}-${pad(m + 1)}-01`, to: todayISO() };
    case "this-quarter": {
      const qm = Math.floor(m / 3) * 3;
      return { from: `${y}-${pad(qm + 1)}-01`, to: todayISO() };
    }
    case "this-year":
      return { from: `${y}-01-01`, to: todayISO() };
    case "last-month": {
      const lastDay = new Date(y, m, 0);
      const firstDay = new Date(y, m - 1, 1);
      return { from: toISO(firstDay), to: toISO(lastDay) };
    }
    case "last-year":
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
  }
}

function prevPeriod(from: string, to: string): { from: string; to: string } {
  const f = new Date(from);
  const t = new Date(to);
  const duration = t.getTime() - f.getTime();
  const pTo = new Date(f.getTime() - 86400000);
  const pFrom = new Date(pTo.getTime() - duration);
  return { from: toISO(pFrom), to: toISO(pTo) };
}

// ── Number helpers ────────────────────────────────────────────────────────────

function pctOfRev(num: string, rev: string): string {
  const r = parseFloat(rev);
  if (!r) return "—";
  return ((parseFloat(num) / r) * 100).toFixed(1) + "%";
}

function changePct(curr: string, prev: string): { label: string; positive: boolean } | null {
  const c = parseFloat(curr);
  const p = parseFloat(prev);
  if (!p) return null;
  const chg = ((c - p) / Math.abs(p)) * 100;
  return { label: (chg >= 0 ? "+" : "") + chg.toFixed(1) + "%", positive: chg >= 0 };
}

// ── CSV export ────────────────────────────────────────────────────────────────

function exportCSV(data: IncomeStatementData, compare: IncomeStatementData | null) {
  const compMap = (lines: ISAccountLine[]) =>
    new Map(lines.map((l) => [l.accountId, l.amount]));
  const cRevMap = compare ? compMap(compare.revenueLines) : new Map<string, string>();
  const cCOGSMap = compare ? compMap(compare.cogsLines) : new Map<string, string>();
  const cExpMap = compare ? compMap(compare.expenses) : new Map<string, string>();

  const h = compare
    ? ["البند", "المبلغ", "% الإيرادات", `الفترة السابقة (${compare.from} — ${compare.to})`, "التغيير"]
    : ["البند", "المبلغ", "% الإيرادات"];

  const rows: string[][] = [h];

  // Same sign rule as the screen: a credit balance is never exported wrapped in
  // deduction parentheses, or the spreadsheet repeats the misleading row.
  const csvAmount = (amount: string, neg: boolean) => {
    if (!neg) return amount;
    const d = deductionDisplay(amount);
    return d.parenthesise ? `(${d.magnitude})` : `${d.magnitude} ${CREDIT_LABEL_AR}`;
  };
  const addLine = (label: string, amount: string, neg: boolean, prevAmt?: string) => {
    const disp = csvAmount(amount, neg);
    const prevDisp = prevAmt != null ? csvAmount(prevAmt, neg) : "—";
    const chg = prevAmt != null ? (changePct(amount, prevAmt)?.label ?? "—") : "—";
    rows.push(compare ? [label, disp, pctOfRev(amount, data.revenue), prevDisp, chg] : [label, disp, pctOfRev(amount, data.revenue)]);
  };

  // The export mirrors the screen exactly: same sections, same order, same
  // signs — so a spreadsheet and a printout can never tell different stories.
  const rev = splitRevenue(data.revenueLines);
  const cRev = compare ? splitRevenue(compare.revenueLines) : null;
  const groups = groupExpenses(data.expenses);
  const cGroups = compare ? groupExpenses(compare.expenses) : null;

  addLine("الإيرادات", rev.grossTotal, false, cRev?.grossTotal);
  for (const l of rev.gross) addLine(`  ${l.code} ${l.nameAr}`, l.amount, false, cRevMap.get(l.accountId));
  if (rev.deductions.length > 0) {
    addLine("مردودات وتخفيضات المبيعات", rev.deductionsTotal, true, cRev?.deductionsTotal);
    for (const l of rev.deductions) {
      const prev = cRevMap.get(l.accountId);
      addLine(`  ${l.code} ${l.nameAr}`, l.amount, true, prev != null ? String(Math.abs(Number(prev))) : undefined);
    }
  }
  addLine("صافي الإيرادات", rev.netRevenue, false, cRev?.netRevenue);

  addLine("تكلفة البضاعة المباعة", data.costOfSales, true, compare?.costOfSales);
  for (const l of data.cogsLines)
    addLine(`  ${l.code} ${l.nameAr}`, l.amount, true, cCOGSMap.get(l.accountId));

  addLine("مجمل الربح", data.grossProfit, false, compare?.grossProfit);

  addLine("المصروفات التشغيلية", data.totalExpenses, true, compare?.totalExpenses);
  for (const g of groups) {
    addLine(`  ${g.labelAr}`, g.total, true, cGroups?.find((x) => x.id === g.id)?.total);
    for (const l of g.lines) addLine(`    ${l.code} ${l.nameAr}`, l.amount, true, cExpMap.get(l.accountId));
  }
  addLine("إجمالي المصروفات", data.totalExpenses, true, compare?.totalExpenses);

  addLine("صافي الربح", data.netProfit, false, compare?.netProfit);

  const csv = "﻿" + rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `income-statement-${data.from}-${data.to}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── KPI Card ──────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
      <div className="text-xs text-textSecondary font-medium uppercase tracking-wide">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${color ?? "text-text"}`} dir="ltr">
        {value}
      </div>
      {sub && <div className="text-xs text-textSecondary">{sub}</div>}
    </div>
  );
}

// ── Statement rows ────────────────────────────────────────────────────────────

/**
 * One account line. `isDeduction` only decides how the amount READS: a positive
 * amount is money out and prints in parentheses, while a credit balance prints
 * as a positive magnitude marked «دائن», because parentheses already mean
 * "deducted" and wrapping a negative would negate it twice.
 */
function AccountRow({
  line, revenue, isDeduction, locale, compare, prevAmt, statementBase, indent = "ps-10",
}: {
  line: PnlAmountLine;
  revenue: string;
  isDeduction: boolean;
  locale: AppLocale;
  compare: IncomeStatementData | null;
  prevAmt: string | undefined;
  statementBase: string;
  indent?: string;
}) {
  const d = deductionDisplay(line.amount);
  const credit = isDeduction && d.kind === "CREDIT";
  const show = (a: string) => {
    if (!isDeduction) return formatCurrency(a, locale);
    const x = deductionDisplay(a);
    return x.parenthesise
      ? `(${formatCurrency(x.magnitude, locale)})`
      : `${formatCurrency(x.magnitude, locale)} ${CREDIT_LABEL_AR}`;
  };
  const chg = prevAmt != null ? changePct(line.amount, prevAmt) : null;
  return (
    <tr className="border-b border-border/40 hover:bg-surface/40 bg-background/20">
      <td className={`px-4 py-2 text-sm ${indent}`}>
        <a
          href={`${statementBase}?accountId=${line.accountId}`}
          className="inline-flex items-center gap-1.5 text-blue-700 hover:underline"
        >
          <span className="font-mono text-xs text-textSecondary">{line.code}</span>
          {locale === "ar" ? line.nameAr : line.nameEn}
          <span className="text-xs opacity-50">↗</span>
        </a>
      </td>
      <td
        className={`px-4 py-2 text-sm text-end tabular-nums ${credit ? "text-green-700" : "text-textSecondary"}`}
        dir="ltr"
        title={credit ? CREDIT_HINT_AR : undefined}
        data-credit={credit ? "true" : undefined}
      >
        {show(line.amount)}
      </td>
      <td className="px-4 py-2 text-sm text-end tabular-nums text-textSecondary">
        {pctOfRev(line.amount, revenue)}
      </td>
      {compare && (
        <>
          <td className="px-4 py-2 text-sm text-end tabular-nums text-textSecondary" dir="ltr">
            {prevAmt != null ? show(prevAmt) : "—"}
          </td>
          <td className="px-4 py-2 text-sm text-end text-textSecondary">{chg?.label ?? "—"}</td>
        </>
      )}
    </tr>
  );
}

/** A named section heading with its own total (الإيرادات، المصروفات، a group). */
function SectionRow({
  label, total, revenue, isDeduction, locale, compare, compareTotal, expandable, expanded, onToggle, indent = "",
}: {
  label: string;
  total: string;
  revenue: string;
  isDeduction: boolean;
  locale: AppLocale;
  compare: IncomeStatementData | null;
  compareTotal: string | undefined;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  indent?: string;
}) {
  const d = deductionDisplay(total);
  const credit = isDeduction && d.kind === "CREDIT";
  const show = (a: string) => {
    if (!isDeduction) return formatCurrency(a, locale);
    const x = deductionDisplay(a);
    return x.parenthesise
      ? `(${formatCurrency(x.magnitude, locale)})`
      : `${formatCurrency(x.magnitude, locale)} ${CREDIT_LABEL_AR}`;
  };
  return (
    <tr
      className={`border-b border-border transition-colors hover:bg-surface/60 ${expandable ? "cursor-pointer select-none" : ""}`}
      onClick={expandable ? onToggle : undefined}
    >
      <td className={`px-4 py-2.5 text-sm ${indent}`}>
        <div className="flex items-center gap-1.5">
          {expandable && (
            <span className="text-textSecondary text-xs w-3 shrink-0">{expanded ? "▾" : "▸"}</span>
          )}
          <span className="font-semibold">{label}</span>
        </div>
      </td>
      <td
        className={`px-4 py-2.5 text-sm text-end tabular-nums font-semibold ${credit ? "text-green-700" : ""}`}
        dir="ltr"
        title={credit ? CREDIT_HINT_AR : undefined}
        data-credit={credit ? "true" : undefined}
      >
        {show(total)}
      </td>
      <td className="px-4 py-2.5 text-sm text-end tabular-nums text-textSecondary">
        {pctOfRev(total, revenue)}
      </td>
      {compare && (
        <>
          <td className="px-4 py-2.5 text-sm text-end tabular-nums text-textSecondary" dir="ltr">
            {compareTotal != null ? show(compareTotal) : "—"}
          </td>
          <td className="px-4 py-2.5 text-sm text-end text-textSecondary">
            {compareTotal != null ? changePct(total, compareTotal)?.label ?? "—" : "—"}
          </td>
        </>
      )}
    </tr>
  );
}

/**
 * A carried-forward subtotal: صافي الإيرادات، مجمل الربح، صافي الربح. These are
 * the numbers a reader follows down the page, so they are never wrapped in
 * deduction parentheses — a subtotal is a result, not an outflow.
 */
function SubtotalRow({
  label, value, revenue, locale, compare, compareValue, strong, testId,
}: {
  label: string;
  value: string;
  revenue: string;
  locale: AppLocale;
  compare: IncomeStatementData | null;
  compareValue: string | undefined;
  strong?: boolean;
  testId?: string;
}) {
  const negative = Number(value) < 0;
  const tone = strong ? (negative ? "text-red-600" : "text-green-700") : negative ? "text-red-600" : "text-blue-700";
  const chg = compareValue != null ? changePct(value, compareValue) : null;
  return (
    <tr
      className={strong ? (negative ? "bg-red-50/60 border-b-2 border-border" : "bg-green-50/60 border-b-2 border-border") : "border-b border-border bg-blue-50/40"}
      data-testid={testId}
    >
      <td className={`px-4 py-3 text-sm ${strong ? "font-bold" : "font-semibold"}`}>{label}</td>
      <td className={`px-4 py-3 ${strong ? "text-base font-bold" : "text-sm font-semibold"} text-end tabular-nums ${tone}`} dir="ltr">
        {formatCurrency(value, locale)}
      </td>
      <td className="px-4 py-3 text-sm text-end tabular-nums text-textSecondary">{pctOfRev(value, revenue)}</td>
      {compare && (
        <>
          <td className="px-4 py-3 text-sm text-end tabular-nums text-textSecondary" dir="ltr">
            {compareValue != null ? formatCurrency(compareValue, locale) : "—"}
          </td>
          <td className={`px-4 py-3 text-sm text-end font-medium ${chg ? (chg.positive ? "text-green-700" : "text-red-600") : "text-textSecondary"}`}>
            {chg?.label ?? "—"}
          </td>
        </>
      )}
    </tr>
  );
}

// ── Divider row ───────────────────────────────────────────────────────────────

function DividerRow({ cols, thick }: { cols: number; thick?: boolean }) {
  return (
    <tr className={thick ? "border-b-2 border-border" : "border-b border-border/60"}>
      <td colSpan={cols} className="p-0" />
    </tr>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function IncomeStatementPage() {
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const isOwner = useHasRole();

  useEffect(() => {
    if (!isOwner) router.replace(`/${locale}/dashboard`);
  }, [isOwner, router, locale]);

  // ── Period state ─────────────────────────────────────────────────────────
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 7) + "-01");
  const [to, setTo] = useState(todayISO);
  const [compareEnabled, setCompareEnabled] = useState(false);

  // ── Data state ───────────────────────────────────────────────────────────
  const [data, setData] = useState<IncomeStatementData | null>(null);
  const [compareData, setCompareData] = useState<IncomeStatementData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Expand state (all expanded by default) ───────────────────────────────
  const [expanded, setExpanded] = useState<Set<string>>(
    new Set(["revenue", "returns", "cogs", "expenses"]),
  );

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handlePreset(type: Preset) {
    const p = applyPreset(type);
    setFrom(p.from);
    setTo(p.to);
  }

  async function load(f: string, t: string) {
    setLoading(true);
    setError(null);
    try {
      const pp = prevPeriod(f, t);
      const [curr, comp] = await Promise.all([
        getIncomeStatement(f, t),
        compareEnabled ? getIncomeStatement(pp.from, pp.to) : Promise.resolve(null),
      ]);
      setData(curr);
      setCompareData(comp);
    } catch {
      setError("فشل تحميل قائمة الدخل");
    } finally {
      setLoading(false);
    }
  }

  async function handleApply(e: React.FormEvent) {
    e.preventDefault();
    await load(from, to);
  }

  // ── Derived values ───────────────────────────────────────────────────────
  const rev = data ? parseFloat(data.revenue) : 0;
  const netNum = data ? parseFloat(data.netProfit) : 0;
  const gm = data && rev ? parseFloat(data.grossMarginPct) : null;
  const nm = data && rev ? ((parseFloat(data.netProfit) / rev) * 100) : null;

  const cols = compareData ? 5 : 3;

  const cRevMap = new Map((compareData?.revenueLines ?? []).map((l) => [l.accountId, l.amount]));
  const cCOGSMap = new Map((compareData?.cogsLines ?? []).map((l) => [l.accountId, l.amount]));
  const cExpMap = new Map((compareData?.expenses ?? []).map((l) => [l.accountId, l.amount]));

  // Presentation only: the API's totals are used verbatim below. `revSplit.netRevenue`
  // is reconstructed from the same lines and equals `data.revenue`, so the sales
  // return is deducted once, not twice.
  const revSplit: RevenueSplit = splitRevenue(data?.revenueLines ?? []);
  const cRev = compareData ? splitRevenue(compareData.revenueLines) : null;
  const expenseGroups: ExpenseGroup[] = groupExpenses(data?.expenses ?? []);
  const cGroups = compareData ? groupExpenses(compareData.expenses) : null;

  const statementBase = `/${locale}/accounting/statement`;

  const presets: [Preset, string][] = [
    ["this-month", "هذا الشهر"],
    ["this-quarter", "هذا الربع"],
    ["this-year", "هذا العام"],
    ["last-month", "الشهر الماضي"],
    ["last-year", "العام الماضي"],
  ];

  return (
    <div className="space-y-4 max-w-5xl print:max-w-none" dir="rtl">

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between print:hidden">
        <div>
          <h1 className="text-xl font-bold">قائمة الدخل</h1>
          <p className="text-sm text-textSecondary">بيان الأرباح والخسائر</p>
        </div>
        <div className="flex gap-2">
          {data && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => exportCSV(data, compareData)}
            >
              تصدير CSV
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => window.print()}>
            طباعة
          </Button>
        </div>
      </div>

      {/* Print-only header */}
      <div className="hidden print:block text-center border-b pb-4 mb-2">
        <div className="text-lg font-bold">شروق ERP</div>
        <div className="text-base font-semibold">قائمة الدخل — بيان الأرباح والخسائر</div>
        {data && (
          <div className="text-sm text-gray-500">
            الفترة: {data.from} — {data.to}
          </div>
        )}
      </div>

      {/* ── Preset + filter bar ──────────────────────────────────────────── */}
      <form onSubmit={(e) => void handleApply(e)} className="space-y-3 print:hidden">
        <div className="flex flex-wrap gap-1.5">
          {presets.map(([type, label]) => (
            <button
              key={type}
              type="button"
              className="px-3 py-1.5 rounded text-xs font-medium border border-border hover:bg-surface transition-colors text-textSecondary hover:text-text"
              onClick={() => handlePreset(type)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-sm font-medium mb-1">من</label>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-36"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">إلى</label>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-36"
              required
            />
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer pb-0.5">
            <input
              type="checkbox"
              checked={compareEnabled}
              onChange={(e) => setCompareEnabled(e.target.checked)}
              className="rounded"
            />
            مقارنة بالفترة السابقة
          </label>
          <Button type="submit" disabled={loading}>
            {loading ? "جاري التحميل..." : "عرض القائمة"}
          </Button>
        </div>
      </form>

      {error && <Alert variant="error">{error}</Alert>}

      {/* ── Results ──────────────────────────────────────────────────────── */}
      {data && !loading && (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 print:hidden">
            <KpiCard
              label="الإيرادات"
              value={formatCurrency(data.revenue, locale)}
              sub={
                compareData
                  ? `السابقة: ${formatCurrency(compareData.revenue, locale)}`
                  : undefined
              }
            />
            <KpiCard
              label="مجمل الربح"
              value={formatCurrency(data.grossProfit, locale)}
              sub={gm != null ? `هامش المجمل ${gm.toFixed(1)}%` : undefined}
              color={parseFloat(data.grossProfit) >= 0 ? "text-green-700" : "text-red-600"}
            />
            <KpiCard
              label="إجمالي المصاريف"
              value={(() => {
                const d = deductionDisplay(data.totalExpenses);
                return d.parenthesise
                  ? `(${formatCurrency(d.magnitude, locale)})`
                  : `${formatCurrency(d.magnitude, locale)} ${CREDIT_LABEL_AR}`;
              })()}
              sub={
                deductionDisplay(data.totalExpenses).kind === "CREDIT"
                  ? CREDIT_HINT_AR
                  : `${data.expenses.length} بند مصروف`
              }
              color={deductionDisplay(data.totalExpenses).kind === "CREDIT" ? "text-green-700" : "text-red-600"}
            />
            <KpiCard
              label="صافي الربح"
              value={formatCurrency(data.netProfit, locale)}
              sub={nm != null ? `${nm.toFixed(1)}% من الإيرادات` : undefined}
              color={netNum >= 0 ? "text-green-700" : "text-red-600"}
            />
          </div>

          {/* P&L table */}
          <div className="border border-border rounded overflow-hidden">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-surface border-b-2 border-border text-right">
                  <th className="px-4 py-2.5 text-xs font-semibold text-textSecondary">البند</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-textSecondary text-end">
                    {data.from} — {data.to}
                  </th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-textSecondary text-end w-24">
                    % الإيرادات
                  </th>
                  {compareData && (
                    <>
                      <th className="px-4 py-2.5 text-xs font-semibold text-textSecondary text-end">
                        {compareData.from} — {compareData.to}
                      </th>
                      <th className="px-4 py-2.5 text-xs font-semibold text-textSecondary text-end w-20">
                        التغيير
                      </th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {/* ── الإيرادات ─────────────────────────────────────────── */}
                <SectionRow
                  label="الإيرادات"
                  total={revSplit.grossTotal}
                  revenue={data.revenue}
                  isDeduction={false}
                  locale={locale}
                  compare={compareData}
                  compareTotal={cRev?.grossTotal}
                  expandable={revSplit.gross.length > 0}
                  expanded={expanded.has("revenue")}
                  onToggle={() => toggle("revenue")}
                />
                {expanded.has("revenue") &&
                  revSplit.gross.map((l) => (
                    <AccountRow
                      key={l.accountId}
                      line={l}
                      revenue={data.revenue}
                      isDeduction={false}
                      locale={locale}
                      compare={compareData}
                      prevAmt={cRevMap.get(l.accountId)}
                      statementBase={statementBase}
                    />
                  ))}

                {/* مردودات المبيعات — a visible deduction from revenue. The API's
                    revenue total is ALREADY net of it, so صافي الإيرادات below is
                    that same total: the return is applied exactly once. */}
                {revSplit.deductions.length > 0 && (
                  <>
                    <SectionRow
                      label="مردودات وتخفيضات المبيعات"
                      total={revSplit.deductionsTotal}
                      revenue={data.revenue}
                      isDeduction
                      locale={locale}
                      compare={compareData}
                      compareTotal={cRev?.deductionsTotal}
                      expandable
                      expanded={expanded.has("returns")}
                      onToggle={() => toggle("returns")}
                    />
                    {expanded.has("returns") &&
                      revSplit.deductions.map((l) => {
                        const prev = cRevMap.get(l.accountId);
                        return (
                          <AccountRow
                            key={l.accountId}
                            line={l}
                            revenue={data.revenue}
                            isDeduction
                            locale={locale}
                            compare={compareData}
                            prevAmt={prev != null ? String(Math.abs(Number(prev))) : undefined}
                            statementBase={statementBase}
                          />
                        );
                      })}
                  </>
                )}

                <SubtotalRow
                  label="صافي الإيرادات"
                  value={revSplit.netRevenue}
                  revenue={data.revenue}
                  locale={locale}
                  compare={compareData}
                  compareValue={cRev?.netRevenue}
                  testId="is-net-revenue"
                />

                {/* ── تكلفة البضاعة المباعة ──────────────────────────────── */}
                <SectionRow
                  label="تكلفة البضاعة المباعة"
                  total={data.costOfSales}
                  revenue={data.revenue}
                  isDeduction
                  locale={locale}
                  compare={compareData}
                  compareTotal={compareData?.costOfSales}
                  expandable={data.cogsLines.length > 0}
                  expanded={expanded.has("cogs")}
                  onToggle={() => toggle("cogs")}
                />
                {expanded.has("cogs") &&
                  data.cogsLines.map((l) => (
                    <AccountRow
                      key={l.accountId}
                      line={l}
                      revenue={data.revenue}
                      isDeduction
                      locale={locale}
                      compare={compareData}
                      prevAmt={cCOGSMap.get(l.accountId)}
                      statementBase={statementBase}
                    />
                  ))}

                <SubtotalRow
                  label="مجمل الربح"
                  value={data.grossProfit}
                  revenue={data.revenue}
                  locale={locale}
                  compare={compareData}
                  compareValue={compareData?.grossProfit}
                  testId="is-gross-profit"
                />

                {/* ── المصروفات التشغيلية ────────────────────────────────── */}
                <SectionRow
                  label="المصروفات التشغيلية"
                  total={data.totalExpenses}
                  revenue={data.revenue}
                  isDeduction
                  locale={locale}
                  compare={compareData}
                  compareTotal={compareData?.totalExpenses}
                  expandable={expenseGroups.length > 0}
                  expanded={expanded.has("expenses")}
                  onToggle={() => toggle("expenses")}
                />
                {expanded.has("expenses") &&
                  expenseGroups.map((g) => (
                    <Fragment key={g.id}>
                      <SectionRow
                        label={g.labelAr}
                        total={g.total}
                        revenue={data.revenue}
                        isDeduction
                        locale={locale}
                        compare={compareData}
                        compareTotal={cGroups?.find((x) => x.id === g.id)?.total}
                        indent="ps-8"
                      />
                      {g.lines.map((l) => (
                        <AccountRow
                          key={l.accountId}
                          line={l}
                          revenue={data.revenue}
                          isDeduction
                          locale={locale}
                          compare={compareData}
                          prevAmt={cExpMap.get(l.accountId)}
                          statementBase={statementBase}
                          indent="ps-14"
                        />
                      ))}
                    </Fragment>
                  ))}

                <SubtotalRow
                  label="إجمالي المصروفات"
                  value={data.totalExpenses}
                  revenue={data.revenue}
                  locale={locale}
                  compare={compareData}
                  compareValue={compareData?.totalExpenses}
                  testId="is-total-expenses"
                />

                <DividerRow cols={cols} thick />

                <SubtotalRow
                  label="صافي الربح"
                  value={data.netProfit}
                  revenue={data.revenue}
                  locale={locale}
                  compare={compareData}
                  compareValue={compareData?.netProfit}
                  strong
                  testId="is-net-profit"
                />
              </tbody>
            </table>
          </div>

          {/* Print footer */}
          <div className="hidden print:block text-xs text-gray-400 text-center mt-8 pt-4 border-t">
            تم إنشاء هذا التقرير بواسطة شروق ERP
          </div>
        </>
      )}

      {!data && !loading && !error && (
        <div className="text-center py-16 text-textSecondary">
          <div className="text-sm">اختر الفترة الزمنية وانقر &quot;عرض القائمة&quot;</div>
        </div>
      )}
    </div>
  );
}
