import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CUTOVER_ERROR, CutoverRefusal, type CutoverMode } from "./cutover.types";
import { cutoverManifestSchema, type CutoverManifest } from "./manifest.schema";

/**
 * Loads and gates an approved manifest. Everything here runs before the planner
 * and long before any database work, so a manifest that should never execute is
 * rejected while the importer is still stateless.
 */

export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function parseManifest(raw: string): CutoverManifest {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new CutoverRefusal(CUTOVER_ERROR.MANIFEST_INVALID, { reason: "not_json" });
  }
  if (
    typeof json === "object" &&
    json !== null &&
    "manifestVersion" in json &&
    (json as { manifestVersion: unknown }).manifestVersion !== 1
  ) {
    throw new CutoverRefusal(CUTOVER_ERROR.MANIFEST_VERSION_UNSUPPORTED, {
      version: String((json as { manifestVersion: unknown }).manifestVersion),
    });
  }
  const parsed = cutoverManifestSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new CutoverRefusal(CUTOVER_ERROR.MANIFEST_INVALID, {
      path: first?.path.join(".") ?? "",
      issue: first?.message ?? "invalid",
    });
  }
  return parsed.data;
}

export function loadManifestFile(path: string | undefined | null): CutoverManifest {
  if (!path || !path.trim()) throw new CutoverRefusal(CUTOVER_ERROR.MANIFEST_MISSING);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new CutoverRefusal(CUTOVER_ERROR.MANIFEST_UNREADABLE);
  }
  return parseManifest(raw);
}

/**
 * The source files the manifest claims to derive from must still hash to the
 * recorded digests. A changed source means the approval no longer describes the
 * data, so the run is refused rather than re-derived.
 */
export interface SourceVerification {
  verified: boolean;
  hashes: Record<string, string>;
}

/**
 * The source files a manifest claims to derive from must still hash to the
 * recorded digests. A changed workbook or PDF means the approval no longer
 * describes the data, so the run is refused rather than silently re-derived.
 *
 * Mandatory for dry-run and execute: a rehearsal that skipped this check would
 * not be a rehearsal of the real run. Audit may skip it, and says so.
 */
export function verifySourceHashes(
  manifest: CutoverManifest,
  sourceDir: string | undefined | null,
  { required }: { required: boolean },
): SourceVerification {
  if (!sourceDir || !sourceDir.trim()) {
    if (required) throw new CutoverRefusal(CUTOVER_ERROR.SOURCE_DIR_REQUIRED);
    return { verified: false, hashes: {} };
  }

  const hashes: Record<string, string> = {};
  for (const src of manifest.sourceFiles) {
    const path = join(sourceDir, src.id);
    if (!existsSync(path)) {
      throw new CutoverRefusal(CUTOVER_ERROR.SOURCE_FILE_NOT_FOUND, { sourceFileId: src.id });
    }
    const actual = sha256OfFile(path);
    if (actual.toLowerCase() !== src.sha256.toLowerCase()) {
      throw new CutoverRefusal(CUTOVER_ERROR.SOURCE_HASH_MISMATCH, { sourceFileId: src.id });
    }
    hashes[src.id] = actual;
  }
  return { verified: true, hashes };
}

export function verifyManifestHash(actualHash: string, declaredHash: string | undefined): void {
  if (!declaredHash) return;
  if (actualHash.toLowerCase() !== declaredHash.toLowerCase()) {
    throw new CutoverRefusal(CUTOVER_ERROR.MANIFEST_HASH_MISMATCH);
  }
}

export function verifyApprovalFile(
  manifest: CutoverManifest,
  approvalFilePath: string | undefined | null,
): void {
  if (!approvalFilePath || !approvalFilePath.trim()) {
    throw new CutoverRefusal(CUTOVER_ERROR.APPROVAL_FILE_MISSING);
  }
  let actual: string;
  try {
    actual = sha256OfFile(approvalFilePath);
  } catch {
    throw new CutoverRefusal(CUTOVER_ERROR.APPROVAL_FILE_MISSING);
  }
  if (!manifest.approvalEvidenceHash) {
    throw new CutoverRefusal(CUTOVER_ERROR.APPROVAL_HASH_MISMATCH, { reason: "not_declared" });
  }
  if (actual.toLowerCase() !== manifest.approvalEvidenceHash.toLowerCase()) {
    throw new CutoverRefusal(CUTOVER_ERROR.APPROVAL_HASH_MISMATCH);
  }
}

/**
 * The opening importer's scope is master data, opening stock and approved
 * opening balances. Operational documents — July history, post-cutover sales,
 * collections, expenses, returns — belong to the application, not here.
 */
const OPERATIONAL_MARKERS =
  /(SALES_INVOICE|PURCHASE_INVOICE|RECEIPT|COLLECTION|EXPENSE|PAYMENT|SALES_RETURN|PURCHASE_RETURN|OPERATIONAL)/i;

export function assertOpeningScopeOnly(manifest: CutoverManifest): void {
  const cutover = manifest.cutoverDate;
  const allRows = [
    ...manifest.customerRows,
    ...manifest.productRows,
    ...manifest.inventoryRows,
    ...manifest.openingGlRows,
  ];

  for (const row of allRows) {
    const key = `${row.sourceKey} ${row.normalizedApprovedKey}`;
    if (OPERATIONAL_MARKERS.test(key)) {
      const isReturn = /RETURN/i.test(key);
      throw new CutoverRefusal(
        isReturn
          ? CUTOVER_ERROR.OPERATIONAL_RETURN_IN_MANIFEST
          : CUTOVER_ERROR.OPERATIONAL_TRANSACTION_IN_MANIFEST,
        { decisionId: row.decisionId },
      );
    }
    // A transaction date in the source key is the other way operational rows
    // leak in; anything before the cutover is July history by definition.
    const dateMatch = /(\d{4}-\d{2}-\d{2})/.exec(row.sourceKey);
    if (dateMatch && dateMatch[1] < cutover) {
      throw new CutoverRefusal(CUTOVER_ERROR.JULY_TRANSACTION_IN_MANIFEST, {
        decisionId: row.decisionId,
      });
    }
  }
}

/** Gates that apply only when a run is allowed to commit. */
export function assertExecutePreconditions(manifest: CutoverManifest, mode: CutoverMode): void {
  if (mode !== "execute") return;
  if (manifest.unresolvedDecisions !== 0) {
    throw new CutoverRefusal(CUTOVER_ERROR.UNRESOLVED_DECISIONS, {
      count: manifest.unresolvedDecisions,
    });
  }
  if (manifest.importScope === "AUDIT_ONLY") {
    throw new CutoverRefusal(CUTOVER_ERROR.ROW_NOT_APPROVED, { reason: "scope_is_audit_only" });
  }
  const blocked = [
    ...manifest.customerRows,
    ...manifest.productRows,
    ...manifest.inventoryRows,
  ].filter((r) => r.approvalStatus === "BLOCKED");
  if (blocked.length > 0) {
    throw new CutoverRefusal(CUTOVER_ERROR.BLOCKED_ROW_MARKED_IMPORTABLE, {
      count: blocked.length,
      firstDecisionId: blocked[0].decisionId,
    });
  }
}

export function assertCutoverDate(manifest: CutoverManifest, approvedCutoverDate: string): void {
  if (manifest.cutoverDate !== approvedCutoverDate) {
    throw new CutoverRefusal(CUTOVER_ERROR.CUTOVER_DATE_MISMATCH, {
      manifest: manifest.cutoverDate,
      approved: approvedCutoverDate,
    });
  }
}
