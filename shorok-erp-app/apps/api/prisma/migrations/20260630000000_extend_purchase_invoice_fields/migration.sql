-- Extend purchase_invoices with extra header fields
ALTER TABLE "purchase_invoices"
  ADD COLUMN IF NOT EXISTS "due_date" DATE,
  ADD COLUMN IF NOT EXISTS "based_on" VARCHAR(300),
  ADD COLUMN IF NOT EXISTS "doc_direction" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "customs_number" VARCHAR(100);

-- Extend purchase_invoice_lines with dimension fields
ALTER TABLE "purchase_invoice_lines"
  ADD COLUMN IF NOT EXISTS "length_m" DECIMAL(14,4),
  ADD COLUMN IF NOT EXISTS "width_m" DECIMAL(14,4),
  ADD COLUMN IF NOT EXISTS "unit_label" VARCHAR(30);
