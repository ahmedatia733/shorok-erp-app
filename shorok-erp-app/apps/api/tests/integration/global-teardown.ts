import { dropSchema, getActiveSchema } from "./test-db";

export default async function globalTeardown(): Promise<void> {
  try {
    dropSchema(getActiveSchema());
  } catch {
    // Best-effort cleanup — the schema may have failed to materialize.
  }
}
