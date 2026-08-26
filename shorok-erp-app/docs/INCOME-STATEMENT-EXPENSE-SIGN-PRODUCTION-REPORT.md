# Income Statement expense sign + JE #83 correction

**Status:** live · **Date:** 2026-08-26 · **main:** `0e297d9`

Two separate things were wrong, and only one of them was in the code.

---

## A. Root cause

### The arithmetic was already correct

`FinancialReportsService.pnl()` computes, once:

```
revenue     = credit − debit          costOfSales = debit − credit
expense     = debit − credit          grossProfit = revenue − costOfSales
netProfit   = grossProfit − totalExpenses
```

The income statement page does not recompute anything — it renders `data.netProfit`
straight from the API. There is **no double negation anywhere in the code**.

### What actually made profit rise

Journal entry **#83** (`0ba09ef1-6fa6-44ef-94e5-40acfbc64005`, 2026-08-06, POSTED,
10 lines, balanced at 60,555.00) is a batch of customer collections. Four lines are
legitimate `Dr CASH-2 / Cr AR-CONTROL` receipts. The fifth pair was posted in the
same receipt direction:

```
Dr CASH-2                 900.00      باقي مصاريف مخزن الوراق
Cr 6100 النقل والشحن      900.00      باقي مصاريف مخزن الوراق
```

The expense account was **credited**. A credit balance on an expense account is a
negative expense — a refund or recovery — which legitimately increases profit. The
report was faithfully reporting a mis-posted entry:

```
grossProfit 629,645.88 − (−900.00) = netProfit 630,545.88
```

### The one genuine code defect

Presentation, not arithmetic. Parentheses are the accounting convention for a
deduction, so wrapping an already-negative amount negated it a second time
visually: the row printed as an expense of 900 while net profit was 900 **higher**.
The two halves of the same screen contradicted each other.

**Formula before:** unchanged — `grossProfit − totalExpenses`, correct.
**Display before:** `(${format(amount)})` regardless of sign → `(؜-٩٠٠٫٠٠ ج.م.‏)`.
**Display after:** a negative amount renders as a positive magnitude marked
«دائن», in green, with a hover explanation. Screen and CSV follow the same rule.

---

## B. The production correction

Because the original 900 was posted in the **opposite** direction, simply adding
`Dr 6100 900 / Cr CASH-2 900` would only neutralise it and leave zero expense. To
move the net effect from `expense −900 / cash +900` to `expense +900 / cash −900`
the corrective delta must be **double**:

| | Account | Debit | Credit |
|---|---|---|---|
| Entry **#250** (`4e68856b-7365-47fe-80e2-939db77f87aa`) | 6100 النقل والشحن | **1,800.00** | — |
| 2026-08-26 · ADJUSTMENT · `JE-83-CORRECTION` | CASH-2 خزنه فرع الوراق | — | **1,800.00** |

Combined effect of the #83 pair **plus** the correction, isolated from all other
activity: `6100 = +900.00 (debit)`, `CASH-2 = −900.00 (credit)` — exactly the
intended `Dr 6100 900 / Cr CASH-2 900`.

**Entry #83 was not reversed, edited or deleted.** Reversing it would have undone
four legitimate customer collections. Its line fingerprint is byte-identical before
and after (`6e146052b489cca549dcadc16fec1dc0`), and AR-CONTROL is unchanged at
4,338,465.00.

### Treasury consistency

`Treasury never stores a mutable balance` — every treasury balance is derived from
`journal_lines` on its GL account as `Σ(debit − credit)`. GL and treasury are the
same number, so a canonical journal keeps them consistent by construction; no
separate treasury workflow was needed.

TRZ-003 خزنه فرع الوراق (GL CASH-2): **92,135.00 → 90,335.00** (−1,800.00), and the
treasury API balance equals the GL-derived balance exactly.

---

## C. P&L, before and after

| | PRE | POST | Δ |
|---|---:|---:|---:|
| Revenue | 3,964,365.00 | 3,964,365.00 | **0.00** |
| Cost of sales | 3,334,719.12 | 3,334,719.12 | **0.00** |
| Gross profit | 629,645.88 | 629,645.88 | **0.00** |
| Total expenses | −900.00 | 900.00 | **+1,800.00** |
| Net profit | 630,545.88 | 628,745.88 | **−1,800.00** |

Account 6100 net contribution: **−900.00 → +900.00**. Expenses now reduce profit.

---

## D. Verification

**Scratch proof (isolated restore of production, before any production write):**
20/20 — entry #83 unchanged, collections intact, no AR reversal, 6100 −900 → +900,
expenses +1800, net profit −1800, revenue/COGS/gross profit unchanged, ledger
balanced, treasury = GL and −1800, no inventory/invoice/return/product/party/account
change, exactly one entry and two lines added and none modified.

**Tests:** API integration 84 suites / **1016** tests; API unit **359**; web unit
**239**; focused `income-statement-sign.spec.ts` **12/12** and `pnl-format.test.ts`
**7/7**; API build OK; web build OK. Lint **320 problems (59 errors, 261 warnings)** —
exactly the baseline, no new problems.

**Production UI acceptance (read-only):** 8/8 — page loads, the corrected expense
renders as a deduction in parentheses, no «دائن» marker remains, gross − 900 = net
(629,645.88 → 628,745.88), expenses sit below gross profit, and **zero** business
POST/PUT/PATCH/DELETE requests were issued.

---

## E. Backup

`pre-je83-expense-correction-J7au-20260826T103616Z.dump`
`/Users/otonom/projects/_shorok_private_import_20260801/production-repair-20260802/backup/`

594,335 bytes · SHA-256 `ae7cec498de6397b13c8631807361e0e0fd59bea63d330d0cd50ad59930293bb`
(remote = local) · 689 TOC entries · 63 TABLE DATA · restore errors **0** ·
restore matched production on **54/54** general and **11/11** JE83-specific fields.

The earlier `pre-income-statement-expense-sign-J7au-20260826T091235Z.dump` is also
retained.

---

## F. Database

schema.prisma diff **0** · migrations diff **0** · migration count **43 → 43** ·
tables **63 → 63** · columns **859 → 859** · seed unchanged · env/Railway config
unchanged. API deploy logged *"No pending migrations to apply. 43 migrations found."*

---

## G. Watermarks

Immediately-before-write → final, 54 fields: **47 identical**. The 7 that moved are
all consequences of the one approved correction:

| Field | PRE | FINAL |
|---|---|---|
| journals | 236 | 237 |
| journal_lines | 569 | 571 |
| total debit | 30,672,523.11 | 30,674,323.11 |
| total credit | 30,672,523.11 | 30,674,323.11 |
| ledger fingerprint | — | changed (2 lines added) |
| audit_logs | 1,211 | 1,214 |
| audit_non_auth | 1,017 | 1,018 |

**Unexpected business or schema changes: 0.** Unchanged: users and OWNER
fingerprint, branches, 91 customers, 11 suppliers, 46 accounts, posting profiles,
89 sales invoices, 136 lines, 4 revisions, 14 purchase invoices, 1 sales return,
2 legacy returns, 6 archive rows, 42 SKUs, 65 variants, 111 stock rows, 4,619
boards, 20,643.60 metres, 409 movements, 97 customer transactions, treasuries,
vouchers, expense tables.

`audit_non_auth` moved by exactly **+1** — the `CREATE journal_entry #250` row. The
`audit_logs` +3 is that row plus **2 LOGIN rows** from the read-only acceptance
logins; those are authentication noise, not business writes.

---

## H. Git & deployment

| | |
|---|---|
| Branch | `fix/income-statement-expense-sign` |
| Feature commit before identity fix | `d90bc42` (unpushed) |
| Amended commit | `0e297d9` — tree byte-identical |
| Author / Committer | Ahmed Attia <ahmedatia733@gmail.com> |
| main | `45087b2` → `0e297d9` (fast-forward only) |
| origin/main | `0e297d9` — matches HEAD |
| Web deployment | `dbfb7e19-c4fc-4e24-ad7d-d1879203ee95` RUNNING |
| API deployment | `e2697e2b-e298-4d40-af87-aeb5fb04e7d3` RUNNING |

No force push, no history rewrite of any pushed commit, no Amr Mohamed identity in
the pushed commit. The global git identity was not modified — only this repository's
local config.

---

## I. Production safety

No seed, no `db push`, no backfill, no raw SQL write, no schema change. No test
invoice, product, customer, return, stock movement, treasury transaction or journal
beyond the single approved correction. No credential, Keychain, OWNER, service, URL
or environment variable was changed. The temporary runner `shorok-je83-runner` was
deleted; the final topology is exactly `Postgres-J7au`, `perpetual-warmth`,
`shorok-erp-app`. Both verified backups are retained; the scratch databases were
dropped after verification.

---

## J. Worth the client's attention

The mis-post also overstated **cash**: entry #83 recorded 900 coming *into* TRZ-003
that was actually spent. The correction removes it, so the treasury now reads
90,335.00. If the physical cash box was already short by 900, it now reconciles; if
it was not, the 900 needs tracing.

Nothing prevents the same mistake recurring — the manual journal screen will accept
a credit to an expense account, which is legitimate for a genuine refund. The
statement now makes such a balance obvious («دائن», in green) instead of disguising
it as a deduction.
