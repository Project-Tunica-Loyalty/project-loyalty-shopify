import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { identityPath, loyaltyApi, LoyaltyApiError } from "../lib/loyalty-api.server";
import { issueAutomaticDiscount, findAutomaticDiscount, deactivateDiscount, type DiscountInstruction } from "../lib/discounts.server";

async function checkoutContext(request: Request) {
  const { sessionToken, cors } = await authenticate.public.checkout(request);
  const customerId = String(sessionToken.sub ?? "").split("/").pop() ?? "";
  if (!/^\d+$/.test(customerId))
    throw new Response("Log in to your customer account", { status: 401 });
  const destination = String(sessionToken.dest ?? "");
  const shop = new URL(destination.startsWith("https://") ? destination : `https://${destination}`).hostname;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop))
    throw new Response("Invalid shop", { status: 400 });
  const { admin } = await unauthenticated.admin(shop);
  const response = await admin.graphql(`#graphql
    query LoyaltyCheckoutShop { shop { id plan { shopifyPlus partnerDevelopment } } }`);
  const info = (await response.json()).data?.shop;
  if (!info?.id) throw new Response("Shop unavailable", { status: 503 });
  return {
    cors, admin, customerId, shopId: String(info.id), shopDomain: shop,
    compatible: Boolean(info.plan?.shopifyPlus || info.plan?.partnerDevelopment),
  };
}

const result = (cors: (response: Response) => Response, data: unknown, status = 200) =>
  cors(Response.json(data, { status, headers: { "cache-control": "no-store" } }));

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors, customerId, shopId, shopDomain, compatible } = await checkoutContext(request);
  try {
    if (new URL(request.url).searchParams.get("view") === "signup")
      return result(cors, await loyaltyApi(
        "GET",
        `/integrations/shopify/context?shopId=${encodeURIComponent(shopId)}&shopDomain=${encodeURIComponent(shopDomain)}`,
      ));
    const [balance, rewards] = await Promise.all([
      loyaltyApi("GET", `/integrations/shopify/customers/me/balance${identityPath(shopId, customerId)}`),
      loyaltyApi("GET", `/integrations/shopify/rewards?shopId=${encodeURIComponent(shopId)}`),
    ]);
    return result(cors, { linked: true, compatible, balance, rewards });
  } catch (error) {
    if (error instanceof LoyaltyApiError && error.status === 403 &&
      error.message === "Customer must link an active loyalty account")
      return result(cors, { linked: false, compatible });
    return result(cors, { error: error instanceof Error ? error.message : "Loyalty unavailable" }, 502);
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { cors, admin, customerId, shopId, compatible } = await checkoutContext(request);
  const body = await request.json().catch(() => ({}));
  const identity = { shopId, customerId };
  const signupEndpoints: Record<string, string> = {
    "signup-send": "otp/send",
    "signup-resend": "otp/resend",
    "signup-verify": "otp/verify",
    "signup-complete": "complete",
  };
  if (signupEndpoints[body.action] || body.action === "send-otp" || body.action === "verify-otp") {
    try {
      const fields: Record<string, unknown> = { ...identity };
      if (body.action === "signup-send" || body.action === "send-otp") {
        fields.countryCode = String(body.countryCode ?? "");
        fields.phoneNumber = String(body.phoneNumber ?? "");
      }
      if (["signup-resend", "signup-verify", "verify-otp"].includes(body.action))
        fields.challengeId = String(body.challengeId ?? "");
      if (body.action === "signup-verify" || body.action === "verify-otp")
        fields.otp = String(body.otp ?? "");
      if (body.action === "signup-complete")
        Object.assign(fields, {
          name: String(body.name ?? ""),
          signupVerificationToken: String(body.signupVerificationToken ?? ""),
          termsVersion: String(body.termsVersion ?? ""),
          termsAccepted: body.termsAccepted === true,
          marketingAccepted: body.marketingAccepted === true,
        });
      const path = signupEndpoints[body.action]
        ? `/integrations/shopify/customers/signup/${signupEndpoints[body.action]}`
        : `/integrations/shopify/customers/otp/${body.action === "send-otp" ? "send" : "verify"}`;
      return result(cors, await loyaltyApi("POST", path, fields));
    } catch (error) {
      return result(cors, { error: error instanceof Error ? error.message : "Loyalty account request failed" }, 400);
    }
  }
  if (!compatible) return result(cors, { error: "Checkout rewards require a Plus store" }, 403);
  if (body.action === "RELEASE") {
    const checkoutToken = String(body.checkoutToken ?? "");
    const redemptionId = String(body.redemptionId ?? "");
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(checkoutToken) || !/^[0-9a-f-]{36}$/i.test(redemptionId))
      return result(cors, { error: "Invalid reward release" }, 400);
    try {
      const id = await findAutomaticDiscount(admin, {
        checkoutToken, redemptionId, customerId: `gid://shopify/Customer/${customerId}`,
      } as DiscountInstruction);
      if (!id) return result(cors, { error: "Reward discount could not be verified" }, 409);
      await deactivateDiscount(admin, id);
      await loyaltyApi("POST", "/integrations/shopify/redemptions", {
        shopId, customerId, action: "FAILED", redemptionId,
      });
      return result(cors, { released: true });
    } catch (error) {
      return result(cors, { error: error instanceof Error ? error.message : "Could not release points" }, 502);
    }
  }
  const key = String(body.idempotencyKey ?? "");
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(key))
    return result(cors, { error: "Invalid redemption request" }, 400);
  if (body.kind !== "ORDER" && body.kind !== "PRODUCT")
    return result(cors, { error: "Invalid reward type" }, 400);
  try {
    const instruction = await loyaltyApi<DiscountInstruction>(
      "POST", "/integrations/shopify/redemptions",
      {
        shopId, customerId, kind: body.kind, channel: "CHECKOUT_AUTOMATIC",
        checkoutPhone: String(body.checkoutPhone ?? ""),
        ...(body.kind === "PRODUCT"
          ? { rewardProductId: String(body.rewardProductId ?? "") }
          : { points: Number(body.points), cartSubtotal: Number(body.cartSubtotal) }),
      }, key,
    );
    if (instruction.status === "ACTIVE" && instruction.checkoutToken)
      return result(cors, { checkoutToken: instruction.checkoutToken, redemptionId: instruction.redemptionId, expiresAt: instruction.expiresAt });
    let created: { discountId: string } | undefined;
    try {
      created = await issueAutomaticDiscount(admin, customerId, instruction);
      await loyaltyApi("POST", "/integrations/shopify/redemptions", {
        shopId, customerId, action: "ISSUED", redemptionId: instruction.redemptionId,
        discountId: created.discountId, checkoutToken: instruction.checkoutToken,
      });
    } catch (error) {
      if (created?.discountId) {
        await deactivateDiscount(admin, created.discountId);
        await loyaltyApi("POST", "/integrations/shopify/redemptions", {
          shopId, customerId, action: "FAILED", redemptionId: instruction.redemptionId,
        });
      }
      throw error;
    }
    return result(cors, { checkoutToken: instruction.checkoutToken, redemptionId: instruction.redemptionId, expiresAt: instruction.expiresAt });
  } catch (error) {
    return result(cors, { error: error instanceof Error ? error.message : "Reward unavailable" }, 400);
  }
};
