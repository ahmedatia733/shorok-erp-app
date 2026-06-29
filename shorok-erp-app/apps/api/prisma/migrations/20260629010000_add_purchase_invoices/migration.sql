-- CreateEnum
CREATE TYPE "PurchaseInvoiceStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');

-- CreateTable purchase_invoices
CREATE TABLE "purchase_invoices" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "invoice_number" VARCHAR(30) NOT NULL,
  "invoice_date" DATE NOT NULL,
  "supplier_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "notes" VARCHAR(1000),
  "status" "PurchaseInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
  "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "tax_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "grand_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "purchase_invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "purchase_invoices_invoice_number_key" ON "purchase_invoices"("invoice_number");
CREATE INDEX "purchase_invoices_supplier_id_idx" ON "purchase_invoices"("supplier_id");
CREATE INDEX "purchase_invoices_branch_id_idx" ON "purchase_invoices"("branch_id");
CREATE INDEX "purchase_invoices_invoice_date_idx" ON "purchase_invoices"("invoice_date" DESC);
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable purchase_invoice_lines
CREATE TABLE "purchase_invoice_lines" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "invoice_id" UUID NOT NULL,
  "product_variant_id" UUID NOT NULL,
  "boards_quantity" DECIMAL(14,4) NOT NULL,
  "meters_quantity" DECIMAL(14,4) NOT NULL,
  "unit_price" DECIMAL(14,2) NOT NULL,
  "line_total" DECIMAL(14,2) NOT NULL,
  "tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "tax_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "is_free" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "purchase_invoice_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "purchase_invoice_lines_invoice_id_idx" ON "purchase_invoice_lines"("invoice_id");
ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "purchase_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
