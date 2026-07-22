-- Migration 020: Stellar-only pivot — undo the Arc/EVM rename from 019.
-- Employers are keyed by their Stellar wallet (G...) again.
ALTER TABLE employers RENAME COLUMN evm_address TO stellar_address;
ALTER INDEX IF EXISTS idx_employers_evm_address RENAME TO idx_employers_stellar_address;

-- Repair rows lowercased by the old EVM-style inserts: Stellar addresses are
-- canonically uppercase base32, and a lowercased G... address is unusable for
-- on-chain calls (e.g. the employer approving a worker via set_stream_active).
UPDATE worker_registrations
   SET worker_address   = UPPER(worker_address),
       employer_address = UPPER(employer_address);

UPDATE employee_profiles
   SET worker_address   = UPPER(worker_address),
       employer_address = UPPER(employer_address);

UPDATE employers
   SET stellar_address = UPPER(stellar_address)
 WHERE stellar_address IS NOT NULL;
