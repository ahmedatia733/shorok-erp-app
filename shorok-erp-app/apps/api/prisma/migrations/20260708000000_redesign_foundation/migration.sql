-- Phase 2 accounting foundation — new configuration & period tables.
-- All additive; no existing table is modified here (see the companion
-- 20260708000100_redesign_journal_dimensions migration for column additions).
-- Nothing in production reads these yet; the PostingEngine and configuration
-- module are the only consumers and are not wired into any live flow.

-- ── Enum types ──────────────────────────────────────────────────────────────
CREATE TYPE "FinancialPeriodStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "TreasuryType"          AS ENUM ('CASH', 'BANK');
CREATE TYPE "AccountSystemRole"     AS ENUM (
  'AR_CONTROL', 'AP_CONTROL', 'VAT_INPUT', 'VAT_OUTPUT', 'INVENTORY', 'COGS',
  'REVENUE', 'DISCOUNT', 'ROUNDING', 'RETAINED_EARNINGS', 'OPENING_EQUITY', 'SHRINKAGE'
);
CREATE TYPE "JournalEntryStatus"    AS ENUM ('POSTED', 'REVERSED');
CREATE TYPE "JournalSourceType"     AS ENUM (
  'SALES_INVOICE', 'PURCHASE_INVOICE', 'SALES_RETURN', 'PURCHASE_RETURN',
  'RECEIPT_VOUCHER', 'PAYMENT_VOUCHER', 'EXPENSE', 'ADJUSTMENT',
  'DEPRECIATION', 'OPENING', 'MANUAL'
);
CREATE TYPE "JournalPartyType"      AS ENUM ('CUSTOMER', 'SUPPLIER');
CREATE TYPE "TaxRegistrationStatus" AS ENUM ('REGISTERED', 'NOT_REGISTERED');
CREATE TYPE "TaxFilingCycle"        AS ENUM ('MONTHLY', 'QUARTERLY');
CREATE TYPE "PrintBrandingPolicy"   AS ENUM ('CURRENT', 'AS_POSTED');
CREATE TYPE "PaperSize"             AS ENUM ('A4', 'A5_LANDSCAPE');
CREATE TYPE "CostingMethod"         AS ENUM ('WAC');

-- ── company_profile (single row per tenant DB) ──────────────────────────────
CREATE TABLE "company_profile" (
  "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name_ar"               VARCHAR(200) NOT NULL,
  "name_en"               VARCHAR(200) NOT NULL,
  "logo_url"              TEXT,
  "brand_primary_color"   VARCHAR(20),
  "currency"              CHAR(3) NOT NULL DEFAULT 'EGP',
  "currency_locked_at"    TIMESTAMPTZ(6),
  "tax_registration_no"   VARCHAR(60),
  "fiscal_year_start_month" INT NOT NULL DEFAULT 1,
  "default_locale"        VARCHAR(5) NOT NULL DEFAULT 'ar',
  "print_footer_ar"       TEXT,
  "print_footer_en"       TEXT,
  "print_branding_policy" "PrintBrandingPolicy" NOT NULL DEFAULT 'CURRENT',
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "company_profile_fiscal_month_ck" CHECK ("fiscal_year_start_month" BETWEEN 1 AND 12)
);

-- ── financial_periods ───────────────────────────────────────────────────────
CREATE TABLE "financial_periods" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "year"          INT NOT NULL,
  "month"         INT NOT NULL,
  "status"        "FinancialPeriodStatus" NOT NULL DEFAULT 'OPEN',
  "closed_by"     UUID REFERENCES "users"("id"),
  "closed_at"     TIMESTAMPTZ(6),
  "reopened_by"   UUID REFERENCES "users"("id"),
  "reopened_at"   TIMESTAMPTZ(6),
  "reopen_reason" VARCHAR(500),
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "financial_periods_month_ck" CHECK ("month" BETWEEN 1 AND 12),
  CONSTRAINT "financial_periods_year_month_uq" UNIQUE ("year", "month")
);

-- ── posting_profiles (versioned by effective_from) ──────────────────────────
CREATE TABLE "posting_profiles" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "effective_from"           DATE NOT NULL,
  "ar_account_id"            UUID REFERENCES "accounts"("id"),
  "ap_account_id"            UUID REFERENCES "accounts"("id"),
  "revenue_account_id"       UUID REFERENCES "accounts"("id"),
  "cogs_account_id"          UUID REFERENCES "accounts"("id"),
  "inventory_account_id"     UUID REFERENCES "accounts"("id"),
  "vat_input_account_id"     UUID REFERENCES "accounts"("id"),
  "vat_output_account_id"    UUID REFERENCES "accounts"("id"),
  "discount_account_id"      UUID REFERENCES "accounts"("id"),
  "rounding_account_id"      UUID REFERENCES "accounts"("id"),
  "retained_earnings_account_id" UUID REFERENCES "accounts"("id"),
  "opening_equity_account_id"    UUID REFERENCES "accounts"("id"),
  "shrinkage_account_id"     UUID REFERENCES "accounts"("id"),
  "created_by"               UUID NOT NULL REFERENCES "users"("id"),
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX "posting_profiles_effective_from_idx" ON "posting_profiles" ("effective_from" DESC);

-- ── tax_profiles (versioned by effective_from) ──────────────────────────────
CREATE TABLE "tax_profiles" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name_key"            VARCHAR(100) NOT NULL,
  "rate"                DECIMAL(5,2) NOT NULL,
  "input_account_id"    UUID REFERENCES "accounts"("id"),
  "output_account_id"   UUID REFERENCES "accounts"("id"),
  "registration_status" "TaxRegistrationStatus" NOT NULL DEFAULT 'REGISTERED',
  "filing_cycle"        "TaxFilingCycle" NOT NULL DEFAULT 'MONTHLY',
  "effective_from"      DATE NOT NULL,
  "active"              BOOLEAN NOT NULL DEFAULT true,
  "created_by"          UUID NOT NULL REFERENCES "users"("id"),
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "tax_profiles_rate_ck" CHECK ("rate" >= 0 AND "rate" <= 100)
);
CREATE INDEX "tax_profiles_effective_from_idx" ON "tax_profiles" ("effective_from" DESC);

-- ── expense_categories ──────────────────────────────────────────────────────
CREATE TABLE "expense_categories" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name_ar"         VARCHAR(160) NOT NULL,
  "name_en"         VARCHAR(160) NOT NULL,
  "account_id"      UUID NOT NULL REFERENCES "accounts"("id"),
  "taxable_default" BOOLEAN NOT NULL DEFAULT false,
  "active"          BOOLEAN NOT NULL DEFAULT true,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- ── numbering_series (foundation table; endpoints deferred to Phase 3) ───────
CREATE TABLE "numbering_series" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_type" "JournalSourceType" NOT NULL,
  "prefix"        VARCHAR(10) NOT NULL DEFAULT '',
  "pad_width"     INT NOT NULL DEFAULT 5,
  "next_number"   BIGINT NOT NULL DEFAULT 1,
  "reset_yearly"  BOOLEAN NOT NULL DEFAULT false,
  "per_branch"    BOOLEAN NOT NULL DEFAULT false,
  "branch_id"     UUID REFERENCES "branches"("id"),
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- ── print_templates (foundation table; endpoints deferred to Phase 6) ────────
CREATE TABLE "print_templates" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_type"   "JournalSourceType" NOT NULL,
  "version"         INT NOT NULL DEFAULT 1,
  "field_toggles"   JSONB,
  "footer_ar"       TEXT,
  "footer_en"       TEXT,
  "signature_slots" JSONB,
  "paper"           "PaperSize" NOT NULL DEFAULT 'A4',
  "branding_policy" "PrintBrandingPolicy" NOT NULL DEFAULT 'CURRENT',
  "effective_from"  DATE NOT NULL DEFAULT CURRENT_DATE,
  "active"          BOOLEAN NOT NULL DEFAULT true
);

-- ── costing_settings (single row; guarded change flow deferred to Phase 3) ───
CREATE TABLE "costing_settings" (
  "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "method"                "CostingMethod" NOT NULL DEFAULT 'WAC',
  "effective_from"        DATE NOT NULL DEFAULT CURRENT_DATE,
  "changed_by"            UUID REFERENCES "users"("id"),
  "valuation_snapshot_url" TEXT
);

-- ── warehouses (foundation table; inventory warehouse_id columns deferred) ───
CREATE TABLE "warehouses" (
  "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branch_id" UUID REFERENCES "branches"("id"),
  "name_ar"   VARCHAR(160) NOT NULL,
  "name_en"   VARCHAR(160) NOT NULL,
  "active"    BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
