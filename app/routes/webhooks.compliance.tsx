import { createHash } from "node:crypto";
import { deactivateDiscount } from "../lib/discounts.server";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { loyaltyApi } from "../lib/loyalty-api.server";
import { encryptTokens } from "../lib/admin-session.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  const id = request.headers.get("x-shopify-webhook-id");
  if (!id) return new Response("Webhook ID required", { status: 400 });
  const topics: Record<string, string> = {
    CUSTOMERS_DATA_REQUEST: "customers/data_request",
    CUSTOMERS_REDACT: "customers/redact",
    SHOP_REDACT: "shop/redact",
  };
  const privacyTopic = topics[topic];
  if (!privacyTopic) return new Response("Unsupported topic", { status: 400 });
  const result = await loyaltyApi<{ discountIds?: string[] }>(
    "POST",
    "/integrations/shopify/privacy",
    { shopDomain: shop, topic: privacyTopic, payload },
  );
  const subject = (payload as { customer?: { id?: number | string } }).customer
    ?.id;
  const subjectHash =
    subject == null
      ? null
      : createHash("sha256")
          .update(shop + ":" + subject)
          .digest("hex");
  for (const discountId of result.discountIds || [])
    if (admin) await deactivateDiscount(admin, discountId);
  if (privacyTopic === "customers/redact" && subjectHash)
    await db.customerDataRequest.deleteMany({ where: { shop, subjectHash } });
  if (privacyTopic === "customers/data_request") {
    await db.customerDataRequest.upsert({
      where: { id },
      update: {},
      create: {
        id,
        shop,
        subjectHash,
        encryptedResult: encryptTokens(result, {
          shop,
          staffId: `privacy:${id}`,
        }),
      },
    });
  } else if (privacyTopic === "shop/redact") {
    await db.$transaction([
      db.customerDataRequest.deleteMany({ where: { shop } }),
      db.brandAdminSession.deleteMany({ where: { shop } }),
      db.session.deleteMany({ where: { shop } }),
    ]);
  }
  return new Response(null, { status: 200 });
};
