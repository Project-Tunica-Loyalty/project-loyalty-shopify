import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import db from "../db.server";
import { backendApi, LoyaltyApiError } from "./loyalty-api.server";

export type BrandTokens = {
  accessToken: string;
  refreshToken?: string;
  pendingMfa?: boolean;
};
export type StaffIdentity = { shop: string; staffId: string };
const sessionId = ({ shop, staffId }: StaffIdentity) =>
  createHash("sha256").update(`${shop}:${staffId}`).digest("hex");
function encryptionKey() {
  const raw = process.env.LOYALTY_ADMIN_SESSION_KEY;
  if (!raw || !/^[a-f\d]{64}$/i.test(raw))
    throw new Error(
      "Configure LOYALTY_ADMIN_SESSION_KEY with a random 32-byte hexadecimal key",
    );
  return Buffer.from(raw, "hex");
}
export function encryptTokens(tokens: unknown, identity: StaffIdentity) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(sessionId(identity)));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
export function decryptTokens<T = BrandTokens>(
  value: string,
  identity: StaffIdentity,
): T {
  const bytes = Buffer.from(value, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    bytes.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from(sessionId(identity)));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString("utf8"),
  );
}
export async function saveBrandSession(
  identity: StaffIdentity,
  tokens: BrandTokens,
) {
  const values = {
    ...identity,
    encryptedTokens: encryptTokens(tokens, identity),
    expiresAt: new Date(
      Date.now() + (tokens.pendingMfa ? 5 * 60_000 : 8 * 60 * 60_000),
    ),
  };
  await db.brandAdminSession.upsert({
    where: { id: sessionId(identity) },
    create: { id: sessionId(identity), ...values },
    update: values,
  });
}
export async function readBrandSession(identity: StaffIdentity) {
  const record = await db.brandAdminSession.findUnique({
    where: { id: sessionId(identity) },
  });
  if (!record || record.expiresAt <= new Date()) return null;
  return decryptTokens(record.encryptedTokens, identity);
}
export async function deleteBrandSession(identity: StaffIdentity) {
  await db.brandAdminSession.deleteMany({ where: { id: sessionId(identity) } });
}
export async function brandApi<T>(
  identity: StaffIdentity,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const tokens = await readBrandSession(identity);
  if (!tokens || tokens.pendingMfa)
    throw new LoyaltyApiError(
      "Sign in with your Project Loyalty brand account",
      401,
    );
  try {
    return await backendApi<T>(method, path, body, tokens.accessToken);
  } catch (error) {
    if (
      !(error instanceof LoyaltyApiError) ||
      error.status !== 401 ||
      !tokens.refreshToken
    )
      throw error;
    try {
      const refreshed = await backendApi<BrandTokens>("POST", "/auth/refresh", {
        refreshToken: tokens.refreshToken,
      });
      if (!refreshed.accessToken)
        throw new Error("Invalid session refresh response");
      await saveBrandSession(identity, refreshed);
      return await backendApi<T>(method, path, body, refreshed.accessToken);
    } catch (refreshError) {
      await deleteBrandSession(identity);
      throw refreshError;
    }
  }
}
