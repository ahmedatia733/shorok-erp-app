ALTER TABLE "purchase_invoice_lines"
  ADD COLUMN IF NOT EXISTS "color_code" VARCHAR(20);
