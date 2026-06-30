CREATE TABLE "fixed_assets" (
  "id"                              UUID          NOT NULL DEFAULT gen_random_uuid(),
  "code"                            VARCHAR(20)   NOT NULL,
  "name_ar"                         VARCHAR(200)  NOT NULL,
  "name_en"                         VARCHAR(200)  NOT NULL DEFAULT '',
  "acquisition_date"                DATE          NOT NULL,
  "acquisition_cost"                DECIMAL(14,2) NOT NULL,
  "salvage_value"                   DECIMAL(14,2) NOT NULL DEFAULT 0,
  "useful_life_months"              INTEGER       NOT NULL,
  "depreciation_method"             VARCHAR(20)   NOT NULL DEFAULT 'STRAIGHT_LINE',
  "asset_account_id"                UUID          NOT NULL,
  "accumulated_dep_account_id"      UUID          NOT NULL,
  "depreciation_expense_account_id" UUID          NOT NULL,
  "active"                          BOOLEAN       NOT NULL DEFAULT true,
  "notes"                           VARCHAR(500),
  "created_by"                      UUID          NOT NULL,
  "created_at"                      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"                      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "fixed_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fixed_assets_code_key" UNIQUE ("code"),
  CONSTRAINT "fixed_assets_asset_account_fkey" FOREIGN KEY ("asset_account_id") REFERENCES "accounts"("id"),
  CONSTRAINT "fixed_assets_accum_dep_account_fkey" FOREIGN KEY ("accumulated_dep_account_id") REFERENCES "accounts"("id"),
  CONSTRAINT "fixed_assets_dep_expense_account_fkey" FOREIGN KEY ("depreciation_expense_account_id") REFERENCES "accounts"("id"),
  CONSTRAINT "fixed_assets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id")
);

CREATE TABLE "depreciation_entries" (
  "id"               UUID          NOT NULL DEFAULT gen_random_uuid(),
  "asset_id"         UUID          NOT NULL,
  "period_date"      DATE          NOT NULL,
  "amount"           DECIMAL(14,2) NOT NULL,
  "journal_entry_id" UUID,
  "notes"            VARCHAR(300),
  "created_by"       UUID          NOT NULL,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "depreciation_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dep_entries_asset_fkey" FOREIGN KEY ("asset_id") REFERENCES "fixed_assets"("id") ON DELETE CASCADE,
  CONSTRAINT "dep_entries_je_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id"),
  CONSTRAINT "dep_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id"),
  CONSTRAINT "dep_entries_asset_period_unique" UNIQUE ("asset_id", "period_date")
);

CREATE INDEX "fixed_assets_active_idx" ON "fixed_assets"("active");
CREATE INDEX "dep_entries_asset_idx" ON "depreciation_entries"("asset_id");
