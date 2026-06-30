-- Convert 1210 (الخزن والنقدية) and 1220 (البنوك) from leaf → parent
UPDATE "accounts" SET "is_leaf" = false WHERE "code" IN ('1210', '1220');

-- Seed sub-accounts for cash safes under 1210
INSERT INTO "accounts" ("id","code","name_ar","name_en","category","account_type","parent_id","is_leaf","active","created_at")
VALUES
  (gen_random_uuid(),'1211','خزنة رئيسية','Main Safe','ASSET','CURRENT_ASSET',
   (SELECT id FROM accounts WHERE code='1210'),true,true,NOW())
ON CONFLICT ("code") DO NOTHING;

-- Seed sub-accounts for each bank under 1220
INSERT INTO "accounts" ("id","code","name_ar","name_en","category","account_type","parent_id","is_leaf","active","created_at")
VALUES
  (gen_random_uuid(),'1221','بنك مصر','Banque Misr','ASSET','CURRENT_ASSET',
   (SELECT id FROM accounts WHERE code='1220'),true,true,NOW()),
  (gen_random_uuid(),'1222','مصرف أبو ظبي الإسلامي','Abu Dhabi Islamic Bank','ASSET','CURRENT_ASSET',
   (SELECT id FROM accounts WHERE code='1220'),true,true,NOW()),
  (gen_random_uuid(),'1223','CIB','CIB','ASSET','CURRENT_ASSET',
   (SELECT id FROM accounts WHERE code='1220'),true,true,NOW())
ON CONFLICT ("code") DO NOTHING;
