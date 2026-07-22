-- Additive: custom-dimension support on sales invoice lines (mirrors
-- purchase_invoice_lines). Nullable columns → existing rows are unaffected.
ALTER TABLE "sales_invoice_lines"
  ADD COLUMN "length_m"        DECIMAL(14,4),
  ADD COLUMN "width_m"         DECIMAL(14,4),
  ADD COLUMN "meters_quantity" DECIMAL(14,4);

-- Backfill existing lines' effective total meters with the value that was
-- already used for their posting (boards × the variant's size). This only
-- populates the NEW column — it never rewrites any financial or inventory
-- figure. length_m/width_m stay NULL (these lines used the variant size).
UPDATE "sales_invoice_lines" l
SET "meters_quantity" = ROUND(l."quantity" * v."size_meters_per_board", 4)
FROM "product_variants" v
WHERE v."id" = l."product_variant_id"
  AND l."meters_quantity" IS NULL;
