import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoyaltyPage, { action } from "../routes/app.loyalty.$view";

const mocks = vi.hoisted(() => ({
  brandApi: vi.fn(),
  merchantContext: vi.fn(),
  loaderData: {} as Record<string, unknown>,
}));

vi.mock("../db.server", () => ({ default: {} }));
vi.mock("../lib/shop-context.server", () => ({ merchantContext: mocks.merchantContext }));
vi.mock("../lib/request-origin.server", () => ({ assertAppOrigin: vi.fn() }));
vi.mock("../lib/admin-session.server", () => ({
  brandApi: mocks.brandApi,
  readBrandSession: vi.fn(),
  saveBrandSession: vi.fn(),
  deleteBrandSession: vi.fn(),
}));
vi.mock("@shopify/app-bridge-react", () => ({ useAppBridge: () => ({ resourcePicker: vi.fn() }) }));
vi.mock("react-router", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-router")>();
  return {
    ...original,
    Form: ({ children, ...props }: { children: React.ReactNode }) => createElement("form", props, children),
    useLoaderData: () => mocks.loaderData,
    useActionData: () => undefined,
    useNavigation: () => ({ state: "idle" }),
  };
});

const program = {
  program: {
    status: "ACTIVE",
    currentVersion: {
      version: 1,
      timezone: "Asia/Kolkata",
      currency: "INR",
      pointsPerCurrencyUnit: 0.5,
      shopifyCurrencyPerPoint: 0.5,
      redemptionType: "PARTIAL",
      milestones: [],
    },
  },
};

beforeEach(() => {
  mocks.merchantContext.mockResolvedValue({
    identity: "merchant",
    shop: { currencyCode: "INR" },
    connection: { brandId: "brand", connected: true },
    compatible: true,
  });
  mocks.loaderData = {
    view: "program",
    shop: { currencyCode: "INR" },
    connection: { brandId: "brand", connected: true },
    compatible: true,
    signedIn: true,
    pendingMfa: false,
    program,
    content: null,
    error: null,
    privacyRequests: [],
    filters: { search: "", customer: "" },
  };
});

describe("Shopify merchant redemption value", () => {
  it("shows the brand-wide Shopify value beside the earning rate", () => {
    const html = renderToStaticMarkup(createElement(LoyaltyPage));
    expect(html).toContain("Points earned per currency unit");
    expect(html).toContain("Value of 1 point in store currency (Shopify only)");
    expect(html).toContain('name="shopifyCurrencyPerPoint"');
    expect(html).toContain("600 points at 0.5");
  });

  it("submits the Shopify-only value through preview and save", async () => {
    mocks.brandApi.mockResolvedValueOnce(program).mockResolvedValueOnce({ impactRequired: false });
    const previewForm = new FormData();
    previewForm.set("intent", "preview-program");
    previewForm.set("expectedVersion", "1");
    previewForm.set("timezone", "Asia/Kolkata");
    previewForm.set("changeReason", "Set Shopify rate");
    previewForm.set("redemptionType", "PARTIAL");
    previewForm.set("milestones", "[]");
    previewForm.set("pointsPerCurrencyUnit", "0.5");
    previewForm.set("shopifyCurrencyPerPoint", "0.5");
    const preview = await action({
      request: new Request("https://shop.example/app/loyalty/program", { method: "POST", body: previewForm }),
    } as ActionFunctionArgs);
    expect(mocks.brandApi).toHaveBeenNthCalledWith(
      2, "merchant", "POST", "/brands/brand/loyalty-program/impact-preview",
      expect.objectContaining({ shopifyCurrencyPerPoint: 0.5 }),
    );
    if (!("draft" in preview.data)) throw new Error("Preview did not return a draft");
    const draft = preview.data.draft;

    mocks.brandApi.mockResolvedValueOnce(program).mockResolvedValueOnce({});
    const saveForm = new FormData();
    saveForm.set("intent", "save-program");
    saveForm.set("draft", JSON.stringify(draft));
    await action({
      request: new Request("https://shop.example/app/loyalty/program", { method: "POST", body: saveForm }),
    } as ActionFunctionArgs);
    expect(mocks.brandApi).toHaveBeenNthCalledWith(
      4, "merchant", "PUT", "/brands/brand/loyalty-program",
      expect.objectContaining({ shopifyCurrencyPerPoint: 0.5 }),
    );
  });

  it("keeps legacy Shopify conversion when the field is blank", async () => {
    mocks.brandApi.mockResolvedValueOnce(program).mockResolvedValueOnce({ impactRequired: false });
    const form = new FormData();
    form.set("intent", "preview-program");
    form.set("expectedVersion", "1");
    form.set("timezone", "Asia/Kolkata");
    form.set("changeReason", "Keep legacy conversion");
    form.set("redemptionType", "PARTIAL");
    form.set("milestones", "[]");
    form.set("shopifyCurrencyPerPoint", "");
    await action({
      request: new Request("https://shop.example/app/loyalty/program", { method: "POST", body: form }),
    } as ActionFunctionArgs);
    expect(mocks.brandApi).toHaveBeenNthCalledWith(
      2, "merchant", "POST", "/brands/brand/loyalty-program/impact-preview",
      expect.objectContaining({ shopifyCurrencyPerPoint: null }),
    );
  });
});
