import { z } from "zod";

export const accountWalletLinkSchema = z
  .object({
    chain: z.enum(["stellar", "arc"]),
    address: z.string().trim().min(1).max(255),
  })
  .superRefine((val, ctx) => {
    if (val.chain === "stellar" && !/^G[A-Z2-7]{55}$/.test(val.address)) {
      ctx.addIssue({
        code: "custom",
        path: ["address"],
        message: "Must be a valid Stellar address (G...)",
      });
    }
    if (val.chain === "arc" && !/^0x[a-fA-F0-9]{40}$/.test(val.address)) {
      ctx.addIssue({
        code: "custom",
        path: ["address"],
        message: "Must be a valid Arc/EVM address (0x...)",
      });
    }
  });

export type AccountWalletLinkInput = z.infer<typeof accountWalletLinkSchema>;
