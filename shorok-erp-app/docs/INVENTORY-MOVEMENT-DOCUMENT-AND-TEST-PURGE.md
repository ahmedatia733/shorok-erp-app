# Inventory Movement Document Column + Test Document Purge

**Status:** live in production · **Date:** 2026-08-27 · **Commits:** `82fda3e`, `4cebcd2`

النسخة العربية: [INVENTORY-MOVEMENT-DOCUMENT-AND-TEST-PURGE.ar.md](INVENTORY-MOVEMENT-DOCUMENT-AND-TEST-PURGE.ar.md)

Two things in one delivery: showing which document produced each stock
movement, and removing the two test documents left on the returns screen.

---

## Part A — what was actually wrong

The brief described legacy sales returns as missing or mis-linked in Inventory
Movements. The audit found something different, and it changed what needed
building:

| Assumed | Found |
|---|---|
| Movements missing | **All present and correct** — every confirmed return has its movement |
| Quantities wrong | **Exact** — boards and metres both match |
| Duplicate movements | **None** |
| Linking broken | **Yes — this was the real gap** |

The table listed every movement without saying **what caused it**, so a
«مردود بدون فاتورة» looked like stock appearing for no reason.

**So no data was repaired.** Inserting a movement would have duplicated a
record that was already correct.

---

## Part B — the المستند column

Every movement stores `referenceType` and `referenceId` at the moment the
engine wrote it, so its source is knowable **structurally**. The new column
maps that pair to an Arabic label and, where the document has a page, a link.

- **All fourteen reference types** present in the live ledger are labelled.
- **Every stored `referenceId` resolves to a real document**: 134 sales
  invoices, 112 transfers, 75 purchases, 5 legacy returns, 1 sales return —
  **100%**. No link is speculative.
- An unmapped type echoes its raw key rather than rendering blank, so a
  document kind added later cannot make a movement look sourceless.

### Keyed on the stored type, never on the Arabic note

Matching is on the stored `referenceType`, **not the note**. The note is free
text written for a human — rewording it would break the match, and more
importantly it cannot distinguish «مردود بدون فاتورة» from an invoice-linked
«مردود مبيعات». Those are different documents on different pages, and that
confusion is exactly what produced the "not found" link on the customer
statement.

### Deliberate details

- **Transfers link too**: 112 of the movements are transfers and the page
  already existed.
- **Opening balances are labelled but not linked** — they carry a reference,
  but no opening-balance page exists to open.
- **Links use `Link`, not `<a>`**: a full reload drops the session cookie and
  bounces the user to the login screen.
- The header goes through a translation key (`columns.document`) in both
  locales, like every neighbouring column.

---

## Part C — the test document purge

Two documents under a test customer were left on the returns screen:

| Document | Status | Contents |
|---|---|---|
| **LRN-4** | DRAFT | One line. No journals, no movements, no customer transactions |
| **LRN-3** | CANCELLED | Confirmed then cancelled — a full chain, but **every net is zero** |

### Why deletion was safe

LRN-3's chain was **entirely self-contained**, every side cancelling its pair:

| Component | Effect |
|---|---|
| 2 inventory movements | +2 boards / +10.5 m then −2 / −10.5 → **zero** |
| 4 journal entries (#251–254) | debit = credit = 113,547.00 |
| Net per account (4200, 5100, AR, Inventory) | **0.00 on every one** |
| 2 customer transactions | CR 51,544.50 then DR 51,544.50 → **zero** |
| Cash/bank accounts | **none touched at all** |
| Other documents referencing those journals | **zero** |

### Rehearsed on a restored copy

The deletion was run first against a full restored copy of production, then
compared against the untouched original:

| Check | Result |
|---|---|
| Tables byte-identical | **57 / 63** |
| Rows removed / added / modified | **18 / 0 / 0** |
| Foreign keys re-validated | **182, zero violations** |
| Trial balance | **byte-identical** |
| Customer balances (all 92) | **numerically identical** |
| Inventory, WAC, treasury | **identical** |
| LRN-1 / LRN-2 | **untouched** |
| Second run | "both documents are already absent — nothing to do" |

The six tables that changed changed **only by subtraction** — nothing was
added and nothing was modified in place.

### The production result

The **same tested script** was run inside the API container. It matched the
rehearsal:

- **23 of 35** watermark fields **unchanged**
- **Trial balance byte-identical** — both the hash and the full text
- **All 92 customer balances numerically identical**
- Inventory 4,619 boards / 20,643.60 metres — **unchanged**
- Treasury and weighted-average cost — **unchanged**
- **182 foreign keys** re-validated with no violation
- **The ledger is still balanced**

---

## ⚠ One consequence that must be read

**Journal entries #251–254 are gone, leaving a permanent gap in the numbering
(250 → 255).** Two of them (#253, #254) were **POSTED**.

The important part: `entry_number` comes from a **database sequence**, not
`MAX()+1`. The sequence still reads 254, so the next entry takes **255** —
**no number is ever reused**. The gap stays visible as evidence that something
was removed, which is the correct behaviour; reuse would have been the real
danger.

Those four entries were also the **last four in the ledger** (the highest
remaining is #250, the JE-83 correction), so nothing later depends on them.

The ledger is balanced and every report is unaffected, but this is an
irreversible mark on the journal sequence and it sits against the
posted-record immutability principle. It is recorded here rather than buried.

**The test customer C-0087 was not deleted** — it was not in scope. It remains
with no documents and no transactions.

---

## Verification

**Automated:** API integration **1027/1027** (84 suites), API unit
**359/359**, web unit **273/273**, both builds compile, and lint is **exactly
at baseline** (469 problems / 234 errors / 235 warnings — measured with and
without these changes). **Schema, migration and seed delta = 0**; 43
migrations unchanged.

**In a real browser (Chromium):** 5 tests seed a confirmed legacy return
through the API and drive the page. The one that matters most is negative: it
fails if a legacy return ever points at `/sales/returns/<id>` again.

**Against real production data:** the actual production rows were fed through
the shipped mapper — **3 of 3** legacy-return movements (LRN-1 with two,
LRN-2 with one) resolve to «مردود بدون فاتورة» linking to their own page.

---

## The backup

A full backup was taken **before** any change and fully verified:

- `pre-legacy-return-inventory-link-fix-J7au-20260826T210320Z.dump`
- 602,159 bytes · SHA-256 `6d2a5310…52142c4`
- 689 TOC entries · 63 tables · isolated restore exit 0, zero errors
- 63/63 row counts · 63/63 fingerprints · 25/25 accounting invariants

It was confirmed to still match production at deletion time: **all 92 customer
balances numerically identical**. (An ordering-hash difference was a Debian vs
macOS collation artifact, not data.)

The backup is kept outside this repository and was not deleted.

---

## Production was not otherwise touched

No schema change, migration, `db push`, seed, backfill or repair. No test
invoice, customer, product or journal. No Railway service, URL, variable or
credential was changed; the temporary `shorok-lrn-purge` runner was deleted
and only the three original services remain. The scratch databases were
dropped.

**No password, owner identity or permission was changed.**
