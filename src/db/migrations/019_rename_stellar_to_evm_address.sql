-- Rename stellar_address → evm_address on the employers table
ALTER TABLE employers RENAME COLUMN stellar_address TO evm_address;
ALTER INDEX IF EXISTS idx_employers_stellar_address RENAME TO idx_employers_evm_address;
