-- =====================================================================
-- Phase 4A-2a — Inventory opening-cost audit (PUBLIC-SAFE, aggregate-only)
-- =====================================================================
-- READ-ONLY. This public version outputs ONLY high-level aggregates
-- (counts and a confidence distribution). It deliberately does NOT emit
-- SKU-level costs, branch-level stock quantities, supplier/factory-derived
-- prices, or GL balance amounts.
--
-- The detailed per-variant candidate query (with the full cost hierarchy and
-- per-row output) is retained privately and NOT committed to this repo
-- (see private-notes/inventory-avg-cost-candidates-full.sql, untracked).
--
-- Candidate cost-per-board hierarchy used privately (most trustworthy first):
--   1. PURCHASE_INVOICE_LINES  weighted avg = Σ(line_total)/Σ(boards_quantity)  (HIGH)
--   2. FACTORY_LEDGER          avg(purchase_price_per_meter) × size             (MEDIUM)
--   3. DEFAULT_PURCHASE_PRICE  default_purchase_price_per_meter × size          (LOW)
--   else UNRESOLVED (BLOCKED)
-- =====================================================================

WITH pil AS (
  SELECT product_variant_id
  FROM purchase_invoice_lines
  WHERE boards_quantity > 0
  GROUP BY product_variant_id
  HAVING SUM(boards_quantity) > 0
),
fle AS (
  SELECT product_variant_id
  FROM factory_ledger_entries
  WHERE product_variant_id IS NOT NULL AND purchase_price_per_meter > 0
  GROUP BY product_variant_id
),
cand AS (
  SELECT
    pv.id,
    CASE
      WHEN pil.product_variant_id IS NOT NULL THEN 'HIGH'      -- purchase invoice lines
      WHEN fle.product_variant_id IS NOT NULL THEN 'MEDIUM'    -- factory ledger
      WHEN pv.default_purchase_price_per_meter > 0 THEN 'LOW'  -- default price
      ELSE 'BLOCKED'
    END AS confidence
  FROM branch_inventory_balances bib
  JOIN product_variants pv ON pv.id = bib.product_variant_id
  LEFT JOIN pil ON pil.product_variant_id = pv.id
  LEFT JOIN fle ON fle.product_variant_id = pv.id
  WHERE bib.boards_on_hand > 0 AND pv.avg_cost = 0
)
-- Aggregate-only output: no costs, no quantities, no SKUs.
SELECT 'total_stocked_variants' AS metric,
       (SELECT count(*) FROM branch_inventory_balances WHERE boards_on_hand > 0)::text AS value
UNION ALL
SELECT 'stocked_avg_cost_zero',
       (SELECT count(*) FROM branch_inventory_balances bib
          JOIN product_variants pv ON pv.id = bib.product_variant_id
          WHERE bib.boards_on_hand > 0 AND pv.avg_cost = 0)::text
UNION ALL
SELECT 'stocked_avg_cost_gt_zero',
       (SELECT count(*) FROM branch_inventory_balances bib
          JOIN product_variants pv ON pv.id = bib.product_variant_id
          WHERE bib.boards_on_hand > 0 AND pv.avg_cost > 0)::text
UNION ALL SELECT 'confidence_HIGH',    (SELECT count(*)::text FROM cand WHERE confidence = 'HIGH')
UNION ALL SELECT 'confidence_MEDIUM',  (SELECT count(*)::text FROM cand WHERE confidence = 'MEDIUM')
UNION ALL SELECT 'confidence_LOW',     (SELECT count(*)::text FROM cand WHERE confidence = 'LOW')
UNION ALL SELECT 'confidence_BLOCKED', (SELECT count(*)::text FROM cand WHERE confidence = 'BLOCKED');
