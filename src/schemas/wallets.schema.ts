import { z } from "zod";

export const walletChallengeSchema = z.object({
  address: z.string().trim().min(10).max(120),
  chain: z.enum(["stellar", "evm"]),
});

export const walletVerifySchema = z.object({
  address: z.string().trim().min(10).max(120),
  chain: z.enum(["stellar", "evm"]),
  challenge: z.string().trim().min(10).max(200),
  signature: z.string().trim().min(10).max(1000),
});

export type WalletChallengeInput = z.infer<typeof walletChallengeSchema>;
export type WalletVerifyInput = z.infer<typeof walletVerifySchema>;
