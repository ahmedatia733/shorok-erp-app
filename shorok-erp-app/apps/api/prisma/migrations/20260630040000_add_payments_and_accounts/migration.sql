-- Payment account types
CREATE TYPE "payment_account_type" AS ENUM ('CASH', 'BANK');

-- Payment entity types
CREATE TYPE "payment_entity_type" AS ENUM ('SUPPLIER', 'CUSTOMER');

-- Payment accounts (خزنة / بنك)
CREATE TABLE "payment_accounts" (
  "id"         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"       VARCHAR(100) NOT NULL,
  "type"       payment_account_type NOT NULL,
  "active"     BOOLEAN     NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the 4 accounts
INSERT INTO "payment_accounts" ("id", "name", "type", "active", "created_at", "updated_at") VALUES
  (gen_random_uuid(), 'خزنة رئيسية',           'CASH', true, NOW(), NOW()),
  (gen_random_uuid(), 'بنك مصر',                'BANK', true, NOW(), NOW()),
  (gen_random_uuid(), 'مصرف أبو ظبي الإسلامي', 'BANK', true, NOW(), NOW()),
  (gen_random_uuid(), 'CIB',                    'BANK', true, NOW(), NOW());

-- Payments (supplier payments; customer collections use order_collections)
CREATE TABLE "payments" (
  "id"                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_type"        payment_entity_type NOT NULL,
  "entity_id"          UUID          NOT NULL,
  "payment_account_id" UUID          NOT NULL REFERENCES "payment_accounts"("id"),
  "amount"             DECIMAL(14,2) NOT NULL,
  "payment_date"       DATE          NOT NULL,
  "reference_number"   VARCHAR(100),
  "notes"              VARCHAR(500),
  "created_by"         UUID          NOT NULL REFERENCES "users"("id"),
  "created_at"         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "updated_at"         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX "payments_entity_idx" ON "payments"("entity_type", "entity_id");
CREATE INDEX "payments_account_idx" ON "payments"("payment_account_id");
CREATE INDEX "payments_date_idx"    ON "payments"("payment_date" DESC);
