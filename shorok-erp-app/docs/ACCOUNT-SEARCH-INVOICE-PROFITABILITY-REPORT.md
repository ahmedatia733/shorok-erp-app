# Account Statement Search + تقرير ربحية الفواتير

**Status:** live in production · **Date:** 2026-08-10 · **Commit:** `ba03cee`

النسخة العربية: [ACCOUNT-SEARCH-INVOICE-PROFITABILITY-REPORT.ar.md](ACCOUNT-SEARCH-INVOICE-PROFITABILITY-REPORT.ar.md)

Two things shipped together: statement screens you can search, and a report
that answers what each sale actually earned.

---

## Part A — restoring search

### What was actually wrong

The brief described search as missing from both statement screens. Reading the
code and then the live pages found something more specific, and worth stating
plainly because it changed what needed building:

| Control | Before | Verdict |
|---|---|---|
| كشف الحساب — القائمة (category) | native `<select>`, 15 fixed options | left alone, deliberately |
| كشف الحساب — الحساب/الجهة | already a searchable combobox | **already worked** — 72 → 4 on «اسلام», → 1 on «C-0014» |
| كشف الحساب — consolidated table | **123 account rows, no filter at all** | **the real gap** |
| كشف حساب عميل | **plain `<select>` with 72 customers** | **the real gap** |

So the entity picker on the general statement was not broken. What was missing
was a way to search the 123-row results table it produces, and any search at all
on the customer statement.

### What changed

**كشف حساب عميل** now uses `SearchableSelect` — the app's existing combobox, the
same one the sales invoice and legacy return screens use — in both places a
customer is chosen (the filter bar and the «تسجيل حركة» dialog). A customer is
findable by code, Arabic name or phone. Inactive customers stay listed and are
marked «(غير نشط)» rather than hidden, because an inactive customer can still
have a history worth reading.

Rather than write a fourth copy of the customer→option mapping (three already
existed), the shared `toCustomerOptions` helper gained an optional
`markInactive` flag.

**كشف الحساب العام** gained a search box over the consolidated accounts table,
matching on code and name.

**The balances do not move.** This is the part that mattered most: the opening,
debit, credit and closing totals under that table are the API's authoritative
category totals, and filtering must not appear to change them. The filter is a
pure display function (`filterStatementAccounts`, unit-tested), the totals row
is untouched, and while a search is active the footer says
«(إجمالي كل حسابات القائمة)» so nobody reads a category total as a total of the
three visible rows. A browser test asserts the rendered numbers are byte-identical
before and after filtering.

Changing category clears a stale query, so a search from the old list cannot
hide the new one.

The category `<select>` stayed native on purpose: 15 fixed options are quicker to
scan than to type, mobile gets a native picker, and six end-to-end tests drive it
with `selectOption`. No accounting, balance, date-filter or
«إظهار الحسابات بدون حركة» behaviour was touched.

**Not done, and flagged rather than assumed:** كشف حساب المورد has the same plain
`<select>`. It was not in the brief's scope and has only 2 suppliers with
activity, so it is a one-line change available on request.

---

## Part B — تقرير ربحية الفواتير

### The calculation

```
صافي المبيعات بدون الضريبة  −  تكلفة البضاعة المباعة  =  إجمالي الربح
```

VAT is collected on the state's behalf and is never revenue. Operating expenses
(rent, salaries, transport) are not allocated to invoices. This is **gross
invoice profit**, not company net profit — a distinction the report states on
screen and in every export.

`subtotal` on the invoice **is** the ex-VAT net, and `Σ line_total = subtotal`.
The header `discount_amount` is a reporting echo of discounts already applied
inside `line_total`, so subtracting it would double-count the discount. It does
not enter the calculation.

### Cost, and the part worth reading carefully

COGS is the snapshot stamped when the invoice was posted, never today's moving
average. An invoice sold when stock cost 475/m stays at 475 after stock rises —
tested by moving the current average to 9999 after posting and asserting the
report does not budge.

But some legacy lines predate cost snapshots entirely, and the codebase's usual
fallback resolves those to `0` — which reads as *"this sale cost nothing"* and
prints a 100% margin. That would be the most dangerous number this report could
show, because it looks precise.

So every line is classified `METER_SNAPSHOT` / `LEGACY_BOARD` / `MISSING`, and:

- an invoice missing any line's cost shows its **sales** (those are known) with
  **cost, profit and margin explicitly «غير متاحة»**;
- the summary reports revenue over **all** confirmed invoices but cost and
  profit over the **cost-complete subset only**, and says how much revenue it had
  to leave out — «ربحية مؤكدة للفواتير ذات بيانات التكلفة المكتملة» alongside
  «فواتير تحتاج بيانات تكلفة تاريخية: N»;
- every aggregate tab uses the same split, so the tabs always reconcile with the
  invoice list.

Cost is never recovered from the current average, the last purchase price or the
catalogue. It was checked whether an authoritative recovery source exists:
`inventory_movements` carries **no cost column at all**, and its `referenceId` is
the invoice id rather than the line id, so a per-line cost cannot be recovered
even in principle. Anything derived would be fabricated, not recovered.

### Which documents count

- **CONFIRMED only.** Cancelling an invoice reverses its journals but leaves the
  document's totals intact, so omitting the status filter would silently inflate
  both revenue and cost.
- **A revised invoice counts once, at its current value.** Revision rewrites the
  invoice and its lines in place, so the row *is* the current economic state;
  `sales_invoice_revisions` is an audit spine, never a version of record, and
  joining it would multiply rows by revision count. Production contains a real
  revision-2 invoice, and it appears once at 30,240 — labelled «مراجعة 2».
- **Only CONFIRMED returns linked by `original_sales_invoice_id`** are
  subtracted, at the cost the return itself recorded. Draft and cancelled
  returns do not move any figure.
- **«مردودات بدون فواتير» are excluded.** A legacy return has no reliable link to
  an electronic invoice; matching one by customer, price or date would attach a
  guess to a specific customer's profit. A test asserts a confirmed legacy return
  leaves the report unchanged.

### What shipped

`GET /reports/sales/invoice-profitability` (+ `/aggregates`, `/:invoiceId`,
`/pdf`, `/export`, `/:invoiceId/pdf`) — all GET, all read-only, `OWNER` +
`ACCOUNTANT`, matching the other margin-bearing reports, enforced by the guard
rather than by hiding the menu entry. Non-OWNERs are branch-scoped in SQL.

The page carries 12 summary cards, the filters the brief asked for (dates,
branch, searchable customer, representative, product code, invoice number, cost
coverage), five tabs (الفواتير / الأصناف / العملاء / الفروع / مندوبي المبيعات),
a per-invoice drill-down, six insight panels, PDF and Excel.

**Excel is real .xlsx**, six Arabic sheets, numeric cells with display formats —
using `exceljs`, already a dependency for import parsing, so no new dependency.
Unknown costs are written as «غير متاحة», never as `0`, so they cannot sum
silently into a total.

The revenue and cost SQL expressions were lifted out of the sales-representative
report engine into a shared module. Two copies of a profit formula eventually
disagree, and the copy that disagrees is the one nobody notices.

---

## Verification

**Automated** — `1004/1004` API integration across `83/83` suites (baseline
`974/82`; 30 new), `359/359` API unit, `232/232` web unit (15 new), both builds
compile, and lint is **exactly at baseline**: 320 problems, 59 errors, 261
warnings, unchanged.

The integration suite pins the VAT exclusion, the double-discount trap, the
475-vs-9999 historical cost matrix, drafts and cancellations, a revision through
the real preview→execute flow, partial and full linked returns, draft/cancelled
returns, legacy returns staying out, missing and partial cost coverage,
reconciliation to persisted invoice totals to the cent, all four aggregations,
every filter, pagination, invalid input, authorization for three roles, PDF,
workbook contents, and a check that six report requests change no row count.

**On a restored copy of production** — the backup was verified (SHA-256,
`pg_restore --list`, full isolated restore, **55/55 watermark match**), then both
features were driven in a browser against that real data: **30/30 checks**,
including that filtering leaves the statement balances byte-identical and that
browsing wrote no business row. The report reconciled to the database exactly —
Σ `line_total` 1,027,392.50, Σ `subtotal` identical, COGS 879,517.47, and all
four aggregate tabs summing back to the same net.

**In production** — verified without authenticating at all, per the zero-write
rule: the four new endpoints return `401` (deployed and guarded) while a
non-existent sibling returns `404`, and the three web routes serve. Functional
verification was done on the restored copy precisely so production needed no
login.

## Production was not otherwise touched

A 55-field watermark was taken immediately before any code change and again
after deployment.

**54 of 55 fields are identical.** Schema untouched: 43 migrations, 63 tables,
859 columns, same latest migration. The deploy log reads *"No pending migrations
to apply. 43 migrations found"*. Business data identical, by count and by
fingerprint: 71 customers, 46 accounts, 104 journals, 239 journal lines
(debits = credits = 14,403,549.65), 40 sales invoices, 66 lines, 1 revision,
53 variants, 85 stock rows, 4172 boards, 18,344.35 metres, 199 movements,
42 customer transactions, 6 archive rows, and the OWNER fingerprint.

The single moving field is `audit_logs` +3 — three `LOGIN` rows at 13:41–13:43
UTC, **before** the 14:32 deployment, i.e. the client using the system.
Non-auth audit rows since deployment: **0**.

**Zero** schema changes, migrations, `db push`, seeds, backfills or repairs. No
test invoice, customer, product, return or journal. No Railway service, URL,
variable or credential changed; the temporary read-only runner was deleted and
only the three original services remain.

## Artifacts

- Backup: `pre-account-search-invoice-profitability-J7au-20260810T133126Z.dump`
  (463,443 bytes, SHA-256 `5be25888…315661ff`, 689 TOC entries, 63 tables),
  kept with the other production backups outside this repository.
- The scratch database and its temporary runner were removed afterwards.
