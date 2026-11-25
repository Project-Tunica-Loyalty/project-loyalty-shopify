import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createHmac, timingSafeEqual } from "node:crypto";
import { authenticate } from "../shopify.server";
import {
  identityPath,
  loyaltyApi,
  LoyaltyApiError,
} from "../lib/loyalty-api.server";
import { deactivateDiscount, deleteDiscount, issueDiscount, type DiscountInstruction } from "../lib/discounts.server";

type Cancellation = {
  shopId: string;
  customerId: string;
  redemptionId: string;
  discountId: string;
  code: string;
  expiresAt: string;
};

function cancellationSignature(payload: string) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("Shopify app secret is unavailable");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function cancellationToken(value: Cancellation) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${cancellationSignature(payload)}`;
}

function readCancellationToken(token: string, shopId: string, customerId: string): Cancellation {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || token.length > 2000)
    throw new Error("Invalid loyalty coupon");
  const expected = cancellationSignature(payload);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes))
    throw new Error("Invalid loyalty coupon");
  const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Cancellation;
  if (value.shopId !== shopId || value.customerId !== customerId ||
      !/^[0-9a-f-]{36}$/i.test(value.redemptionId) ||
      !/^gid:\/\/shopify\/DiscountCodeNode\/\d+$/.test(value.discountId) ||
      !/^PL[A-Z0-9]+$/.test(value.code) ||
      !Number.isFinite(Date.parse(value.expiresAt)))
    throw new Error("Invalid loyalty coupon");
  return value;
}

const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });

async function context(request: Request) {
  const proxy = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const rawId = url.searchParams.get("logged_in_customer_id");
  if (!rawId || !/^\d+$/.test(rawId))
    throw new Response("Log in to Shopify first", { status: 401 });
  if (!proxy.admin || !proxy.session)
    throw new Response("Shop is not installed", { status: 403 });
  const shopResponse = await proxy.admin.graphql(
    `#graphql
    query LoyaltyProxyShop { shop { id plan { shopifyPlus partnerDevelopment } } }`,
  );
  const shopInfo = (await shopResponse.json()).data?.shop;
  const shopId = shopInfo?.id as string | undefined;
  if (!shopId) throw new Response("Shop is unavailable", { status: 503 });
  return {
    shopId,
    customerId: rawId,
    shop: proxy.session.shop,
    admin: proxy.admin,
    checkoutRedemptionAvailable: Boolean(shopInfo.plan?.shopifyPlus),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopId, customerId, shop, checkoutRedemptionAvailable } = await context(request);
  const url = new URL(request.url);
  try {
    if (url.searchParams.get("view") === "signup")
      return json(
        await loyaltyApi(
          "GET",
          `/integrations/shopify/context?shopId=${encodeURIComponent(shopId)}&shopDomain=${encodeURIComponent(shop)}`,
        ),
      );
    if (url.searchParams.get("view") === "rewards")
      return json(
        await loyaltyApi(
          "GET",
          `/integrations/shopify/rewards?shopId=${encodeURIComponent(shopId)}`,
        ),
      );
    return json({
      linked: true,
      checkoutRedemptionAvailable,
      balance: await loyaltyApi(
        "GET",
        `/integrations/shopify/customers/me/balance${identityPath(shopId, customerId)}`,
      ),
    });
  } catch (error) {
    if (
      !url.searchParams.has("view") &&
      error instanceof LoyaltyApiError &&
      error.status === 403 &&
      error.message === "Customer must link an active loyalty account"
    )
      return json({ linked: false });
    return json(
      {
        linked: false,
        error:
          error instanceof Error ? error.message : "Unable to load balance",
      },
      400,
    );
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopId, customerId, admin, checkoutRedemptionAvailable } = await context(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const identity = { shopId, customerId };
  try {
    if (intent === "cancel") {
      const coupon = readCancellationToken(String(form.get("cancelToken") || ""), shopId, customerId);
      const response = await admin.graphql(`#graphql
        query LoyaltyCouponForCancellation($code: String!) {
          codeDiscountNodeByCode(code: $code) {
            id codeDiscount { ... on DiscountCodeBasic { title } ... on DiscountCodeApp { title } }
          }
        }`, { variables: { code: coupon.code } });
      const lookup = await response.json() as {
        data?: { codeDiscountNodeByCode?: { id: string; codeDiscount?: { title: string } } | null };
        errors?: Array<{ message: string }>;
      };
      if (lookup.errors?.length) throw new Error("Could not verify the loyalty coupon");
      const found = lookup.data?.codeDiscountNodeByCode;
      if (found) {
        if (found.id !== coupon.discountId ||
            found.codeDiscount?.title !== `Project Loyalty ${coupon.redemptionId}`)
          throw new Error("Loyalty coupon no longer matches its reservation");
        await deleteDiscount(admin, coupon.discountId);
      }
      await loyaltyApi("POST", "/integrations/shopify/redemptions", {
        shopId, customerId, action: "FAILED", redemptionId: coupon.redemptionId,
      });
      return json({ cancelled: true });
    }
    if (intent.startsWith("signup-")) {
      const endpoints: Record<string, string> = {
        "signup-send": "otp/send",
        "signup-resend": "otp/resend",
        "signup-verify": "otp/verify",
        "signup-complete": "complete",
      };
      const endpoint = endpoints[intent];
      if (!endpoint) return json({ error: "Unknown signup action" }, 400);
      const fields: Record<string, unknown> = { ...identity };
      if (intent === "signup-send") {
        fields.countryCode = String(form.get("countryCode") || "");
        fields.phoneNumber = String(form.get("phoneNumber") || "");
      }
      if (["signup-resend", "signup-verify"].includes(intent))
        fields.challengeId = String(form.get("challengeId") || "");
      if (intent === "signup-verify")
        fields.otp = String(form.get("otp") || "");
      if (intent === "signup-complete")
        Object.assign(fields, {
          name: String(form.get("name") || ""),
          signupVerificationToken: String(
            form.get("signupVerificationToken") || "",
          ),
          termsVersion: String(form.get("termsVersion") || ""),
          termsAccepted: form.get("termsAccepted") === "on",
          marketingAccepted: form.get("marketingAccepted") === "on",
        });
      return json(
        await loyaltyApi(
          "POST",
          `/integrations/shopify/customers/signup/${endpoint}`,
          fields,
        ),
      );
    }
    if (intent === "send-otp") {
      const challenge = await loyaltyApi(
        "POST",
        "/integrations/shopify/customers/otp/send",
        {
          ...identity,
          countryCode: String(form.get("countryCode") || ""),
          phoneNumber: String(form.get("phoneNumber") || ""),
        },
      );
      return json(challenge);
    }
    if (intent === "verify-otp") {
      return json(
        await loyaltyApi("POST", "/integrations/shopify/customers/otp/verify", {
          ...identity,
          challengeId: String(form.get("challengeId") || ""),
          otp: String(form.get("otp") || ""),
        }),
      );
    }
    if (intent === "redeem") {
      if (checkoutRedemptionAvailable)
        return json({ error: "Use the loyalty block at checkout to apply points" }, 403);
      const points = Number(form.get("points"));
      const cartSubtotal = Number(form.get("cartSubtotal"));
      const key = String(form.get("idempotencyKey") || "");
      if (!Number.isFinite(points) || points <= 0 || !Number.isFinite(cartSubtotal) || cartSubtotal <= 0 ||
          !/^[a-zA-Z0-9_-]{16,100}$/.test(key))
        return json({ error: "Enter valid points for a nonempty cart" }, 400);
      const instruction = await loyaltyApi<DiscountInstruction>(
        "POST", "/integrations/shopify/redemptions", {
          shopId, customerId, kind: "ORDER", channel: "STOREFRONT", points, cartSubtotal,
        }, key,
      );
      let created: { code: string; discountId: string } | undefined;
      try {
        created = await issueDiscount(admin, customerId, instruction);
        if (instruction.status !== "ACTIVE")
          await loyaltyApi("POST", "/integrations/shopify/redemptions", {
            shopId, customerId, action: "ISSUED", redemptionId: instruction.redemptionId,
            discountId: created.discountId, code: created.code,
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
      return json({
        code: created.code,
        expiresAt: instruction.expiresAt,
        cancelToken: cancellationToken({
          shopId, customerId, redemptionId: instruction.redemptionId,
          discountId: created.discountId, code: created.code,
          expiresAt: instruction.expiresAt,
        }),
      });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Request failed" },
      400,
    );
  }
};
