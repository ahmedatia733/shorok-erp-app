/**
 * Runs in EACH jest worker before its tests (globalSetup does not propagate env
 * to workers). Re-validates the local test database and repoints DATABASE_URL —
 * which test-app.ts / test-db.ts read — at TEST_DATABASE_URL, so integration
 * tests can NEVER accidentally target the dev or production database.
 */
import { assertTestDatabase } from "./db-safety-guard";

const testUrl = assertTestDatabase();
// The engine + Prisma read DATABASE_URL; force it to the validated test DB for
// this worker. The dev DATABASE_URL is only used above to prove they differ.
process.env.DATABASE_URL = testUrl;
