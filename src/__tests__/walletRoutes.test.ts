import express from "express";
import request from "supertest";
import { workersRouter } from "../routes/workers";
import * as pool from "../db/pool";
import * as walletVerification from "../services/walletVerification";

jest.mock("../db/pool", () => ({
  getPool: jest.fn(() => ({})),
  query: jest.fn(),
}));

jest.mock("../services/baseChain", () => ({
  getWorkerStreamsBase: jest.fn(),
  getStreamBase: jest.fn(),
}));

jest.mock("../services/walletVerification");
jest.mock("../audit/serviceLogger", () => ({
  logServiceInfo: jest.fn(),
  logServiceWarn: jest.fn(),
  logServiceError: jest.fn(),
}));

jest.mock("../middleware/privyAuth", () => ({
  requirePrivyAuth: (req: any, _res: any, next: any) => {
    req.privyUser = { sub: "did:privy:test-user-123" };
    next();
  },
}));

jest.mock("../middleware/validation", () => ({
  validateRequest:
    (schemas: { body?: any }) =>
    async (req: any, res: any, next: any) => {
      if (schemas.body) {
        try {
          req.body = await schemas.body.parseAsync(req.body);
          next();
        } catch (err: any) {
          res.status(400).json({
            error: "Validation error",
            details: err.issues ?? err.message,
          });
        }
      } else {
        next();
      }
    },
}));

const mockQuery = pool.query as jest.Mock;
const mockCreateChallenge = walletVerification.createChallenge as jest.Mock;
const mockVerifyAndLink = walletVerification.verifyAndLink as jest.Mock;
const mockGetWalletStatus = walletVerification.getWalletVerificationStatus as jest.Mock;

const app = express();
app.use(express.json());
app.use("/workers", workersRouter);

describe("Wallet verification routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /workers/me/wallets/challenge", () => {
    it("returns a challenge and expiry date", async () => {
      const futureDate = new Date(Date.now() + 300000);
      mockCreateChallenge.mockResolvedValueOnce({
        challenge: "quipay-verify:abc123",
        expiresAt: futureDate,
      });

      const res = await request(app)
        .post("/workers/me/wallets/challenge")
        .send({ address: "GABC123DEF456", chain: "stellar" });

      expect(res.status).toBe(200);
      expect(res.body.challenge).toBe("quipay-verify:abc123");
      expect(res.body.expiresAt).toBe(futureDate.toISOString());
      expect(mockCreateChallenge).toHaveBeenCalledWith(
        "GABC123DEF456",
        "stellar",
        "did:privy:test-user-123",
      );
    });

    it("validates chain must be stellar or evm", async () => {
      const res = await request(app)
        .post("/workers/me/wallets/challenge")
        .send({ address: "GABC123DEF456", chain: "bitcoin" });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /workers/me/wallets/verify", () => {
    it("returns success on valid verification", async () => {
      mockVerifyAndLink.mockResolvedValueOnce({ success: true });

      const res = await request(app)
        .post("/workers/me/wallets/verify")
        .send({
          address: "GABC123DEF456",
          chain: "stellar",
          challenge: "quipay-verify:abc123",
          signature: "valid_signature_base64",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.verified).toBe(true);
    });

    it("returns 400 on failed verification", async () => {
      mockVerifyAndLink.mockResolvedValueOnce({
        success: false,
        error: "Signature verification failed.",
      });

      const res = await request(app)
        .post("/workers/me/wallets/verify")
        .send({
          address: "GABC123DEF456",
          chain: "stellar",
          challenge: "quipay-verify:abc123",
          signature: "bad_signature_12345",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Signature verification failed");
    });

    it("returns 410 on expired challenge", async () => {
      mockVerifyAndLink.mockResolvedValueOnce({
        success: false,
        error: "Challenge expired. Request a new one.",
      });

      const res = await request(app)
        .post("/workers/me/wallets/verify")
        .send({
          address: "GABC123DEF456",
          chain: "stellar",
          challenge: "quipay-verify:abc123",
          signature: "a-valid-signature",
        });

      expect(res.status).toBe(410);
    });
  });

  describe("GET /workers/me/wallets/status", () => {
    it("returns verification status for both chains", async () => {
      mockGetWalletStatus.mockResolvedValueOnce({
        stellar: true,
        base: false,
      });

      const res = await request(app).get("/workers/me/wallets/status");

      expect(res.status).toBe(200);
      expect(res.body.stellar).toBe(true);
      expect(res.body.base).toBe(false);
    });
  });
});
