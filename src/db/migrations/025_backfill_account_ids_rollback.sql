UPDATE worker_registrations SET employer_account_id = NULL, worker_account_id = NULL;
UPDATE employee_profiles SET employer_account_id = NULL, worker_account_id = NULL;
UPDATE worker_invites SET employer_account_id = NULL;
UPDATE treasury_balances SET account_id = NULL;
UPDATE worker_notification_settings SET account_id = NULL;
