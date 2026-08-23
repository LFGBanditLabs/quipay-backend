import crypto from "crypto";
import { getPool } from "../db/pool";
import { logger } from "../logger";

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CHALLENGE_PREFIX = "quipay-verify:";

// ─── Challenge Generation ─────────────────────────────────────────────────────

export async function createChallenge(
  address: string,
  chain: "stellar" | "evm",
  privyId: string,
): Promise<{ challenge: string; expiresAt: Date }> {
  const pool = getPool();
  if (!pool) throw new Error("Database not available");

  const nonce = crypto.randomBytes(32).toString("hex");
  const challenge = `${CHALLENGE_PREFIX}${nonce}`;
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

  // Invalidate any existing pending challenges for this address+chain
  await pool.query(
    `DELETE FROM wallet_challenges WHERE address = $1 AND chain = $2`,
    [address, chain],
  );

  await pool.query(
    `INSERT INTO wallet_challenges (address, chain, nonce, privy_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [address, chain, nonce, privyId, expiresAt.toISOString()],
  );

  return { challenge, expiresAt };
}

// ─── Stellar Signature Verification ──────────────────────────────────────────

async function verifyStellarSignature(
  address: string,
  challenge: string,
  signature: string,
): Promise<boolean> {
  try {
    // Dynamic import to avoid loading stellar-sdk when not needed
    const { StrKey, TransactionBuilder, Networks, Transaction } = await import(
      "@stellar/stellar-sdk"
    );

    // Decode the claimed public key
    const rawKey = StrKey.decodeEd25519PublicKey(address);

    // Decode the signature from base64
    const sigBuf = Buffer.from(signature, "base64");

    // The client signs the challenge string as a raw message.
    // Stellar signMessage produces a standard ed25519 signature over the UTF-8 bytes.
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );

    const valid = await crypto.subtle.verify(
      "Ed25519",
      cryptoKey,
      sigBuf,
      new TextEncoder().encode(challenge),
    );

    return valid;
  } catch (err) {
    logger.error({ err }, "Stellar signature verification failed");
    return false;
  }
}

// ─── EVM Signature Verification ──────────────────────────────────────────────

async function verifyEvmSignature(
  address: string,
  challenge: string,
  signature: string,
): Promise<boolean> {
  try {
    const { recoverMessageAddress } = await import("viem");

    const recovered = await recoverMessageAddress({
      message: challenge,
      signature: signature as `0x${string}`,
    });

    return recovered.toLowerCase() === address.toLowerCase();
  } catch (err) {
    logger.error({ err }, "EVM signature verification failed");
    return false;
  }
}

// ─── Verify and Link ─────────────────────────────────────────────────────────

export interface VerifyResult {
  success: boolean;
  error?: string;
}

export async function verifyAndLink(
  address: string,
  chain: "stellar" | "evm",
  challenge: string,
  signature: string,
  privyId: string,
): Promise<VerifyResult> {
  const pool = getPool();
  if (!pool) throw new Error("Database not available");

  // Look up the stored challenge
  const result = await pool.query(
    `SELECT id, nonce, expires_at FROM wallet_challenges
     WHERE address = $1 AND chain = $2 AND privy_id = $3
     ORDER BY created_at DESC LIMIT 1`,
    [address, chain, privyId],
  );

  if (!result.rows.length) {
    return { success: false, error: "No pending challenge found. Request a new one." };
  }

  const stored = result.rows[0];

  // Check expiry
  if (new Date(stored.expires_at) < new Date()) {
    await pool.query(`DELETE FROM wallet_challenges WHERE id = $1`, [stored.id]);
    return { success: false, error: "Challenge expired. Request a new one." };
  }

  // Reconstruct the expected challenge string
  const expectedChallenge = `${CHALLENGE_PREFIX}${stored.nonce}`;

  // Validate the challenge matches
  if (challenge !== expectedChallenge) {
    return { success: false, error: "Challenge mismatch." };
  }

  // Verify signature based on chain
  let valid = false;
  if (chain === "stellar") {
    valid = await verifyStellarSignature(address, challenge, signature);
  } else {
    valid = await verifyEvmSignature(address, challenge, signature);
  }

  if (!valid) {
    return { success: false, error: "Signature verification failed." };
  }

  // Mark wallet as verified
  const column =
    chain === "stellar" ? "wallet_stellar_verified" : "wallet_base_verified";
  const walletColumn = chain === "stellar" ? "wallet_stellar" : "wallet_base";

  await pool.query(
    `UPDATE workers
     SET ${column} = TRUE,
         ${walletColumn} = COALESCE(${walletColumn}, $1)
     WHERE privy_id = $2`,
    [address, privyId],
  );

  // Clean up the used challenge
  await pool.query(`DELETE FROM wallet_challenges WHERE id = $1`, [stored.id]);

  return { success: true };
}

// ─── Check Verification Status ───────────────────────────────────────────────

export async function getWalletVerificationStatus(
  privyId: string,
): Promise<{ stellar: boolean; base: boolean }> {
  const pool = getPool();
  if (!pool) throw new Error("Database not available");

  const result = await pool.query(
    `SELECT wallet_stellar_verified, wallet_base_verified
     FROM workers WHERE privy_id = $1 LIMIT 1`,
    [privyId],
  );

  if (!result.rows.length) {
    return { stellar: false, base: false };
  }

  return {
    stellar: result.rows[0].wallet_stellar_verified ?? false,
    base: result.rows[0].wallet_base_verified ?? false,
  };
}

// ─── Cleanup Expired Challenges ──────────────────────────────────────────────

export async function cleanupExpiredChallenges(): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;

  const result = await pool.query(
    `DELETE FROM wallet_challenges WHERE expires_at < NOW()`,
  );
  return result.rowCount ?? 0;
}
