CREATE TABLE IF NOT EXISTS worker_invites (
  id                  SERIAL PRIMARY KEY,
  code                TEXT        NOT NULL UNIQUE,
  employer_address    TEXT        NOT NULL,
  candidate_name      TEXT        NOT NULL,
  job_title           TEXT        NOT NULL,
  description         TEXT,
  pay_amount          NUMERIC     NOT NULL,
  pay_token           TEXT        NOT NULL DEFAULT 'USDC',
  duration_days       INTEGER     NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'accepted', 'expired', 'cancelled')),
  accepted_by_address TEXT,
  accepted_at         TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_worker_invites_employer ON worker_invites (employer_address);
