import { authenticate } from "../shopify.server";
import { loyaltyApi } from "./loyalty-api.server";

export type LoyaltyConnection = {
  brandId: string | null;
  brandName: string | null;
  storeId: string | null;
  connected: boolean;
  termsUrl: string | null;
  privacyUrl: string | null;
  termsVersion: string | null;
};
export async function merchantContext(request: Request) {
  const auth = await authenticate.admin(request);
  const staffId = auth.sessionToken?.sub;
  if (!staffId)
    throw new Response("A verified Shopify staff session is required", {
      status: 401,
    });
  const response = await auth.admin.graphql(`#graphql
    query LoyaltyShopContext { shop { id myshopifyDomain currencyCode plan { shopifyPlus partnerDevelopment } } }
  `);
  const result: { data?: { shop?: unknown }; errors?: unknown[] } =
    await response.json();
  const shop = result.data?.shop as
    | {
        id: string;
        myshopifyDomain: string;
        currencyCode: string;
        plan: { shopifyPlus: boolean; partnerDevelopment: boolean };
      }
    | undefined;
  if (!shop || result.errors?.length)
    throw new Error("Unable to verify the Shopify shop and plan");
  const connection = await loyaltyApi<LoyaltyConnection>(
    "GET",
    `/integrations/shopify/context?shopId=${encodeURIComponent(shop.id)}&shopDomain=${encodeURIComponent(shop.myshopifyDomain)}`,
  );
  return {
    ...auth,
    shop,
    connection,
    identity: { shop: auth.session.shop, staffId },
    compatible: shop.plan.shopifyPlus || shop.plan.partnerDevelopment,
  };
}
