# Project Loyalty Shopify custom app

One Shopify app can serve multiple brands. A one-time connection token issued by a brand owner binds each shop to one brand and store. Wallets, point lots, reservations, conversions and redemptions use Project Loyalty's existing services. It does not create a separate Shopify wallet or enroll customers automatically.

## Local configuration

1. Configure this app from `.env.example`. The local backend is `http://127.0.0.1:4002/api`.
2. In the backend environment, set `PORT=4002`, the shared `SHOPIFY_LOYALTY_SERVICE_SECRET`, and the public `SHOPIFY_LOYALTY_APP_URL`. The brand owner's connection token selects the brand and store; each brand owner configures their approved HTTPS terms URL, privacy URL and terms version after connecting.
3. Set the same `SHOPIFY_LOYALTY_SERVICE_SECRET` in both applications. Generate a separate `LOYALTY_ADMIN_SESSION_KEY` for this app. Each must be 32 random bytes encoded as 64 hex characters: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
4. Review pending migrations in both projects. The app's tables belong in `shopify_sessions`; backend tables belong in its existing schema. Run `npm run setup` here and the backend's Prisma migrate-deploy command after checking migration status. Do not use `db push` or reset an existing database.
5. Restart the backend after environment changes. Run `shopify app dev`, connect using a store connection token issued by the brand owner, then sign in to that Project Loyalty brand account for management. The operator's backend permissions remain authoritative; signing into Shopify alone does not grant brand access.
6. Add the Project Loyalty theme block to the storefront and the Project Loyalty checkout block in the checkout editor. Sign in as a Shopify customer. New members verify their phone and accept membership terms. Marketing SMS consent is optional. Existing profiles and previously recorded consent are preserved.

Brand owners can save their HTTPS terms and privacy URLs and terms version in the connected shop's settings page or through `PUT /api/brands/:brandId/shopify/policy`. A shop can connect without a policy, but customer signup remains unavailable until the policy is configured. The signed shop context has null brand and policy fields before connection.

Set backend `SHOPIFY_LOYALTY_APP_URL` to the publicly reachable app URL for scheduled reconciliation. Local tunnels change; update this setting after starting a new tunnel. The backend invokes signed `/webhooks?reconcile=1` every 15 minutes, re-fetches orders updated in the preceding 48 hours and retries code deactivation. It also releases expired reservations on its existing schedule. Missed events outside that window require explicit order replay through the signed event adapter; this release does not bulk-import history.

## Behavior

- Points are deducted when an order is created and awarded only after payment and complete fulfillment. Merchandise value excludes shipping; the shared program decides whether merchandise tax earns points. Shopify orders link to a Project Loyalty purchase immediately so they appear with line items before fulfillment. Cancellation and refunds restore spent points according to the refunded share of an order discount; a refunded product reward restores its full points cost.
- The storefront block handles account linking and optionally shows the balance. Points and product rewards are applied in the checkout block for signed-in customers whose checkout phone matches their verified linked phone. No separate redemption OTP or manually entered coupon is needed. The checkout block must be enabled in Shopify's checkout editor, and external network access must be enabled for the extension in Shopify's developer dashboard.
- Product rewards use the TypeScript Shopify Function and discount precisely one matching variant unit, including across multiple matching cart lines. They retain their product benefit. Monetary discounts use the reservation's actual conversion value and a Shopify checkout minimum subtotal derived from the program's percentage cap. Browser cart totals are only an estimate for reservation, never the checkout enforcement boundary.
- Discount codes are generated once by the backend, customer-restricted, single-use, non-combinable, and expire with the reservation. Lost create responses recover by the reserved code. Uncertain issuance keeps points held until confirmed deactivation or expiry.
- Overview and Reports use the connected store's backend reporting APIs. Customers shows brand wallet balances with store-scoped purchase history. Program Rules edits the shared brand configuration after an impact preview. Its Shopify-only point value is one brand-wide setting for all connected Shopify stores; 0.5 makes 600 redeemed points worth 300 in the store currency. Leaving it blank retains the previous Shopify conversion and does not change Petpooja or consumer app redemption. Rewards configures Shopify variants and costs from either the embedded app or the brand dashboard. Connection Settings displays installation, policy, and storefront balance visibility.
- Brand sign-in and MFA tokens are encrypted in server-side sessions bound to the authenticated Shopify shop and staff ID. Browser requests cannot select a brand to gain access. Logging out or uninstalling clears these sessions.

## Customer data

Compliance webhooks are configured at `/webhooks/compliance`. Data requests create encrypted exports, downloadable by authenticated brand operators with customer-management permission from Reports. Deliver the export through the brand's verified customer-support process. Customer redaction removes Shopify identity mappings and webhook payloads, anonymizes integration rows, expires outstanding discounts and deletes saved exports. A hashed tombstone prevents old orders from re-linking a redacted customer; new explicit signup can record reconsent. Shop redaction is accepted only after uninstall.

The existing cross-channel brand account and required accounting ledger are not deleted by this Shopify adapter. The brand must handle any broader account erasure/retention obligations through its existing privacy process. Exports include the linked profile, brand consent records and points history, and Shopify order/redemption activity. Review the brand's broader data inventory before production approval.

## Launch gates

Custom-distribution apps using Shopify Functions require Shopify Plus in production. Development stores may be used for testing. Confirm the target store plan and, for multiple stores, that they belong to the same eligible Plus organization. The app blocks complete redemption on incompatible production stores and does not substitute a monetary benefit for a product reward.

Request the necessary protected customer-data access in Shopify's developer dashboard, including access needed for order/customer webhooks and customer-restricted discounts. Deploy the configured scopes (`write_app_proxy` included) and have the store approve changes. Keeping these webhooks requires approval; removing subscriptions would leave earning/refunds incomplete.

Before launch, record a real development-store journey: install → connect with a brand token → brand sign-in → configure policy → theme block → new signup and existing-account link → paid/full fulfillment → redeem → checkout → payment confirmation → refund/cancel → uninstall/reinstall. Exercise denied brand access, blocked members, concurrent/insufficient balances, consent preservation, cross-channel balances and rule changes, privacy requests, expiry and lost issuance responses. Automated tests supplement this journey; they do not establish live checkout compatibility.

## Checks

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm test --workspace extensions/loyalty-discount`. In the backend run the Shopify, consumer OTP/signup, and loyalty-points test suites plus its TypeScript/build check. Shopify AI Toolkit validates generated API queries, the Function schema and Liquid block. The Toolkit's standalone App Home validator currently fails to load `s-*` JSX declarations; project TypeScript checks use the installed Polaris declarations.
