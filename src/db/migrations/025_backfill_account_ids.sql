-- Data-only backfill. Safe to re-run — every UPDATE is guarded by
-- "... IS NULL" so it only ever fills gaps, never overwrites.
--
-- Joins on stellar_address / wallet_stellar / wallet_base, NOT employer_id —
-- employer_id is stored lowercased (used only as the login key), while
-- stellar_address is canonical-uppercase and is what every other table's
-- employer_address column actually matches (see src/routes/employers.ts's
-- existing JOIN in GET /worker-registrations/:workerAddress).

UPDATE worker_registrations wr
   SET employer_account_id = e.account_id
  FROM employers e
 WHERE wr.employer_account_id IS NULL
   AND e.account_id IS NOT NULL
   AND LOWER(e.stellar_address) = LOWER(wr.employer_address);

UPDATE worker_registrations wr
   SET worker_account_id = w.account_id
  FROM workers w
 WHERE wr.worker_account_id IS NULL
   AND w.account_id IS NOT NULL
   AND (LOWER(w.wallet_stellar) = LOWER(wr.worker_address) OR LOWER(w.wallet_base) = LOWER(wr.worker_address));

UPDATE employee_profiles ep
   SET employer_account_id = e.account_id
  FROM employers e
 WHERE ep.employer_account_id IS NULL
   AND e.account_id IS NOT NULL
   AND LOWER(e.stellar_address) = LOWER(ep.employer_address);

UPDATE employee_profiles ep
   SET worker_account_id = w.account_id
  FROM workers w
 WHERE ep.worker_account_id IS NULL
   AND w.account_id IS NOT NULL
   AND (LOWER(w.wallet_stellar) = LOWER(ep.worker_address) OR LOWER(w.wallet_base) = LOWER(ep.worker_address));

UPDATE worker_invites wi
   SET employer_account_id = e.account_id
  FROM employers e
 WHERE wi.employer_account_id IS NULL
   AND e.account_id IS NOT NULL
   AND LOWER(e.stellar_address) = LOWER(wi.employer_address);

UPDATE treasury_balances tb
   SET account_id = e.account_id
  FROM employers e
 WHERE tb.account_id IS NULL
   AND e.account_id IS NOT NULL
   AND LOWER(e.stellar_address) = LOWER(tb.employer);

UPDATE worker_notification_settings wns
   SET account_id = w.account_id
  FROM workers w
 WHERE wns.account_id IS NULL
   AND w.account_id IS NOT NULL
   AND (LOWER(w.wallet_stellar) = LOWER(wns.worker) OR LOWER(w.wallet_base) = LOWER(wns.worker));
