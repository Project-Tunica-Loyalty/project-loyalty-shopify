import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "graphql";
import type { LoaderFunctionArgs } from "react-router";
import { LoyaltyApiError } from "../lib/loyalty-api.server";
import { loader } from "../routes/apps.loyalty";

const mocks = vi.hoisted(() => ({
  appProxy: vi.fn(),
  loyaltyApi: vi.fn(),
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
