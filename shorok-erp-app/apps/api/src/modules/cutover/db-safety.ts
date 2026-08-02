import { lookup } from "node:dns/promises";
import { CUTOVER_ERROR, CutoverRefusal } from "./cutover.types";
import { maskDatabaseUrl } from "./redaction";

/**
 * Database safety for the importer.
 *
 * The importer never falls back to an ambient DATABASE_URL: a connection string
 * must be passed explicitly, and it is then checked four independent ways
 * before a single write is attempted —
 *
 *   1. the URL parses and names a database;
 *   2. the host is loopback (during local phases) and not a public/managed host;
 *   3. the database name is on an explicit allowlist;
 *   4. the LIVE server agrees it is that database, on that address.
 *
 * A name containing "test" proves nothing on its own, so it is never sufficient.
 */

export const LOCAL_DB_ALLOWLIST = ["shorok_erp_test", "shorok_erp_cutover_20260801_local"] as const;

/** Never a write target for the importer, whatever the mode. */
export const FORBIDDEN_DB_NAMES = ["shorok_erp", "postgres", "template0", "template1"] as const;

const MANAGED_HOST_PATTERN =
  /(railway|rlwy\.net|render\.com|supabase|neon\.tech|amazonaws\.com|azure|gcp|heroku|planetscale|digitalocean)/i;

export interface ParsedTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  masked: string;
}

export function parseDatabaseUrl(url: string | undefined | null): ParsedTarget {
  if (!url || !url.trim()) throw new CutoverRefusal(CUTOVER_ERROR.DATABASE_URL_MISSING);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new CutoverRefusal(CUTOVER_ERROR.DB_URL_MALFORMED);
  }
  const database = u.pathname.replace(/^\//, "");
  if (!u.protocol.startsWith("postgres") || !u.hostname || !database) {
    throw new CutoverRefusal(CUTOVER_ERROR.DB_URL_MALFORMED);
  }
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    database,
    user: u.username,
    masked: maskDatabaseUrl(url),
  };
}

function isLoopbackLiteral(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * Static checks. `allowlist` is explicit rather than derived, so widening it is
 * always a visible code change.
 */
export async function assertLocalTargetIsSafe(
  target: ParsedTarget,
  allowlist: readonly string[] = LOCAL_DB_ALLOWLIST,
): Promise<void> {
  if (MANAGED_HOST_PATTERN.test(target.host)) {
    throw new CutoverRefusal(CUTOVER_ERROR.DB_HOST_PUBLIC, { host: target.host });
  }

  if (!isLoopbackLiteral(target.host)) {
    let addresses: string[];
    try {
      addresses = (await lookup(target.host, { all: true })).map((a) => a.address);
    } catch {
      throw new CutoverRefusal(CUTOVER_ERROR.DB_HOST_NOT_LOOPBACK, { host: target.host });
    }
    const allLoopback =
      addresses.length > 0 && addresses.every((a) => a.startsWith("127.") || a === "::1");
    if (!allLoopback) {
      throw new CutoverRefusal(CUTOVER_ERROR.DB_HOST_NOT_LOOPBACK, {
        host: target.host,
        resolved: addresses.join(","),
      });
    }
  }

  if ((FORBIDDEN_DB_NAMES as readonly string[]).includes(target.database)) {
    throw new CutoverRefusal(CUTOVER_ERROR.DB_TARGET_FORBIDDEN, { database: target.database });
  }
  if (!allowlist.includes(target.database)) {
    throw new CutoverRefusal(CUTOVER_ERROR.DB_NAME_NOT_ALLOWLISTED, { database: target.database });
  }
}

export interface ServerIdentity {
  currentDatabase: string;
  currentUser: string;
  serverAddress: string | null;
  serverPort: number | null;
  version: string;
}

type IdentityQuery = (sql: string) => Promise<Array<Record<string, unknown>>>;

/**
 * Ask the live server who it is, and refuse if it disagrees with the URL. This
 * is the check a hostname alias, a proxy or a tunnel cannot fake.
 */
export async function assertServerIdentityMatches(
  target: ParsedTarget,
  query: IdentityQuery,
): Promise<ServerIdentity> {
  const rows = await query(
    "SELECT current_database() AS db, current_user AS usr, " +
      "host(coalesce(inet_server_addr(), '127.0.0.1'::inet)) AS addr, " +
      "inet_server_port() AS port, version() AS ver",
  );
  const row = rows[0] ?? {};
  const identity: ServerIdentity = {
    currentDatabase: String(row.db ?? ""),
    currentUser: String(row.usr ?? ""),
    serverAddress: row.addr === null || row.addr === undefined ? null : String(row.addr),
    serverPort: row.port === null || row.port === undefined ? null : Number(row.port),
    version: String(row.ver ?? ""),
  };

  if (identity.currentDatabase !== target.database) {
    throw new CutoverRefusal(CUTOVER_ERROR.DB_IDENTITY_MISMATCH, {
      expected: target.database,
      actual: identity.currentDatabase,
    });
  }

  // A unix-socket connection reports no address; that is loopback by definition.
  if (identity.serverAddress && !isLoopbackAddress(identity.serverAddress)) {
    throw new CutoverRefusal(CUTOVER_ERROR.DB_HOST_NOT_LOOPBACK, {
      actualServerAddress: identity.serverAddress,
    });
  }

  return identity;
}

function isLoopbackAddress(address: string): boolean {
  return address.startsWith("127.") || address === "::1";
}
