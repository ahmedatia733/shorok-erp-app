-- Returns (مردودات) — additive, backward-compatible. Independent SalesReturn /
-- PurchaseReturn documents linked to the original invoice; no existing table or
-- posted row is modified. Enum values + one nullable posting-profile column +
-- four new tables with FKs/indexes. No production backfill.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MovementType" ADD VALUE 'SALE_RETURN';
ALTER TYPE "MovementType" ADD VALUE 'PURCHASE_RETURN';

-- AlterTable
ALTER TABLE "posting_profiles" ADD COLUMN     "sales_returns_account_id" UUID;

-- CreateTable
CREATE TABLE "sales_returns" (
    "id" UUID NOT NULL,
    "return_number" BIGSERIAL NOT NULL,
    "original_sales_invoice_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "sales_representative_id" UUID,
    "return_date" DATE NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "reason" VARCHAR(300),
    "notes" VARCHAR(1000),
    "settlement_mode" VARCHAR(40) NOT NULL DEFAULT 'KEEP_AS_CUSTOMER_CREDIT',
    "refund_treasury_account_id" UUID,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discount_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grand_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cogs_reversal_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "journal_entry_id" UUID,
    "cogs_journal_entry_id" UUID,
    "customer_transaction_id" UUID,
    "sales_returns_account_id" UUID,
    "confirmed_at" TIMESTAMPTZ(6),
    "confirmed_by" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by" UUID,
    "cancellation_reason" VARCHAR(300),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sales_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_return_lines" (
    "id" UUID NOT NULL,
    "sales_return_id" UUID NOT NULL,
    "original_sales_invoice_line_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "length_m" DECIMAL(14,4),
    "width_m" DECIMAL(14,4),
    "returned_boards" DECIMAL(14,4) NOT NULL,
    "returned_meters_quantity" DECIMAL(14,4) NOT NULL,
    "original_sale_price_per_meter" DECIMAL(14,2) NOT NULL,
    "original_discount_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "original_tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "return_subtotal" DECIMAL(14,2) NOT NULL,
    "return_discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "return_net_ex_tax" DECIMAL(14,2) NOT NULL,
    "return_tax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "return_total" DECIMAL(14,2) NOT NULL,
    "original_cost_per_meter_at_posting" DECIMAL(14,4),
    "return_cogs" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "inventory_disposition" VARCHAR(40) NOT NULL DEFAULT 'RETURN_TO_AVAILABLE_STOCK',
    "reason" VARCHAR(300),
    "note" VARCHAR(300),

    CONSTRAINT "sales_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_returns" (
    "id" UUID NOT NULL,
    "return_number" BIGSERIAL NOT NULL,
    "original_purchase_invoice_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "return_date" DATE NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "reason" VARCHAR(300),
    "notes" VARCHAR(1000),
    "settlement_mode" VARCHAR(40) NOT NULL DEFAULT 'KEEP_AS_SUPPLIER_CREDIT',
    "refund_treasury_account_id" UUID,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grand_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "inventory_value_out" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "journal_entry_id" UUID,
    "confirmed_at" TIMESTAMPTZ(6),
    "confirmed_by" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by" UUID,
    "cancellation_reason" VARCHAR(300),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "purchase_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_return_lines" (
    "id" UUID NOT NULL,
    "purchase_return_id" UUID NOT NULL,
    "original_purchase_invoice_line_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "length_m" DECIMAL(14,4),
    "width_m" DECIMAL(14,4),
    "returned_boards" DECIMAL(14,4) NOT NULL,
    "returned_meters_quantity" DECIMAL(14,4) NOT NULL,
    "original_purchase_price_per_meter" DECIMAL(14,2) NOT NULL,
    "original_tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "return_net_ex_tax" DECIMAL(14,2) NOT NULL,
    "return_tax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "return_total" DECIMAL(14,2) NOT NULL,
    "historical_inventory_cost_per_meter" DECIMAL(14,4) NOT NULL,
    "inventory_value_out" DECIMAL(14,2) NOT NULL,
    "reason" VARCHAR(300),
    "note" VARCHAR(300),

    CONSTRAINT "purchase_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_returns_return_number_key" ON "sales_returns"("return_number");

-- CreateIndex
CREATE INDEX "sales_returns_original_sales_invoice_id_idx" ON "sales_returns"("original_sales_invoice_id");

-- CreateIndex
CREATE INDEX "sales_returns_customer_id_idx" ON "sales_returns"("customer_id");

-- CreateIndex
CREATE INDEX "sales_returns_branch_id_idx" ON "sales_returns"("branch_id");

-- CreateIndex
CREATE INDEX "sales_returns_sales_representative_id_idx" ON "sales_returns"("sales_representative_id");

-- CreateIndex
CREATE INDEX "sales_returns_status_idx" ON "sales_returns"("status");

-- CreateIndex
CREATE INDEX "sales_returns_return_date_idx" ON "sales_returns"("return_date" DESC);

-- CreateIndex
CREATE INDEX "sales_return_lines_sales_return_id_idx" ON "sales_return_lines"("sales_return_id");

-- CreateIndex
CREATE INDEX "sales_return_lines_original_sales_invoice_line_id_idx" ON "sales_return_lines"("original_sales_invoice_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_returns_return_number_key" ON "purchase_returns"("return_number");

-- CreateIndex
CREATE INDEX "purchase_returns_original_purchase_invoice_id_idx" ON "purchase_returns"("original_purchase_invoice_id");

-- CreateIndex
CREATE INDEX "purchase_returns_supplier_id_idx" ON "purchase_returns"("supplier_id");

-- CreateIndex
CREATE INDEX "purchase_returns_branch_id_idx" ON "purchase_returns"("branch_id");

-- CreateIndex
CREATE INDEX "purchase_returns_status_idx" ON "purchase_returns"("status");

-- CreateIndex
CREATE INDEX "purchase_returns_return_date_idx" ON "purchase_returns"("return_date" DESC);

-- CreateIndex
CREATE INDEX "purchase_return_lines_purchase_return_id_idx" ON "purchase_return_lines"("purchase_return_id");

-- CreateIndex
CREATE INDEX "purchase_return_lines_original_purchase_invoice_line_id_idx" ON "purchase_return_lines"("original_purchase_invoice_line_id");

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_original_sales_invoice_id_fkey" FOREIGN KEY ("original_sales_invoice_id") REFERENCES "sales_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_sales_representative_id_fkey" FOREIGN KEY ("sales_representative_id") REFERENCES "sales_representatives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_sales_return_id_fkey" FOREIGN KEY ("sales_return_id") REFERENCES "sales_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_original_sales_invoice_line_id_fkey" FOREIGN KEY ("original_sales_invoice_line_id") REFERENCES "sales_invoice_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_original_purchase_invoice_id_fkey" FOREIGN KEY ("original_purchase_invoice_id") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_purchase_return_id_fkey" FOREIGN KEY ("purchase_return_id") REFERENCES "purchase_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_original_purchase_invoice_line_id_fkey" FOREIGN KEY ("original_purchase_invoice_line_id") REFERENCES "purchase_invoice_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

