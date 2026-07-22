import { z } from "zod";

export const employerOnboardingSchema = z.object({
  businessName: z.string().trim().min(2).max(200),
  registrationNumber: z.string().trim().min(3).max(100),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase()),
  contactName: z.string().trim().min(2).max(120).optional(),
  contactEmail: z.string().trim().email().max(320).optional(),
  // Optional — an employer can complete KYB with email login alone and link
  // a wallet later. If supplied it must still be a canonical Stellar address.
  stellarAddress: z
    .string()
    .trim()
    .regex(/^G[A-Z2-7]{55}$/, "Must be a valid Stellar address (G...)")
    .optional(),
});

export const employerTreasuryDepositSchema = z.object({
  amount: z.coerce.bigint().positive(),
  token: z.string().trim().min(2).max(20).default("USDC"),
});

export const workerInviteSchema = z.object({
  candidateQuipayId: z
    .string()
    .trim()
    .regex(/^QP\d+$/i, "Must be a valid QP ID (e.g. QP100000042)")
    .transform((value) => value.toUpperCase()),
  jobTitle: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional(),
  payAmount: z.coerce.number().positive(),
  payToken: z.string().trim().min(2).max(20).default("USDC"),
  durationDays: z.coerce.number().int().positive().max(3650),
});

export type EmployerOnboardingInput = z.infer<typeof employerOnboardingSchema>;
export type EmployerTreasuryDepositInput = z.infer<
  typeof employerTreasuryDepositSchema
>;
export type WorkerInviteInput = z.infer<typeof workerInviteSchema>;
