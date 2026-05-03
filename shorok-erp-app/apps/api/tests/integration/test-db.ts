/**
 * Integration test database utilities.
 *
 * Each integration test run lives in a dedicated Postgres schema so suites
 * cannot collide. The schema name is "test_<8-hex>" derived from the worker
 * pid + a random suffix; it is created in global-setup and dropped in
 * global-teardown.
 *
 * Tests get a Prisma client wired to that schema via DATABASE_URL with
 * ?schema=<name> appended.
 */

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const TEST_SCHEMA_ENV_VAR = "SHOROK_TEST_SCHEMA";

function databaseUrlFor(schema: string): string {
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "Integration tests require DATABASE_URL pointing at a Postgres instance.",
    );
  }
  const url = new URL(base);
  url.searchParams.set("schema", schema);
  return url.toString();
}

export function newSchemaName(): string {
  return `test_${randomBytes(4).toString("hex")}`;
}

export function applyMigrationsToSchema(schema: string): void {
  const url = databaseUrlFor(schema);
  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
    cwd: __dirname + "/../..",
  });
}

export function dropSchema(schema: string): void {
  const url = databaseUrlFor(schema);
  const client = new PrismaClient({ datasources: { db: { url } } });
  // Best-effort drop; ignore failures (test may have crashed mid-setup).
  client
    .$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`)
    .catch(() => {})
    .finally(() => client.$disconnect());
}

export function prismaForSchema(schema: string): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: databaseUrlFor(schema) } },
  });
}

export function getActiveSchema(): string {
  const schema = process.env[TEST_SCHEMA_ENV_VAR];
  if (!schema) {
    throw new Error(
      `${TEST_SCHEMA_ENV_VAR} not set — global-setup did not run.`,
    );
  }
  return schema;
}

export const TEST_SCHEMA_VAR = TEST_SCHEMA_ENV_VAR;
