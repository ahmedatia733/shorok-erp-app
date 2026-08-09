# مردودات بدون فواتير — Legacy Returns Without Invoice

**Status:** live in production · **Date:** 2026-08-09 · **Commit:** `d3a8d6c`

A customer walks in with a paper invoice from before the ERP existed and returns
goods against it. The merchandise is resalable, it goes back into stock, and its
value is credited to the customer's account. No cash leaves the business.

Until now that transaction had nowhere to live: every return path in the system
starts from an electronic sales invoice, and for these sales there isn't one.

---

## What was decided, and why it needed deciding

Implementation was **blocked and reported** before any code was written, because
two questions could only be answered by the business:

**1. What cost do the goods come back at?**
An invoice-linked return reverses the cost snapshotted on the original invoice
line — the exact cost those boards left stock at. A legacy return has no such
line, and no honest way to reconstruct one.

The approved policy: **the variant's current weighted-average cost, at the
moment of confirmation.** Explicitly not the selling price, not the default
purchase price, not the latest purchase price, not zero, and never fabricated.

This has a useful property. Goods arriving *at* the current average cannot move
that average — `newValue / newMeters` resolves back to the same number. So the
policy values the return without distorting the valuation of everything already
on the shelf. It is also why the existing weighted-average code could be reused
rather than duplicated.

**2. Where does the return post?**
`PostingProfile.salesReturnsAccountId` was `NULL` in production with no
candidate account, so confirming *any* return would have failed. The business
authorized creating one contra-revenue account for it.

---

## What changed in production

Three deliberate changes, all authorized in advance, and nothing else.

| # | Change | Result |
|---|---|---|
| A | Additive migration `20260809180000_legacy_sales_returns` | 2 new tables, 61 → 63 |
| B | New Chart-of-Accounts detail account | `4200` «مردودات المبيعات», active leaf REVENUE |
| C | Posting profile now points sales returns at it | superseded, not rewritten |

**On the account code.** `4200` was verified unused, sits under the existing
revenue block (`4000 الإيرادات`, `4100 إيرادات المبيعات`), and was created as a
posting *leaf* — parents are never postable, and the configuration path rejects
a non-leaf, inactive or non-revenue account outright.

**On the profile.** Posting profiles are effective-dated. The existing row was
left exactly as it was and a copy created carrying every other leg forward
unchanged, verified field-by-field on read-back. Rewriting the row in place
would have silently restated what historical entries meant.

Both B and C ran over the real HTTP API as a real user through
`apps/api/scripts/configure-sales-returns-account.ts` — Zod validation, the
OWNER guard, the leaf/active/revenue check, and the audit trail. No row was
written directly. The script is idempotent: re-running it is a no-op, and it
refuses to repoint a profile that already has a sales-returns account.

---

## The document

`LegacySalesReturn` + `LegacySalesReturnLine`. It records the paper invoice
number and date as **reference text, not a relation** — there is no row to point
at, and inventing a fake `SalesInvoice` to hang it from would corrupt sales
history to satisfy a foreign key.

**Draft** does nothing at all. **Confirm**, in one transaction:

1. locks the variants, reads each current weighted-average cost, and **freezes**
   it onto the line as `costPerMeterSnapshot` with the resulting `lineCogs`;
2. posts the commercial entry — Dr «مردودات المبيعات» (net) + Dr VAT-out, Cr the
   customer's receivable;
3. posts the cost entry — Dr Inventory, Cr COGS;
4. puts the boards back into stock through the shared return-costing path;
5. credits the customer's ledger.

**Confirmation is refused** — in Arabic, naming the item — when the exact variant
has no authoritative weighted-average cost. A return cannot be valued out of
thin air, so the system says so rather than guessing.

**Cancel** reverses the *persisted* amounts, never whatever the average happens
to be later, and is refused if the returned goods have since been sold.

Both operations take a row lock and re-read inside the transaction, so a double
click or a retried request cannot post twice.

## One costing path, not two

`ReturnStockService` was extracted from the invoice-linked return **unchanged**
and is now shared by both documents. Two weighted-average implementations would
eventually disagree, and the one that disagreed would be the one nobody tested.

What differs is only the value each document hands over: historical snapshot for
an invoice-linked return, current average for a legacy one. The arithmetic is
identical.

---

## Verification

**Automated** — `974/974` API integration across `82/82` suites (baseline
`954/81`; 20 new), `359/359` API unit, `222/222` web unit, both builds compile,
no new lint findings.

The new suite covers the cost-snapshot matrix (a later average change does not
rewrite a confirmed return), the zero/absent-cost block, draft-has-no-effect,
idempotent confirm and cancel, three concurrent confirms posting exactly two
journals, cancellation refused after the goods are consumed, immutability of a
confirmed document, ك/ص/custom size identity, and that no `SalesInvoice` or
`SalesReturn` is ever fabricated.

**On a restored copy of production** — the backup was verified by SHA-256,
`pg_restore --list`, and a full isolated restore that matched the production
watermark on **all 39 fields**. Then, on that real data, 17 checks passed:
account creation, profile supersession, a legacy return against genuine stock
(cost snapshot `498.0000`, average unmoved, stock up by the returned boards,
balanced journals, no treasury movement).

**Including the mandatory regression.** Because account `4200` also unblocks the
existing invoice-linked return path, that path was tested there too: it now
confirms, and it still reverses the **historical** `unitCostPerMeterAtPosting`
from the original invoice line — no current-average leak — and posts to `4200`.

**In production** — 14 read-only checks: the endpoint is live and empty, filters
work, the account and profile are wired, the list PDF renders, and the sidebar
entry «مردودات بدون فواتير» opens a working, honestly-empty page whose form asks
for the paper invoice and offers customer and product entry.

## Production was not otherwise touched

A watermark of 39 fields was taken immediately before the first change and again
after everything was done.

**Unauthorized business-data changes: 0.** Identical across the whole operation:
37 SKUs, 53 variants (same fingerprint), 85 stock rows, 4187 boards,
18400.6 metres, inventory value 9,594,756.51, 39 sales invoices, 7 purchase
invoices, 6 transfers, 193 movements, 100 journals, 231 journal lines
(debits = credits = 14,238,667.64, same fingerprint), 40 customer transactions
totalling 1,058,082.50, 3 branches, 9 users, and the OWNER fingerprint.

The **6 rows of `HistoricalSalesReturnArchive` are untouched** — not converted,
not reposted, not migrated. They remain the historical record they were.

The only differences are the three authorized changes above, plus 7 audit rows:
2 non-auth (exactly the account and the profile) and 5 logins.

**No** test return, customer, product, invoice, movement or journal was created
in production. No seed, no `db push`, no backfill, no repair. The OWNER
credential was neither changed nor rotated.

## Artifacts

- Backup: `backup/pre-legacy-returns-no-invoice-J7au-20260809T180011Z.dump`
  (426,263 bytes, SHA-256 `5afe0b55…c8d81c9a18`, 588 TOC entries, 61 tables) —
  taken fresh immediately before the change and retained.
- The scratch database and its temporary runner were removed afterwards.
