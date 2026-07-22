import crypto from "crypto";

/** Short, URL-safe, hard-to-guess code for a shareable worker invite link. */
export function generateInviteCode(): string {
  return crypto.randomBytes(18).toString("base64url");
}
