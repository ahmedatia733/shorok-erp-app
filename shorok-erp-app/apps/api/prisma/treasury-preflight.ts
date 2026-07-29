/**
 * TREASURY MIGRATION PREFLIGHT GUARD (executable, read-only).
 *
 * Run BEFORE deploying the multi-treasury feature to any environment:
 *     pnpm --filter @shorok/api treasury:preflight        (uses DATABASE_URL)
 * or  DATABASE_URL=... pnpm treasury:preflight
 *
 * It performs ONLY read-only checks and then:
 *   - EXITS NON-ZERO (deployment BLOCKED) when there is >1 active branch AND
 *     unwrapped cash/bank leaf accounts exist AND no explicit mapping is supplied
 *     (via the env var TREASURY_MAPPING_JSON = path to a JSON array of
 *     { glAccountId, branchId }). Ambiguous cash accounts cannot be assigned to a
 *     branch automatically, so the blind first-branch backfill would be unsafe.
 *   - EXITS ZERO (safe) when: exactly one active branch, OR every cash/bank leaf
 *     is already wrapped by a Treasury, OR an unambiguous mapping is supplied.
 *
 * It NEVER writes, NEVER connects to a database other than the supplied URL, and
 * NEVER touches journal lines. Do not run against production without approval.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) {
    console.error("[treasury-preflight] DATABASE_URL is not set — refusing to run.");
    return 2;
  }
  console.log(`[treasury-preflight] target: ${url.replace(/:[^:@/]*@/, ":***@")}`);

  const prisma = new PrismaClient();
  try {
    const [{ n: activeBranches }] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM branches WHERE active = true`;
    const unwrapped = await prisma.$queryRaw<Array<{ gl_account_id: string; account_code: string; account_name: string; current_gl_balance: string }>>`
      SELECT a.id AS gl_account_id, a.code AS account_code, a.name_ar AS account_name,
             COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl WHERE jl.account_id = a.id), 0)::text AS current_gl_balance
      FROM accounts a
      WHERE a.is_cash_or_bank = true AND a.treasury_type IN ('CASH','BANK') AND a.is_leaf = true
        AND NOT EXISTS (SELECT 1 FROM treasuries t WHERE t.gl_account_id = a.id)
      ORDER BY a.code`;

    console.log(`[treasury-preflight] active branches: ${activeBranches}`);
    console.log(`[treasury-preflight] unwrapped cash/bank leaf accounts: ${unwrapped.length}`);

    // Optional explicit mapping (glAccountId → branchId) for ambiguous cases.
    let mapping: Array<{ glAccountId: string; branchId: string }> = [];
    const mapPath = process.env.TREASURY_MAPPING_JSON;
    if (mapPath) {
      try {
        mapping = JSON.parse(readFileSync(mapPath, "utf8"));
        console.log(`[treasury-preflight] mapping file: ${mapPath} (${mapping.length} entries)`);
      } catch (e) {
        console.error(`[treasury-preflight] could not read TREASURY_MAPPING_JSON=${mapPath}: ${(e as Error).message}`);
        return 2;
      }
    }
    const mappedGls = new Set(mapping.map((m) => m.glAccountId));
    const stillAmbiguous = unwrapped.filter((u) => !mappedGls.has(u.gl_account_id));

    if (unwrapped.length === 0) {
      console.log("[treasury-preflight] OK — every cash/bank leaf is already wrapped by a Treasury. SAFE.");
      return 0;
    }
    if (Number(activeBranches) <= 1) {
      console.log("[treasury-preflight] OK — a single active branch makes the automatic backfill deterministic. SAFE.");
      return 0;
    }
    if (stillAmbiguous.length === 0) {
      console.log("[treasury-preflight] OK — all unwrapped accounts have an explicit branch mapping. SAFE.");
      return 0;
    }

    console.error("\n[treasury-preflight] BLOCKED — multiple active branches and AMBIGUOUS cash accounts with no mapping:");
    console.error("  glAccountId                          | code       | name                 | current GL balance");
    for (const r of stillAmbiguous) {
      console.error(`  ${r.gl_account_id} | ${r.account_code.padEnd(10)} | ${(r.account_name ?? "").padEnd(20)} | ${r.current_gl_balance}`);
    }
    console.error("\n  Supply TREASURY_MAPPING_JSON (a JSON array of { glAccountId, branchId }) approved by");
    console.error("  the finance owner, then re-run. DO NOT deploy the blind first-branch backfill.\n");
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(2); });
