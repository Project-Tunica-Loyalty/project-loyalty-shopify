# Shopify loyalty backend adapter

This app serves one configured brand and explicitly allowed stores. Wallets, point lots, reservations, conversions and redemptions use Project Loyalty's existing services. It does not create a separate Shopify wallet or enroll customers automatically.

## Local configuration

1. Configure this app from `.env.example`. The local backend is `http://127.0.0.1:4002/api`.
2. In the backend environment, set `PORT=4002`, `SHOPIFY_BRAND_ID`, `SHOPIFY_ALLOWED_SHOPS=reglrs.myshopify.com`, `SHOPIFY_TERMS_URL`, `SHOPIFY_PRIVACY_URL`, and `SHOPIFY_TERMS_VERSION`. Use the real brand UUID and approved HTTPS policy pages. Keep a version stable once consent has been recorded.
3. Set the same `SHOPIFY_LOYALTY_SERVICE_SECRET` in both applications. Generate a separate `LOYALTY_ADMIN_SESSION_KEY` for this app. Each must be 32 random bytes encoded as 64 hex characters: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
4. Review pending migrations in both projects. The app's tables belong in `shopify_sessions`; backend tables belong in its existing schema. Run `npm run setup` here and the backend's Prisma migrate-deploy command after checking migration status. Do not use `db push` or reset an existing database.
5. Restart the backend after environment changes. Run `shopify app dev`, sign in to an existing Project Loyalty brand account in Shopify Admin, then connect using a store connection token issued by the brand owner. The operator's backend permissions remain authoritative; signing into Shopify alone does not grant brand access.
6. Add the Project Loyalty theme block to the storefront and sign in as a Shopify customer. New members verify their phone and accept membership terms. Marketing SMS consent is optional. Existing profiles and previously recorded consent are preserved.

Set backend `SHOPIFY_LOYALTY_APP_URL` to the publicly reachable app URL for scheduled reconciliation. Local tunnels change; update this setting after starting a new tunnel. The backend invokes signed `/webhooks?reconcile=1` every 15 minutes, re-fetches orders updated in the preceding 48 hours and retries code deactivation. It also releases expired reservations on its existing schedule. Missed events outside that window require explicit order replay through the signed event adapter; this release does not bulk-import history.

## Behavior

- Points are awarded only after payment and complete fulfillment. Merchandise value excludes shipping; the shared program decides whether merchandise tax earns points. Paid redemption orders receive a purchase reference immediately so cancellation before fulfillment can reverse spent points.
- Product rewards use the TypeScript Shopify Function and discount precisely one matching variant unit, including across multiple matching cart lines. They retain their product benefit. Monetary discounts use the reservation's actual conversion value and a Shopify checkout minimum subtotal derived from the program's percentage cap. Browser cart totals are only an estimate for reservation, never the checkout enforcement boundary.
- Discount codes are generated once by the backend, customer-restricted, single-use, non-combinable, and expire with the reservation. Lost create responses recover by the reserved code. Uncertain issuance keeps points held until confirmed deactivation or expiry.
- Overview and Reports use the connected store's backend reporting APIs. Customers shows brand wallet balances with store-scoped purchase history. Program Rules edits the shared brand configuration after an impact preview. Rewards configures Shopify variants and costs. Connection Settings displays installation and policy configuration.
- Brand sign-in and MFA tokens are encrypted in server-side sessions bound to the authenticated Shopify shop and staff ID. Browser requests cannot select a brand to gain access. Logging out or uninstalling clears these sessions.

## Customer data

Compliance webhooks are configured at `/webhooks/compliance`. Data requests create encrypted exports, downloadable by authenticated brand operators with customer-management permission from Reports. Deliver the export through the brand's verified customer-support process. Customer redaction removes Shopify identity mappings and webhook payloads, anonymizes integration rows, expires outstanding discounts and deletes saved exports. A hashed tombstone prevents old orders from re-linking a redacted customer; new explicit signup can record reconsent. Shop redaction is accepted only after uninstall.

The existing cross-channel brand account and required accounting ledger are not deleted by this Shopify adapter. The brand must handle any broader account erasure/retention obligations through its existing privacy process. Exports include the linked profile, brand consent records and points history, and Shopify order/redemption activity. Review the brand's broader data inventory before production approval.

## Launch gates

Custom-distribution apps using Shopify Functions require Shopify Plus in production. Development stores may be used for testing. Confirm the target store plan and, for multiple stores, that they belong to the same eligible Plus organization. The app blocks complete redemption on incompatible production stores and does not substitute a monetary benefit for a product reward.

Request the necessary protected customer-data access in Shopify's developer dashboard, including access needed for order/customer webhooks and customer-restricted discounts. Deploy the configured scopes (`write_app_proxy` included) and have the store approve changes. Keeping these webhooks requires approval; removing subscriptions would leave earning/refunds incomplete.

Before launch, record a real development-store journey: install → brand sign-in/connect → theme block → new signup and existing-account link → paid/full fulfillment → redeem → checkout → payment confirmation → refund/cancel → uninstall/reinstall. Exercise denied brand access, blocked members, concurrent/insufficient balances, consent preservation, cross-channel balances and rule changes, privacy requests, expiry and lost issuance responses. Automated tests supplement this journey; they do not establish live checkout compatibility.

## Checks

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm test --workspace extensions/loyalty-discount`. In the backend run the Shopify, consumer OTP/signup, and loyalty-points test suites plus its TypeScript/build check. Shopify AI Toolkit validates generated API queries, the Function schema and Liquid block. The Toolkit's standalone App Home validator currently fails to load `s-*` JSX declarations; project TypeScript checks use the installed Polaris declarations.

## API contract

All integration routes are relative to the backend /api prefix. Signature: HMAC-SHA256(secret, timestamp + "\n" + METHOD + "\n" + actualPathAndQuery + "\n" + exactBody). Timestamp is epoch milliseconds within five minutes. The key is a 64-character hexadecimal value, used as UTF-8 text in both applications. A GET has an empty body. Signing /integrations/... while requesting /api/integrations/... is invalid. Shopify verifies its own webhook/app-proxy signature before calling this adapter.

GET /integrations/shopify/context returns the configured brand, active installation/store and policy links; no browser brand selector grants authorization. POST /customers/signup/otp/send, /otp/resend, /otp/verify and /complete are under /integrations/shopify/customers/signup. The phone verification token is restricted to the consumer client, brand and Shopify customer challenge binding. Completion and identity mapping commit in the same transaction; already linked completion is idempotent. Consents use source SHOPIFY.

GET/POST /brands/:brandId/shopify/rewards use the existing JWT, brand role and LOYALTY_SETTINGS checks, including brand-owner restriction on writes. Legacy signed-only reward writes are forbidden. Other merchant screens proxy the existing auth, loyalty-program, customers and reporting APIs without bypassing their role checks.

Reservation responses include code, discountAmount, minimumSubtotal, variantId and expiresAt. ISSUED must echo the reserved code and customerId. FAILED requires the same customerId and confirmed deactivation of any issued code. Used or non-reserved redemptions cannot be released through failure recovery. GET /integrations/shopify/discounts/expired and POST /discounts/deactivated support the app's deactivation retry queue.

POST /integrations/shopify/privacy accepts shopDomain, topic and verified Shopify payload. Export, customer redaction and uninstalled-shop redaction are supported. Shared brand account/ledger retention is a separate brand privacy responsibility.

Order event snapshots add sourceUpdatedAt, merchandiseTax and refundedMerchandiseTax. Tax fields default to zero for older adapters. Older source updates are ignored, per-order processing is serialized, and both payment and full fulfillment are required for earning.

### Bruno

Select Local (4002/api) or UAT. Fill the shopify_* variables and calculate shopify_service_timestamp/signature over the fully expanded final URL path and exact body. Regenerate after each body/query edit; never save the service secret in committed environments. Run requests individually. Authentication requests capture account_access_token. Test wrong path signature (401), cross-brand/unknown-shop (403), wrong-customer challenge, stale terms, blocked member, duplicate completion, redemption ownership, expiry/retry, and uninstall/reinstall. Privacy requests can erase integration data and must be selected deliberately.
