import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  identityPath,
  loyaltyApi,
  LoyaltyApiError,
} from "../lib/loyalty-api.server";

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
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopId, customerId, shop } = await context(request);
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
  const { shopId, customerId } = await context(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const identity = { shopId, customerId };
  try {
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
    if (intent === "redeem")
      return json({ error: "Use points at checkout" }, 400);
    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Request failed" },
      400,
    );
  }
};
