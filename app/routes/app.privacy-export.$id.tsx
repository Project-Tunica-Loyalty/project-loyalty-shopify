import type { LoaderFunctionArgs } from "react-router";
import { merchantContext } from "../lib/shop-context.server";
import { brandApi, decryptTokens } from "../lib/admin-session.server";
import db from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const ctx = await merchantContext(request);
  if (!ctx.connection.connected || !ctx.connection.storeId)
    throw new Response("Shop is not connected", { status: 403 });
  await brandApi(
    ctx.identity,
    "GET",
    `/customer/list?storeIds=${encodeURIComponent(ctx.connection.storeId)}&limit=1`,
  );
  const result = await db.customerDataRequest.findFirst({
    where: { id: params.id, shop: ctx.identity.shop },
  });
  if (!result) throw new Response("Data request not found", { status: 404 });
  const payload = decryptTokens<unknown>(result.encryptedResult, {
    shop: ctx.identity.shop,
    staffId: `privacy:${result.id}`,
  });
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition":
        'attachment; filename="loyalty-customer-data.json"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
};
