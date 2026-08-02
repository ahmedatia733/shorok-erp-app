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

import { CUTOVER_ERROR, CUTOVER_WARNING, CutoverRefusal, type CutoverMode } from "./cutover.types";
import { planCutover, computeManifestHash, type CutoverPlan } from "./cutover-planner";
import {
  assertCutoverDate,
  assertExecutePreconditions,
  assertOpeningScopeOnly,
  loadManifestFile,
  verifyApprovalFile,
  verifyManifestHash,
  verifySourceHashes,
} from "./manifest-loader";
import { assertTargetIsSafe, parseDatabaseUrl } from "./db-safety";
import { existsSync } from "node:fs";
import type { TargetMode } from "./cutover.types";
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
  // Production authorization — every field must be supplied explicitly.
  targetMode?: string;
  expectedHost?: string;
  expectedDatabase?: string;
  productionToken?: string;
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
      case "--target-mode":
        args.targetMode = next();
        break;
      case "--expected-host":
        args.expectedHost = next();
        break;
      case "--expected-database":
        args.expectedDatabase = next();
        break;
      case "--production-token":
        args.productionToken = next();
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
  /** Whether the source files were actually hashed and matched this run. */
  sourceVerified: boolean;
  verifiedSourceHashes: Record<string, string>;
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

  // Source verification is MANDATORY for anything that opens a transaction.
  // A dry-run is meant to be a rehearsal of the real run, so it cannot skip a
  // check the real run performs. Audit may skip it, and the report says so.
  const sourceRequired = args.mode === "execute" || args.mode === "dry-run";
  const verification = verifySourceHashes(manifest, args.sourceDir, { required: sourceRequired });

  const hash = computeManifestHash(manifest);
  verifyManifestHash(hash, undefined);

  if (args.mode === "execute") {
    assertExecutePreconditions(manifest, "execute");
    verifyApprovalFile(manifest, args.approvalFile);
  }

  const plan = planCutover(manifest);
  const warnings = [...plan.warnings];
  if (!verification.verified) {
    warnings.push({
      code: CUTOVER_WARNING.SOURCE_FILES_NOT_VERIFIED,
      decisionId: "MANIFEST",
      note: "structural audit only — source files were not hashed against the manifest",
    });
  }
  return {
    plan,
    manifestHashPrefix: hashPrefix(plan.manifestHash),
    warnings,
    sourceVerified: verification.verified,
    verifiedSourceHashes: verification.hashes,
  };
}

/**
 * Static database gates. The live-identity probe happens after connecting.
 * `local` keeps the loopback/allowlist rules; `production` must satisfy the
 * default-deny authorization contract.
 */
export async function runDatabaseGates(
  args: CliArgs,
): Promise<{ masked: string; targetMode: TargetMode }> {
  if (args.mode === "audit") return { masked: "", targetMode: "local" };
  const target = parseDatabaseUrl(args.databaseUrl);
  const targetMode = await assertTargetIsSafe(target, args, existsSync);
  return { masked: target.masked, targetMode };
}

/** Report lines are redaction-safe by construction: no names, no per-row money. */
export function formatSummary(
  outcome: AuditOutcome,
  maskedDb: string,
  targetMode: TargetMode = "local",
): string[] {
  const r = outcome.plan.reconciliation;
  return [
    `manifest        : ${outcome.plan.manifestId} (sha256 ${outcome.manifestHashPrefix}…)`,
    `scope           : ${outcome.plan.scope}`,
    `cutover date    : ${outcome.plan.cutoverDate}`,
    `database        : ${maskedDb || "(none — audit mode)"}`,
    `target mode     : ${targetMode.toUpperCase()}`,
    `customers       : ${r.customerDebitCount} debit / ${r.customerCreditCount} credit` +
      ` (+${r.masterOnlyCustomerCount} preserved master-only at zero balance)`,
    `customer totals : Dr ${r.customerDebitTotal} / Cr ${r.customerCreditTotal} / net ${r.customerNetAr}`,
    `inventory rows  : ${r.inventoryImportRowCount} (zero-qty ${r.zeroQuantityVariants})`,
    `inventory qty   : ${r.inventoryBoards} boards / ${r.inventoryMeters} meters`,
    `inventory value : ${r.inventoryValue}`,
    `opening Dr/Cr   : ${r.openingDebitTotal} / ${r.openingCreditTotal} (gap ${r.openingGap})`,
    `journal posts   : ${outcome.plan.journalMustPost ? "YES" : "NO"}`,
    `balancing policy: ${outcome.plan.balancingPolicy}`,
    `source verified : ${outcome.sourceVerified ? "YES" : "NO — SOURCE_FILES_NOT_VERIFIED"}`,
    `accounting      : ${outcome.plan.accountingComplete ? "COMPLETE" : "NOT_ACCOUNTING_COMPLETE"}`,
    `approved branch : ${outcome.plan.approvedBranchId}`,
    `approved actor  : ${outcome.plan.approvedActorUserId}`,
    `operator/approver: ${outcome.plan.operator} / ${outcome.plan.approver}`,
    ...outcome.warnings.map((w) => `warning         : ${w.code} [${w.decisionId}] ${w.note}`),
  ];
}

export function describeTarget(databaseUrl: string | undefined): string {
  return databaseUrl ? maskDatabaseUrl(databaseUrl) : "(none)";
}
