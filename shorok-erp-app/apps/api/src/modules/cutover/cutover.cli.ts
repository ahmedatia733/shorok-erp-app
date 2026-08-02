/**
 * Cutover importer CLI.
 *
 *   audit    — validate a manifest and recompute every total. No database.
 *   dry-run  — perform the whole import in a transaction, then roll it back.
 *   execute  — the same path, committed, once every check passes.
 *
 * There is no default mode and no ambient DATABASE_URL fallback: dry-run and
 * execute both require --database-url, so the importer can never write to
 * "whatever happens to be configured".
 */

import { CUTOVER_ERROR, CutoverRefusal, type CutoverMode } from "./cutover.types";
import { planCutover, computeManifestHash, type CutoverPlan } from "./cutover-planner";
import {
  assertCutoverDate,
  assertExecutePreconditions,
  assertOpeningScopeOnly,
  loadManifestFile,
  sha256OfFile,
  verifyApprovalFile,
  verifyManifestHash,
  verifySourceHashes,
} from "./manifest-loader";
import { assertLocalTargetIsSafe, parseDatabaseUrl } from "./db-safety";
import { hashPrefix, maskDatabaseUrl } from "./redaction";

export const APPROVED_CUTOVER_DATE = "2026-08-01";

export interface CliArgs {
  mode: CutoverMode | null;
  manifestPath?: string;
  databaseUrl?: string;
  approvalFile?: string;
  sourceDir?: string;
  verbose: boolean;
  dumpPrivate: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mode: null, verbose: false, dumpPrivate: false };
  const modes: CutoverMode[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--audit":
        modes.push("audit");
        break;
      case "--dry-run":
        modes.push("dry-run");
        break;
      case "--execute":
        modes.push("execute");
        break;
      case "--manifest":
        args.manifestPath = next();
        break;
      case "--database-url":
        args.databaseUrl = next();
        break;
      case "--approval-file":
        args.approvalFile = next();
        break;
      case "--source-dir":
        args.sourceDir = next();
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--dump-private":
        args.dumpPrivate = true;
        break;
      default:
        break;
    }
  }

  if (modes.length === 0) throw new CutoverRefusal(CUTOVER_ERROR.MODE_MISSING);
  if (modes.length > 1) throw new CutoverRefusal(CUTOVER_ERROR.MODE_AMBIGUOUS);
  args.mode = modes[0];
  return args;
}

export interface AuditOutcome {
  plan: CutoverPlan;
  manifestHashPrefix: string;
  warnings: CutoverPlan["warnings"];
}

/**
 * Everything a run must satisfy before touching a database. Shared by all three
 * modes, so audit really does exercise the same gates as execute.
 */
export function runManifestGates(args: CliArgs): AuditOutcome {
  if (args.dumpPrivate) throw new CutoverRefusal(CUTOVER_ERROR.PRIVATE_DUMP_REQUESTED);

  const manifest = loadManifestFile(args.manifestPath);
  assertCutoverDate(manifest, APPROVED_CUTOVER_DATE);
  assertOpeningScopeOnly(manifest);

  if (args.sourceDir) {
    verifySourceHashes(manifest, (id) => {
      try {
        return sha256OfFile(`${args.sourceDir}/${id}`);
      } catch {
        return null;
      }
    });
  }

  const hash = computeManifestHash(manifest);
  verifyManifestHash(hash, undefined);

  if (args.mode === "execute") {
    assertExecutePreconditions(manifest, "execute");
    verifyApprovalFile(manifest, args.approvalFile);
  }

  const plan = planCutover(manifest);
  return { plan, manifestHashPrefix: hashPrefix(plan.manifestHash), warnings: plan.warnings };
}

/** Static database gates. The live-identity probe happens in the service. */
export async function runDatabaseGates(args: CliArgs): Promise<string> {
  if (args.mode === "audit") return "";
  const target = parseDatabaseUrl(args.databaseUrl);
  await assertLocalTargetIsSafe(target);
  return target.masked;
}

/** Report lines are redaction-safe by construction: no names, no per-row money. */
export function formatSummary(outcome: AuditOutcome, maskedDb: string): string[] {
  const r = outcome.plan.reconciliation;
  return [
    `manifest        : ${outcome.plan.manifestId} (sha256 ${outcome.manifestHashPrefix}…)`,
    `scope           : ${outcome.plan.scope}`,
    `cutover date    : ${outcome.plan.cutoverDate}`,
    `database        : ${maskedDb || "(none — audit mode)"}`,
    `customers       : ${r.customerDebitCount} debit / ${r.customerCreditCount} credit`,
    `customer totals : Dr ${r.customerDebitTotal} / Cr ${r.customerCreditTotal} / net ${r.customerNetAr}`,
    `inventory rows  : ${r.inventoryImportRowCount} (zero-qty ${r.zeroQuantityVariants})`,
    `inventory qty   : ${r.inventoryBoards} boards / ${r.inventoryMeters} meters`,
    `inventory value : ${r.inventoryValue}`,
    `opening Dr/Cr   : ${r.openingDebitTotal} / ${r.openingCreditTotal} (gap ${r.openingGap})`,
    `journal posts   : ${outcome.plan.journalMustPost ? "YES" : "NO"}`,
    ...outcome.warnings.map((w) => `warning         : ${w.code} [${w.decisionId}] ${w.note}`),
  ];
}

export function describeTarget(databaseUrl: string | undefined): string {
  return databaseUrl ? maskDatabaseUrl(databaseUrl) : "(none)";
}
