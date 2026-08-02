import { lookup } from "node:dns/promises";
import {
  CUTOVER_ERROR,
  CutoverRefusal,
  PRODUCTION_CUTOVER_TOKEN,
  type TargetMode,
} from "./cutover.types";
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

export const LOCAL_DB_ALLOWLIST = [
  "shorok_erp_test",
  "shorok_erp_cutover_20260801_local",
  "shorok_erp_cutover_20260801_local_v2",
] as const;

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
  targetMode: TargetMode = "local",
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

  // Applies in BOTH modes: the live server must be the database that was named.
  if (identity.currentDatabase !== target.database) {
    throw new CutoverRefusal(CUTOVER_ERROR.DB_IDENTITY_MISMATCH, {
      expected: target.database,
      actual: identity.currentDatabase,
    });
  }

  // The loopback rule is a LOCAL-mode protection: locally, a database that
  // answers from a non-loopback address is not the local database it claimed to
  // be. Inside a provider's private network the server legitimately answers from
  // a private address (Railway uses private IPv6), so requiring loopback there
  // would be meaningless. It is not skipped silently: production mode replaces
  // it with the stronger runtime-identity checks in
  // `assertRuntimeIdentityMatches`, which pin the exact project, environment and
  // service rather than merely the shape of an address.
  if (targetMode === "local") {
    // A unix-socket connection reports no address; that is loopback by definition.
    if (identity.serverAddress && !isLoopbackAddress(identity.serverAddress)) {
      throw new CutoverRefusal(CUTOVER_ERROR.DB_HOST_NOT_LOOPBACK, {
        actualServerAddress: identity.serverAddress,
      });
    }
  }

  return identity;
}

/**
 * Production runs execute from inside the provider's private network, where the
 * proof of "am I pointed at the right database" is not an IP shape but the
 * runtime's own identity. Every field is compared against a value the operator
 * declared up front, so a runner deployed into the wrong project, the wrong
 * environment or under the wrong name cannot proceed.
 */
export interface RuntimeIdentityExpectation {
  expectedProjectId: string;
  expectedEnvironmentId: string;
  expectedDatabaseServiceName: string;
}

export function assertRuntimeIdentityMatches(
  env: NodeJS.ProcessEnv,
  expectation: RuntimeIdentityExpectation,
): void {
  const projectId = env.RAILWAY_PROJECT_ID;
  const environmentId = env.RAILWAY_ENVIRONMENT_ID;
  if (!projectId || !environmentId) {
    throw new CutoverRefusal(CUTOVER_ERROR.RUNTIME_IDENTITY_UNAVAILABLE);
  }
  if (projectId !== expectation.expectedProjectId) {
    throw new CutoverRefusal(CUTOVER_ERROR.RUNTIME_PROJECT_MISMATCH, { actual: projectId });
  }
  if (environmentId !== expectation.expectedEnvironmentId) {
    throw new CutoverRefusal(CUTOVER_ERROR.RUNTIME_ENVIRONMENT_MISMATCH, {
      actual: environmentId,
    });
  }
  const dbServiceName = env.CUTOVER_TARGET_SERVICE_NAME;
  if (dbServiceName !== expectation.expectedDatabaseServiceName) {
    throw new CutoverRefusal(CUTOVER_ERROR.RUNTIME_SERVICE_NAME_MISMATCH, {
      actual: String(dbServiceName ?? ""),
    });
  }
}

function isLoopbackAddress(address: string): boolean {
  return address.startsWith("127.") || address === "::1";
}

/**
 * Production target authorization — DEFAULT DENY.
 *
 * The local guards above stay exactly as they are: every mode except an
 * explicitly authorized production run still refuses a managed/public host. This
 * function is the ONLY way past them, and it demands six independent things, all
 * supplied by the operator and none of them inferable:
 *
 *   --target-mode production      the intent, stated explicitly
 *   --database-url                no ambient fallback, ever
 *   --expected-host               the exact proxy hostname, matched exactly
 *   --expected-database           the exact database name, matched exactly
 *   --approval-file               signed approval evidence that must exist
 *   --production-token            the current cutover token
 *
 * Nothing here is hard-coded to a hostname, a password or a Railway credential:
 * the operator states what they expect and the parsed URL must agree.
 */
export interface ProductionTargetArgs {
  targetMode?: string;
  databaseUrl?: string;
  expectedHost?: string;
  expectedDatabase?: string;
  approvalFile?: string;
  productionToken?: string;
}

export function resolveTargetMode(raw: string | undefined | null): TargetMode {
  if (raw === undefined || raw === null || raw === "") return "local";
  if (raw === "local" || raw === "production") return raw;
  throw new CutoverRefusal(CUTOVER_ERROR.TARGET_MODE_INVALID, { targetMode: String(raw) });
}

export function assertProductionTargetIsAuthorized(
  target: ParsedTarget,
  args: ProductionTargetArgs,
  fileExists: (path: string) => boolean,
): void {
  if (args.targetMode !== "production") {
    throw new CutoverRefusal(CUTOVER_ERROR.TARGET_MODE_MISSING);
  }
  if (!args.productionToken) {
    throw new CutoverRefusal(CUTOVER_ERROR.PRODUCTION_TOKEN_MISSING);
  }
  if (args.productionToken !== PRODUCTION_CUTOVER_TOKEN) {
    throw new CutoverRefusal(CUTOVER_ERROR.PRODUCTION_TOKEN_INVALID);
  }
  if (!args.expectedHost) {
    throw new CutoverRefusal(CUTOVER_ERROR.EXPECTED_HOST_MISSING);
  }
  // Exact equality, not "contains": a substring rule would accept a lookalike
  // host that merely embeds the expected one.
  if (args.expectedHost !== target.host) {
    throw new CutoverRefusal(CUTOVER_ERROR.EXPECTED_HOST_MISMATCH, {
      expected: args.expectedHost,
      actual: target.host,
    });
  }
  if (!args.expectedDatabase) {
    throw new CutoverRefusal(CUTOVER_ERROR.EXPECTED_DATABASE_MISSING);
  }
  if (args.expectedDatabase !== target.database) {
    throw new CutoverRefusal(CUTOVER_ERROR.EXPECTED_DATABASE_MISMATCH, {
      expected: args.expectedDatabase,
      actual: target.database,
    });
  }
  if (!args.approvalFile || !fileExists(args.approvalFile)) {
    throw new CutoverRefusal(CUTOVER_ERROR.PRODUCTION_APPROVAL_FILE_MISSING);
  }
}

/**
 * The single entry point every command uses to decide whether a target may be
 * written to. `local` keeps the loopback + allowlist rules unchanged.
 */
export async function assertTargetIsSafe(
  target: ParsedTarget,
  args: ProductionTargetArgs,
  fileExists: (path: string) => boolean,
  allowlist: readonly string[] = LOCAL_DB_ALLOWLIST,
): Promise<TargetMode> {
  const mode = resolveTargetMode(args.targetMode);
  if (mode === "local") {
    await assertLocalTargetIsSafe(target, allowlist);
    return "local";
  }
  assertProductionTargetIsAuthorized(target, args, fileExists);
  return "production";
}
