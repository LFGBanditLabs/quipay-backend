-- Nullable account_id columns on the tables that today relate employer<->worker
-- purely via plain-text address string equality. Additive only — existing
-- reads keep using the address columns until backfill (025) plus a later,
-- deferred cutover migration switch them over.
--
-- Deliberately out of scope: payroll_streams, withdrawals,
-- worker_withdrawal_events, and other append-only on-chain event mirrors —
-- those are correctly keyed by wallet address (the chain's own identity).

ALTER TABLE worker_registrations
  ADD COLUMN IF NOT EXISTS worker_account_id   BIGINT REFERENCES accounts (id),
  ADD COLUMN IF NOT EXISTS employer_account_id BIGINT REFERENCES accounts (id);
CREATE INDEX IF NOT EXISTS idx_worker_reg_worker_account   ON worker_registrations (worker_account_id);
CREATE INDEX IF NOT EXISTS idx_worker_reg_employer_account ON worker_registrations (employer_account_id);

ALTER TABLE employee_profiles
  ADD COLUMN IF NOT EXISTS worker_account_id   BIGINT REFERENCES accounts (id),
  ADD COLUMN IF NOT EXISTS employer_account_id BIGINT REFERENCES accounts (id);
CREATE INDEX IF NOT EXISTS idx_emp_profiles_worker_account   ON employee_profiles (worker_account_id);
CREATE INDEX IF NOT EXISTS idx_emp_profiles_employer_account ON employee_profiles (employer_account_id);

ALTER TABLE worker_invites
  ADD COLUMN IF NOT EXISTS employer_account_id    BIGINT REFERENCES accounts (id),
  ADD COLUMN IF NOT EXISTS accepted_by_account_id  BIGINT REFERENCES accounts (id);
CREATE INDEX IF NOT EXISTS idx_worker_invites_employer_account ON worker_invites (employer_account_id);

ALTER TABLE treasury_balances
  ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts (id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_treasury_balances_account ON treasury_balances (account_id) WHERE account_id IS NOT NULL;

ALTER TABLE worker_notification_settings
  ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts (id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_notif_settings_account ON worker_notification_settings (account_id) WHERE account_id IS NOT NULL;
