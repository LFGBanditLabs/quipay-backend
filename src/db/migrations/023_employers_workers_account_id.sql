-- Link the existing employers/workers tables to the new accounts table.
-- Nullable for now — a legacy employers/workers row has no verified Privy
-- identity yet until it's claimed (see queries.ts linkLegacyEmployerToAccount).

ALTER TABLE employers ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts (id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employers_account_id ON employers (account_id) WHERE account_id IS NOT NULL;

ALTER TABLE workers ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts (id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_account_id ON workers (account_id) WHERE account_id IS NOT NULL;
