ALTER TABLE worker_notification_settings DROP COLUMN IF EXISTS account_id;
ALTER TABLE treasury_balances DROP COLUMN IF EXISTS account_id;
ALTER TABLE worker_invites DROP COLUMN IF EXISTS accepted_by_account_id, DROP COLUMN IF EXISTS employer_account_id;
ALTER TABLE employee_profiles DROP COLUMN IF EXISTS employer_account_id, DROP COLUMN IF EXISTS worker_account_id;
ALTER TABLE worker_registrations DROP COLUMN IF EXISTS employer_account_id, DROP COLUMN IF EXISTS worker_account_id;
