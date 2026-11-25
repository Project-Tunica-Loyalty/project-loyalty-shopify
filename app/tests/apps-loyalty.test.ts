import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "graphql";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { LoyaltyApiError } from "../lib/loyalty-api.server";
import { action, loader } from "../routes/apps.loyalty";

const mocks = vi.hoisted(() => ({
  appProxy: vi.fn(),
  loyaltyApi: vi.fn(),
  issueBasicDiscount: vi.fn(),
}));

vi.mock("../shopify.server", () => ({
  authenticate: { public: { appProxy: mocks.appProxy } },
}));
vi.mock("../lib/loyalty-api.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/loyalty-api.server")>()),
  loyaltyApi: mocks.loyaltyApi,
}));
vi.mock("../lib/discounts.server", () => ({
  deactivateDiscount: vi.fn(),
  issueDiscount: vi.fn(),
  issueBasicDiscount: mocks.issueBasicDiscount,
}));

beforeEach(() => {
  mocks.appProxy.mockResolvedValue({
    session: { shop: "reglrs.myshopify.com" },
    admin: {
      graphql: vi.fn().mockImplementation((query: string) => {
        parse(query);
        return Response.json({ data: { shop: { id: "gid://shopify/Shop/1" } } });
      }),
    },
  });
});

describe("storefront cart redemption", () => {
  it("issues a customer-restricted native code and acknowledges it", async () => {
    mocks.loyaltyApi.mockResolvedValueOnce({
      redemptionId: "12345678-1234-1234-1234-123456789abc",
      status: "PENDING", code: "PLONEUSECODE", discountAmount: "25.00",
      minimumSubtotal: "100.00", expiresAt: "2030-01-01T00:00:00Z",
      variantId: null, verifiedPhone: "+15551234567",
    }).mockResolvedValueOnce({ status: "ACTIVE" });
    mocks.issueBasicDiscount.mockResolvedValue({ code: "PLONEUSECODE", discountId: "gid://shopify/DiscountCodeNode/1" });
    const request = new Request("https://shopify.reglrs.ai/apps/loyalty?logged_in_customer_id=42", {
      method: "POST", body: new URLSearchParams({
        intent: "redeem", points: "100", cartSubtotal: "125", idempotencyKey: "0123456789abcdef",
      }),
    });
    const response = await action({ request } as ActionFunctionArgs);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: "PLONEUSECODE" });
    expect(mocks.loyaltyApi).toHaveBeenNthCalledWith(1, "POST", "/integrations/shopify/redemptions", {
      shopId: "gid://shopify/Shop/1", customerId: "42", kind: "ORDER", channel: "STOREFRONT",
      points: 100, cartSubtotal: 125,
    }, "0123456789abcdef");
    expect(mocks.issueBasicDiscount).toHaveBeenCalled();
    expect(mocks.loyaltyApi).toHaveBeenNthCalledWith(2, "POST", "/integrations/shopify/redemptions", expect.objectContaining({ action: "ISSUED", code: "PLONEUSECODE" }));
  });
});

describe("storefront loyalty balance", () => {
  const request = new Request(
    "https://shopify.reglrs.ai/apps/loyalty?logged_in_customer_id=42",
  );

  it("shows account linking for a customer who has not joined", async () => {
    mocks.loyaltyApi.mockRejectedValue(
      new LoyaltyApiError("Customer must link an active loyalty account", 403),
    );
    const response = await loader({ request } as LoaderFunctionArgs);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ linked: false });
  });

  it("keeps unrelated backend failures visible as errors", async () => {
    mocks.loyaltyApi.mockRejectedValue(
      new LoyaltyApiError("Shop is not connected", 403),
    );
    const response = await loader({ request } as LoaderFunctionArgs);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      linked: false,
      error: "Shop is not connected",
    });
  });
});
