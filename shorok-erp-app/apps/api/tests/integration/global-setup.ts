import { applyMigrationsToSchema, newSchemaName, TEST_SCHEMA_VAR } from "./test-db";

export default async function globalSetup(): Promise<void> {
  const schema = newSchemaName();
  process.env[TEST_SCHEMA_VAR] = schema;
  applyMigrationsToSchema(schema);
}
