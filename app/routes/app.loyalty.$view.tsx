import {
  Form,
  data,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { merchantContext } from "../lib/shop-context.server";
import { assertAppOrigin } from "../lib/request-origin.server";
import {
  backendApi,
  LoyaltyApiError,
  loyaltyApi,
} from "../lib/loyalty-api.server";
import {
  brandApi,
  deleteBrandSession,
  readBrandSession,
  saveBrandSession,
} from "../lib/admin-session.server";
import type { BrandTokens } from "../lib/admin-session.server";

type ObjectData = Record<string, unknown>;
type Tier = {
  id?: string;
  position: number;
  requiredPurchaseAmount?: number | null;
  requiredPurchaseCount?: number | null;
  rewardPoints: number;
};
type Milestone = {
  id?: string;
  name: string;
  cycleType: string;
  cycleDays?: number | null;
  cycleStartDate: string;
  tiers: Tier[];
};
type Version = ObjectData & { milestones?: Milestone[]; version?: number };
type Program = {
  program: {
    historicalPointExpiryPolicy?: string;
    legacyPointsRatio?: number;
    currentVersion: Version | null;
    version?: number;
    status: string;
  } | null;
};
type Login = BrandTokens & { user?: { tempLogin?: boolean } };
const views = [
  "overview",
  "program",
  "customers",
  "orders",
  "rewards",
  "reports",
  "settings",
];
const headers = { "cache-control": "no-store", pragma: "no-cache" };
const message = (error: unknown) =>
  error instanceof Error ? error.message : "The request could not be completed";
const numericFields = {
  pointsPerCurrencyUnit: "Points earned per currency unit",
  shopifyCurrencyPerPoint: "Value of 1 point in store currency (Shopify only)",
  minimumPaidAmountToEarn: "Minimum paid amount to earn",
  maximumPointsPerPurchase: "Maximum points per purchase",
  pointExpiryDays: "Point expiry in days",
  minimumRedemptionPoints: "Minimum points per redemption",
  maximumRedemptionPoints: "Maximum points per redemption",
  maximumBillPercentage: "Maximum percentage of bill covered",
  redemptionRateTarget: "Target redemption percentage",
  milestoneMinimumPaidAmount: "Minimum purchase amount for milestones",
};
const programFieldGroups = [
  {
    title: "Earning",
    description: "Choose how purchases earn points across the brand.",
    keys: [
      "pointsPerCurrencyUnit",
      "minimumPaidAmountToEarn",
      "maximumPointsPerPurchase",
    ],
  },
  {
    title: "Redemption",
    description: "Set the Shopify point value and limits for using points.",
    keys: [
      "shopifyCurrencyPerPoint",
      "minimumRedemptionPoints",
      "maximumRedemptionPoints",
      "maximumBillPercentage",
      "redemptionRateTarget",
    ],
  },
  {
    title: "Expiry and milestones",
    description: "Control point expiry and milestone eligibility.",
    keys: ["pointExpiryDays", "milestoneMinimumPaidAmount"],
  },
] as const;
const defaults: Version = {
  timezone: "Asia/Kolkata",
  pointsPerCurrencyUnit: 1,
  minimumPaidAmountToEarn: 0,
  pointExpiryDays: 365,
  redemptionType: "FULL",
  redemptionRateTarget: 0,
  milestoneMinimumPaidAmount: 0,
  milestones: [],
};
function programVersion(program: Program | null): Version {
  return { ...(program?.program || {}), ...(program?.program?.currentVersion || defaults) };
}
function record(value: unknown): ObjectData {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectData)
    : {};
}
function formatMoney(value: unknown, currency: unknown) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: String(currency || "USD"),
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${String(currency || "")}`.trim();
  }
}
function formatDate(value: unknown) {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime())
    ? "—"
    : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
function rows(value: unknown): ObjectData[] {
  if (Array.isArray(value)) return value.map(record);
  const obj = record(value);
  for (const key of ["customers", "data", "items", "rows", "results"])
    if (obj[key]) {
      const found = rows(obj[key]);
      if (found.length) return found;
    }
  return [];
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const view = params.view || "overview";
  if (!views.includes(view))
    throw new Response("Page not found", { status: 404 });
  const ctx = await merchantContext(request);
  const tokens = await readBrandSession(ctx.identity);
  let program: Program | null = null;
  let content: unknown = null;
  let error: string | null = null;
  let challenge: unknown = null;
  let privacyRequests: Array<{ id: string; requestedAt: Date }> = [];
  if (tokens?.pendingMfa) {
    try {
      challenge = await backendApi(
        "GET",
        "/auth/sign-in/2fa",
        undefined,
        tokens.accessToken,
      );
    } catch (err) {
      error = message(err);
    }
  } else if (tokens && ctx.connection.brandId) {
    try {
      program = await brandApi<Program>(
        ctx.identity,
        "GET",
        `/brands/${ctx.connection.brandId}/loyalty-program`,
      );
      if (ctx.connection.connected && ctx.connection.storeId) {
        const url = new URL(request.url);
        const store = encodeURIComponent(ctx.connection.storeId);
        if (view === "orders") {
          const after = url.searchParams.get("after");
          if (after && after.length > 512)
            throw new Error("Invalid order page");
          const response = await ctx.admin.graphql(
            `#graphql
            query LoyaltyMerchantOrders($after: String) {
              orders(first: 25, after: $after, sortKey: CREATED_AT, reverse: true) {
                nodes {
                  id name createdAt displayFinancialStatus displayFulfillmentStatus
                  totalPriceSet { shopMoney { amount currencyCode } }
                  customer { id displayName }
                  lineItems(first: 20) {
                    nodes { name quantity }
                    pageInfo { hasNextPage }
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          `,
            { variables: { after } },
          );
          const result = (await response.json()) as {
            data?: { orders?: unknown };
            errors?: Array<{ message: string }>;
          };
          if (result.errors?.length || !result.data?.orders)
            throw new Error(
              result.errors?.map((item: { message: string }) => item.message).join("; ") ||
                "Could not load Shopify orders",
            );
          content = result.data.orders;
        }
        if (view === "customers") {
          const customer = url.searchParams.get("customer");
          if (customer && !/^[a-f\d-]{36}$/i.test(customer))
            throw new Error("Invalid customer");
          content = await brandApi(
            ctx.identity,
            "GET",
            customer
              ? `/customer/${customer}/profile?storeIds=${store}&page=${Math.max(1, Number(url.searchParams.get("page")) || 1)}`
              : `/customer/list?storeIds=${store}&page=${Math.max(1, Number(url.searchParams.get("page")) || 1)}&limit=20&search=${encodeURIComponent(url.searchParams.get("search") || "")}`,
          );
        }
        if (view === "rewards")
          content = await brandApi(
            ctx.identity,
            "GET",
            `/brands/${ctx.connection.brandId}/shopify/rewards?shopId=${encodeURIComponent(ctx.shop.id)}`,
          );
        if (view === "settings")
          content = await brandApi(
            ctx.identity,
            "GET",
            `/brands/${ctx.connection.brandId}/shopify/policy`,
          );
        if (view === "reports")
          privacyRequests = await db.customerDataRequest.findMany({
            where: { shop: ctx.identity.shop },
            select: { id: true, requestedAt: true },
            orderBy: { requestedAt: "desc" },
            take: 50,
          });
        if (["overview", "reports"].includes(view)) {
          const to =
            url.searchParams.get("to") || new Date().toISOString().slice(0, 10);
          const from =
            url.searchParams.get("from") ||
            new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
            !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
            from > to
          )
            throw new Error("Choose a valid report date range");
          content = await brandApi(
            ctx.identity,
            "GET",
            `/reporting/loyalty/summary?brandId=${encodeURIComponent(ctx.connection.brandId)}&storeIds=${store}&from=${from}&to=${to}`,
          );
        }
      }
    } catch (err) {
      error = message(err);
    }
  }
  return data(
    {
      view,
      shop: ctx.shop,
      connection: ctx.connection,
      compatible: ctx.compatible,
      signedIn: Boolean(program),
      pendingMfa: Boolean(tokens?.pendingMfa),
      challenge,
      program,
      content,
      error,
      privacyRequests,
      filters: { search: new URL(request.url).searchParams.get("search") || "", customer: new URL(request.url).searchParams.get("customer") || "" },
    },
    { headers },
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await merchantContext(request);
  assertAppOrigin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  try {
    if (intent === "connect") {
      if (ctx.connection.connected)
        throw new Error("This shop is already connected");
      if (!ctx.compatible)
        throw new Error(
          "This custom app requires a compatible Shopify Plus store for product rewards",
        );
      await loyaltyApi("POST", "/integrations/shopify/installations/connect", {
        token: String(form.get("token") || "").trim(),
        shopId: ctx.shop.id,
        shopDomain: ctx.shop.myshopifyDomain,
        currency: ctx.shop.currencyCode,
      });
      return data({ success: "Shop connected to the brand" }, { headers });
    }
    if (intent === "logout") {
      const tokens = await readBrandSession(ctx.identity);
      if (tokens && !tokens.pendingMfa)
        await backendApi("POST", "/auth/logout", {}, tokens.accessToken).catch(
          () => {},
        );
      await deleteBrandSession(ctx.identity);
      return data({ success: "Signed out of Project Loyalty" }, { headers });
    }
    if (intent === "login" || intent === "verify-mfa") {
      if (!ctx.connection.brandId) throw new Error("Connect this shop first");
      const previous = await readBrandSession(ctx.identity);
      if (intent === "verify-mfa" && !previous?.pendingMfa)
        throw new Error("Start sign-in again");
      const result =
        intent === "login"
          ? await backendApi<Login>("POST", "/auth/sign-in", {
              email: String(form.get("email") || ""),
              password: String(form.get("password") || ""),
            })
          : await backendApi<Login>(
              "POST",
              "/auth/sign-in/verify-2fa",
              {
                challengeId: String(form.get("challengeId") || ""),
                otp: String(form.get("otp") || ""),
              },
              previous!.accessToken,
            );
      if (!result.accessToken)
        throw new Error("The backend did not return a sign-in session");
      if (!result.user?.tempLogin)
        await backendApi(
          "GET",
          `/brands/${ctx.connection.brandId}/loyalty-program`,
          undefined,
          result.accessToken,
        );
      await saveBrandSession(ctx.identity, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        pendingMfa: result.user?.tempLogin === true,
      });
      return data(
        {
          success: result.user?.tempLogin
            ? "Enter the verification code sent to your email"
            : "Brand account connected",
        },
        { headers },
      );
    }
    if (intent === "resend-mfa") {
      const tokens = await readBrandSession(ctx.identity);
      if (!tokens?.pendingMfa) throw new Error("Start sign-in again");
      await backendApi(
        "POST",
        "/auth/sign-in/resend-2fa",
        { challengeId: String(form.get("challengeId") || "") },
        tokens.accessToken,
      );
      return data({ success: "A new verification code was sent" }, { headers });
    }
    if (!ctx.connection.brandId) throw new Error("Connect this shop first");
    const brandPath = `/brands/${ctx.connection.brandId}`;
    const current = await brandApi<Program>(
      ctx.identity,
      "GET",
      `${brandPath}/loyalty-program`,
    );
    if (!ctx.connection.connected)
      throw new Error("Connect the shop before managing loyalty");
    if (intent === "save-policy") {
      await brandApi(ctx.identity, "PUT", `${brandPath}/shopify/policy`, {
        termsUrl: String(form.get("termsUrl") || "").trim(),
        privacyUrl: String(form.get("privacyUrl") || "").trim(),
        termsVersion: String(form.get("termsVersion") || "").trim(),
        showStorefrontBalance: form.get("showStorefrontBalance") === "on",
      });
      return data({ success: "Brand policy saved" }, { headers });
    }
    if (intent === "reward") {
      if (!ctx.compatible)
        throw new Error(
          "Product rewards require Shopify Plus for this custom app",
        );
      const variantId = String(form.get("variantId") || "");
      const response = await ctx.admin.graphql(
        `#graphql
        query LoyaltyRewardVariant($id: ID!) { productVariant(id: $id) { id title product { title } } }
      `,
        { variables: { id: variantId } },
      );
      const variant = (await response.json()).data?.productVariant;
      if (!variant)
        throw new Error("Select an available product variant from this shop");
      await brandApi(ctx.identity, "POST", `${brandPath}/shopify/rewards`, {
        shopId: ctx.shop.id,
        variantId: variant.id,
        title: `${variant.product.title} / ${variant.title}`,
        pointsCost: Number(form.get("pointsCost")),
        enabled: form.get("enabled") === "on",
        ...(form.get("updatedAt")
          ? { updatedAt: String(form.get("updatedAt")) }
          : {}),
      });
      return data({ success: "Reward saved" }, { headers });
    }
    if (intent === "preview-program") {
      const base = programVersion(current);
      const draft: ObjectData = {
        timezone: String(form.get("timezone") || ""),
        currency: ctx.shop.currencyCode,
        ...(form.get("legacyPointsRatio")
          ? { legacyPointsRatio: Number(form.get("legacyPointsRatio")) }
          : {}),
        expectedVersion: Number(form.get("expectedVersion")),
        changeReason: String(form.get("changeReason") || ""),
        redemptionType: String(form.get("redemptionType") || "FULL"),
        countOnlyHighestTransactionPerDay:
          form.get("countOnlyHighestTransactionPerDay") === "on",
        allowMultipleMilestoneRewardsPerDay:
          form.get("allowMultipleMilestoneRewardsPerDay") === "on",
        givePointsOnTaxValue: form.get("givePointsOnTaxValue") === "on",
        historicalPointExpiryPolicy: String(
          form.get("historicalPointExpiryPolicy") ||
            base.historicalPointExpiryPolicy ||
            "GRANDFATHER",
        ),
        milestones: JSON.parse(String(form.get("milestones") || "[]")),
        ...(base.pointExpiryAlert
          ? { pointExpiryAlert: base.pointExpiryAlert }
          : {}),
        ...(base.excludeOrdersFrom
          ? { excludeOrdersFrom: base.excludeOrdersFrom }
          : {}),
        ...(base.profileUpdateRewardEnabled != null
          ? {
              profileUpdateRewardEnabled: base.profileUpdateRewardEnabled,
              profileUpdateRewardPoints: base.profileUpdateRewardPoints,
            }
          : {}),
      };
      for (const key of Object.keys(numericFields))
        draft[key] = form.get(key) === "" ? null : Number(form.get(key));
      const preview = await brandApi<ObjectData>(
        ctx.identity,
        "POST",
        `${brandPath}/loyalty-program/impact-preview`,
        draft,
      );
      return data({ preview, draft }, { headers });
    }
    if (intent === "save-program") {
      const draft = record(JSON.parse(String(form.get("draft"))));
      if (draft.currency !== ctx.shop.currencyCode)
        throw new Error("The program currency must match the shop");
      await brandApi(ctx.identity, "PUT", `${brandPath}/loyalty-program`, {
        ...draft,
        impactPreviewToken: String(form.get("impactPreviewToken") || ""),
        retroactiveAwardPolicy: String(
          form.get("retroactiveAwardPolicy") || "NEXT_PURCHASE",
        ),
      });
      return data({ success: "Brand-wide loyalty rules saved" }, { headers });
    }
    throw new Error("Unknown action");
  } catch (error) {
    return data(
      { error: message(error) },
      {
        status: error instanceof LoyaltyApiError ? error.status : 400,
        headers,
      },
    );
  }
};

function Details({ value }: { value: unknown }) {
  const obj = record(value);
  return (
    <dl className="loyalty-details">
      {Object.entries(obj)
        .filter(
          ([key, val]) =>
            val != null &&
            !["id", "brandId", "storeId", "requestId", "batchId"].includes(key),
        )
        .map(([key, val]) => (
          <div key={key}>
            <dt>{key.replace(/([A-Z])/g, " $1").replace(/_/g, " ")}</dt>
            <dd>
              {typeof val === "object" ? (
                Array.isArray(val) ? (
<details><summary>{val.length} records</summary><ol>{val.slice(0, 100).map((entry, index) => <li key={String(record(entry).id || index)}>{typeof entry === "object" && entry !== null ? <Details value={entry} /> : String(entry)}</li>)}</ol>{val.length > 100 && <p>Showing the first 100 records.</p>}</details>
                ) : (
                  <Details value={val} />
                )
              ) : (
                String(val)
              )}
            </dd>
          </div>
        ))}
    </dl>
  );
}
function ReportSummary({ value, currency }: { value: unknown; currency: string }) {
  const report = record(value);
  const reportData = record(report.data);
  const metrics = rows(reportData.metrics);
  const charts = rows(reportData.charts);
  const meta = record(report.meta);
  const format = (entry: ObjectData) => {
    if (entry.value == null || !Number.isFinite(Number(entry.value))) return "—";
    if (entry.format === "currency") return formatMoney(entry.value, currency);
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Number(entry.value))}${entry.format === "percent" ? "%" : ""}`;
  };
  return <div className="loyalty-report">
    <p className="loyalty-report-freshness">{meta.dataThrough
      ? `Data through ${formatDate(meta.dataThrough)}`
      : "Reporting is waiting for its first successful refresh."}</p>
    <div className="loyalty-metric-grid">
      {metrics.map((metric) => <article className="loyalty-metric" key={String(metric.key)}>
        <p className="loyalty-metric-label">{String(metric.title)}</p>
        <p className="loyalty-metric-value">{format(metric)}</p>
        {Boolean(metric.description) && <p className="loyalty-metric-description">{String(metric.description)}</p>}
      </article>)}
    </div>
    <div className="loyalty-chart-grid">
      {charts.map((chart) => {
        const points = rows(chart.points).slice(0, 12);
        const max = Math.max(1, ...points.map((point) => Number(point.value) || 0));
        return <section className="loyalty-chart" key={String(chart.key)}>
          <h3>{String(chart.title)}</h3>
          {points.length ? <ol>{points.map((point, index) => <li key={`${String(chart.key)}-${index}`}>
            <span>{String(point.label)}</span>
            <span className="loyalty-chart-bar"><span style={{ width: `${Math.max(0, Math.min(100, (Number(point.value) || 0) / max * 100))}%` }} /></span>
            <strong>{format({ value: point.value, format: chart.format })}</strong>
          </li>)}</ol> : <p>No activity for this period.</p>}
        </section>;
      })}
    </div>
  </div>;
}
function Milestones({ initial }: { initial: Milestone[] }) {
  const [items, setItems] = useState(initial);
  const update = (index: number, value: Partial<Milestone>) =>
    setItems(
      items.map((item, i) => (i === index ? { ...item, ...value } : item)),
    );
  return (
    <fieldset>
      <legend>Milestones</legend>
      <input type="hidden" name="milestones" value={JSON.stringify(items)} />
      {items.map((item, index) => (
        <fieldset key={item.id || index}>
          <legend>Milestone {index + 1}</legend>
          <label>
            Name
            <input
              required
              value={item.name}
              onChange={(e) => update(index, { name: e.target.value })}
            />
          </label>
          <label>
            Cycle
            <select
              value={item.cycleType}
              onChange={(e) => update(index, { cycleType: e.target.value })}
            >
              <option value="FOREVER">Lifetime</option>
              <option value="FIXED_DAYS">Custom period</option>
            </select>
          </label>
          <label>
            Cycle days
            <input
              type="number"
              min="1"
              value={item.cycleDays ?? ""}
              onChange={(e) =>
                update(index, {
                  cycleDays: e.target.value ? Number(e.target.value) : null,
                })
              }
            />
          </label>
          <label>
            Starts on
            <input
              type="date"
              required
              value={item.cycleStartDate.slice(0, 10)}
              onChange={(e) =>
                update(index, { cycleStartDate: e.target.value })
              }
            />
          </label>
          {item.tiers.map((tier, t) => (
            <div key={tier.id || t} className="loyalty-fields">
              {(
                [
                  "requiredPurchaseAmount",
                  "requiredPurchaseCount",
                  "rewardPoints",
                ] as const
              ).map((key) => (
                <label key={key}>
                  {key === "rewardPoints"
                    ? "Reward points"
                    : key === "requiredPurchaseAmount"
                      ? "Required spend"
                      : "Required purchases"}
                  <input
                    type="number"
                    min={key === "rewardPoints" ? "0.01" : "0"}
                    step={key === "requiredPurchaseCount" ? "1" : "0.01"}
                    value={tier[key] ?? ""}
                    onChange={(e) =>
                      update(index, {
                        tiers: item.tiers.map((v, n) =>
                          n === t
                            ? {
                                ...v,
                                [key]: e.target.value
                                  ? Number(e.target.value)
                                  : null,
                              }
                            : v,
                        ),
                      })
                    }
                  />
                </label>
              ))}
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              update(index, {
                tiers: [
                  ...item.tiers,
                  { position: item.tiers.length + 1, rewardPoints: 1 },
                ],
              })
            }
          >
            Add reward tier
          </button>
          <button
            type="button"
            onClick={() => setItems(items.filter((_, i) => i !== index))}
          >
            Remove milestone
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        onClick={() =>
          setItems([
            ...items,
            {
              name: "",
              cycleType: "FOREVER",
              cycleStartDate: new Date().toISOString().slice(0, 10),
              tiers: [{ position: 1, rewardPoints: 1 }],
            },
          ])
        }
      >
        Add milestone
      </button>
    </fieldset>
  );
}

export default function LoyaltyPage() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const bridge = useAppBridge();
  const [variant, setVariant] = useState({
    id: "",
    title: "",
    pointsCost: "",
    enabled: true,
    updatedAt: "",
  });
  const version = programVersion(loaded.program);
  const info = record(result);
  const error = String(info.error || loaded.error || "");
  const customers = rows(loaded.content);
  const profile = record(loaded.content);
  const transactions = rows(profile.transactions);
  const orders = rows(record(loaded.content).nodes);
  const orderPage = record(record(loaded.content).pageInfo);
  const pagination = record(record(loaded.content).pagination);
  const page = Number(pagination.page) || 1;
  const productRewards = rows(record(loaded.content).products);
  const challenge = record(loaded.challenge);
  const heading = (
    {
      overview: "Overview",
      program: "Program rules",
      customers: "Customers",
      orders: "Orders",
      rewards: "Rewards",
      reports: "Loyalty reports",
      settings: "Connection settings",
    } as Record<string, string>
  )[loaded.view];
  const pick = async () => {
    const selected = await bridge.resourcePicker({
      type: "product",
      multiple: false,
      filter: { variants: true },
    });
    const product = selected?.[0];
    const chosen = product?.variants?.[0];
    if (product && chosen?.id) {
      const id = chosen.id;
      setVariant((v) => ({
        ...v,
        id,
        title: `${product.title} / ${chosen.title}`,
        updatedAt: "",
      }));
    }
  };
  return (
    <s-page heading={heading}>
      <s-section heading={loaded.connection.brandName || "Connect your brand"}>
        <s-paragraph>
          {loaded.shop.myshopifyDomain} · {loaded.shop.currencyCode} ·{" "}
          {loaded.compatible
            ? "Compatible for custom-app product rewards"
            : "Product rewards require a compatible Plus store"}
        </s-paragraph>
        <s-paragraph>
          Points and program rules are shared with this brand’s other Project
          Loyalty channels.
        </s-paragraph>
      </s-section>
      {!loaded.compatible && (
        <s-banner tone="critical" heading="Production launch is blocked">
          Confirm Shopify Plus compatibility before enabling the complete
          redemption experience.
        </s-banner>
      )}
      {error && (
        <s-banner tone="critical" heading="Action required">
          {error}
        </s-banner>
      )}
      {info.success != null && (
        <s-banner tone="success" heading="Saved">
          {String(info.success)}
        </s-banner>
      )}
      {!loaded.connection.connected ? (
        <s-section heading="Connect this shop">
          <s-paragraph>
            Enter the one-time connection token issued by a Project Loyalty
            brand owner for this store.
          </s-paragraph>
          <Form method="post" className="loyalty-form">
            <input name="intent" type="hidden" value="connect" />
            <label>
              Connection token
              <input name="token" required autoComplete="off" />
            </label>
            <button disabled={busy || !loaded.compatible}>Connect shop</button>
          </Form>
        </s-section>
      ) : !loaded.signedIn ? (
        <s-section heading="Sign in to your brand account">
          <s-paragraph>
            Use your existing Project Loyalty account. Your brand permissions
            apply here.
          </s-paragraph>
          {loaded.pendingMfa ? (
            <Form method="post" className="loyalty-form">
              <input
                type="hidden"
                name="challengeId"
                value={String(challenge.challengeId || "")}
              />
              <label>
                Email verification code
                <input
                  name="otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  pattern="[0-9]{6}"
                />
              </label>
              <button name="intent" value="verify-mfa" disabled={busy}>
                Verify
              </button>
              <button
                name="intent"
                value="resend-mfa"
                formNoValidate
                disabled={busy}
              >
                Resend code
              </button>
            </Form>
          ) : (
            <Form method="post" className="loyalty-form">
              <input type="hidden" name="intent" value="login" />
              <label>
                Email
                <input
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                />
              </label>
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </label>
              <button disabled={busy}>Sign in</button>
            </Form>
          )}
        </s-section>
      ) : (
        <>
          <s-section>
            <Form method="post">
              <button name="intent" value="logout" disabled={busy}>
                Sign out of Project Loyalty
              </button>
            </Form>
          </s-section>
          {loaded.view === "settings" && (
            <s-section heading="Brand connection">
              <s-paragraph>
                {loaded.connection.connected
                  ? "This shop is connected to its brand and shares the brand wallet."
                  : "Generate a store connection token in Project Loyalty, then paste it below."}
              </s-paragraph>
              <Form method="post" className="loyalty-form">
                <input type="hidden" name="intent" value="save-policy" />
                <label>
                  Terms URL
                  <input name="termsUrl" type="url" required
                    defaultValue={loaded.connection.termsUrl || ""} />
                </label>
                <label>
                  Privacy URL
                  <input name="privacyUrl" type="url" required
                    defaultValue={loaded.connection.privacyUrl || ""} />
                </label>
                <label>
                  Terms version
                  <input name="termsVersion" required maxLength={50}
                    defaultValue={loaded.connection.termsVersion || ""} />
                </label>
                <label><span><input type="checkbox" name="showStorefrontBalance"
                  defaultChecked={record(loaded.content).showStorefrontBalance !== false} />{" "}
                  Show linked customers their points in the storefront</span></label>
                <button disabled={busy}>Save brand policy</button>
              </Form>
              <s-paragraph>
                Customer signup requires the brand’s current terms and privacy
                links to be configured on the backend. The storefront theme must
                include the Project Loyalty block.
              </s-paragraph>
              {loaded.connection.termsUrl && (
                <s-link href={loaded.connection.termsUrl} target="_blank">
                  Terms
                </s-link>
              )}
              {loaded.connection.privacyUrl && (
                <s-link href={loaded.connection.privacyUrl} target="_blank">
                  Privacy policy
                </s-link>
              )}
            </s-section>
          )}
          {loaded.view === "program" && (
            <s-section heading="Brand-wide earning and redemption rules">
              <s-banner heading="Applies to every brand channel">
                Earning and other loyalty rules apply to every brand channel.
                The Shopify point value below affects Shopify redemptions only.
              </s-banner>
              <Form method="post" className="loyalty-form">
                <input type="hidden" name="intent" value="preview-program" />
                <input
                  type="hidden"
                  name="expectedVersion"
                  value={String(
                    version.version || loaded.program?.program?.version || 0,
                  )}
                />
                {programFieldGroups.map((group) => (
                  <section className="loyalty-form-section" key={group.title}>
                    <div className="loyalty-section-heading">
                      <h3>{group.title}</h3>
                      <p>{group.description}</p>
                    </div>
                    <div className="loyalty-fields">
                      {group.keys.map((key) => (
                        <label key={key}>
                          {numericFields[key]}
                          <input
                            name={key}
                            type="number"
                            step={key === "pointExpiryDays" ? "1" : "0.000001"}
                            min={
                              key === "shopifyCurrencyPerPoint"
                                ? "0.000001"
                                : "0"
                            }
                            defaultValue={String(version[key] ?? "")}
                          />
                          {key === "shopifyCurrencyPerPoint" && (
                            <small>
                              Applies across this brand’s Shopify stores. For
                              example, 600 points at 0.5 give a{" "}
                              {formatMoney(300, loaded.shop.currencyCode)}
                              discount.
                            </small>
                          )}
                        </label>
                      ))}
                    </div>
                  </section>
                ))}
                <div className="loyalty-fields loyalty-fields-settings">
                  <label>
                    Timezone
                    <input
                      name="timezone"
                      required
                      defaultValue={String(version.timezone || "Asia/Kolkata")}
                    />
                  </label>
                  <label>
                    Redemption type
                    <select
                      name="redemptionType"
                      defaultValue={String(version.redemptionType || "FULL")}
                    >
                      <option value="FULL">Full product reward</option>
                      <option value="PARTIAL">
                        Partial monetary redemption
                      </option>
                    </select>
                  </label>
                </div>
                {(
                  [
                    [
                      "countOnlyHighestTransactionPerDay",
                      "Count only the highest purchase each day",
                    ],
                    [
                      "allowMultipleMilestoneRewardsPerDay",
                      "Allow multiple milestone rewards each day",
                    ],
                    [
                      "givePointsOnTaxValue",
                      "Earn points on tax-inclusive purchase value",
                    ],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    <span>
                      <input
                        type="checkbox"
                        name={key}
                        defaultChecked={Boolean(version[key])}
                      />{" "}
                      {label}
                    </span>
                  </label>
                ))}
                <label>
                  Historical points expiry
                  <select
                    name="historicalPointExpiryPolicy"
                    defaultValue={String(
                      version.historicalPointExpiryPolicy || "GRANDFATHER",
                    )}
                  >
                    <option value="GRANDFATHER">
                      Preserve existing expiry dates
                    </option>
                    <option value="APPLY_CURRENT_EXPIRY">
                      Apply the current expiry policy
                    </option>
                    <option value="PENDING">
                      Keep the existing pending migration policy
                    </option>
                  </select>
                </label>
                <label>
                  Historical points conversion ratio (when required)
                  <input
                    name="legacyPointsRatio"
                    type="number"
                    min="0.000001"
                    step="0.000001"
                    defaultValue={String(version.legacyPointsRatio ?? "")}
                  />
                </label>
                <Milestones
                  key={String(version.version || 0)}
                  initial={version.milestones || []}
                />
                <label>
                  Reason for this change
                  <input name="changeReason" required maxLength={500} />
                </label>
                <button disabled={busy || !loaded.connection.connected}>
                  Review impact
                </button>
              </Form>
              {info.preview != null && (
                <s-section heading="Review before saving">
                  <Details value={info.preview} />
                  <Form method="post" className="loyalty-form">
                    <input type="hidden" name="intent" value="save-program" />
                    <input
                      type="hidden"
                      name="draft"
                      value={JSON.stringify(info.draft)}
                    />
                    <input
                      type="hidden"
                      name="impactPreviewToken"
                      value={String(record(info.preview).token || "")}
                    />
                    <label>
                      Existing customer milestone eligibility
                      <select name="retroactiveAwardPolicy">
                        <option value="NEXT_PURCHASE">
                          Apply on the next purchase
                        </option>
                        <option value="GRANT">
                          Grant eligible rewards now
                        </option>
                      </select>
                    </label>
                    <button disabled={busy}>Save brand-wide rules</button>
                  </Form>
                </s-section>
              )}
            </s-section>
          )}
          {loaded.view === "rewards" && (
            <s-section heading="Product rewards">
              <s-paragraph>
                Each reward gives one unit of its selected variant for the
                configured number of points.
              </s-paragraph>
              <Form method="post" className="loyalty-form">
                <input type="hidden" name="intent" value="reward" />
                <input type="hidden" name="variantId" value={variant.id} />
                <input type="hidden" name="updatedAt" value={variant.updatedAt} />
                <button type="button" onClick={() => void pick()}>
                  Choose product variant
                </button>
                <p>{variant.title || "No product selected"}</p>
                <label>
                  Point cost
                  <input
                    type="number"
                    name="pointsCost"
                    min="0.01"
                    step="0.01"
                    required
                    value={variant.pointsCost}
                    onChange={(e) =>
                      setVariant((v) => ({ ...v, pointsCost: e.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>
                    <input
                      type="checkbox"
                      name="enabled"
                      checked={variant.enabled}
                      onChange={(e) =>
                        setVariant((v) => ({ ...v, enabled: e.target.checked }))
                      }
                    />{" "}
                    Enabled
                  </span>
                </label>
                <button disabled={busy || !variant.id || !loaded.compatible}>
                  Save reward
                </button>
              </Form>
              <div className="loyalty-table-scroll" role="region" aria-label="Product rewards" tabIndex={0}>
              <table className="loyalty-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Points</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {productRewards.map((reward) => (
                    <tr key={String(reward.id)}>
                      <td>{String(reward.title)}<br /><small>{String(reward.variantId)}</small></td>
                      <td>{String(reward.pointsCost)}</td>
                      <td>{reward.enabled === false ? "Disabled" : "Enabled"}</td>
                      <td>
                        <button
                          onClick={() =>
                            setVariant({
                              id: String(reward.variantId),
                              title: String(reward.title),
                              pointsCost: String(reward.pointsCost),
                              enabled: reward.enabled !== false,
                              updatedAt: String(reward.updatedAt || ""),
                            })
                          }
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </s-section>
          )}
          {loaded.view === "orders" && (
            <s-section heading="Recent Shopify orders">
              <s-paragraph>
                Orders from this shop appear here after Shopify grants order access.
                Open an order to inspect its items and payment and fulfillment status.
              </s-paragraph>
              {orders.length ? (
                <div className="loyalty-table-scroll" role="region" aria-label="Recent Shopify orders" tabIndex={0}>
                <table className="loyalty-table loyalty-table-orders">
                  <thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Total</th><th>Payment</th><th>Fulfillment</th><th>Items</th></tr></thead>
                  <tbody>
                    {orders.map((order) => {
                      const amount = record(record(order.totalPriceSet).shopMoney);
                      const items = rows(record(order.lineItems).nodes);
                      const id = String(order.id || "").split("/").pop();
                      return (
                        <tr key={String(order.id)}>
                          <td><s-link href={`https://${loaded.shop.myshopifyDomain}/admin/orders/${encodeURIComponent(id || "")}`} target="_blank">{String(order.name || id || "Order")}</s-link></td>
                          <td>{formatDate(order.createdAt)}</td>
                          <td>{String(record(order.customer).displayName || "Guest / no customer account")}</td>
                          <td>{formatMoney(amount.amount, amount.currencyCode)}</td>
                          <td>{String(order.displayFinancialStatus || "—").replaceAll("_", " ")}</td>
                          <td>{String(order.displayFulfillmentStatus || "—").replaceAll("_", " ")}</td>
                          <td><details><summary>{items.length} item{items.length === 1 ? "" : "s"}</summary>
                            <ul>{items.map((item, index) => <li key={`${String(order.id)}-${index}`}>{String(item.name || "Item")} × {String(item.quantity || 0)}</li>)}</ul>
                            {Boolean(record(record(order.lineItems).pageInfo).hasNextPage) && <p>Open the order in Shopify to see more items.</p>}
                          </details></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              ) : (
                <p>No Shopify orders are available for this shop yet.</p>
              )}
              {Boolean(orderPage.hasNextPage) && <s-link href={`?after=${encodeURIComponent(String(orderPage.endCursor))}`}>Older orders</s-link>}
              <s-paragraph>
                Points are recorded in the linked customer&apos;s profile after
                an eligible order is paid and fulfilled.
              </s-paragraph>
            </s-section>
          )}
          {loaded.view === "customers" && (
            <s-section heading="Customer profiles">
              <Form method="get" className="loyalty-form">
                <label>
                  Find a customer
                  <input name="search" type="search" defaultValue={loaded.filters.search} />
                </label>
                <button>Search</button>
              </Form>
              {loaded.filters.customer && loaded.content ? (
                <>
                  <s-paragraph>
                    {String(record(profile.customer).name || "Customer")}: {String(record(profile.loyaltyBalance).currentPoints ?? "—")} available points
                  </s-paragraph>
                  <h3>Orders and points for this store</h3>
                  {transactions.length ? <div className="loyalty-table-scroll" role="region" aria-label="Customer transactions" tabIndex={0}><table className="loyalty-table loyalty-table-transactions">
                    <thead><tr><th>Date</th><th>Amount</th><th>Points earned</th><th>Points used</th><th>Balance after</th><th>Items</th></tr></thead>
                    <tbody>{transactions.map((transaction) => {
                      const items = rows(transaction.items);
                      return <tr key={String(transaction.purchaseId)}>
                        <td>{formatDate(transaction.date)}</td>
                        <td>{formatMoney(transaction.billAmount, loaded.shop.currencyCode)}</td>
                        <td>{String(transaction.credited ?? 0)}</td>
                        <td>{String(transaction.debited ?? 0)}</td>
                        <td>{String(transaction.balanceAfter ?? "—")}</td>
                        <td>{items.length ? items.map((item) => `${String(item.name)} × ${String(item.quantity)}`).join(", ") : "See Orders for Shopify item details"}</td>
                      </tr>;
                    })}</tbody>
                  </table></div> : <p>No eligible purchases are linked to this customer in this store yet.</p>}
                </>
              ) : customers.length ? (
                <div className="loyalty-table-scroll" role="region" aria-label="Customer profiles" tabIndex={0}>
                <table className="loyalty-table">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Phone</th>
                      <th>Points</th>
                      <th>Profile</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customers.map((customer) => (
                      <tr key={String(customer.id)}>
                        <td>
                          {String(
                            customer.name || customer.customerName || "Member",
                          )}
                        </td>
                        <td>
                          {String(
                            customer.phoneNumber || customer.phone || "—",
                          )}
                        </td>
                        <td>
                          {String(
                            customer.currentPoints ??
                              customer.totalPoints ??
                              "—",
                          )}
                        </td>
                        <td>
                          <s-link
                            href={`?customer=${encodeURIComponent(String(customer.id))}`}
                          >
                            View profile
                          </s-link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              ) : loaded.content ? (
                <p>No customer profiles match this store and search.</p>
              ) : (
                <p>No customers to display yet.</p>
              )}
              {loaded.filters.customer && <s-link href="/app/loyalty/customers">Back to customers</s-link>}
              {Number(pagination.totalPages) > 1 && <Form method="get" className="loyalty-nav" aria-label="Customer pagination">
                <input type="hidden" name="search" value={loaded.filters.search} />
                {loaded.filters.customer && <input type="hidden" name="customer" value={loaded.filters.customer} />}
                <button name="page" value={page - 1} disabled={page <= 1}>Previous</button>
                <span>Page {page} of {String(pagination.totalPages)}</span>
                <button name="page" value={page + 1} disabled={page >= Number(pagination.totalPages)}>Next</button>
              </Form>}
              <s-paragraph>
                Wallet balances belong to the brand; purchase activity on this
                page is scoped to the connected store.
              </s-paragraph>
            </s-section>
          )}
          {["overview", "reports"].includes(loaded.view) && (
            <s-section
              heading={
                loaded.view === "overview"
                  ? "Store loyalty activity"
                  : "Points and redemption performance"
              }
            >
              <Form method="get" className="loyalty-form">
                <div className="loyalty-fields">
                  <label>
                    From
                    <input type="date" name="from" />
                  </label>
                  <label>
                    To
                    <input type="date" name="to" />
                  </label>
                </div>
                <button>Update report</button>
              </Form>
              {loaded.content ? (
                <ReportSummary value={loaded.content} currency={loaded.shop.currencyCode} />
              ) : (
                <p>Connect this store to load loyalty reporting.</p>
              )}
              <s-paragraph>
                Reports show the connected store. Customers continue to use the
                shared brand wallet across channels.
              </s-paragraph>
            </s-section>
          )}
          {loaded.view === "reports" && loaded.privacyRequests.length > 0 && (
            <s-section heading="Customer data requests">
              <s-paragraph>
                Download and deliver these exports to the requesting customer
                through the brand&apos;s verified support process.
              </s-paragraph>
              <ul>
                {loaded.privacyRequests.map((item) => (
                  <li key={item.id}>
                    <s-link
                      href={
                        "/app/privacy-export/" + encodeURIComponent(item.id)
                      }
                      target="_blank"
                    >
                      Download requested data (
                      {new Date(item.requestedAt).toISOString().slice(0, 10)})
                    </s-link>
                  </li>
                ))}
              </ul>
            </s-section>
          )}
        </>
      )}
    </s-page>
  );
}
