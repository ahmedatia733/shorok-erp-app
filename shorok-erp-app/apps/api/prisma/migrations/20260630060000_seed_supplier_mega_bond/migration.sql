INSERT INTO "suppliers" ("id", "name_ar", "name_en", "active", "created_at", "updated_at")
VALUES (
  gen_random_uuid(),
  'الشركة الإماراتية الأمريكية ميجا بوند',
  'Mega Bond UAE-American Company',
  true,
  NOW(),
  NOW()
)
ON CONFLICT ("name_ar") DO UPDATE
  SET "name_en" = EXCLUDED."name_en",
      "updated_at" = NOW();
