import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { action, loader } from "../routes/checkout.loyalty";

const mocks = vi.hoisted(() => ({
  checkout: vi.fn(),
  admin: vi.fn(),
  loyaltyApi: vi.fn(),
  findAutomaticDiscountForRelease: vi.fn(),
  deleteDiscount: vi.fn(),
}));

vi.mock("../shopify.server", () => ({
  authenticate: { public: { checkout: mocks.checkout } },
  unauthenticated: { admin: mocks.admin },
}));
vi.mock("../lib/loyalty-api.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/loyalty-api.server")>()),
  loyaltyApi: mocks.loyaltyApi,
}));
vi.mock("../lib/discounts.server", () => ({
  findAutomaticDiscountForRelease: mocks.findAutomaticDiscountForRelease,
  deleteDiscount: mocks.deleteDiscount,
  deactivateDiscount: vi.fn(),
  issueAutomaticDiscount: vi.fn(),
}));

beforeEach(() => {
  mocks.checkout.mockResolvedValue({
    sessionToken: {
      sub: "gid://shopify/Customer/42",
      dest: "https://reglrs-dqerlmg3.myshopify.com",
    },
    cors: (response: Response) => response,
  });
  mocks.admin.mockResolvedValue({
    admin: {
      graphql: vi.fn().mockResolvedValue(Response.json({
        data: { shop: { id: "gid://shopify/Shop/7", plan: { shopifyPlus: true } } },
      })),
    },
  });
  mocks.loyaltyApi.mockResolvedValue({ challengeId: "challenge-1" });
});

describe("checkout loyalty account access", () => {
  it("deletes an unused automatic discount before releasing its points", async () => {
    mocks.findAutomaticDiscountForRelease.mockResolvedValue({
      id: "gid://shopify/DiscountAutomaticNode/1",
      redemptionId: "12345678-1234-1234-1234-123456789abc",
    });
    mocks.loyaltyApi.mockResolvedValue({ status: "FAILED" });
    const request = new Request("https://shopify.reglrs.ai/checkout/loyalty", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "RELEASE", checkoutToken: "token-1234567890123456",
        redemptionId: "12345678-1234-1234-1234-123456789abc",
      }),
    });
    const response = await action({ request } as ActionFunctionArgs);
    expect(response.status).toBe(200);
    expect(mocks.deleteDiscount).toHaveBeenCalledWith(expect.anything(), "gid://shopify/DiscountAutomaticNode/1");
    expect(mocks.loyaltyApi).toHaveBeenCalledWith("POST", "/integrations/shopify/redemptions", {
      shopId: "gid://shopify/Shop/7", customerId: "42", action: "FAILED",
      redemptionId: "12345678-1234-1234-1234-123456789abc",
    });
  });
  it("loads the connected brand terms for inline signup", async () => {
    const request = new Request("https://shopify.reglrs.ai/checkout/loyalty?view=signup");
    const response = await loader({ request } as LoaderFunctionArgs);
    expect(response.status).toBe(200);
    expect(mocks.loyaltyApi).toHaveBeenCalledWith(
      "GET",
      "/integrations/shopify/context?shopId=gid%3A%2F%2Fshopify%2FShop%2F7&shopDomain=reglrs-dqerlmg3.myshopify.com",
    );
  });

  it("uses the authenticated Shopify customer for the OTP request", async () => {
    const request = new Request("https://shopify.reglrs.ai/checkout/loyalty", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "send-otp",
        shopId: "attacker-shop",
        customerId: "attacker-customer",
        countryCode: "+1",
        phoneNumber: "5551234567",
      }),
    });
    const response = await action({ request } as ActionFunctionArgs);
    expect(response.status).toBe(200);
    expect(mocks.loyaltyApi).toHaveBeenCalledWith(
      "POST",
      "/integrations/shopify/customers/otp/send",
      {
        shopId: "gid://shopify/Shop/7",
        customerId: "42",
        countryCode: "+1",
        phoneNumber: "5551234567",
      },
    );
  });
});
