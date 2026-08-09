/**
 * Creates the contra-revenue account that sales returns are booked to, and
 * points the posting profile at it.
 *
 * Returns credit the customer and reverse revenue, but they must not be netted
 * off the revenue account itself: a business needs to see what it sold and what
 * came back as two separate facts, and a revenue account quietly reduced by
 * returns can no longer answer either question. So returns land in their own
 * contra-revenue account, and the posting profile is what tells the engine
 * which one that is. Until it is set, confirming a return has nowhere to post
 * and is refused.
 *
 * This runs the two changes it is named for and nothing else:
 *
 *   1. one new active leaf REVENUE account (default 4200 «مردودات المبيعات»);
 *   2. one new posting profile that is a copy of the current effective profile
 *      with salesReturnsAccountId filled in.
 *
 * The profile is superseded rather than edited. Posting profiles are
 * effective-dated precisely so that history keeps posting the way it posted —
 * rewriting the existing row would silently restate what old entries meant.
 *
 * Everything goes over the real HTTP API as a real user, so both changes travel
 * the ordinary path: Zod validation, the OWNER role guard, the leaf/active/
 * REVENUE check on the account being wired, and the audit trail. No row is
 * written directly, and no existing row is modified.
 *
 *   pnpm --filter @shorok/api sales-returns-account:configure -- \
 *     --base <url> --phone <e164> [--code 4200] [--execute]
 *
 * Without --execute it inspects production, prints exactly what it would do,
 * and writes nothing. Re-running after a successful run is a no-op: an existing
 * account with the same code is reused, and a profile already pointing at it is
 * left alone. The password is read from SHOROK_PASSWORD and is never logged.
 */

interface Account {
  id: string;
  code: string;
  nameAr: string;
  category: string;
  accountType: string;
  isLeaf: boolean;
  active: boolean;
}

interface PostingProfile {
  id: string;
  effectiveFrom: string;
  salesReturnsAccountId: string | null;
  [key: string]: unknown;
}

/** Every account leg a profile carries, so a superseding copy loses nothing. */
const PROFILE_LEGS = [
  "arAccountId",
  "apAccountId",
  "revenueAccountId",
  "salesReturnsAccountId",
  "cogsAccountId",
  "inventoryAccountId",
  "vatInputAccountId",
  "vatOutputAccountId",
  "discountAccountId",
  "roundingAccountId",
  "retainedEarningsAccountId",
  "openingEquityAccountId",
  "shrinkageAccountId",
] as const;

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (value === undefined || value.startsWith("--")) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const base = arg("base").replace(/\/$/, "");
  const phone = arg("phone");
  const code = arg("code", "4200");
  const nameAr = arg("name-ar", "مردودات المبيعات");
  const nameEn = arg("name-en", "Sales Returns");
  const execute = process.argv.includes("--execute");
  const password = process.env.SHOROK_PASSWORD;
  if (!password) throw new Error("SHOROK_PASSWORD is not set");

  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const { accessToken } = (await login.json()) as { accessToken: string };
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };

  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, { ...init, headers });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${JSON.stringify(body)}`);
    return body;
  };

  // ── 1. the account ────────────────────────────────────────────────────────
  const accounts = (await call("/accounts")) as Account[] | { data: Account[] };
  const all = Array.isArray(accounts) ? accounts : accounts.data;
  let account = all.find((a) => a.code === code);

  if (account) {
    console.log(`account ${code} already exists: ${account.nameAr} (${account.category}/${account.accountType}, leaf=${account.isLeaf}, active=${account.active})`);
    if (!account.active || !account.isLeaf || account.category !== "REVENUE") {
      throw new Error(`account ${code} exists but is not an active leaf REVENUE account; refusing to use it`);
    }
  } else if (!execute) {
    console.log(`WOULD CREATE account ${code} «${nameAr}» as an active leaf REVENUE account`);
  } else {
    account = (await call("/accounts", {
      method: "POST",
      body: JSON.stringify({ code, nameAr, nameEn, category: "REVENUE", accountType: "REVENUE" }),
    })) as Account;
    console.log(`created account ${account.code} «${account.nameAr}» id=${account.id} leaf=${account.isLeaf} active=${account.active}`);
  }

  // ── 2. the profile ────────────────────────────────────────────────────────
  const profiles = (await call("/settings/posting-profiles")) as PostingProfile[];
  const current = profiles[0];
  if (!current) throw new Error("no posting profile exists to supersede");

  if (account && current.salesReturnsAccountId === account.id) {
    console.log("the effective posting profile already points at this account — nothing to do");
    return;
  }
  if (current.salesReturnsAccountId) {
    const existing = all.find((a) => a.id === current.salesReturnsAccountId);
    throw new Error(`the effective profile already has a sales-returns account (${existing?.code ?? current.salesReturnsAccountId}); refusing to repoint it`);
  }

  const next: Record<string, unknown> = { effectiveFrom: new Date().toISOString().slice(0, 10) };
  for (const leg of PROFILE_LEGS) next[leg] = current[leg] ?? null;
  next.salesReturnsAccountId = account?.id ?? null;

  if (!execute) {
    console.log(`WOULD SUPERSEDE profile ${current.id} (effectiveFrom ${String(current.effectiveFrom).slice(0, 10)}) with an identical copy whose salesReturnsAccountId = ${code}`);
    console.log("dry run — nothing was written. Re-run with --execute to apply.");
    return;
  }

  const saved = (await call("/settings/posting-profiles", { method: "POST", body: JSON.stringify(next) })) as PostingProfile;
  console.log(`created posting profile ${saved.id} effectiveFrom ${String(saved.effectiveFrom).slice(0, 10)}`);

  // ── 3. read back what production actually believes ────────────────────────
  const after = (await call("/settings/posting-profiles")) as PostingProfile[];
  const effective = after[0];
  if (effective.salesReturnsAccountId !== account?.id) {
    throw new Error("read-back failed: the effective profile does not point at the new account");
  }
  for (const leg of PROFILE_LEGS) {
    if (leg === "salesReturnsAccountId") continue;
    if ((effective[leg] ?? null) !== (current[leg] ?? null)) {
      throw new Error(`read-back failed: ${leg} changed while superseding the profile`);
    }
  }
  console.log("verified: sales returns post to " + code + ", every other leg carried over unchanged");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
