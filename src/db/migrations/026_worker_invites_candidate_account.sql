-- Pins a worker invite to a specific Quipay account at creation time, resolved
-- by QP ID, instead of only recording a freeform candidate_name. Additive.
ALTER TABLE worker_invites
  ADD COLUMN IF NOT EXISTS candidate_account_id BIGINT REFERENCES accounts (id);
CREATE INDEX IF NOT EXISTS idx_worker_invites_candidate_account ON worker_invites (candidate_account_id);
