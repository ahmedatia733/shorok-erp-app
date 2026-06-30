ALTER TABLE "purchase_invoice_lines"
  ADD COLUMN IF NOT EXISTS "height_m" DECIMAL(14,4);
