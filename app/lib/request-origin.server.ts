export function assertAppOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;

  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!appUrl) throw new Error("SHOPIFY_APP_URL is required");
  if (origin !== new URL(appUrl).origin)
    throw new Response("Invalid request origin", { status: 403 });
}
