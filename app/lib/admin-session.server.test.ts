import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../db.server", () => ({ default: {} }));
import { decryptTokens, encryptTokens } from "./admin-session.server";
afterEach(() => vi.unstubAllEnvs());
describe("brand session encryption", () => {
  it("keeps credentials encrypted and binds them to the shop and staff member", () => {
    vi.stubEnv("LOYALTY_ADMIN_SESSION_KEY", "1a".repeat(32));
    const identity = { shop: "brand.myshopify.com", staffId: "staff-1" };
    const value = encryptTokens(
      { accessToken: "private-token", refreshToken: "private-refresh" },
      identity,
    );
    expect(value).not.toContain("private-token");
    expect(decryptTokens(value, identity).accessToken).toBe("private-token");
    expect(() =>
      decryptTokens(value, { ...identity, staffId: "other-staff" }),
    ).toThrow();
    expect(() =>
      decryptTokens(value, { ...identity, shop: "other.myshopify.com" }),
    ).toThrow();
    expect(() =>
      decryptTokens(value.slice(0, -8) + "AAAA", identity),
    ).toThrow();
  });
  it("requires an independent correctly sized session key", () => {
    vi.stubEnv("LOYALTY_ADMIN_SESSION_KEY", "");
    expect(() => encryptTokens({}, { shop: "brand", staffId: "1" })).toThrow(
      "LOYALTY_ADMIN_SESSION_KEY",
    );
  });
});
