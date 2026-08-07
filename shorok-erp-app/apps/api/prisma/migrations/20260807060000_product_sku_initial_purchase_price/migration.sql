-- P12 — a starting purchase price on the base product.
--
-- Purely additive: one nullable column. Nothing existing is written, renamed,
-- dropped, backfilled or revalued, and no default is supplied, so every product
-- that already exists keeps a NULL here and the catalogue falls back to its
-- confirmed purchase history exactly as before.
--
-- The value is a per-square-metre figure in the same unit as a purchase invoice
-- line, and Decimal(14,2) matches product_variants.default_purchase_price_per_meter
-- so the two can never disagree about precision. It is not a cost, not a WAC and
-- not an inventory value; it is only what someone typed when they first entered
-- the product, shown until a real purchase supersedes it.
--
-- ADD COLUMN of a nullable column with no default is metadata-only in
-- PostgreSQL 11+, so this takes a brief ACCESS EXCLUSIVE lock and rewrites no
-- rows — safe against a live table.
ALTER TABLE "product_skus"
  ADD COLUMN IF NOT EXISTS "initial_purchase_price_per_meter" DECIMAL(14,2);

-- A price is a positive number or it is absent; a zero or negative starting
-- price is a data-entry mistake, not a business fact.
DO $$
BEGIN
  -- Scoped to the CURRENT schema, not a hardcoded `public`. Integration tests
  -- apply migrations into a throwaway schema, where a `public.`-qualified
  -- regclass lookup would fail outright and a bare catalogue scan would
  -- false-positive off another schema's constraint.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'product_skus_initial_purchase_price_positive'
      AND t.relname = 'product_skus'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "product_skus"
      ADD CONSTRAINT "product_skus_initial_purchase_price_positive"
      CHECK ("initial_purchase_price_per_meter" IS NULL
             OR "initial_purchase_price_per_meter" > 0);
  END IF;
END $$;
