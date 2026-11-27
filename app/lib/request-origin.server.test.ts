import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAppOrigin } from "./request-origin.server";

afterEach(() => vi.unstubAllEnvs());

describe("app action origin", () => {
  it("accepts the public HTTPS origin behind an HTTP reverse proxy", () => {
    vi.stubEnv("SHOPIFY_APP_URL", "https://shopify.reglrs.ai");
    const request = new Request("http://shopify.reglrs.ai/app/loyalty/settings", {
      method: "POST",
      headers: { origin: "https://shopify.reglrs.ai" },
    });

    expect(() => assertAppOrigin(request)).not.toThrow();
  });

  it.each(["https://other.example", "http://shopify.reglrs.ai"])(
    "rejects a different origin: %s",
    (origin) => {
      vi.stubEnv("SHOPIFY_APP_URL", "https://shopify.reglrs.ai");
      const request = new Request("http://shopify.reglrs.ai/app/loyalty/settings", {
        method: "POST",
        headers: { origin },
      });

      try {
        assertAppOrigin(request);
        throw new Error("Expected origin rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(403);
      }
    },
  );
});
