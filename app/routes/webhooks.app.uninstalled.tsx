import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { loyaltyApi } from "../lib/loyalty-api.server";
import { deactivateDiscount } from "../lib/discounts.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, admin, payload } = await authenticate.webhook(request);

  const webhookId = request.headers.get("x-shopify-webhook-id");
  const rawShopId =
    (payload as { admin_graphql_api_id?: string; id?: number })
      .admin_graphql_api_id ?? (payload as { id?: number }).id;
  const shopId = rawShopId
    ? String(rawShopId).startsWith("gid://")
      ? String(rawShopId)
      : `gid://shopify/Shop/${rawShopId}`
    : undefined;
  if (webhookId && shopId) {
    const result = await loyaltyApi<{ discountIds?: string[] }>(
      "POST",
      "/integrations/shopify/events",
      {
        shopId,
        webhookId,
        topic: "app/uninstalled",
        payload: {},
      },
    );
    if (admin)
      for (const id of result.discountIds ?? [])
        await deactivateDiscount(admin, id);
  }

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }
  await db.brandAdminSession.deleteMany({ where: { shop } });

  return new Response();
};
