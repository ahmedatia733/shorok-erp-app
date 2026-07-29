-- Reassess the default-treasury scope. There is no documented company-wide
-- default policy in the repo, so a single default PER BRANCH is the correct
-- scope. Swap the company-wide partial unique index for a per-branch one.
-- Purely an index change — no data is rewritten.
DROP INDEX IF EXISTS "treasuries_one_default_key";
CREATE UNIQUE INDEX IF NOT EXISTS "treasuries_one_default_per_branch_key"
  ON "treasuries"("branch_id") WHERE "is_default" = true;
