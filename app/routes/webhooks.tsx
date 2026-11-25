import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { loyaltyApi } from "../lib/loyalty-api.server";
import { orderSnapshot } from "../lib/orders.server";
import { deactivateDiscount, deleteDiscount } from "../lib/discounts.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const secret = process.env.SHOPIFY_LOYALTY_SERVICE_SECRET;
  const url = new URL(request.url);
  const timestamp = request.headers.get("x-loyalty-timestamp") ?? "";
  const signature = request.headers.get("x-loyalty-signature") ?? "";
  const time = Number(timestamp);
  const expected =
    secret &&
    createHmac("sha256", secret)
      .update(`${timestamp}\nGET\n${url.pathname}${url.search}\n`)
      .digest("hex");
  if (
    url.searchParams.get("reconcile") !== "1" ||
    !secret ||
    secret.length < 32 ||
    !Number.isSafeInteger(time) ||
    Math.abs(Date.now() - time) > 300000 ||
    !expected ||
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    return new Response("Unauthorized", { status: 401 });
  const sessions = await db.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });
  const since = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
  let synced = 0;
  for (const session of sessions) {
    const { admin } = await unauthenticated.admin(session.shop);
    let shopResponse: Response;
    try {
      shopResponse = await admin.graphql(
        `#graphql
        query LoyaltyShopId { shop { id } }`,
      );
    } catch (error) {
      if ((error as { response?: { code?: number } }).response?.code === 404) {
        console.warn(`Skipping unavailable Shopify shop ${session.shop}`);
        continue;
      }
      throw error;
    }
    const shopId = (await shopResponse.json()).data?.shop?.id as
      string | undefined;
    if (!shopId) throw new Error(`Shop ID unavailable for ${session.shop}`);
    const expired = await loyaltyApi<Array<{ discountId: string }>>(
      "GET",
      `/integrations/shopify/discounts/expired?shopId=${encodeURIComponent(shopId)}`,
    );
    for (const discount of expired) {
      if (discount.discountId.startsWith("gid://shopify/DiscountCodeNode/"))
        await deleteDiscount(admin, discount.discountId);
      else
        await deactivateDiscount(admin, discount.discountId);
      await loyaltyApi("POST", "/integrations/shopify/discounts/deactivated", {
        shopId,
        discountId: discount.discountId,
      });
    }
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const response: Response = await admin.graphql(
        `#graphql
        query LoyaltyRecentOrders($query: String!, $after: String) {
          orders(first: 100, query: $query, after: $after, sortKey: UPDATED_AT) {
            nodes { id }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
        { variables: { query: `updated_at:>=${since}`, after: cursor } },
      );
      const result:
        | {
            nodes: Array<{ id: string }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          }
        | undefined = (await response.json()).data?.orders;
      if (!result)
        throw new Error(`Order reconciliation failed for ${session.shop}`);
      for (const order of result.nodes as Array<{ id: string }>) {
        const snapshot = await orderSnapshot(admin, order.id);
        const digest = createHash("sha256")
          .update(`${shopId}:${JSON.stringify(snapshot)}`)
          .digest("hex");
        await loyaltyApi("POST", "/integrations/shopify/events", {
          shopId,
          webhookId: `reconcile:${digest}`,
          topic: "orders/updated",
          payload: snapshot,
        });
        synced++;
      }
      if (!result.pageInfo.hasNextPage) break;
      cursor = result.pageInfo.endCursor;
      if (page === 99)
        throw new Error(
          `Order reconciliation exceeded page limit for ${session.shop}`,
        );
    }
  }
  return Response.json(
    { shops: sessions.length, synced },
    { headers: { "cache-control": "no-store" } },
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, topic, payload } = await authenticate.webhook(request);
  if (!admin) return new Response("Shop session unavailable", { status: 503 });
  const webhookId = request.headers.get("x-shopify-webhook-id");
  if (!webhookId) return new Response("Webhook ID missing", { status: 400 });
  const shopResponse = await admin.graphql(
    `#graphql
    query LoyaltyShopId { shop { id } }`,
  );
  const shopId = (await shopResponse.json()).data?.shop?.id as
    string | undefined;
  if (!shopId) return new Response("Shop ID unavailable", { status: 503 });
  const body = payload as Record<string, unknown>;
  const rawOrderId =
    topic === "REFUNDS_CREATE"
      ? body.order_id
      : (body.admin_graphql_api_id ?? body.id);
  if (!rawOrderId) return new Response("Order ID missing", { status: 400 });
  const orderId = String(rawOrderId).startsWith("gid://")
    ? String(rawOrderId)
    : `gid://shopify/Order/${rawOrderId}`;
  const snapshot = await orderSnapshot(admin, orderId);
  await loyaltyApi("POST", "/integrations/shopify/events", {
    shopId,
    webhookId,
    topic: topic.toLowerCase().replace("_", "/"),
    payload: snapshot,
  });
  return new Response(null, { status: 200 });
};
