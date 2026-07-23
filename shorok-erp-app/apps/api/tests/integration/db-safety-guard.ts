/**
 * Production-data safety guard for the integration test suite.
 *
 * Integration tests target a DEDICATED LOCAL test database given by
 * TEST_DATABASE_URL — never the dev DATABASE_URL and never production. Each run
 * still lives in a throwaway `test_<hex>` schema inside that database; cleanup
 * only ever drops that generated schema.
 *
 * Refuses to run (hard fail BEFORE any connection) unless TEST_DATABASE_URL:
 *   - is set
 *   - host is loopback (localhost/127.0.0.1/::1) — NO non-local escape hatch
 *   - database name clearly contains "test"
 *   - is NOT equal to DATABASE_URL (the dev database)
 *   - is NOT equal to PROD_DATABASE_URL
 *   - host is not a managed/production host (railway/rlwy/amazonaws/…)
 *   - NODE_ENV is not "production"
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROD_HOST_MARKERS = [
  "railway", "rlwy.net", "proxy.rlwy", ".rlwy.", "amazonaws.com", "supabase",
  "neon.tech", "render.com", "herokuapp", "azure", "gcp", "digitalocean",
];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"]);

/** Prisma auto-loads .env; mirror that so the guard sees the same values the
 *  tests will (DATABASE_URL, TEST_DATABASE_URL, PROD_DATABASE_URL). */
function loadEnvFiles(): void {
  const wanted = ["DATABASE_URL", "TEST_DATABASE_URL", "PROD_DATABASE_URL"];
  if (wanted.every((k) => process.env[k])) return;
  const files = [
    join(__dirname, "..", "..", ".env"),             // apps/api/.env
    join(__dirname, "..", "..", "..", "..", ".env"),  // repo/shorok-erp-app/.env
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(DATABASE_URL|TEST_DATABASE_URL|PROD_DATABASE_URL)\s*=\s*(.+)\s*$/.exec(line);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
    }
  }
}

/** Pure validation of the test-database URL (no env/.env reads) — unit-testable. */
export function validateTestUrl(opts: {
  testUrl?: string; devUrl?: string; prodUrl?: string; nodeEnv?: string;
}): string {
  if (opts.nodeEnv === "production") {
    throw new Error("SAFETY: refusing to run tests with NODE_ENV=production.");
  }
  const test = opts.testUrl;
  if (!test || test.trim() === "") {
    throw new Error("SAFETY: TEST_DATABASE_URL is not set — integration tests require a dedicated LOCAL test database (name must contain 'test').");
  }
  let url: URL;
  try { url = new URL(test); } catch { throw new Error("SAFETY: TEST_DATABASE_URL is not a valid URL."); }

  const host = url.hostname.toLowerCase();
  const dbName = url.pathname.replace(/^\//, "").split("?")[0]!.toLowerCase();
  const hay = test.toLowerCase();

  for (const marker of PROD_HOST_MARKERS) {
    if (hay.includes(marker)) throw new Error(`SAFETY: TEST_DATABASE_URL host looks like production ("${marker}").`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`SAFETY: TEST_DATABASE_URL host "${host}" is not loopback — tests must use a LOCAL database.`);
  }
  if (!dbName.includes("test")) {
    throw new Error(`SAFETY: TEST_DATABASE_URL database "${dbName}" must clearly contain "test".`);
  }
  if (opts.devUrl && opts.devUrl.trim() === test.trim()) {
    throw new Error("SAFETY: TEST_DATABASE_URL equals DATABASE_URL — the dev and test databases must be separate.");
  }
  if (opts.prodUrl && opts.prodUrl.trim() === test.trim()) {
    throw new Error("SAFETY: TEST_DATABASE_URL equals PROD_DATABASE_URL — refusing to test against production.");
  }
  return test;
}

/** Load .env, then validate and RETURN the local test database URL. */
export function assertTestDatabase(): string {
  loadEnvFiles();
  return validateTestUrl({
    testUrl: process.env.TEST_DATABASE_URL,
    devUrl: process.env.DATABASE_URL,
    prodUrl: process.env.PROD_DATABASE_URL,
    nodeEnv: process.env.NODE_ENV,
  });
}

// jest globalSetup entrypoint — fail fast for the whole run.
export default async function globalSetup(): Promise<void> {
  const url = assertTestDatabase();
  // eslint-disable-next-line no-console
  console.log(`[db-safety] OK — integration tests target the local TEST database (${new URL(url).hostname}/${new URL(url).pathname.slice(1)}).`);
}
