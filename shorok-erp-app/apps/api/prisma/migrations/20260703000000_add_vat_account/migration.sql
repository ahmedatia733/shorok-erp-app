-- Add VAT / Tax account to chart of accounts
-- Used by: sales invoices (output VAT → credit), purchase invoices (input VAT → debit),
--          tax-ledger report, and the "الضرائب" category in the journal form.
-- Single account approach: net credit = amount owed to government; net debit = refund due.

INSERT INTO "accounts" ("id","code","name_ar","name_en","category","account_type","parent_id","is_leaf","active","created_at")
VALUES (
  gen_random_uuid(),
  '2300',
  'ضريبة القيمة المضافة',
  'Value Added Tax (VAT)',
  'LIABILITY',
  'LIABILITY',
  (SELECT id FROM accounts WHERE code = '2000'),
  true,
  true,
  NOW()
)
ON CONFLICT ("code") DO NOTHING;
