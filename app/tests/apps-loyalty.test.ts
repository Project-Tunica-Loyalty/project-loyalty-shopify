import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "graphql";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { LoyaltyApiError } from "../lib/loyalty-api.server";
import { action, loader } from "../routes/apps.loyalty";

const mocks = vi.hoisted(() => ({
  appProxy: vi.fn(),
  loyaltyApi: vi.fn(),
  issueDiscount: vi.fn(),
  deleteDiscount: vi.fn(),
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
  deleteDiscount: mocks.deleteDiscount,
  issueDiscount: mocks.issueDiscount,
  issueBasicDiscount: vi.fn(),
}));

beforeEach(() => {
  vi.stubEnv("SHOPIFY_API_SECRET", "test-app-secret-at-least-32-characters");
  mocks.appProxy.mockResolvedValue({
    session: { shop: "reglrs.myshopify.com" },
    admin: {
      graphql: vi.fn().mockImplementation((query: string) => {
        parse(query);
        if (query.includes("LoyaltyCouponForCancellation"))
          return Response.json({ data: { codeDiscountNodeByCode: {
            id: "gid://shopify/DiscountCodeNode/1",
            codeDiscount: { title: "Project Loyalty 12345678-1234-1234-1234-123456789abc" },
          } } });
        return Response.json({ data: { shop: { id: "gid://shopify/Shop/1" } } });
      }),
    },
  });
});

describe("storefront cart redemption", () => {
  it("issues a customer-restricted Function code and acknowledges it", async () => {
    mocks.loyaltyApi.mockResolvedValueOnce({
      redemptionId: "12345678-1234-1234-1234-123456789abc",
      status: "PENDING", code: "PLONEUSECODE", discountAmount: "25.00",
      minimumSubtotal: "100.00", expiresAt: "2030-01-01T00:00:00Z",
      variantId: null, verifiedPhone: "+15551234567",
    }).mockResolvedValueOnce({ status: "ACTIVE" });
    mocks.issueDiscount.mockResolvedValue({ code: "PLONEUSECODE", discountId: "gid://shopify/DiscountCodeNode/1" });
    const request = new Request("https://shopify.reglrs.ai/apps/loyalty?logged_in_customer_id=42", {
      method: "POST", body: new URLSearchParams({
        intent: "redeem", points: "100", cartSubtotal: "125", idempotencyKey: "0123456789abcdef",
      }),
    });
    const response = await action({ request } as ActionFunctionArgs);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: "PLONEUSECODE", cancelToken: expect.any(String) });
    expect(mocks.loyaltyApi).toHaveBeenNthCalledWith(1, "POST", "/integrations/shopify/redemptions", {
      shopId: "gid://shopify/Shop/1", customerId: "42", kind: "ORDER", channel: "STOREFRONT",
      points: 100, cartSubtotal: 125,
    }, "0123456789abcdef");
    expect(mocks.issueDiscount).toHaveBeenCalled();
    expect(mocks.loyaltyApi).toHaveBeenNthCalledWith(2, "POST", "/integrations/shopify/redemptions", expect.objectContaining({ action: "ISSUED", code: "PLONEUSECODE" }));
  });

  it("deletes an unused cart coupon and releases the matching reservation", async () => {
    mocks.loyaltyApi.mockResolvedValueOnce({
      redemptionId: "12345678-1234-1234-1234-123456789abc",
      status: "PENDING", code: "PLONEUSECODE", discountAmount: "25.00",
      minimumSubtotal: "100.00", expiresAt: "2030-01-01T00:00:00Z",
      variantId: null, verifiedPhone: "+15551234567",
    }).mockResolvedValueOnce({ status: "ACTIVE" }).mockResolvedValueOnce({ status: "FAILED" });
    mocks.issueDiscount.mockResolvedValue({ code: "PLONEUSECODE", discountId: "gid://shopify/DiscountCodeNode/1" });
    const url = "https://shopify.reglrs.ai/apps/loyalty?logged_in_customer_id=42";
    const issued = await action({ request: new Request(url, {
      method: "POST", body: new URLSearchParams({
        intent: "redeem", points: "100", cartSubtotal: "125", idempotencyKey: "0123456789abcdef",
      }),
    }) } as ActionFunctionArgs);
    const { cancelToken } = await issued.json();
    const otherCustomer = await action({ request: new Request(
      "https://shopify.reglrs.ai/apps/loyalty?logged_in_customer_id=43", {
        method: "POST", body: new URLSearchParams({ intent: "cancel", cancelToken }),
      },
    ) } as ActionFunctionArgs);
    expect(otherCustomer.status).toBe(400);
    expect(mocks.deleteDiscount).not.toHaveBeenCalled();
    const cancelled = await action({ request: new Request(url, {
      method: "POST", body: new URLSearchParams({ intent: "cancel", cancelToken }),
    }) } as ActionFunctionArgs);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ cancelled: true });
    expect(mocks.deleteDiscount).toHaveBeenCalledWith(expect.anything(), "gid://shopify/DiscountCodeNode/1");
    expect(mocks.loyaltyApi).toHaveBeenLastCalledWith("POST", "/integrations/shopify/redemptions", {
      shopId: "gid://shopify/Shop/1", customerId: "42", action: "FAILED",
      redemptionId: "12345678-1234-1234-1234-123456789abc",
    });
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
