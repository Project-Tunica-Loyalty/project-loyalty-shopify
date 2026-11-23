# Deploy a paid brand installation

This repository runs the **Shopify app web process** and its session database. It still requires the existing Project Loyalty backend and its own database, Redis, brand account, and operator process. The `artifacts/backend` directory contains integration artifacts, not a standalone backend container. Provision and verify that backend separately before installing the app.

Use one clone, Shopify app record, HTTPS app hostname, and Compose project per paying brand. The merchant's storefront domain may be completely different from the app hostname. A custom app hostname is needed only when you want a branded app URL; any stable HTTPS hostname that you control works. The app proxy remains at `https://<merchant-store-domain>/apps/loyalty` and Shopify forwards it to the app hostname.

Custom distribution is intended for one merchant store or stores in the same eligible Plus organization. It does not support Shopify app billing. Collect payment through your own sales process and issue the Project Loyalty connection token only after payment and backend provisioning. The connection token binds the Shopify shop to the customer's brand and store; possession of an install link alone does not connect the loyalty program. For a public app sold to unrelated merchants through Shopify, use a different distribution and pricing design.

## Per-brand setup

1. Create a Shopify app record for this brand in the Shopify Dev Dashboard. Select **Custom distribution** for the target store or eligible Plus organization. Record its client ID and secret. Confirm the store plan supports the Shopify Functions used by this app. Request any required protected customer data access before production use. Follow Shopify's current custom app IP allowlist requirements for installations outside your organization.
2. Pick an app hostname, such as `loyalty.brand.example`, and point DNS to your web server. Terminate HTTPS with a trusted certificate at your reverse proxy. Forward all requests, including `/auth/*`, `/webhooks/*`, and `/apps/loyalty`, to `127.0.0.1:3000`. Preserve the original host and `X-Forwarded-Proto: https`. The app must be reachable publicly for Shopify callbacks and webhooks. For example, a Caddy site on the same host can use:

   ```caddyfile
   loyalty.brand.example {
       reverse_proxy 127.0.0.1:3000
   }
   ```
3. Clone this repo on the server. Copy `.env.example` to `.env`; set `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `POSTGRES_PASSWORD`, `LOYALTY_BACKEND_URL`, `SHOPIFY_LOYALTY_SERVICE_SECRET`, and `LOYALTY_ADMIN_SESSION_KEY`. `SHOPIFY_APP_URL` is the HTTPS app origin, not the merchant storefront domain. `LOYALTY_BACKEND_URL` must be reachable **from inside** Docker. Use a long URL-safe PostgreSQL password. Generate each application secret separately with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Never commit `.env`.
4. Configure the existing Project Loyalty backend for this brand. Set its `SHOPIFY_LOYALTY_SERVICE_SECRET` to the same value and `SHOPIFY_LOYALTY_APP_URL` to the HTTPS app origin. Provision its own database, Redis, brand account, policy URLs, and store connection token using the backend's normal operator flow. Keep backend service authentication on. The app's Compose database stores Shopify and brand admin sessions only; it does not replace the loyalty ledger.
5. Generate a brand config: `npm run brand:config -- --client-id <client-id> --app-url https://loyalty.brand.example --name "Brand Loyalty"`. Review the generated `shopify.app.brand.toml`. It is ignored by Git. Run `shopify app config use brand` and `shopify app deploy` with Shopify CLI authenticated to the app owner to release the extensions, webhook subscriptions, app proxy, OAuth redirect URL, and app URL. Do this from an operator machine, not in the running container. The deployed URL and `SHOPIFY_APP_URL` must match exactly.
6. Run `docker compose up -d --build`. Compose creates a private PostgreSQL service and volume, waits for database readiness, and runs `prisma migrate deploy` before the app starts. Check `docker compose logs app` and open the HTTPS app URL. Keep the database volume when updating the image. Back up that volume regularly; it contains sessions and encrypted customer data exports.
7. After payment is confirmed, create the one-time connection token in Project Loyalty and have the merchant install the custom app using the store-specific Shopify install link. In the app, connect with the token, sign in to the brand account, configure membership policy URLs/version, enable the theme block, and run the end-to-end acceptance journey in [shopify-loyalty.md](shopify-loyalty.md). Keep the install link and token in your private onboarding record.

For each later release, update the repo on that brand's server, run `docker compose up -d --build`, and deploy the Shopify app version from the matching config if extensions or app settings changed. Coordinate backend changes first. Do not use `prisma db push` or reset a production database.

## Checks and limits

- This stack binds port 3000 to host loopback. If your reverse proxy runs on another machine or Docker network, change the port binding and firewall rules deliberately.
- The database password in `.env` is interpolated into a PostgreSQL URL. Use only URL-safe characters, or adapt the Compose database URL with proper percent encoding.
- A fresh clone needs the committed `package-lock.json` for reproducible `npm ci` container builds.
- The app is not a payment processor or automated subscription gate. Activation is the operator-issued backend connection token. Removing access or handling renewal is an operator/backend policy decision; a container rebuild does not change paid entitlement.
- `docker compose down` leaves the named database volume intact. Do not use `down -v` on a customer installation unless you intend to destroy its session database.
