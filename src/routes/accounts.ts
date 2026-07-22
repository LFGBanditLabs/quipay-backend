import { Router, Request, Response, NextFunction } from "express";
import {
  authenticateRequest,
  requireUser,
  AuthenticatedRequest,
} from "../middleware/rbac";
import { validateRequest } from "../middleware/validation";
import {
  getAccountByQuipayId,
  getAccountWallets,
  upsertAccountWallet,
  backfillStellarAddressForAccount,
  updateAccountEmail,
} from "../db/queries";
import { accountWalletLinkSchema } from "../schemas/accounts.schema";

export const accountsRouter = Router();

accountsRouter.use(authenticateRequest, requireUser);

/**
 * GET /api/accounts/me
 * Returns the caller's Quipay ID and basic account info, resolved from the
 * verified Privy identity by authenticateRequest.
 */
accountsRouter.get("/me", (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.json({
    quipayId: req.user.quipayId,
    email: req.user.email ?? null,
  });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/accounts/email
 * Captures the caller's email (from Privy on the client) since it isn't in the
 * auth token. Lets the roster show who a worker is by email, not just QP ID.
 */
accountsRouter.post("/email", async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Invalid email" });
  }
  await updateAccountEmail(req.user.accountId, email);
  res.json({ ok: true });
});

const QUIPAY_ID_RE = /^QP\d+$/i;

/**
 * GET /api/accounts/lookup/:quipayId
 * Resolves another account by its QP ID — used before adding someone to a
 * roster/stream, so the caller only ever needs their QP ID, never a raw
 * wallet address. Returns 404 rather than leaking whether the account exists
 * beyond that.
 */
accountsRouter.get(
  "/lookup/:quipayId",
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const quipayId = req.params.quipayId?.trim().toUpperCase() ?? "";
    if (!QUIPAY_ID_RE.test(quipayId)) {
      return res.status(400).json({ error: "Invalid QP ID" });
    }

    const account = await getAccountByQuipayId(quipayId);
    if (!account) {
      return res.status(404).json({ error: "No account found with that QP ID" });
    }

    res.json({
      quipayId: account.quipayId,
      email: account.email,
      walletStellar: account.walletStellar,
      walletBase: account.walletBase,
    });
  },
);

/**
 * GET /api/accounts/wallets
 * Lists the chain wallets linked to the caller's account.
 */
accountsRouter.get(
  "/wallets",
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const wallets = await getAccountWallets(req.user.accountId);
    res.json({
      wallets: wallets.map((w) => ({
        chain: w.chain,
        address: w.address,
        isPrimary: w.is_primary,
      })),
    });
  },
);

/**
 * POST /api/accounts/wallets
 * Links a chain wallet address to the caller's account (one per chain).
 *
 * TODO(security): this accepts a bare address with no proof of ownership.
 * The (chain, address) pair is globally unique across all accounts, so a
 * bad-faith or mistaken submission can squat someone else's real address.
 * Acceptable while nothing reads this table for payout/fund routing — this
 * MUST gain a signed-challenge ownership check (wallet signature for
 * Stellar, EIP-191 personal_sign for Arc) before any funding flow relies on
 * it.
 */
accountsRouter.post(
  "/wallets",
  validateRequest({ body: accountWalletLinkSchema }),
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { chain, address } = req.body as { chain: string; address: string };
    const wallet = await upsertAccountWallet(req.user.accountId, chain, address);

    // Heal employer/worker rows created before the wallet existed (onboarding
    // is wallet-optional), so address-keyed flows like invites keep working.
    if (chain === "stellar") {
      await backfillStellarAddressForAccount(req.user.accountId, address);
    }

    res.json({
      chain: wallet.chain,
      address: wallet.address,
      isPrimary: wallet.is_primary,
    });
  },
);

accountsRouter.use(
  (err: any, req: Request, res: Response, next: NextFunction) => {
    if (err.code === "23505") {
      return res
        .status(409)
        .json({ error: "This address is already linked to another account." });
    }
    next(err);
  },
);
