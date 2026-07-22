DROP INDEX IF EXISTS idx_workers_account_id;
ALTER TABLE workers DROP COLUMN IF EXISTS account_id;

DROP INDEX IF EXISTS idx_employers_account_id;
ALTER TABLE employers DROP COLUMN IF EXISTS account_id;
