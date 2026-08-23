import * as pool from "../db/pool";

jest.mock("../db/pool", () => ({
  getPool: jest.fn(),
}));

jest.mock("../logger", () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const mockQuery = jest.fn();
(pool.getPool as jest.Mock).mockReturnValue({ query: mockQuery });

import {
  createChallenge,
  verifyAndLink,
  getWalletVerificationStatus,
  cleanupExpiredChallenges,
} from "../services/walletVerification";

describe("walletVerification", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("createChallenge", () => {
    it("generates a challenge with correct prefix and stores it in DB", async () => {
      mockQuery
        .mockResolvedValueOnce({}) // DELETE old challenges
        .mockResolvedValueOnce({}); // INSERT new challenge

      const { challenge, expiresAt } = await createChallenge(
        "GABC123DEF456",
        "stellar",
        "did:privy:test123",
      );

      expect(challenge).toMatch(/^quipay-verify:[a-f0-9]{64}$/);
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1000);

      // Should delete old challenges first
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM wallet_challenges"),
        ["GABC123DEF456", "stellar"],
      );

      // Should insert new challenge
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO wallet_challenges"),
        expect.arrayContaining(["GABC123DEF456", "stellar", expect.any(String), "did:privy:test123"]),
      );
    });
  });

  describe("verifyAndLink", () => {
    it("returns error when no pending challenge exists", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await verifyAndLink(
        "GABC123DEF456",
        "stellar",
        "quipay-verify:abc123",
        "sig_base64",
        "did:privy:test123",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("No pending challenge");
    });

    it("returns 410-style error for expired challenges", async () => {
      const pastDate = new Date(Date.now() - 10000).toISOString();
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 1, nonce: "abc123", expires_at: pastDate }],
      });

      const result = await verifyAndLink(
        "GABC123DEF456",
        "stellar",
        "quipay-verify:abc123",
        "sig_base64",
        "did:privy:test123",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("expired");

      // Should have cleaned up the expired challenge
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM wallet_challenges WHERE id"),
        [1],
      );
    });

    it("returns error for challenge mismatch", async () => {
      const futureDate = new Date(Date.now() + 300000).toISOString();
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 1, nonce: "abc123", expires_at: futureDate }],
      });

      const result = await verifyAndLink(
        "GABC123DEF456",
        "stellar",
        "quipay-verify:WRONG",
        "sig_base64",
        "did:privy:test123",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("mismatch");
    });

    it("rejects invalid Stellar signatures", async () => {
      const futureDate = new Date(Date.now() + 300000).toISOString();
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 1, nonce: "abc123", expires_at: futureDate }],
      });

      const result = await verifyAndLink(
        "GABC123DEF456",
        "stellar",
        "quipay-verify:abc123",
        "invalid_signature_base64",
        "did:privy:test123",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Signature verification failed");
    });

    it("rejects invalid EVM signatures", async () => {
      const futureDate = new Date(Date.now() + 300000).toISOString();
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 1, nonce: "abc123", expires_at: futureDate }],
      });

      const result = await verifyAndLink(
        "0x1234567890abcdef",
        "evm",
        "quipay-verify:abc123",
        "0xinvalid",
        "did:privy:test123",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Signature verification failed");
    });
  });

  describe("getWalletVerificationStatus", () => {
    it("returns false for both chains when worker not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const status = await getWalletVerificationStatus("did:privy:unknown");
      expect(status).toEqual({ stellar: false, base: false });
    });

    it("returns correct verification status", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ wallet_stellar_verified: true, wallet_base_verified: false }],
      });

      const status = await getWalletVerificationStatus("did:privy:test123");
      expect(status).toEqual({ stellar: true, base: false });
    });
  });

  describe("cleanupExpiredChallenges", () => {
    it("deletes expired challenges and returns count", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 3 });

      const count = await cleanupExpiredChallenges();
      expect(count).toBe(3);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM wallet_challenges WHERE expires_at"),
      );
    });
  });
});
