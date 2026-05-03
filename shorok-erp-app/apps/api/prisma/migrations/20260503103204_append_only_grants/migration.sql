-- ====================================================================
-- Append-only enforcement (Constitution Principle III: Audit-Everything)
-- ====================================================================
--
-- The application connects as `shorok_app` (not as the migration owner).
-- We REVOKE UPDATE and DELETE on the four append-only tables from that
-- role; corrections must use compensating rows, not in-place mutations.
--
-- Append-only tables:
--   * audit_logs              (audit trail; never mutate or delete)
--   * inventory_movements     (stock ledger)
--   * order_collections       (collection ledger; refunds are negative rows)
--   * factory_ledger_entries  (supplier ledger)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shorok_app') THEN
    CREATE ROLE "shorok_app" NOLOGIN;
  END IF;
END
$$;

-- Grant the operational privileges the app needs on the schema...
GRANT USAGE ON SCHEMA "public" TO "shorok_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "shorok_app";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "shorok_app";

-- ...then take UPDATE and DELETE away on the append-only tables.
REVOKE UPDATE, DELETE ON "audit_logs"             FROM "shorok_app";
REVOKE UPDATE, DELETE ON "inventory_movements"    FROM "shorok_app";
REVOKE UPDATE, DELETE ON "order_collections"      FROM "shorok_app";
REVOKE UPDATE, DELETE ON "factory_ledger_entries" FROM "shorok_app";

-- Future tables created under this schema inherit the same default grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "shorok_app";
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT USAGE, SELECT ON SEQUENCES TO "shorok_app";

-- The app role must be granted to the user that the application connects as.
-- That GRANT is environment-specific and is performed in deployment scripts;
-- in dev (where the migration owner == the app user), we GRANT it to the
-- current connecting role so existing dev databases work without extra setup.
DO $$
DECLARE current_user_name TEXT := current_user;
BEGIN
  EXECUTE format('GRANT "shorok_app" TO %I', current_user_name);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$$;
