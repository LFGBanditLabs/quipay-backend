import { Router, Response, Request, NextFunction } from "express";
import { validateRequest } from "../middleware/validation";
import {
  authenticateRequest,
  requireUser,
  AuthenticatedRequest,
} from "../middleware/rbac";
import { requireVerifiedEmployer } from "../middleware/employerVerification";
import { query } from "../db/pool";
import {
  employerOnboardingSchema,
  employerTreasuryDepositSchema,
  workerInviteSchema,
} from "../schemas/employers.schema";
import { generateInviteCode } from "../utils/inviteCode";
import {
  getTreasuryBalanceByEmployer,
  getEmployerById,
  recordVaultEvent,
  upsertEmployerVerification,
  updateTreasuryBalance,
  findUnclaimedEmployerByEmail,
  linkLegacyEmployerToAccount,
  updateAccountEmail,
  getAccountByQuipayId,
} from "../db/queries";
import { verifyBusinessRegistration } from "../services/kybService";

export const employersRouter = Router();

// Stellar public keys are canonically uppercase base32 — never lowercase them,
// a case-mangled G... address is unusable for on-chain calls.
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/**
 * GET /api/employers/by-address?address=G...
 * Public — no auth. Returns an employer by their Stellar address.
 */
employersRouter.get("/by-address", async (req: Request, res: Response) => {
  const address =
    typeof req.query.address === "string" ? req.query.address.trim() : "";
  if (!STELLAR_ADDRESS_RE.test(address)) return res.json({ employer: null });

  const result = await query<{
    employer_id: string;
    business_name: string;
    country_code: string;
    stellar_address: string;
  }>(
    `SELECT employer_id, business_name, country_code, stellar_address
     FROM employers
     WHERE stellar_address = $1
     LIMIT 1`,
    [address],
  );

  return res.json({ employer: result.rows[0] ?? null });
});

/**
 * POST /api/employers/worker-registrations
 * Public — no auth. Records an on-chain worker→employer registration and
 * upserts the employee profile (name, role, dept, etc.).
 */
employersRouter.post(
  "/worker-registrations",
  async (req: Request, res: Response) => {
    const {
      workerAddress,
      employerAddress,
      fullName,
      jobTitle,
      department,
      workEmail,
      startDate,
      employeeRef,
    } = req.body as {
      workerAddress?: string;
      employerAddress?: string;
      fullName?: string;
      jobTitle?: string;
      department?: string;
      workEmail?: string;
      startDate?: string;
      employeeRef?: string;
    };

    if (!workerAddress || !employerAddress) {
      return res
        .status(400)
        .json({ error: "workerAddress and employerAddress are required" });
    }
    if (!fullName || !jobTitle) {
      return res.status(400).json({ error: "fullName and jobTitle are required" });
    }

    const normWorker = workerAddress.trim();
    const normEmployer = employerAddress.trim();
    if (
      !STELLAR_ADDRESS_RE.test(normWorker) ||
      !STELLAR_ADDRESS_RE.test(normEmployer)
    ) {
      return res
        .status(400)
        .json({ error: "Addresses must be valid Stellar addresses (G...)" });
    }

    await query(
      `INSERT INTO worker_registrations (worker_address, employer_address)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [normWorker, normEmployer],
    );

    await query(
      `INSERT INTO employee_profiles
         (worker_address, employer_address, full_name, job_title, department, work_email, start_date, employee_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8)
       ON CONFLICT (worker_address, employer_address) DO UPDATE SET
         full_name    = EXCLUDED.full_name,
         job_title    = EXCLUDED.job_title,
         department   = EXCLUDED.department,
         work_email   = EXCLUDED.work_email,
         start_date   = EXCLUDED.start_date::date,
         employee_ref = EXCLUDED.employee_ref,
         updated_at   = NOW()`,
      [
        normWorker,
        normEmployer,
        fullName,
        jobTitle,
        department ?? null,
        workEmail ?? null,
        startDate ?? null,
        employeeRef ?? null,
      ],
    );

    return res.json({ success: true });
  },
);

/**
 * GET /api/employers/worker-registrations/:workerAddress
 * Public — no auth. Returns all employers a worker is registered under.
 */
employersRouter.get(
  "/worker-registrations/:workerAddress",
  async (req: Request, res: Response) => {
    const { workerAddress } = req.params;
    const result = await query<{
      employer_id: string;
      business_name: string;
      country_code: string;
      stellar_address: string;
    }>(
      `SELECT e.employer_id, e.business_name, e.country_code, e.stellar_address
       FROM worker_registrations wr
       JOIN employers e ON e.stellar_address = wr.employer_address
       WHERE wr.worker_address = $1
       ORDER BY wr.registered_at DESC`,
      [workerAddress],
    );
    return res.json({ employers: result.rows });
  },
);

/**
 * GET /api/employers/invites/:code
 * Public — no auth. Returns the offer details for a worker to review before
 * connecting their wallet. Status is computed here rather than by a cron —
 * a pending invite past its expiry reads as 'expired' without a background job.
 */
employersRouter.get(
  "/invites/:code",
  async (req: Request, res: Response) => {
    const rawCode = req.params.code;
    const code = (Array.isArray(rawCode) ? rawCode[0] : rawCode)?.trim() ?? "";
    if (!code) return res.status(404).json({ error: "Invite not found" });

    const result = await query<{
      code: string;
      employer_address: string;
      business_name: string;
      candidate_name: string;
      candidate_quipay_id: string | null;
      job_title: string;
      description: string | null;
      pay_amount: string;
      pay_token: string;
      duration_days: number;
      status: string;
      expires_at: string;
    }>(
      `SELECT wi.code, wi.employer_address, e.business_name, wi.candidate_name,
              a.quipay_id AS candidate_quipay_id,
              wi.job_title, wi.description, wi.pay_amount, wi.pay_token,
              wi.duration_days, wi.status, wi.expires_at
       FROM worker_invites wi
       JOIN employers e ON e.stellar_address = wi.employer_address
       LEFT JOIN accounts a ON a.id = wi.candidate_account_id
       WHERE wi.code = $1
       LIMIT 1`,
      [code],
    );

    const invite = result.rows[0];
    if (!invite) return res.status(404).json({ error: "Invite not found" });

    const effectiveStatus =
      invite.status === "pending" && new Date(invite.expires_at) < new Date()
        ? "expired"
        : invite.status;

    return res.json({ invite: { ...invite, status: effectiveStatus } });
  },
);

/**
 * POST /api/employers/invites/:code/accept
 * Auth required (the invited worker's own Quipay login) — replaces the old
 * public/self-reported `workerAddress` body with the caller's own on-file
 * wallet address, resolved by QP ID. If the invite was pinned to a specific
 * candidate (via candidateQuipayId at creation), only that account may
 * accept it. Records the worker's registration + profile using the invite's
 * own terms, not freeform input — this is the data source change; the
 * Pending Requests panel (backend `GET /employees` + the frontend hook)
 * reads from the same worker_registrations/employee_profiles tables exactly
 * as it does for the legacy self-registration path, unmodified.
 */
employersRouter.post(
  "/invites/:code/accept",
  authenticateRequest,
  requireUser,
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const rawCode = req.params.code;
    const code = (Array.isArray(rawCode) ? rawCode[0] : rawCode)?.trim() ?? "";

    const inviteResult = await query<{
      employer_address: string;
      employer_account_id: number | null;
      candidate_name: string;
      candidate_account_id: number | null;
      job_title: string;
      description: string | null;
      status: string;
      expires_at: string;
    }>(
      `SELECT employer_address, employer_account_id, candidate_name,
              candidate_account_id, job_title, description, status, expires_at
       FROM worker_invites
       WHERE code = $1
       LIMIT 1`,
      [code],
    );
    const invite = inviteResult.rows[0];
    if (!invite) return res.status(404).json({ error: "Invite not found" });

    const expired =
      invite.status === "pending" && new Date(invite.expires_at) < new Date();
    if (invite.status !== "pending" || expired) {
      return res
        .status(409)
        .json({ error: expired ? "Invite has expired" : "Invite already used" });
    }

    if (
      invite.candidate_account_id !== null &&
      invite.candidate_account_id !== req.user.accountId
    ) {
      return res
        .status(403)
        .json({ error: "This invite was issued to a different QP ID" });
    }

    const account = await getAccountByQuipayId(req.user.quipayId);
    const workerAddress = account?.walletStellar;
    if (!workerAddress || !STELLAR_ADDRESS_RE.test(workerAddress)) {
      return res.status(409).json({
        error:
          "No Stellar address on file for your account yet — open the app once to finish wallet setup, then try again.",
      });
    }

    await query(
      `UPDATE worker_invites
       SET status = 'accepted', accepted_by_address = $1, accepted_by_account_id = $2,
           accepted_at = NOW(), updated_at = NOW()
       WHERE code = $3`,
      [workerAddress, req.user.accountId, code],
    );

    await query(
      `INSERT INTO worker_registrations
         (worker_address, employer_address, worker_account_id, employer_account_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (worker_address, employer_address) DO UPDATE SET
         worker_account_id   = EXCLUDED.worker_account_id,
         employer_account_id = EXCLUDED.employer_account_id`,
      [workerAddress, invite.employer_address, req.user.accountId, invite.employer_account_id],
    );

    await query(
      `INSERT INTO employee_profiles
         (worker_address, employer_address, full_name, job_title, department,
          work_email, start_date, employee_ref, worker_account_id, employer_account_id)
       VALUES ($1, $2, $3, $4, NULL, NULL, NULL, NULL, $5, $6)
       ON CONFLICT (worker_address, employer_address) DO UPDATE SET
         full_name           = EXCLUDED.full_name,
         job_title           = EXCLUDED.job_title,
         worker_account_id   = EXCLUDED.worker_account_id,
         employer_account_id = EXCLUDED.employer_account_id,
         updated_at          = NOW()`,
      [
        workerAddress,
        invite.employer_address,
        invite.candidate_name,
        invite.job_title,
        req.user.accountId,
        invite.employer_account_id,
      ],
    );

    return res.json({ success: true, quipayId: req.user.quipayId, workerAddress });
  },
);

/**
 * GET /api/employers/search?q=acme
 * Public — no auth. Returns verified employers matching the query.
 */
employersRouter.get("/search", async (req: Request, res: Response) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q || q.length < 2) {
    return res.json({ employers: [] });
  }

  const result = await query<{
    employer_id: string;
    business_name: string;
    country_code: string;
    stellar_address: string | null;
  }>(
    `SELECT employer_id, business_name, country_code, stellar_address
     FROM employers
     WHERE verification_status = 'verified'
       AND business_name ILIKE $1
     ORDER BY business_name
     LIMIT 10`,
    [`%${q}%`],
  );

  return res.json({ employers: result.rows });
});

/**
 * POST /api/employers/withdrawal-events
 * Public — records a worker withdrawal after the on-chain TX succeeds.
 */
employersRouter.post(
  "/withdrawal-events",
  async (req: Request, res: Response) => {
    const { workerAddress, employerAddress, streamId, amount, tokenSymbol, txHash } =
      req.body as {
        workerAddress?: string;
        employerAddress?: string;
        streamId?: string;
        amount?: string;
        tokenSymbol?: string;
        txHash?: string;
      };

    if (!workerAddress || !streamId || !amount || !txHash) {
      return res.status(400).json({ error: "workerAddress, streamId, amount and txHash are required" });
    }

    await query(
      `INSERT INTO worker_withdrawal_events
         (worker_address, employer_address, stream_id, amount, token_symbol, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tx_hash) DO NOTHING`,
      [
        workerAddress,
        employerAddress ?? null,
        streamId,
        amount,
        tokenSymbol ?? "USDC",
        txHash,
      ],
    );

    return res.json({ success: true });
  },
);

/**
 * GET /api/employers/withdrawal-events?address=G...
 * Public — returns all recorded withdrawal events for a worker address.
 */
employersRouter.get(
  "/withdrawal-events",
  async (req: Request, res: Response) => {
    const address =
      typeof req.query.address === "string" ? req.query.address.trim() : "";
    if (!address) return res.json({ withdrawals: [] });

    const result = await query<{
      id: number;
      worker_address: string;
      employer_address: string | null;
      stream_id: string;
      amount: string;
      token_symbol: string;
      tx_hash: string;
      created_at: string;
    }>(
      `SELECT id, worker_address, employer_address, stream_id, amount, token_symbol, tx_hash, created_at
       FROM worker_withdrawal_events
       WHERE worker_address = $1
       ORDER BY created_at DESC
       LIMIT 500`,
      [address],
    );

    return res.json({ withdrawals: result.rows });
  },
);

employersRouter.use(authenticateRequest, requireUser);

employersRouter.post(
  "/onboard",
  validateRequest({ body: employerOnboardingSchema }),
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const verification = await verifyBusinessRegistration(req.body);
    const stellarAddress = req.body.stellarAddress as string | undefined;
    const contactEmail = req.body.contactEmail as string | undefined;

    // If this Quipay account has no employer row linked yet, check for a
    // pre-real-auth employer record with matching contact email so a legacy
    // business keeps its KYB history instead of getting a duplicate row.
    let employerId = req.user.id;
    if (employerId === req.user.quipayId && contactEmail) {
      const unclaimed = await findUnclaimedEmployerByEmail(contactEmail);
      if (unclaimed) {
        employerId = unclaimed.employer_id;
      }
    }

    const employer = await upsertEmployerVerification({
      employerId,
      businessName: req.body.businessName,
      registrationNumber: req.body.registrationNumber,
      countryCode: req.body.countryCode,
      contactName: req.body.contactName,
      contactEmail,
      stellarAddress,
      verificationStatus: verification.status,
      verificationReason: verification.reason ?? null,
      verificationMetadata: verification.metadata ?? {},
    });

    await linkLegacyEmployerToAccount(employerId, req.user.accountId);
    if (contactEmail) {
      await updateAccountEmail(req.user.accountId, contactEmail);
    }

    res.status(verification.status === "verified" ? 200 : 202).json({
      employer,
      status: employer.verification_status,
      chain: {
        stellarAddress: stellarAddress ?? null,
        // Populated by the indexer once streams/vault data exist on Stellar;
        // the Arc (EVM) lookups that used to fill these are frozen.
        existingStreams: 0,
        vaultBalance: 0,
      },
    });
  },
);

employersRouter.get(
  "/status",
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const employer = await getEmployerById(req.user.id);
    if (!employer) {
      return res.json({ status: "not_started" });
    }

    res.json({
      status: employer.verification_status,
      employer,
    });
  },
);

/**
 * GET /api/employers/employees
 * Auth required. Returns all employees registered under the authenticated employer,
 * including their profile details.
 */
employersRouter.get(
  "/employees",
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const employer = await getEmployerById(req.user.id);
    const employerAddress = employer?.stellar_address;
    if (!employerAddress) {
      return res.json({ employees: [] });
    }

    const result = await query<{
      worker_address: string;
      quipay_id: string | null;
      email: string | null;
      full_name: string;
      job_title: string;
      department: string | null;
      work_email: string | null;
      start_date: string | null;
      employee_ref: string | null;
      registered_at: string;
    }>(
      `SELECT
         ep.worker_address,
         a.quipay_id,
         COALESCE(a.email, ep.work_email) AS email,
         ep.full_name,
         ep.job_title,
         ep.department,
         ep.work_email,
         ep.start_date,
         ep.employee_ref,
         wr.registered_at
       FROM employee_profiles ep
       JOIN worker_registrations wr
         ON LOWER(wr.worker_address) = LOWER(ep.worker_address)
        AND LOWER(wr.employer_address) = LOWER(ep.employer_address)
       LEFT JOIN accounts a ON a.id = ep.worker_account_id
       WHERE LOWER(ep.employer_address) = LOWER($1)
       ORDER BY wr.registered_at DESC`,
      [employerAddress],
    );

    return res.json({ employees: result.rows });
  },
);

const INVITE_VALIDITY_DAYS = 7;

/**
 * POST /api/employers/invites
 * Auth required. Creates a one-time invite link for a specific hire —
 * role, pay, and duration are defined by the employer, not the worker.
 */
employersRouter.post(
  "/invites",
  validateRequest({ body: workerInviteSchema }),
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const employer = await getEmployerById(req.user.id);
    const employerAddress = employer?.stellar_address;
    if (!employerAddress) {
      return res.status(404).json({ error: "Complete employer onboarding first" });
    }

    const candidate = await getAccountByQuipayId(req.body.candidateQuipayId);
    if (!candidate) {
      return res
        .status(404)
        .json({ error: "No Quipay account found with that QP ID" });
    }

    const code = generateInviteCode();
    const expiresAt = new Date(
      Date.now() + INVITE_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
    );

    const result = await query(
      `INSERT INTO worker_invites
         (code, employer_address, candidate_name, candidate_account_id,
          employer_account_id, job_title, description, pay_amount, pay_token,
          duration_days, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        code,
        employerAddress,
        candidate.email ?? candidate.quipayId,
        candidate.accountId,
        req.user.accountId,
        req.body.jobTitle,
        req.body.description ?? null,
        req.body.payAmount,
        req.body.payToken,
        req.body.durationDays,
        expiresAt,
      ],
    );

    return res
      .status(201)
      .json({ invite: { ...result.rows[0], candidateQuipayId: candidate.quipayId } });
  },
);

/**
 * GET /api/employers/invites
 * Auth required. Lists invites the authenticated employer has sent.
 */
employersRouter.get(
  "/invites",
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const employer = await getEmployerById(req.user.id);
    const employerAddress = employer?.stellar_address;
    if (!employerAddress) {
      return res.json({ invites: [] });
    }

    const result = await query(
      `SELECT * FROM worker_invites
       WHERE LOWER(employer_address) = LOWER($1)
       ORDER BY created_at DESC`,
      [employerAddress],
    );

    return res.json({ invites: result.rows });
  },
);

/**
 * DELETE /api/employers/invites/:code
 * Auth required. Cancels a pending invite, scoped to the caller's own
 * employer address.
 */
employersRouter.delete(
  "/invites/:code",
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const employer = await getEmployerById(req.user.id);
    const employerAddress = employer?.stellar_address;
    if (!employerAddress) {
      return res.status(404).json({ error: "Employer not found" });
    }

    const result = await query(
      `UPDATE worker_invites
       SET status = 'cancelled', updated_at = NOW()
       WHERE code = $1
         AND LOWER(employer_address) = LOWER($2)
         AND status = 'pending'
       RETURNING code`,
      [req.params.code, employerAddress],
    );

    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ error: "Invite not found or already resolved" });
    }

    return res.json({ success: true });
  },
);

/**
 * DELETE /api/employers/worker-registrations/:workerAddress
 * Auth required. Rejects (removes) a worker's join request to the
 * authenticated employer — deletes both the registration row and the
 * employee profile. Scoped to the caller's own employer address.
 */
employersRouter.delete(
  "/worker-registrations/:workerAddress",
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const workerAddress = req.params.workerAddress?.trim() ?? "";
    if (!STELLAR_ADDRESS_RE.test(workerAddress)) {
      return res
        .status(400)
        .json({ error: "workerAddress must be a valid Stellar address (G...)" });
    }

    const employer = await getEmployerById(req.user.id);
    const employerAddress = employer?.stellar_address;
    if (!employerAddress) {
      return res.status(404).json({ error: "Employer not found" });
    }

    await query(
      `DELETE FROM employee_profiles
       WHERE LOWER(worker_address) = LOWER($1)
         AND LOWER(employer_address) = LOWER($2)`,
      [workerAddress, employerAddress],
    );
    const result = await query(
      `DELETE FROM worker_registrations
       WHERE LOWER(worker_address) = LOWER($1)
         AND LOWER(employer_address) = LOWER($2)`,
      [workerAddress, employerAddress],
    );

    return res.json({ success: true, removed: result.rowCount ?? 0 });
  },
);

employersRouter.post(
  "/treasury/deposit",
  validateRequest({ body: employerTreasuryDepositSchema }),
  requireVerifiedEmployer,
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const existingBalance = await getTreasuryBalanceByEmployer(req.user.id);
    const currentBalance = BigInt(existingBalance?.balance ?? "0");
    const amount = req.body.amount as bigint;
    const token = req.body.token as string;

    await updateTreasuryBalance(req.user.id, currentBalance + amount, token);
    await recordVaultEvent({
      eventType: "deposit",
      address: req.user.id,
      token,
      amount,
      ledger: 0,
      ledgerTs: Math.floor(Date.now() / 1000),
    });

    res.status(201).json({
      employerId: req.user.id,
      amount: amount.toString(),
      token,
      status: "accepted",
    });
  },
);

employersRouter.use(
  (err: any, req: Request, res: Response, next: NextFunction) => {
    if (err.code === "23505") {
      const constraint = err.constraint || "";
      if (constraint.includes("pkey") || constraint.includes("employer_id")) {
        return res.status(409).json({ error: "Employer with this EVM address already exists." });
      }
      if (constraint.includes("email")) {
        return res.status(409).json({ error: "Employer with this email already exists." });
      }
      if (constraint.includes("organization_name") || constraint.includes("business_name")) {
        return res.status(409).json({ error: "Employer with this organization name already exists." });
      }
      return res.status(409).json({ error: "Duplicate employer record exists." });
    }
    next(err);
  }
);
