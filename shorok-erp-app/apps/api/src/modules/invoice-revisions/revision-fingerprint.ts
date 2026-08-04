import { createHash } from "node:crypto";

/**
 * The preview fingerprint is the contract between "what the owner was shown"
 * and "what the server is about to commit". Execution recomputes it from live
 * data and refuses to proceed unless it matches, so a preview goes stale the
 * moment ANY input it depended on moves — the invoice itself, the proposed
 * payload, the stock and WAC behind the valuation, a linked return, a linked
 * voucher, the posting period, or the actor.
 */

/**
 * Deterministic JSON: object keys sorted at every depth, arrays kept in order
 * (their order is meaningful), `undefined` dropped so it can never differ from
 * an absent key. Two structurally equal inputs always produce identical bytes.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value === undefined ? null : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export interface FingerprintInput {
  invoiceKind: "SALES" | "PURCHASE";
  invoiceId: string;
  /** The revision the invoice currently carries. */
  currentRevision: number;
  /** Snapshot of the invoice exactly as it stands now. */
  beforeSnapshot: unknown;
  /** The proposed revised invoice, normalised by the server. */
  afterSnapshot: unknown;
  /** Everything the server calculated: totals, stock, journals, valuation. */
  effects: unknown;
  /** Stock and WAC the valuation depended on, per affected variant. */
  valuationState: unknown;
  /** Confirmed returns and voucher allocations linked to this invoice. */
  linkageState: unknown;
  /** The accounting period the adjustment will land in. */
  postingDate: string;
  actorId: string;
}

export function previewFingerprint(input: FingerprintInput): string {
  return sha256Hex(canonicalJson(input));
}

/** Content fingerprints stored on the revision row for the audit trail. */
export function snapshotFingerprint(snapshot: unknown): string {
  return sha256Hex(canonicalJson(snapshot));
}
