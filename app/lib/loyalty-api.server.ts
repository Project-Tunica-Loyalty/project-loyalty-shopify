import { createHmac } from "node:crypto";

export const baseUrl = () => {
  const value = process.env.LOYALTY_BACKEND_URL;
  if (!value) throw new Error("LOYALTY_BACKEND_URL is required");
  return value.replace(/\/$/, "");
};

export class LoyaltyApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function backendUrl(path: string) {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /(^|\/)\.\.(\/|$)/.test(path)
  )
    throw new Error("Invalid loyalty API path");
  const base = new URL(baseUrl());
  if (base.search || base.hash)
    throw new Error("LOYALTY_BACKEND_URL must not include a query or fragment");
  const url = new URL(`${base.toString().replace(/\/$/, "")}${path}`);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/") ||
    url.hash
  )
    throw new Error("Invalid loyalty API path");
  return url;
}

export async function backendApi<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  idempotencyKey?: string,
): Promise<T> {
  const secret = process.env.SHOPIFY_LOYALTY_SERVICE_SECRET;
  if (!secret || secret.length < 32)
    throw new Error(
      "SHOPIFY_LOYALTY_SERVICE_SECRET must have at least 32 characters",
    );
  const url = backendUrl(path);
  const payload = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}\n${method}\n${url.pathname}${url.search}\n${payload}`)
    .digest("hex");
  const response = await fetch(url, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: {
      "content-type": "application/json",
      "x-loyalty-timestamp": timestamp,
      "x-loyalty-signature": signature,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: payload }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new LoyaltyApiError(
      typeof result.message === "string"
        ? result.message
        : "Loyalty request failed",
      response.status,
    );
  return result as T;
}

export async function loyaltyApi<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  return backendApi<T>(method, path, body, undefined, idempotencyKey);
}

export const identityPath = (shopId: string, customerId: string) =>
  `?shopId=${encodeURIComponent(shopId)}&customerId=${encodeURIComponent(customerId)}`;
