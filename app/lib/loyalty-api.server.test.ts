import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { backendApi, backendUrl, LoyaltyApiError } from "./loyalty-api.server";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("backend transport", () => {
  it("signs the actual API-prefixed path, query, method, and exact body", async () => {
    vi.stubEnv("LOYALTY_BACKEND_URL", "http://127.0.0.1:4002/api/");
    vi.stubEnv("SHOPIFY_LOYALTY_SERVICE_SECRET", "a".repeat(64));
    const fetch = vi.fn().mockResolvedValue(Response.json({ accepted: true }));
    vi.stubGlobal("fetch", fetch);
    await backendApi(
      "POST",
      "/integrations/shopify/test?shopId=123",
      { points: 25 },
      "admin-token",
      "request-key",
    );
    const [url, request] = fetch.mock.calls[0];
    expect(url.pathname).toBe("/api/integrations/shopify/test");
    const expected = createHmac("sha256", "a".repeat(64))
      .update(
        `${request.headers["x-loyalty-timestamp"]}\nPOST\n/api/integrations/shopify/test?shopId=123\n${request.body}`,
      )
      .digest("hex");
    expect(request.headers["x-loyalty-signature"]).toBe(expected);
    expect(request.headers.authorization).toBe("Bearer admin-token");
    expect(request.headers["idempotency-key"]).toBe("request-key");
  });
  it("rejects paths that could escape the configured backend", () => {
    vi.stubEnv("LOYALTY_BACKEND_URL", "http://localhost:4002/api");
    expect(() => backendUrl("//evil.example/api")).toThrow();
    expect(() => backendUrl("/../auth")).toThrow();
  });
  it("preserves permission failures rather than reporting a missing account", async () => {
    vi.stubEnv("LOYALTY_BACKEND_URL", "http://localhost:4002/api");
    vi.stubEnv("SHOPIFY_LOYALTY_SERVICE_SECRET", "a".repeat(64));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ message: "Forbidden" }, { status: 403 }),
        ),
    );
    await expect(backendApi("GET", "/brands/private")).rejects.toMatchObject({
      status: 403,
      message: "Forbidden",
    } satisfies Partial<LoyaltyApiError>);
  });
});
