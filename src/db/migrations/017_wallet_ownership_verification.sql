-- Migration 017: Wallet ownership verification via challenge-response
-- Adds wallet_challenges table for nonces and verification columns to workers

-- Table to store pending challenge nonces for wallet verification
CREATE TABLE IF NOT EXISTS wallet_challenges (
  id            SERIAL PRIMARY KEY,
  address       TEXT NOT NULL,
  chain         TEXT NOT NULL CHECK (chain IN ('stellar', 'evm')),
  nonce         TEXT NOT NULL,
  privy_id      TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_challenges_address_chain
  ON wallet_challenges (address, chain);
CREATE INDEX IF NOT EXISTS idx_wallet_challenges_privy_id
  ON wallet_challenges (privy_id);

-- Add wallet_verified columns to workers table
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS wallet_stellar_verified BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS wallet_base_verified BOOLEAN DEFAULT FALSE;
