import { createHash } from "node:crypto";

/**
 * Privacy for importer output. Opening data contains customer names, phone
 * numbers and per-customer balances; none of it may reach a log line, an error
 * message, a batch row or a terminal. Everything identifying is replaced by a
 * stable one-way token so two references to the same customer still correlate.
 */

/** Stable, non-reversible reference for a private string. */
export function maskIdentity(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  return `H${createHash("sha256").update(v).digest("hex").slice(0, 8)}`;
}

/** First 12 hex chars of a hash — enough to compare, useless to reconstruct. */
export function hashPrefix(hash: string | null | undefined): string {
  return (hash ?? "").slice(0, 12);
}

/**
 * Per-row amounts are private; only aggregates may be printed. Bucketing keeps
 * a log useful for spotting outliers without disclosing the figure.
 */
export function bucketAmount(amount: number): string {
  const a = Math.abs(amount);
  if (a === 0) return "0";
  if (a < 1_000) return "<1k";
  if (a < 10_000) return "1k-10k";
  if (a < 100_000) return "10k-100k";
  if (a < 1_000_000) return "100k-1M";
  return ">=1M";
}

/** Never print a connection string. Host + database only, password removed. */
export function maskDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    const db = u.pathname.replace(/^\//, "");
    const user = u.username ? `${u.username}:***@` : "";
    return `${u.protocol}//${user}${u.hostname}:${u.port || "5432"}/${db}`;
  } catch {
    return "<unparseable-url>";
  }
}

const PRIVATE_KEY_PATTERN =
  /(name|nameAr|nameEn|customerName|phone|mobile|amount|balance|price|value|address|note|description)/i;

/**
 * Recursively strip private values from any object before it is logged or
 * stored on a batch row. Keys that look private are masked or bucketed; keys
 * that are safe (ids, codes, counts) pass through unchanged.
 */
export function redact(input: unknown, depth = 0): unknown {
  if (depth > 8) return "<depth-limit>";
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map((v) => redact(v, depth + 1));
  if (typeof input !== "object") return input;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!PRIVATE_KEY_PATTERN.test(key)) {
      out[key] = redact(value, depth + 1);
      continue;
    }
    if (typeof value === "number") out[key] = bucketAmount(value);
    else if (typeof value === "string") out[key] = maskIdentity(value);
    else out[key] = "<redacted>";
  }
  return out;
}

/** Force a message down to a length a VarChar(500) column accepts. */
export function truncateReason(reason: string): string {
  return reason.length > 500 ? `${reason.slice(0, 497)}...` : reason;
}
