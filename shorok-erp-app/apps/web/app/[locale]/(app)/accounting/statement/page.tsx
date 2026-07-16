"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { ACCOUNT_CATEGORIES, accountsInCategory } from "@shorok/shared";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardBody } from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { SearchableSelect, type SearchableOption } from "../../../../../components/ui/searchable-select";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { ApiClientError } from "../../../../../lib/api-client";
import { statementRowLabel } from "../../../../../lib/statement-labels";
import { sourceDocumentHref } from "../../../../../lib/source-document";
import {
  getConsolidatedStatement,
  getStatementOptions,
  type ConsolidatedStatement,
  type StatementOptions,
} from "../../../../../lib/statements-client";

const ALL = "all";

function fmt(v: string) {
  return Number(v).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Balances are signed on the account's own normal side: negative reads as "against" that side. */
function Money({ v, bold = false }: { v: string; bold?: boolean }) {
  const n = Number(v);
  const tone = n < 0 ? "text-red-600" : "text-textPrimary";
  return <span className={`tabular-nums ${tone} ${bold ? "font-bold" : ""}`} dir="ltr">{fmt(v)}</span>;
}

function SummaryCard({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <Card>
      <CardBody className="py-3">
        <div className="text-xs text-textSecondary mb-1">{label}</div>
        <div className={`text-lg ${accent ? "font-bold text-primary" : "font-semibold"} tabular-nums`} dir="ltr">
          {fmt(value)}
        </div>
      </CardBody>
    </Card>
  );
}

export default function StatementPage() {
  const locale = useLocale() as AppLocale;

  const [options, setOptions] = useState<StatementOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const [category, setCategory] = useState("banks");
  const [entityId, setEntityId] = useState(ALL);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [includeZero, setIncludeZero] = useState(false);

  const [data, setData] = useState<ConsolidatedStatement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const categoryDef = ACCOUNT_CATEGORIES.find((c) => c.id === category);

  // ── options (categories + selectable entities) ───────────────────────────

  useEffect(() => {
    void (async () => {
      try {
        const o = await getStatementOptions();
        setOptions(o);

        // Deep link from an invoice / income statement: ?accountId=… selects the
        // account inside whichever category owns it.
        const accountId = new URLSearchParams(window.location.search).get("accountId");
        if (accountId && o.accounts.some((a) => a.id === accountId)) {
          const owning = ACCOUNT_CATEGORIES.find(
            (c) => c.id !== ALL && c.kind === "ACCOUNTS" && accountsInCategory(c.id, o.accounts).some((a) => a.id === accountId),
          );
          setCategory(owning?.id ?? ALL);
          setEntityId(accountId);
        }
      } catch (e) {
        setOptionsError(e instanceof ApiClientError ? e.localizedMessage(locale) : "فشل تحميل قوائم الحسابات");
      } finally {
        setOptionsLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── second selector options ──────────────────────────────────────────────

  const entityOptions = useMemo<SearchableOption[]>(() => {
    if (!options || !categoryDef) return [];
    const all: SearchableOption = { value: ALL, label: categoryDef.allLabel, pinned: true };

    if (categoryDef.kind === "CUSTOMERS") {
      return [all, ...options.customers.map((c) => ({
        value: c.id,
        label: `${c.code} — ${c.nameAr}`,
        keywords: `${c.code} ${c.nameAr}`,
      }))];
    }
    if (categoryDef.kind === "SUPPLIERS") {
      return [all, ...options.suppliers.map((s) => ({
        value: s.id,
        label: s.nameAr,
        keywords: `${s.nameAr} ${s.nameEn ?? ""}`,
      }))];
    }
    // Only active leaf accounts are selectable; parents are never postable.
    return [all, ...accountsInCategory(categoryDef.id, options.accounts).map((a) => ({
      value: a.id,
      label: `${a.code} — ${a.nameAr}`,
      keywords: `${a.code} ${a.nameAr} ${a.nameEn ?? ""}`,
    }))];
  }, [options, categoryDef]);

  // Switching category must drop a selection that no longer exists in it.
  // Re-picking the current category is a no-op: clearing `data` here without a
  // dependency change would blank the page with no reload to refill it.
  function handleCategoryChange(next: string) {
    if (next === category) return;
    setCategory(next);
    setEntityId(ALL);
    setData(null);
  }

  // ── load statement ───────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!categoryDef) return;
    setLoading(true);
    setError(null);
    try {
      // Always re-fetched from the GL — nothing is cached client-side, so a
      // posting or reversal shows up as soon as the page is opened or refreshed.
      setData(await getConsolidatedStatement({
        category,
        entityId,
        from: from || undefined,
        to: to || undefined,
        includeZero,
      }));
    } catch (e) {
      setData(null);
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : "فشل تحميل كشف الحساب");
    } finally {
      setLoading(false);
    }
  }, [category, entityId, from, to, includeZero, categoryDef, locale]);

  useEffect(() => {
    if (!options) return;
    void load();
  }, [options, load]);

  const isConsolidated = data?.selectionType === "consolidated";

  // ── render ───────────────────────────────────────────────────────────────

  if (optionsLoading) {
    return (
      <div className="space-y-4 max-w-6xl" dir="rtl">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (optionsError) {
    return (
      <div className="space-y-3 max-w-6xl" dir="rtl">
        <h1 className="text-xl font-bold">كشف الحساب</h1>
        <Alert variant="error">{optionsError}</Alert>
        <Button onClick={() => window.location.reload()}>إعادة المحاولة</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-6xl" dir="rtl">
      <h1 className="text-xl font-bold">كشف الحساب</h1>

      {/* ── Two-stage selector ─────────────────────────────────────────────── */}
      <Card>
        <CardBody className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <div>
            <label htmlFor="stmt-category" className="block text-sm font-medium mb-1">القائمة</label>
            <select
              id="stmt-category"
              className="w-full border border-border rounded px-2 py-1.5 text-sm bg-background"
              value={category}
              onChange={(e) => handleCategoryChange(e.target.value)}
            >
              {ACCOUNT_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="stmt-entity" className="block text-sm font-medium mb-1">
              {categoryDef?.kind === "CUSTOMERS" ? "العميل"
                : categoryDef?.kind === "SUPPLIERS" ? "المورد"
                : "الحساب"}
            </label>
            <SearchableSelect
              id="stmt-entity"
              value={entityId}
              onChange={setEntityId}
              options={entityOptions}
              placeholder="بحث بالكود أو الاسم..."
              emptyText="لا توجد حسابات في هذه القائمة"
            />
          </div>

          <div>
            <label htmlFor="stmt-from" className="block text-sm font-medium mb-1">من تاريخ</label>
            <Input id="stmt-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>

          <div>
            <label htmlFor="stmt-to" className="block text-sm font-medium mb-1">إلى تاريخ</label>
            <Input id="stmt-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>

          <div className="md:col-span-4 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 accent-primary"
                checked={includeZero}
                onChange={(e) => setIncludeZero(e.target.checked)}
              />
              إظهار الحسابات بدون حركة
            </label>
            <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
              {loading ? "جارِ التحديث..." : "تحديث"}
            </Button>
            {data && (
              <span className="text-sm text-textSecondary">
                {isConsolidated ? "عرض مجمّع — " : "عرض تفصيلي — "}{data.entityLabel}
              </span>
            )}
          </div>
        </CardBody>
      </Card>

      {error && <Alert variant="error">{error}</Alert>}

      {loading && !data && (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-48" />
        </div>
      )}

      {data && (
        <>
          {/* ── Summary ─────────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <SummaryCard label="الرصيد الافتتاحي" value={data.openingBalance} />
            <SummaryCard label="إجمالي المدين" value={data.periodDebit} />
            <SummaryCard label="إجمالي الدائن" value={data.periodCredit} />
            <SummaryCard label="الرصيد النهائي" value={data.endingBalance} accent />
          </div>

          {/* ── Breakdown (consolidated only) ───────────────────────────────── */}
          {isConsolidated && (
            <Card>
              <CardBody className="p-0 overflow-x-auto">
                <div className="px-4 py-2 text-sm font-semibold border-b border-border">
                  تفاصيل الحسابات ({data.breakdown.length})
                </div>
                {data.breakdown.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-textSecondary">
                    لا توجد حسابات بحركة في هذه القائمة.
                    {!includeZero && " فعّل «إظهار الحسابات بدون حركة» لعرض الحسابات الفارغة."}
                  </div>
                ) : (
                  <Table>
                    <THead>
                      <TR>
                        <TH>الكود</TH>
                        <TH>الاسم</TH>
                        <TH>الرصيد الافتتاحي</TH>
                        <TH>مدين</TH>
                        <TH>دائن</TH>
                        <TH>الرصيد النهائي</TH>
                        <TH></TH>
                      </TR>
                    </THead>
                    <TBody>
                      {data.breakdown.map((b) => (
                        <TR key={b.entityId}>
                          <TD className="font-mono text-xs" dir="ltr">{b.code || "—"}</TD>
                          <TD>{b.name}</TD>
                          <TD className="text-end"><Money v={b.openingBalance} /></TD>
                          <TD className="text-end"><Money v={b.debit} /></TD>
                          <TD className="text-end"><Money v={b.credit} /></TD>
                          <TD className="text-end"><Money v={b.endingBalance} bold /></TD>
                          <TD>
                            <button
                              type="button"
                              className="text-xs text-blue-600 hover:underline"
                              onClick={() => setEntityId(b.entityId)}
                            >
                              عرض التفاصيل ←
                            </button>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </CardBody>
            </Card>
          )}

          {/* ── Movements ───────────────────────────────────────────────────── */}
          <Card>
            <CardBody className="p-0 overflow-x-auto">
              <div className="px-4 py-2 text-sm font-semibold border-b border-border">
                الحركات ({data.rows.length})
              </div>
              {data.rows.length === 0 ? (
                <div className="px-4 py-6 text-sm text-textSecondary">لا توجد حركات في هذه الفترة.</div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>التاريخ</TH>
                      <TH>القيد</TH>
                      {isConsolidated && <TH>الحساب</TH>}
                      <TH>البيان / المستند</TH>
                      <TH>مدين</TH>
                      <TH>دائن</TH>
                      <TH>الرصيد</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {data.rows.map((r) => {
                      const href = sourceDocumentHref(r, locale);
                      return (
                        <TR key={r.journalLineId}>
                          <TD className="whitespace-nowrap" dir="ltr">{r.entryDate}</TD>
                          <TD className="font-mono text-xs" dir="ltr">{r.reference ?? `#${r.entryNumber}`}</TD>
                          {isConsolidated && (
                            <TD className="text-xs">
                              <span className="font-mono" dir="ltr">{r.accountCode}</span> — {r.accountName}
                            </TD>
                          )}
                          <TD>
                            {href ? (
                              <a href={href} className="text-blue-600 hover:underline">
                                {statementRowLabel(r)} ↗
                              </a>
                            ) : (
                              statementRowLabel(r)
                            )}
                          </TD>
                          <TD className="text-end">
                            {Number(r.debit) > 0 ? <Money v={r.debit} /> : <span className="text-textSecondary">—</span>}
                          </TD>
                          <TD className="text-end">
                            {Number(r.credit) > 0 ? <Money v={r.credit} /> : <span className="text-textSecondary">—</span>}
                          </TD>
                          <TD className="text-end"><Money v={r.runningBalance} /></TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
