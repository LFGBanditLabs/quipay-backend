-- Real identity layer: a Quipay ID per account, backed by a verified Privy
-- DID, with multi-chain wallet addresses stored separately from the account
-- itself. Net-new tables only — nothing existing is touched here.

CREATE SEQUENCE IF NOT EXISTS quipay_id_seq START WITH 100000000 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS accounts (
  id          BIGSERIAL   PRIMARY KEY,
  quipay_id   TEXT        NOT NULL UNIQUE
                DEFAULT ('QP' || LPAD(nextval('quipay_id_seq')::text, 9, '0')),
  privy_id    TEXT,
  email       TEXT,
  role        TEXT        NOT NULL DEFAULT 'user'
                CHECK (role IN ('user', 'admin', 'superadmin')),
  status      TEXT        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_privy_id ON accounts (privy_id) WHERE privy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts (LOWER(email));

CREATE TABLE IF NOT EXISTS account_wallets (
  id          BIGSERIAL   PRIMARY KEY,
  account_id  BIGINT      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  chain       TEXT        NOT NULL,
  address     TEXT        NOT NULL,
  is_primary  BOOLEAN     NOT NULL DEFAULT false,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_wallets_account_chain ON account_wallets (account_id, chain);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_wallets_chain_address ON account_wallets (chain, LOWER(address));
CREATE INDEX IF NOT EXISTS idx_account_wallets_account ON account_wallets (account_id);
