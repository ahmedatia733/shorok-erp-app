# قائمة الدخل — accounting layout

**Base main:** `902284b` · **Branch:** `feat/income-statement-accounting-layout`
**Author/Committer:** Ahmed Attia \<ahmedatia733@gmail.com\>
**Deployment IDs:** see the final rollout response (a docs-only follow-up commit
would trigger a second deployment, so they are not recorded here).

A presentation change only. No account was created or reclassified, no journal
touched, no schema or migration, and the accounting engine is untouched.

---

## The structure

```
الإيرادات                              4,040,372.50
    4100 إيرادات المبيعات               4,040,372.50
مردودات وتخفيضات المبيعات                (76,007.50)
    4200 مردودات المبيعات                (76,007.50)
صافي الإيرادات                         3,964,365.00
تكلفة البضاعة المباعة                 (3,334,719.12)
    5100 تكلفة البضاعة المباعة          (3,334,719.12)
مجمل الربح                               629,645.88
المصروفات التشغيلية                        (900.00)
    مصروفات البيع والتوزيع                  (900.00)
        6100 النقل والشحن                   (900.00)
إجمالي المصروفات                            900.00
صافي الربح                               628,745.88
```

Formulas, made explicit on the page:

```
إيرادات المبيعات − مردودات المبيعات = صافي الإيرادات
صافي الإيرادات   − تكلفة البضاعة المباعة = مجمل الربح
مجمل الربح       − إجمالي المصروفات      = صافي الربح
```

---

## The one real hazard: deducting the return twice

The API's `revenue` is **already net**. A sales return debits
`4200 مردودات المبيعات`, which is a REVENUE-category account, so its
`credit − debit` contribution is **−76,007.50** and is already inside the
revenue total: `4,040,372.50 + (−76,007.50) = 3,964,365.00`.

Showing that figure as «الإيرادات» and then subtracting the returns line again
would deduct 76,007.50 twice and report net revenue of 3,888,357.50.

So the split runs the other way round. `splitRevenue()` separates the API's
revenue lines by sign, reports the deductions as positive magnitudes, and
reconstructs gross by adding them back. The identity

```
grossTotal − deductionsTotal = netRevenue = the API's own `revenue`
```

then holds by construction, and the return is applied exactly once. Both a unit
test and a rendered-page assertion pin the wrong answer (3,888,357.50) as a
failure.

Classification is by **sign**, not by account code, so an account that reduced
revenue in a period is shown as a deduction whatever it is called and no revenue
account can fall out of the statement.

---

## Expense sections

The chart has no hierarchy field yet and this task must not add one, so
`classifyExpense()` maps the accounts that exist. Display only — it never
touches a balance, a posting or a total.

| Section | Accounts |
|---|---|
| مصروفات البيع والتوزيع | `61xx` — 6100 النقل والشحن |
| المصروفات العمومية والإدارية | `62xx` `63xx` `64xx` `67xx` — الرواتب، الكهرباء والمرافق، الإيجارات، الصيانة |
| المصروفات البنكية والتمويلية | `65xx` — المصروفات البنكية |
| الإهلاك | any account whose name contains «إهلاك» / "depreciation" |
| مصروفات أخرى | `66xx` متنوعة **and anything unrecognised** |

**An unknown or future expense account falls to «مصروفات أخرى».** It must appear
in the wrong section rather than vanish from the statement — a test asserts this
for several codes that do not exist yet.

**الإهلاك is not shown**, because no depreciation account exists in the chart.
This task does not create one, and empty sections are omitted rather than padded
with 0.00 rows.

The section totals always sum to the API's `totalExpenses`, and every account
lands in exactly one section — both asserted.

---

## Sign handling kept

`apps/web/lib/pnl-format.ts` is unchanged and still governs how an amount reads:
a positive expense prints as a deduction `(900.00)`, while a credit balance on an
expense account prints as `900.00 دائن` in green with its explanation, because
parentheses already mean "deducted" and wrapping a negative would negate it
twice. Display sign and calculation sign remain separate.

---

## Engine untouched

`FinancialReportsService.pnl()` is not modified. Revenue is `credit − debit`,
cost of sales and expenses are `debit − credit`, gross profit is
`revenue − costOfSales`, net profit is `grossProfit − totalExpenses`, over
`status='POSTED' AND reversal_of_id IS NULL`. Every figure on the page is the
API's; the client re-derives nothing, and the grouping helpers use exact
decimal-string arithmetic rather than floats.

CSV export and the print view follow the same sections, order and signs as the
screen.

---

## Verification

**Focused:** web `pnl-sections.test.ts` 14/14, `pnl-format.test.ts` 7/7; API
`income-statement-sign.spec.ts` 17/17 (5 new, covering contra-revenue and the
sum-of-lines identity). Rendered-page check against a read-only restore of
current production: **15/15**, including section order, the once-only return
deduction, and reconciliation of net revenue, gross profit, total expenses and
net profit to the API.

**Full:** API integration **84 suites / 1021 tests** (from 1016), API unit
**359**, web unit **253** (from 239), API build OK, web build OK.

**Lint:** baseline 320 problems (59 errors, 261 warnings) → **319 (59, 260)**.
No new problem; one pre-existing warning disappeared with the superseded
`PLSection` component.

**Database:** `schema.prisma` diff 0, migrations diff 0, 43 migration
directories unchanged, no seed change, no env or Railway config change.

**Accounting records:** journal #83 line fingerprint
`6e146052b489cca549dcadc16fec1dc0`, POSTED, 10 lines — unchanged. Correction
#250 (`4e68856b-7365-47fe-80e2-939db77f87aa`) POSTED / ADJUSTMENT /
`JE-83-CORRECTION`, still exactly `Dr 6100 1800.00 / Cr CASH-2 1800.00`. Account
6100 net **+900.00**.

Chart of accounts untouched — its restructuring is a separate future task.
