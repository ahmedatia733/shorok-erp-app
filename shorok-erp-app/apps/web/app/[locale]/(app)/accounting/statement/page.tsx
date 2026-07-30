"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ACCOUNT_CATEGORIES, accountsInCategory } from "@shorok/shared";
import type { AppLocale } from "../../../../../i18n";
import { Alert } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Input } from "../../../../../components/ui/input";
import { Skeleton } from "../../../../../components/ui/skeleton";
import { SearchableSelect, type SearchableOption } from "../../../../../components/ui/searchable-select";
import { ApiClientError } from "../../../../../lib/api-client";
import { cn } from "../../../../../lib/cn";
import { accountingMoney } from "../../../../../lib/statement-format";
import { statementRowLabel } from "../../../../../lib/statement-labels";
import { sourceDocumentHref } from "../../../../../lib/source-document";
import {
  getConsolidatedStatement,
  getStatementOptions,
  type ConsolidatedStatement,
  type StatementOptions,
} from "../../../../../lib/statements-client";

const ALL = "all";

/**
 * A single signed money cell. Balances are signed on the account's own normal
 * side: a negative reads as "against" that side. The negative is shown BOTH in
 * red and in parentheses (a non-colour cue) with a localized aria-label, so it
 * stays legible without relying on colour alone.
 */
function Money({ value, locale, negativeLabel, bold = false }: {
  value: string;
  locale: AppLocale;
  negativeLabel: string;
  bold?: boolean;
}) {
  const { text, negative } = accountingMoney(value, locale);
  return (
    <span
      dir="ltr"
      data-negative={negative ? "true" : undefined}
      aria-label={negative ? `${negativeLabel} ${text}` : undefined}
      title={negative ? negativeLabel : undefined}
      className={cn("tabular-nums", negative && "text-red-600", bold && "font-semibold")}
    >
      {text}
    </span>
  );
}

export default function StatementPage() {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("accounting.statement");
  const dir = locale === "ar" ? "rtl" : "ltr";

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
        setOptionsError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("loadOptionsError"));
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

  const entityLabelText =
    categoryDef?.kind === "CUSTOMERS" ? t("customer")
      : categoryDef?.kind === "SUPPLIERS" ? t("supplier")
      : t("account");

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
      setError(e instanceof ApiClientError ? e.localizedMessage(locale) : t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [category, entityId, from, to, includeZero, categoryDef, locale, t]);

  useEffect(() => {
    if (!options) return;
    void load();
  }, [options, load]);

  const isConsolidated = data?.selectionType === "consolidated";

  // ── render ───────────────────────────────────────────────────────────────

  if (optionsLoading) {
    return (
      <div className="w-full space-y-4" dir={dir}>
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (optionsError) {
    return (
      <div className="w-full space-y-3" dir={dir}>
        <h1 className="text-xl font-bold">{t("title")}</h1>
        <Alert variant="error">{optionsError}</Alert>
        <Button onClick={() => window.location.reload()}>{t("retry")}</Button>
      </div>
    );
  }

  const money = (value: string, bold = false) => (
    <Money value={value} locale={locale} negativeLabel={t("negative")} bold={bold} />
  );

  return (
    <div className="w-full" dir={dir}>
      {/* One connected accounting report inside a single bordered container. */}
      <div className="rounded-lg border border-border bg-surface" data-testid="statement-report">
        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h1 className="text-lg font-bold leading-tight">{t("title")}</h1>
            <p className="text-xs text-textSecondary">{t("subtitle")}</p>
          </div>
          {data && (
            <span className="text-sm text-textSecondary">
              {(isConsolidated ? t("viewConsolidated") : t("viewSpecific"))} — {data.entityLabel}
            </span>
          )}
        </div>

        {/* ── Filter toolbar ─────────────────────────────────────────────────── */}
        <div className="border-b border-border px-4 py-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col">
              <label htmlFor="stmt-category" className="mb-1 text-xs font-medium text-textSecondary">{t("list")}</label>
              <select
                id="stmt-category"
                className="h-9 w-full rounded border border-border bg-background px-2 text-sm"
                value={category}
                onChange={(e) => handleCategoryChange(e.target.value)}
              >
                {ACCOUNT_CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col">
              <label htmlFor="stmt-entity" className="mb-1 text-xs font-medium text-textSecondary">{entityLabelText}</label>
              <SearchableSelect
                id="stmt-entity"
                value={entityId}
                onChange={setEntityId}
                options={entityOptions}
                placeholder={t("searchEntity")}
                emptyText={t("noEntities")}
              />
            </div>

            <div className="flex flex-col">
              <label htmlFor="stmt-from" className="mb-1 text-xs font-medium text-textSecondary">{t("fromDate")}</label>
              <Input id="stmt-from" type="date" className="h-9" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>

            <div className="flex flex-col">
              <label htmlFor="stmt-to" className="mb-1 text-xs font-medium text-textSecondary">{t("toDate")}</label>
              <Input id="stmt-to" type="date" className="h-9" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={includeZero}
                onChange={(e) => setIncludeZero(e.target.checked)}
              />
              {t("includeZero")}
            </label>
            <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
              {loading ? t("refreshing") : t("refresh")}
            </Button>
          </div>
        </div>

        {error && <div className="px-4 py-3"><Alert variant="error">{error}</Alert></div>}

        {loading && !data && (
          <div className="space-y-3 px-4 py-4">
            <Skeleton className="h-16" />
            <Skeleton className="h-48" />
          </div>
        )}

        {data && (
          <>
            {/* ── Totals summary strip (belongs to the report, not floating cards) ── */}
            <div className="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-4" data-testid="statement-summary">
              <SummaryCell label={t("openingBalance")} value={data.openingBalance} money={money} />
              <SummaryCell label={t("totalDebit")} value={data.periodDebit} money={money} />
              <SummaryCell label={t("totalCredit")} value={data.periodCredit} money={money} />
              <SummaryCell label={t("closingBalance")} value={data.endingBalance} money={money} strong />
            </div>

            {/* ── Detailed accounts table (consolidated) ─────────────────────── */}
            {isConsolidated && (
              <section>
                <div className="px-4 py-2 text-sm font-semibold">
                  {t("accountsDetails", { count: data.breakdown.length })}
                </div>
                <div className="max-h-[520px] overflow-auto border-t border-border" data-testid="statement-accounts-scroll">
                  <table className="w-full min-w-[720px] border-collapse text-sm [&_td]:border [&_td]:border-border [&_th]:border [&_th]:border-border" data-testid="statement-accounts-table">
                    <thead className="sticky top-0 z-10 bg-background text-xs uppercase tracking-wide text-textSecondary">
                      <tr>
                        <th className="px-3 py-2 text-start font-medium">{t("code")}</th>
                        <th className="px-3 py-2 text-start font-medium">{t("name")}</th>
                        <th className="px-3 py-2 text-end font-medium">{t("openingBalance")}</th>
                        <th className="px-3 py-2 text-end font-medium">{t("debit")}</th>
                        <th className="px-3 py-2 text-end font-medium">{t("credit")}</th>
                        <th className="px-3 py-2 text-end font-medium">{t("closing")}</th>
                        <th className="px-3 py-2 text-end font-medium">{t("actions")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.breakdown.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-4 py-6 text-center text-sm text-textSecondary">
                            {t("noAccounts")}
                            {!includeZero && t("noAccountsHint")}
                          </td>
                        </tr>
                      ) : (
                        data.breakdown.map((b, i) => (
                          <tr key={b.entityId} className={cn("hover:bg-background/70", i % 2 === 1 && "bg-background/40")}>
                            <td className="px-3 py-2 font-mono text-xs" dir="ltr">{b.code || "—"}</td>
                            <td className="max-w-[240px] truncate px-3 py-2" title={b.name}>{b.name}</td>
                            <td className="px-3 py-2 text-end">{money(b.openingBalance)}</td>
                            <td className="px-3 py-2 text-end">{money(b.debit)}</td>
                            <td className="px-3 py-2 text-end">{money(b.credit)}</td>
                            <td className="px-3 py-2 text-end">{money(b.endingBalance, true)}</td>
                            <td className="px-3 py-2 text-end">
                              <button
                                type="button"
                                className="rounded border border-border px-2 py-1 text-xs text-primary hover:bg-primary/10"
                                onClick={() => setEntityId(b.entityId)}
                              >
                                {t("viewDetails")}
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                    {data.breakdown.length > 0 && (
                      // Authoritative category totals from the API — NOT re-summed
                      // on the client. They total the same accounts the rows list.
                      <tfoot className="sticky bottom-0 border-t-2 border-border bg-background font-semibold">
                        <tr>
                          <td className="px-3 py-2" colSpan={2}>{t("total")}</td>
                          <td className="px-3 py-2 text-end">{money(data.openingBalance)}</td>
                          <td className="px-3 py-2 text-end">{money(data.periodDebit)}</td>
                          <td className="px-3 py-2 text-end">{money(data.periodCredit)}</td>
                          <td className="px-3 py-2 text-end">{money(data.endingBalance, true)}</td>
                          <td className="px-3 py-2 text-end">—</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </section>
            )}

            {/* ── Movements table (drill-down / specific) ─────────────────────── */}
            <section className={isConsolidated ? "border-t border-border" : undefined}>
              <div className="px-4 py-2 text-sm font-semibold">
                {t("movements", { count: data.rows.length })}
              </div>
              <div className="max-h-[520px] overflow-auto border-t border-border">
                <table className="w-full min-w-[720px] border-collapse text-sm [&_td]:border [&_td]:border-border [&_th]:border [&_th]:border-border" data-testid="statement-movements-table">
                  <thead className="sticky top-0 z-10 bg-background text-xs uppercase tracking-wide text-textSecondary">
                    <tr>
                      <th className="px-3 py-2 text-start font-medium">{t("date")}</th>
                      <th className="px-3 py-2 text-start font-medium">{t("entry")}</th>
                      {isConsolidated && <th className="px-3 py-2 text-start font-medium">{t("account")}</th>}
                      <th className="px-3 py-2 text-start font-medium">{t("document")}</th>
                      <th className="px-3 py-2 text-end font-medium">{t("debit")}</th>
                      <th className="px-3 py-2 text-end font-medium">{t("credit")}</th>
                      <th className="px-3 py-2 text-end font-medium">{t("balance")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.rows.length === 0 ? (
                      <tr>
                        <td colSpan={isConsolidated ? 7 : 6} className="px-4 py-6 text-center text-sm text-textSecondary">
                          {t("noMovements")}
                        </td>
                      </tr>
                    ) : (
                      data.rows.map((r, i) => {
                        const href = sourceDocumentHref(r, locale);
                        return (
                          <tr key={r.journalLineId} className={cn("hover:bg-background/70", i % 2 === 1 && "bg-background/40")}>
                            <td className="whitespace-nowrap px-3 py-2" dir="ltr">{r.entryDate}</td>
                            <td className="px-3 py-2 font-mono text-xs" dir="ltr">{r.reference ?? `#${r.entryNumber}`}</td>
                            {isConsolidated && (
                              <td className="px-3 py-2 text-xs">
                                <span className="font-mono" dir="ltr">{r.accountCode}</span> — {r.accountName}
                              </td>
                            )}
                            <td className="max-w-[320px] truncate px-3 py-2" title={statementRowLabel(r, locale)}>
                              {href ? (
                                <Link
                                  href={href}
                                  className="text-primary underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                                >
                                  {statementRowLabel(r, locale)} ↗
                                </Link>
                              ) : (
                                statementRowLabel(r, locale)
                              )}
                            </td>
                            <td className="px-3 py-2 text-end">
                              {Number(r.debit) > 0 ? money(r.debit) : <span className="text-textSecondary">—</span>}
                            </td>
                            <td className="px-3 py-2 text-end">
                              {Number(r.credit) > 0 ? money(r.credit) : <span className="text-textSecondary">—</span>}
                            </td>
                            <td className="px-3 py-2 text-end">{money(r.runningBalance)}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                  {data.rows.length > 0 && (
                    <tfoot className="sticky bottom-0 border-t-2 border-border bg-background font-semibold">
                      <tr>
                        <td className="px-3 py-2" colSpan={isConsolidated ? 4 : 3}>{t("total")}</td>
                        <td className="px-3 py-2 text-end">{money(data.periodDebit)}</td>
                        <td className="px-3 py-2 text-end">{money(data.periodCredit)}</td>
                        <td className="px-3 py-2 text-end">{money(data.endingBalance, true)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function SummaryCell({ label, value, money, strong = false }: {
  label: string;
  value: string;
  money: (value: string, bold?: boolean) => JSX.Element;
  strong?: boolean;
}) {
  return (
    <div className="bg-surface px-4 py-3">
      <div className="mb-1 text-xs text-textSecondary">{label}</div>
      <div className={cn("text-base", strong ? "font-bold" : "font-semibold")}>{money(value, strong)}</div>
    </div>
  );
}
