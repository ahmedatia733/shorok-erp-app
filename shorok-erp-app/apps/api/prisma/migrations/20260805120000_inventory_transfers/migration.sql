-- Inventory transfer (P9) — strictly additive.
--
-- Nothing existing is dropped, renamed, backfilled or redefined: no existing
-- inventory row, movement, balance or journal is touched. The currently
-- deployed application keeps working unchanged both during and after the
-- rollout, because everything here is new and nothing it adds is required by
-- the running code.

-- ── 1. Two new movement types ─────────────────────────────────────────────
-- Exactly the pattern the returns migration used for SALE_RETURN /
-- PURCHASE_RETURN. IF NOT EXISTS makes a re-run harmless. The new labels are
-- only ADDED here and never USED in this migration, which is what keeps this
-- valid inside the transaction Prisma wraps a migration in.
--
-- Two members, not four: a cancellation is a transfer in the opposite
-- direction, so TRANSFER_OUT always reads "stock left this branch on a
-- transfer" and TRANSFER_IN "stock arrived at this branch on a transfer".
-- Cancellations are told apart by reference_type — the same way the return
-- services already distinguish sales_return from sales_return_cancel.
ALTER TYPE "MovementType" ADD VALUE IF NOT EXISTS 'TRANSFER_OUT';
ALTER TYPE "MovementType" ADD VALUE IF NOT EXISTS 'TRANSFER_IN';

-- ── 2. Transfer status ────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'InventoryTransferStatus' AND n.nspname = current_schema()
  ) THEN
    CREATE TYPE "InventoryTransferStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');
  END IF;
END
$$;

-- ── 3. Transfer header ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "inventory_transfers" (
  "id"                            UUID                      NOT NULL,
  -- BIGSERIAL: the number is allocated when the DRAFT row is inserted, so a
  -- preview (which inserts nothing) can never consume one, and a cancelled
  -- transfer keeps its number forever rather than releasing it for reuse.
  "transfer_number"               BIGSERIAL                 NOT NULL,
  "status"                        "InventoryTransferStatus" NOT NULL DEFAULT 'DRAFT',
  "transfer_date"                 DATE                      NOT NULL,
  "source_branch_id"              UUID                      NOT NULL,
  "destination_branch_id"         UUID                      NOT NULL,
  "purpose"                       VARCHAR(300),
  "notes"                         VARCHAR(1000),
  "version"                       INTEGER                   NOT NULL DEFAULT 1,
  "confirmation_idempotency_key"  VARCHAR(120),
  "cancellation_idempotency_key"  VARCHAR(120),
  "confirmation_fingerprint"      VARCHAR(64),
  "cancellation_fingerprint"      VARCHAR(64),
  "created_by_id"                 UUID                      NOT NULL,
  "created_at"                    TIMESTAMPTZ(6)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by_id"                 UUID,
  "updated_at"                    TIMESTAMPTZ(6)            NOT NULL,
  "confirmed_by_id"               UUID,
  "confirmed_at"                  TIMESTAMPTZ(6),
  "cancelled_by_id"               UUID,
  "cancelled_at"                  TIMESTAMPTZ(6),
  "cancellation_reason"           VARCHAR(500),

  CONSTRAINT "inventory_transfers_pkey" PRIMARY KEY ("id"),
  -- The single most important rule of the document, enforced by the database
  -- and not only by the service: stock cannot be transferred to itself.
  CONSTRAINT "inventory_transfers_distinct_branches"
    CHECK ("source_branch_id" <> "destination_branch_id"),
  CONSTRAINT "inventory_transfers_version_positive" CHECK ("version" >= 1),
  -- A cancelled transfer must carry a reason; a confirmed one must carry its
  -- confirmer. These are the invariants the UI relies on when it renders a
  -- status timeline.
  CONSTRAINT "inventory_transfers_cancel_needs_reason"
    CHECK ("status" <> 'CANCELLED' OR ("cancellation_reason" IS NOT NULL AND length(btrim("cancellation_reason")) > 0)),
  CONSTRAINT "inventory_transfers_confirmed_has_actor"
    CHECK ("status" = 'DRAFT' OR ("confirmed_by_id" IS NOT NULL AND "confirmed_at" IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_transfers_transfer_number_key"
  ON "inventory_transfers" ("transfer_number");
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_transfers_confirmation_idempotency_key_key"
  ON "inventory_transfers" ("confirmation_idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_transfers_cancellation_idempotency_key_key"
  ON "inventory_transfers" ("cancellation_idempotency_key");
CREATE INDEX IF NOT EXISTS "inventory_transfers_source_branch_id_idx"
  ON "inventory_transfers" ("source_branch_id");
CREATE INDEX IF NOT EXISTS "inventory_transfers_destination_branch_id_idx"
  ON "inventory_transfers" ("destination_branch_id");
CREATE INDEX IF NOT EXISTS "inventory_transfers_status_idx"
  ON "inventory_transfers" ("status");
CREATE INDEX IF NOT EXISTS "inventory_transfers_transfer_date_idx"
  ON "inventory_transfers" ("transfer_date" DESC);

-- ── 4. Transfer lines ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "inventory_transfer_lines" (
  "id"                              UUID           NOT NULL,
  "transfer_id"                     UUID           NOT NULL,
  "product_variant_id"              UUID           NOT NULL,
  "sku_code"                        VARCHAR(60)    NOT NULL,
  "product_name_ar"                 VARCHAR(200)   NOT NULL,
  "product_name_en"                 VARCHAR(200),
  "board_size_meters"               DECIMAL(10,4)  NOT NULL,
  "board_quantity"                  DECIMAL(14,4)  NOT NULL,
  "meter_quantity"                  DECIMAL(14,4)  NOT NULL,
  "cost_per_meter"                  DECIMAL(14,4)  NOT NULL DEFAULT 0,
  "total_value"                     DECIMAL(14,2)  NOT NULL DEFAULT 0,
  "line_index"                      INTEGER        NOT NULL,
  "source_movement_id"              UUID,
  "destination_movement_id"         UUID,
  "cancel_source_movement_id"       UUID,
  "cancel_destination_movement_id"  UUID,
  "created_at"                      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inventory_transfer_lines_pkey" PRIMARY KEY ("id"),
  -- Complete boards only. `board_quantity = trunc(board_quantity)` is what
  -- makes "no fractional boards" a property of the data rather than a promise
  -- made by the form.
  CONSTRAINT "inventory_transfer_lines_whole_boards"
    CHECK ("board_quantity" > 0 AND "board_quantity" = trunc("board_quantity")),
  CONSTRAINT "inventory_transfer_lines_positive_size"
    CHECK ("board_size_meters" > 0),
  CONSTRAINT "inventory_transfer_lines_positive_metres"
    CHECK ("meter_quantity" > 0),
  -- The metres must BE boards × size, to the stored precision. A tampered
  -- client total cannot survive this even if the service were bypassed.
  CONSTRAINT "inventory_transfer_lines_metres_derived"
    CHECK ("meter_quantity" = round("board_quantity" * "board_size_meters", 4)),
  CONSTRAINT "inventory_transfer_lines_non_negative_value"
    CHECK ("cost_per_meter" >= 0 AND "total_value" >= 0),
  CONSTRAINT "inventory_transfer_lines_line_index_positive" CHECK ("line_index" >= 0)
);

-- One line per variant per transfer: a duplicate variant cannot be split into
-- two lines that would each post their own movement pair.
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_transfer_lines_transfer_variant_key"
  ON "inventory_transfer_lines" ("transfer_id", "product_variant_id");
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_transfer_lines_transfer_index_key"
  ON "inventory_transfer_lines" ("transfer_id", "line_index");
CREATE INDEX IF NOT EXISTS "inventory_transfer_lines_transfer_id_idx"
  ON "inventory_transfer_lines" ("transfer_id");
CREATE INDEX IF NOT EXISTS "inventory_transfer_lines_product_variant_id_idx"
  ON "inventory_transfer_lines" ("product_variant_id");

-- ── 5. Foreign keys ───────────────────────────────────────────────────────
-- Both new tables start empty, so every validation scan here is trivial.
-- Restrict on branches, variants and actors: a branch that has moved stock, or
-- a user who signed a transfer, must not become deletable. Cascade only from a
-- transfer to its own lines.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_transfers_source_branch_id_fkey' AND conrelid = 'inventory_transfers'::regclass) THEN
    ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_source_branch_id_fkey"
      FOREIGN KEY ("source_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_transfers_destination_branch_id_fkey' AND conrelid = 'inventory_transfers'::regclass) THEN
    ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_destination_branch_id_fkey"
      FOREIGN KEY ("destination_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_transfers_created_by_id_fkey' AND conrelid = 'inventory_transfers'::regclass) THEN
    ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_transfers_updated_by_id_fkey' AND conrelid = 'inventory_transfers'::regclass) THEN
    ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_updated_by_id_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_transfers_confirmed_by_id_fkey' AND conrelid = 'inventory_transfers'::regclass) THEN
    ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_confirmed_by_id_fkey"
      FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_transfers_cancelled_by_id_fkey' AND conrelid = 'inventory_transfers'::regclass) THEN
    ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_cancelled_by_id_fkey"
      FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_transfer_lines_transfer_id_fkey' AND conrelid = 'inventory_transfer_lines'::regclass) THEN
    ALTER TABLE "inventory_transfer_lines" ADD CONSTRAINT "inventory_transfer_lines_transfer_id_fkey"
      FOREIGN KEY ("transfer_id") REFERENCES "inventory_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_transfer_lines_product_variant_id_fkey' AND conrelid = 'inventory_transfer_lines'::regclass) THEN
    ALTER TABLE "inventory_transfer_lines" ADD CONSTRAINT "inventory_transfer_lines_product_variant_id_fkey"
      FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

-- ── 6. Posted transfers are immutable ─────────────────────────────────────
-- Lines are written once with the draft and then frozen: after confirmation
-- they carry the quantities and the cost snapshot the movements were built
-- from, and rewriting them would silently divorce the document from the stock
-- it moved. The service never updates a line after confirmation, and this
-- trigger is what makes that true even if a future code path forgets.
CREATE OR REPLACE FUNCTION "inventory_transfer_line_immutable"() RETURNS trigger AS $$
DECLARE
  current_status "InventoryTransferStatus";
BEGIN
  SELECT status INTO current_status FROM "inventory_transfers" WHERE id = OLD."transfer_id";
  IF current_status = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  -- After confirmation only the movement back-references may still be filled
  -- in (confirmation writes them, cancellation adds the reversal pair).
  IF NEW."product_variant_id" IS DISTINCT FROM OLD."product_variant_id"
     OR NEW."board_quantity"   IS DISTINCT FROM OLD."board_quantity"
     OR NEW."meter_quantity"   IS DISTINCT FROM OLD."meter_quantity"
     OR NEW."board_size_meters" IS DISTINCT FROM OLD."board_size_meters"
     OR NEW."cost_per_meter"   IS DISTINCT FROM OLD."cost_per_meter"
     OR NEW."total_value"      IS DISTINCT FROM OLD."total_value"
     OR NEW."transfer_id"      IS DISTINCT FROM OLD."transfer_id" THEN
    RAISE EXCEPTION 'inventory transfer line % is immutable once the transfer leaves DRAFT', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "inventory_transfer_line_immutable_trg" ON "inventory_transfer_lines";
CREATE TRIGGER "inventory_transfer_line_immutable_trg"
  BEFORE UPDATE ON "inventory_transfer_lines"
  FOR EACH ROW EXECUTE FUNCTION "inventory_transfer_line_immutable"();

-- A confirmed or cancelled transfer cannot be deleted at all, so its lines can
-- never disappear from under the movements that reference it.
CREATE OR REPLACE FUNCTION "inventory_transfer_no_delete_posted"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'inventory transfer % is % and cannot be deleted', OLD."transfer_number", OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "inventory_transfer_no_delete_posted_trg" ON "inventory_transfers";
CREATE TRIGGER "inventory_transfer_no_delete_posted_trg"
  BEFORE DELETE ON "inventory_transfers"
  FOR EACH ROW EXECUTE FUNCTION "inventory_transfer_no_delete_posted"();
