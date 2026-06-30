-- Seed AP paint color SKUs and their default variants
-- ON CONFLICT DO NOTHING keeps this idempotent on re-deploy

INSERT INTO product_skus (id, code, color_name_ar, color_name_en, category, active, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'AP 120',  'سيلفر ميتالك',     'Silver Metallic',      'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 250',  'دارك جراي',         'Dark Grey',            'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 115',  'رمادي ساده',        'Plain Grey',           'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 385',  'جراي فاتح',         'Light Grey',           'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP D1',   'ابيض لامع',         'Glossy White',         'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 788',  'ابيض مط',           'Matte White',          'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 9005', 'اسود لامع',         'Glossy Black',         'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 9010', 'اسود مط',           'Matte Black',          'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 113',  'اوف وايت مط',       'Off White Matte',      'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 442',  'بيج غامق',          'Dark Beige',           'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 276',  'احمر لامع',         'Glossy Red',           'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 1010', 'خشبي',              'Wood',                 'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 302',  'مرايا دهبي',        'Gold Mirror',          'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 1023', 'اصفر',              'Yellow',               'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 116',  'كحلي',              'Navy',                 'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 117',  'ازرق',              'Blue',                 'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 111',  'اخضر',              'Green',                'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 375',  'رمادي غامق',        'Dark Grey 375',        'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 119',  'سيلفر مط',          'Matte Silver',         'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP D4',   'لبني فاتح',         'Light Cream',          'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 134',  'لبني غامق',         'Dark Cream',           'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 2004', 'اوراجنج',           'Orange',               'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 301',  'فضي مرايا',         'Silver Mirror',        'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 114',  'شامبين سيلفر',      'Champagne Silver',     'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 183',  'شامبين جولد',       'Champagne Gold',       'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP D2',   'لايت جراي',         'Light Grey D2',        'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 944',  'ازرق ميتالك',       'Metallic Blue',        'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 113G', 'اوف وايت لامع',     'Off White Glossy',     'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 180',  'ابيض ميتالك',       'Metallic White',       'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 056',  'بني',               'Brown',                'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 055',  'بني شيكولاته',      'Chocolate Brown',      'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 3005', 'نبيتي',             'Wine Red',             'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 130',  'دهبي ميتالك',       'Metallic Gold',        'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 106',  'نحاسي',             'Copper',               'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 765',  'اخضر امان',         'Safety Green',         'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 672',  'اخضر نفايتي',       'Naphthyl Green',       'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 110',  'اخضر ابيو',         'Apple Green',          'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 023',  'اخضر زيتي',         'Olive Green',          'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 160',  'موف',               'Mauve',                'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 170',  'بينك',              'Pink',                 'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 401',  'فضي براشد',         'Brushed Silver',       'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 402',  'دهبي براشد',        'Brushed Gold',         'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 777',  'خشبي بارز',         'Embossed Wood',        'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 1008', 'خشبي 1008',         'Wood 1008',            'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 501',  'كونكريت غامق',      'Dark Concrete',        'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 503',  'كونكريت فاتح',      'Light Concrete',       'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 216',  'رخامي فاتح',        'Light Marble',         'NORMAL', true, now(), now()),
  (gen_random_uuid(), 'AP 215',  'رخامي غامق',        'Dark Marble',          'NORMAL', true, now(), now())
ON CONFLICT (code) DO NOTHING;

-- Insert one default variant per SKU (size=1, prices=0) — skips if variant already exists
INSERT INTO product_variants (id, sku_id, size_meters_per_board, default_sale_price_per_meter, default_purchase_price_per_meter, active, created_at, updated_at)
SELECT
  gen_random_uuid(),
  s.id,
  1.0000,
  0.00,
  0.00,
  true,
  now(),
  now()
FROM product_skus s
WHERE s.code IN (
  'AP 120','AP 250','AP 115','AP 385','AP D1','AP 788','AP 9005','AP 9010',
  'AP 113','AP 442','AP 276','AP 1010','AP 302','AP 1023','AP 116','AP 117',
  'AP 111','AP 375','AP 119','AP D4','AP 134','AP 2004','AP 301','AP 114',
  'AP 183','AP D2','AP 944','AP 113G','AP 180','AP 056','AP 055','AP 3005',
  'AP 130','AP 106','AP 765','AP 672','AP 110','AP 023','AP 160','AP 170',
  'AP 401','AP 402','AP 777','AP 1008','AP 501','AP 503','AP 216','AP 215'
)
AND NOT EXISTS (
  SELECT 1 FROM product_variants pv WHERE pv.sku_id = s.id
);
