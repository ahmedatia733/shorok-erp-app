-- CreateEnum
CREATE TYPE "AccountCategory" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COST_OF_SALES', 'EXPENSE');
CREATE TYPE "AccountType" AS ENUM ('FIXED_ASSET', 'CURRENT_ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COST_OF_SALES', 'EXPENSE');

-- CreateTable accounts
CREATE TABLE "accounts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" VARCHAR(20) NOT NULL,
  "name_ar" VARCHAR(160) NOT NULL,
  "name_en" VARCHAR(160) NOT NULL,
  "category" "AccountCategory" NOT NULL,
  "account_type" "AccountType" NOT NULL,
  "parent_id" UUID,
  "is_leaf" BOOLEAN NOT NULL DEFAULT true,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "accounts_code_key" ON "accounts"("code");
CREATE INDEX "accounts_category_idx" ON "accounts"("category");
CREATE INDEX "accounts_parent_id_idx" ON "accounts"("parent_id");
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable journal_entries
CREATE TABLE "journal_entries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "entry_date" DATE NOT NULL,
  "description" VARCHAR(500) NOT NULL,
  "reference_type" VARCHAR(60),
  "reference_id" UUID,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "journal_entries_entry_date_idx" ON "journal_entries"("entry_date" DESC);
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable journal_lines
CREATE TABLE "journal_lines" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "journal_entry_id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "note" VARCHAR(300),
  CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "journal_lines_journal_entry_id_idx" ON "journal_lines"("journal_entry_id");
CREATE INDEX "journal_lines_account_id_idx" ON "journal_lines"("account_id");
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed Chart of Accounts
INSERT INTO "accounts" ("id","code","name_ar","name_en","category","account_type","parent_id","is_leaf") VALUES
(gen_random_uuid(),'1000','الأصول','Assets','ASSET','FIXED_ASSET',NULL,false),
(gen_random_uuid(),'1100','الأصول الثابتة','Fixed Assets','ASSET','FIXED_ASSET',(SELECT id FROM accounts WHERE code='1000'),false),
(gen_random_uuid(),'1110','الأراضي','Land','ASSET','FIXED_ASSET',(SELECT id FROM accounts WHERE code='1100'),true),
(gen_random_uuid(),'1120','المباني','Buildings','ASSET','FIXED_ASSET',(SELECT id FROM accounts WHERE code='1100'),true),
(gen_random_uuid(),'1130','الأثاث والمعدات','Furniture & Equipment','ASSET','FIXED_ASSET',(SELECT id FROM accounts WHERE code='1100'),true),
(gen_random_uuid(),'1200','الأصول المتداولة','Current Assets','ASSET','CURRENT_ASSET',(SELECT id FROM accounts WHERE code='1000'),false),
(gen_random_uuid(),'1210','الخزن والنقدية','Cash & Safes','ASSET','CURRENT_ASSET',(SELECT id FROM accounts WHERE code='1200'),true),
(gen_random_uuid(),'1220','البنوك','Banks','ASSET','CURRENT_ASSET',(SELECT id FROM accounts WHERE code='1200'),true),
(gen_random_uuid(),'1230','العهد والسلف','Advances','ASSET','CURRENT_ASSET',(SELECT id FROM accounts WHERE code='1200'),true),
(gen_random_uuid(),'1240','العملاء والمدينون','Customers Receivable','ASSET','CURRENT_ASSET',(SELECT id FROM accounts WHERE code='1200'),true),
(gen_random_uuid(),'1250','المخزون','Inventory','ASSET','CURRENT_ASSET',(SELECT id FROM accounts WHERE code='1200'),true),
(gen_random_uuid(),'2000','الالتزامات','Liabilities','LIABILITY','LIABILITY',NULL,false),
(gen_random_uuid(),'2100','الموردون والدائنون','Suppliers Payable','LIABILITY','LIABILITY',(SELECT id FROM accounts WHERE code='2000'),true),
(gen_random_uuid(),'2200','المصروفات المستحقة','Accrued Expenses','LIABILITY','LIABILITY',(SELECT id FROM accounts WHERE code='2000'),true),
(gen_random_uuid(),'3000','حقوق الملكية','Equity','EQUITY','EQUITY',NULL,false),
(gen_random_uuid(),'3100','رأس المال','Capital','EQUITY','EQUITY',(SELECT id FROM accounts WHERE code='3000'),true),
(gen_random_uuid(),'3200','الأرباح والخسائر','Profit & Loss','EQUITY','EQUITY',(SELECT id FROM accounts WHERE code='3000'),true),
(gen_random_uuid(),'3300','الأرباح المحتجزة','Retained Earnings','EQUITY','EQUITY',(SELECT id FROM accounts WHERE code='3000'),true),
(gen_random_uuid(),'4000','الإيرادات','Revenue','REVENUE','REVENUE',NULL,false),
(gen_random_uuid(),'4100','إيرادات المبيعات','Sales Revenue','REVENUE','REVENUE',(SELECT id FROM accounts WHERE code='4000'),true),
(gen_random_uuid(),'5000','تكلفة المبيعات','Cost of Sales','COST_OF_SALES','COST_OF_SALES',NULL,false),
(gen_random_uuid(),'5100','تكلفة البضاعة المباعة','Cost of Goods Sold','COST_OF_SALES','COST_OF_SALES',(SELECT id FROM accounts WHERE code='5000'),true),
(gen_random_uuid(),'6000','المصروفات','Expenses','EXPENSE','EXPENSE',NULL,false),
(gen_random_uuid(),'6100','النقل والشحن','Transport & Freight','EXPENSE','EXPENSE',(SELECT id FROM accounts WHERE code='6000'),true),
(gen_random_uuid(),'6200','الرواتب والأجور','Salaries & Wages','EXPENSE','EXPENSE',(SELECT id FROM accounts WHERE code='6000'),true),
(gen_random_uuid(),'6300','الكهرباء والمرافق','Electricity & Utilities','EXPENSE','EXPENSE',(SELECT id FROM accounts WHERE code='6000'),true),
(gen_random_uuid(),'6400','الإيجارات','Rent','EXPENSE','EXPENSE',(SELECT id FROM accounts WHERE code='6000'),true),
(gen_random_uuid(),'6500','المصروفات البنكية','Bank Charges','EXPENSE','EXPENSE',(SELECT id FROM accounts WHERE code='6000'),true),
(gen_random_uuid(),'6600','مصروفات متنوعة','Miscellaneous Expenses','EXPENSE','EXPENSE',(SELECT id FROM accounts WHERE code='6000'),true),
(gen_random_uuid(),'6700','الصيانة','Maintenance','EXPENSE','EXPENSE',(SELECT id FROM accounts WHERE code='6000'),true);
