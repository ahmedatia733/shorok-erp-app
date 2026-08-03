/**
 * Posts ONE capital-funded refundable-deposit journal entry.
 *
 * A refundable deposit is not an expense. Money left with a landlord and
 * recoverable at the end of a lease is an asset the business still owns, and
 * where the owner funded it personally it is additional capital — not a cost.
 * Booking it as an expense would understate both assets and equity and would
 * misstate profit for the period.
 *
 *   Dr  <asset>    amount     (an active leaf ASSET account, e.g. تأمينات لدى الغير)
 *   Cr  <capital>  amount     (the existing equity Capital account)
 *
 * Everything goes over the real HTTP API as a real user, so the entry travels
 * the ordinary path: Zod validation, role guards, leaf/active account checks,
 * period lookup, balancing, numbering, PostingEngine and the audit trail. No row
 * is written directly.
 *
 * Nothing about a particular business is baked in. The amount, the date, the
 * accounts and the source row all come from arguments and from an approved
 * dataset file that lives outside this repository, because that file carries
 * private names.
 *
 *   pnpm --filter @shorok/api deposit:post -- \
 *     --base <url> --phone <e164> --actor-id <uuid> \
 *     --dataset <path> --source-row 7 --source-key AUG2026:REFUNDABLE-DEPOSIT:ROW7 \
 *     --amount 60000.00 --capital-code 3100 \
 *     --asset-code 1260 --asset-name-ar "تأمينات لدى الغير" --asset-name-en "Deposits with Others" \
 *     [--execute]
 *
 * Without --execute it validates everything against production, prints the exact
 * entry it would post, and writes nothing. The password is read from the
 * SHOROK_PASSWORD environment variable and is never logged.
 */
import { readFileSync } from "node:fs";

interface Line {
  accountId: string;
  debit: string;
  credit: string;
  note?: string;
}

/** The subset of a journal entry this script reads back and verifies. */
interface JournalEntry {
  id: string;
  entryNumber: number | string;
  entryDate: string;
  reference: string | null;
  lines?: Array<{ accountId: string; debit: string; credit: string; partyId?: string | null }>;
}

interface Period {
  year: number;
  month: number;
  status: string;
}

/** One approved source row from the private dataset. */
interface SourceRow {
  sourceRow: number | string;
  sourceReference?: string;
  sourceFingerprint: string;
  amount: string | number;
  expenseDate?: string;
  date?: string;
}

interface Account {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  category: string;
  accountType?: string;
  isLeaf: boolean;
  active: boolean;
  isCashOrBank: boolean;
  treasuryType: string | null;
  systemRole: string | null;
  children?: Account[];
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  }
  return process.argv[i + 1];
}

const BASE = arg("base").replace(/\/$/, "");
const EXECUTE = process.argv.includes("--execute");

let token = "";

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  allow: number[] = [200, 201],
): Promise<T> {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const payload = text.trim() ? JSON.parse(text) : {};
  if (!allow.includes(res.status)) {
    throw new Error(`HTTP ${res.status} on ${method} ${path}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload as T;
}

/** This API wraps collections three different ways; guessing one is how a
 *  duplicate check goes blind and re-posts. All three are handled explicitly. */
function rows<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  const record = payload as Record<string, unknown> | null;
  for (const key of ["data", "items", "results"]) {
    const value = record?.[key];
    if (Array.isArray(value)) return value as T[];
  }
  throw new Error(`unrecognised collection response: ${JSON.stringify(payload).slice(0, 200)}`);
}

/** Walks every page. A duplicate on page 2 must still be found. */
async function allRows<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const sep = path.includes("?") ? "&" : "?";
    const page = await api<{ nextCursor?: string | null }>(
      "GET",
      cursor ? `${path}${sep}cursor=${cursor}` : path,
    );
    out.push(...rows<T>(page));
    cursor = page?.nextCursor ?? null;
    if (!cursor) return out;
  }
}

function flattenAccounts(tree: Account[]): Account[] {
  const out: Account[] = [];
  const walk = (ns: Account[]) => ns.forEach((n) => { out.push(n); walk(n.children ?? []); });
  walk(tree);
  return out;
}

/** An account is only safe to debit for a deposit if it is a plain asset leaf.
 *  Each rejection is stated so a wrong pick fails loudly rather than posting. */
function assertUsableAssetAccount(a: Account): void {
  const problems: string[] = [];
  if (!a.active) problems.push("inactive");
  if (!a.isLeaf) problems.push("not a leaf (parents are never postable)");
  if (a.category !== "ASSET") problems.push(`category is ${a.category}, expected ASSET`);
  if (a.isCashOrBank) problems.push("flagged as cash/bank");
  if (a.treasuryType) problems.push(`has treasuryType ${a.treasuryType}`);
  if (a.systemRole) problems.push(`has systemRole ${a.systemRole} — reserved for engine posting`);
  if (/^TEST|DEMO/i.test(a.code)) problems.push("looks like a test/demo account");
  if (problems.length) throw new Error(`asset account ${a.code} is not usable: ${problems.join("; ")}`);
}

function assertUsableCapitalAccount(a: Account, code: string): void {
  const problems: string[] = [];
  if (a.code !== code) problems.push(`code is ${a.code}, expected ${code}`);
  if (!a.active) problems.push("inactive");
  if (!a.isLeaf) problems.push("not a leaf");
  if (a.category !== "EQUITY") problems.push(`category is ${a.category}, expected EQUITY`);
  if (a.systemRole) problems.push(`has systemRole ${a.systemRole}`);
  // Opening-balance equity and the cutover holding account are equity too, and
  // posting owner capital into either of them would quietly corrupt the cutover
  // reconciliation. Name them out explicitly.
  if (/OPENING|CUTOVER|RETAINED|PROFIT/i.test(a.code)) {
    problems.push(`${a.code} is a reserved equity account, not owner capital`);
  }
  if (problems.length) throw new Error(`capital account is not usable: ${problems.join("; ")}`);
}

async function main(): Promise<void> {
  const phone = arg("phone");
  const actorId = arg("actor-id");
  const datasetPath = arg("dataset");
  const sourceRow = Number(arg("source-row"));
  const sourceKey = arg("source-key");
  const amount = arg("amount");
  const capitalCode = arg("capital-code", "3100");
  const assetCode = arg("asset-code");
  const assetNameAr = arg("asset-name-ar");
  const assetNameEn = arg("asset-name-en");
  const parentCode = arg("parent-code", "1200");
  const descriptionAr = arg("description-ar");
  const descriptionEn = arg("description-en");

  const password = process.env.SHOROK_PASSWORD;
  if (!password) throw new Error("SHOROK_PASSWORD must be set in the environment");

  console.log(`  target        : ${BASE}`);
  console.log(`  mode          : ${EXECUTE ? "EXECUTE" : "DRY RUN (validates, writes nothing)"}`);

  // ── 1. source row, from the approved dataset ─────────────────────────────
  const dataset = JSON.parse(readFileSync(datasetPath, "utf8")) as Record<string, SourceRow[]>;
  const pool: SourceRow[] = [
    ...(dataset.augustExpenses ?? []),
    ...(dataset.expenses ?? []),
    ...(dataset.rows ?? []),
  ];
  const matches = pool.filter((r) => Number(r.sourceRow) === sourceRow);
  if (matches.length !== 1) {
    throw new Error(`expected exactly 1 dataset row with sourceRow=${sourceRow}, found ${matches.length}`);
  }
  const src = matches[0];
  if (Number(src.amount) !== Number(amount)) {
    throw new Error(`dataset amount ${src.amount} does not equal --amount ${amount}`);
  }
  const fp: string = src.sourceFingerprint;
  if (!fp || fp.length < 32) throw new Error("dataset row has no usable sourceFingerprint");
  const reference = `${sourceKey}#${fp.slice(0, 12)}`;
  const entryDate: string = src.expenseDate ?? src.date ?? arg("entry-date");

  console.log(`  source row    : ${sourceRow} (${src.sourceReference})`);
  console.log(`  amount        : ${Number(amount).toFixed(2)}`);
  console.log(`  entry date    : ${entryDate}`);
  console.log(`  reference     : ${reference}`);
  console.log(`  fingerprint   : ${fp.slice(0, 12)}…`);

  // ── 2. authenticate and bind the actor by id AND phone ───────────────────
  const login = await api<{ accessToken: string }>("POST", "/auth/login", { phone, password });
  token = login.accessToken;
  const me = await api<{ id: string; phone: string; role: string; status: string }>("GET", "/auth/me");
  if (me.id !== actorId || me.phone !== phone) {
    throw new Error("ACTOR_IDENTITY_MISMATCH: the authenticated user is not the approved actor id + phone");
  }
  console.log(`  actor         : bound by id + phone (role ${me.role}, status ${me.status})`);

  // ── 3. period must be open for the entry's month ─────────────────────────
  const periods = rows<Period>(await api<unknown>("GET", "/settings/periods"));
  const [y, m] = entryDate.split("-").map(Number);
  const period = periods.find((p) => p.year === y && p.month === m);
  if (!period) throw new Error(`no financial period exists for ${y}-${String(m).padStart(2, "0")}`);
  if (period.status !== "OPEN") throw new Error(`financial period ${y}-${m} is ${period.status}, not OPEN`);
  console.log(`  period        : ${y}-${String(m).padStart(2, "0")} ${period.status}`);

  // ── 4. capital account ───────────────────────────────────────────────────
  const chart = flattenAccounts(rows<Account>(await api<unknown>("GET", "/accounts")));
  const capital = chart.find((a) => a.code === capitalCode);
  if (!capital) throw new Error(`capital account ${capitalCode} not found`);
  assertUsableCapitalAccount(capital, capitalCode);
  console.log(`  capital       : ${capital.code} ${capital.nameEn} (${capital.category}, leaf, active)`);

  // ── 5. asset account: reuse an exact match, otherwise create one ─────────
  let asset = chart.find((a) => a.code === assetCode)
    ?? chart.find((a) => a.nameAr === assetNameAr && a.category === "ASSET");
  if (asset) {
    assertUsableAssetAccount(asset);
    console.log(`  asset         : reusing existing ${asset.code} ${asset.nameAr}`);
  } else if (EXECUTE) {
    const parent = chart.find((a) => a.code === parentCode);
    if (!parent) throw new Error(`parent account ${parentCode} not found`);
    if (parent.category !== "ASSET") throw new Error(`parent ${parentCode} is ${parent.category}, expected ASSET`);
    await api("POST", "/accounts", {
      code: assetCode,
      nameAr: assetNameAr,
      nameEn: assetNameEn,
      category: "ASSET",
      accountType: "CURRENT_ASSET",
      parentId: parent.id,
    });
    // Re-fetch rather than trusting the create response, then re-assert every
    // property the posting depends on.
    const after = flattenAccounts(rows<Account>(await api<unknown>("GET", "/accounts")));
    asset = after.find((a) => a.code === assetCode);
    if (!asset) throw new Error(`account ${assetCode} was created but does not read back`);
    assertUsableAssetAccount(asset);
    console.log(`  asset         : created ${asset.code} ${asset.nameAr} (${asset.category}, leaf, active, not cash/bank)`);
  } else {
    console.log(`  asset         : WOULD CREATE ${assetCode} ${assetNameAr} under ${parentCode}`);
  }

  // ── 6. duplicate refusal, across every page of history ───────────────────
  const entries = await allRows<JournalEntry>("/journal?limit=100");
  const byReference = entries.filter((e) => String(e.reference ?? "") === reference);
  const bySourceKey = entries.filter((e) => String(e.reference ?? "").includes(sourceKey));
  console.log(`  history       : ${entries.length} journal entries scanned`);

  if (bySourceKey.length > 0) {
    if (byReference.length !== 1 || bySourceKey.length !== byReference.length) {
      throw new Error(
        `BLOCKED_CONFLICTING_SOURCE_REFERENCE: ${bySourceKey.length} entries carry source key ${sourceKey}, ` +
        `${byReference.length} match the exact fingerprinted reference`,
      );
    }
    const detail = await api<JournalEntry>("GET", `/journal/${byReference[0].id}`);
    const lines = detail.lines ?? [];
    const dr = lines.reduce((sum, l) => sum + Number(l.debit ?? 0), 0);
    const cr = lines.reduce((sum, l) => sum + Number(l.credit ?? 0), 0);
    const ok =
      lines.length === 2 &&
      Math.abs(dr - Number(amount)) < 0.005 &&
      Math.abs(cr - Number(amount)) < 0.005 &&
      String(detail.entryDate).slice(0, 10) === entryDate &&
      lines.some((l) => l.accountId === asset?.id && Number(l.debit) > 0) &&
      lines.some((l) => l.accountId === capital.id && Number(l.credit) > 0);
    if (!ok) {
      throw new Error(
        `BLOCKED_CONFLICTING_SOURCE_REFERENCE: entry ${detail.entryNumber} exists for this source row ` +
        `but does not reconcile (lines=${lines.length} dr=${dr} cr=${cr} date=${String(detail.entryDate).slice(0, 10)})`,
      );
    }
    console.log(`\n  ALREADY_POSTED_AND_RECONCILED`);
    console.log(`    entry ${detail.entryNumber} (${detail.id}) Dr ${dr.toFixed(2)} / Cr ${cr.toFixed(2)} on ${entryDate}`);
    console.log(JSON.stringify({ result: "ALREADY_POSTED_AND_RECONCILED", journalEntryId: detail.id, entryNumber: detail.entryNumber }));
    return;
  }

  // ── 7. the entry ─────────────────────────────────────────────────────────
  if (!asset) {
    console.log("\n  DRY RUN — the asset account does not exist yet, so the entry cannot be fully");
    console.log("  materialised here. Everything else validated. Nothing written.");
    return;
  }
  const lines: Line[] = [
    { accountId: asset.id, debit: Number(amount).toFixed(2), credit: "0", note: `${sourceKey} — deposit` },
    { accountId: capital.id, debit: "0", credit: Number(amount).toFixed(2), note: `${sourceKey} — owner capital` },
  ];
  const totalDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
  const totalCredit = lines.reduce((s, l) => s + Number(l.credit), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.005) throw new Error("entry is not balanced");
  if (lines.length !== 2) throw new Error("entry must have exactly two lines");

  const body = {
    entryType: "JOURNAL" as const,
    entryDate,
    description: descriptionAr,
    reference,
    // The server's own unique index on this column is what makes a repeat POST a
    // no-op; omitting it would make every retry a new entry.
    idempotencyKey: reference,
    lines,
  };

  console.log(`\n  entry to post :`);
  console.log(`    date        ${entryDate}`);
  console.log(`    description ${descriptionAr}`);
  console.log(`    reference   ${reference}`);
  console.log(`    Dr ${asset.code} ${asset.nameAr.padEnd(24)} ${Number(amount).toFixed(2)}`);
  console.log(`    Cr ${capital.code} ${capital.nameAr.padEnd(24)} ${Number(amount).toFixed(2)}`);
  console.log(`    balance gap ${(totalDebit - totalCredit).toFixed(2)}`);
  console.log(`    english     ${descriptionEn}`);

  if (!EXECUTE) {
    console.log(`\n  DRY RUN — validated against production, nothing written.`);
    return;
  }

  const created = await api<{ id: string }>("POST", "/journal", body);
  const detail = await api<JournalEntry>("GET", `/journal/${created.id}`);
  const dl = detail.lines ?? [];
  const dr = dl.reduce((sum, l) => sum + Number(l.debit ?? 0), 0);
  const cr = dl.reduce((sum, l) => sum + Number(l.credit ?? 0), 0);

  const failures: string[] = [];
  if (dl.length !== 2) failures.push(`expected 2 lines, got ${dl.length}`);
  if (Math.abs(dr - Number(amount)) > 0.005) failures.push(`debit ${dr} != ${amount}`);
  if (Math.abs(cr - Number(amount)) > 0.005) failures.push(`credit ${cr} != ${amount}`);
  if (Math.abs(dr - cr) > 0.005) failures.push(`unbalanced by ${dr - cr}`);
  if (String(detail.entryDate).slice(0, 10) !== entryDate) failures.push(`date ${detail.entryDate} != ${entryDate}`);
  if (String(detail.reference) !== reference) failures.push(`reference mismatch`);
  if (!dl.some((l) => l.accountId === asset.id && Number(l.debit) > 0)) failures.push("asset not debited");
  if (!dl.some((l) => l.accountId === capital.id && Number(l.credit) > 0)) failures.push("capital not credited");
  if (dl.some((l) => l.partyId)) failures.push("a line carries a party dimension");
  if (failures.length) throw new Error(`POSTED ENTRY FAILED VERIFICATION: ${failures.join("; ")}`);

  console.log(`\n  POSTED`);
  console.log(`    journalEntryId ${detail.id}`);
  console.log(`    entryNumber    ${detail.entryNumber}`);
  console.log(`    Dr ${dr.toFixed(2)} / Cr ${cr.toFixed(2)}  gap ${(dr - cr).toFixed(2)}`);
  console.log(JSON.stringify({
    result: "POSTED",
    journalEntryId: detail.id,
    entryNumber: detail.entryNumber,
    reference,
    assetAccountId: asset.id,
    assetAccountCode: asset.code,
    capitalAccountId: capital.id,
    capitalAccountCode: capital.code,
    debit: dr.toFixed(2),
    credit: cr.toFixed(2),
    entryDate,
  }));
}

main().catch((e) => {
  console.error(`  FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
