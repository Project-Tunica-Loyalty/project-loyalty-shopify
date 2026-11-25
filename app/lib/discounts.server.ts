import { randomBytes } from "node:crypto";

type Admin = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type DiscountInstruction = {
  redemptionId: string;
  status: string;
  code: string | null;
  discountAmount: string;
  variantId: string | null;
  expiresAt: string;
  minimumSubtotal: string;
  verifiedPhone: string;
  checkoutToken?: string | null;
  discountId?: string | null;
  customerId?: string;
};

const code = () => `PL${randomBytes(18).toString("hex").toUpperCase()}`;

async function run(
  admin: Admin,
  query: string,
  variables: Record<string, unknown>,
  field: string,
) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();
  if (json.errors?.length)
    throw new Error(
      json.errors.map((x: { message: string }) => x.message).join("; "),
    );
  const result = json.data?.[field];
  if (!result) throw new Error(`Shopify ${field} returned no result`);
  if (result.userErrors?.length)
    throw new Error(
      result.userErrors.map((x: { message: string }) => x.message).join("; "),
    );
  return result;
}

async function createDiscount(
  admin: Admin,
  customerId: string,
  instruction: DiscountInstruction,
) {
  const customerGid = customerId.startsWith("gid://")
    ? customerId
    : `gid://shopify/Customer/${customerId}`;
  const common = {
    title: `Project Loyalty ${instruction.redemptionId}`,
    code: instruction.code || code(),
    startsAt: new Date().toISOString(),
    endsAt: instruction.expiresAt,
    context: { customers: { add: [customerGid] } },
    usageLimit: 1,
    appliesOncePerCustomer: true,
    combinesWith: {
      orderDiscounts: false,
      productDiscounts: false,
      shippingDiscounts: false,
    },
  };
  const configuration = JSON.stringify({
    kind: instruction.variantId ? "PRODUCT" : "ORDER",
    customerId: customerGid,
    verifiedPhone: instruction.verifiedPhone,
    variantId: instruction.variantId,
    amount: instruction.discountAmount,
    minimumSubtotal: instruction.minimumSubtotal,
  });
  {
    const result = await run(
      admin,
      `#graphql
      mutation LoyaltyProductDiscount($input: DiscountCodeAppInput!) {
        discountCodeAppCreate(codeAppDiscount: $input) {
          codeAppDiscount { discountId }
          userErrors { message field }
        }
      }`,
      {
        input: {
          ...common,
          functionHandle: "loyalty-discount",
          discountClasses: [instruction.variantId ? "PRODUCT" : "ORDER"],
          metafields: [
            {
              namespace: "loyalty_discount",
              key: "configuration",
              type: "json",
              value: configuration,
            },
          ],
        },
      },
      "discountCodeAppCreate",
    );
    return {
      code: common.code,
      discountId: result.codeAppDiscount.discountId as string,
    };
  }
}

export async function deactivateDiscount(admin: Admin, id: string) {
  if (id.includes("DiscountAutomaticNode")) {
    await run(admin, `#graphql
      mutation LoyaltyAutomaticDeactivate($id: ID!) {
        discountAutomaticDeactivate(id: $id) { automaticDiscountNode { id } userErrors { message field } }
      }`, { id }, "discountAutomaticDeactivate");
    return;
  }
  await run(
    admin,
    `#graphql
    mutation LoyaltyDeactivate($id: ID!) {
      discountCodeDeactivate(id: $id) { codeDiscountNode { id } userErrors { message field } }
    }`,
    { id },
    "discountCodeDeactivate",
  );
}

export async function deleteDiscount(admin: Admin, id: string) {
  if (!/^gid:\/\/shopify\/Discount(?:Automatic|Code)Node\/\d+$/.test(id))
    throw new Error("Invalid loyalty discount ID");
  const lookup = await admin.graphql(`#graphql
    query LoyaltyDiscountExistence($id: ID!) { discountNode(id: $id) { id } }
  `, { variables: { id } });
  const existing = await lookup.json();
  if (existing.errors?.length) throw new Error("Could not verify the loyalty discount");
  if (!existing.data?.discountNode) return;
  if (id.startsWith("gid://shopify/DiscountAutomaticNode/")) {
    const deleted = await run(admin, `#graphql
      mutation LoyaltyAutomaticDelete($id: ID!) {
        discountAutomaticDelete(id: $id) { deletedAutomaticDiscountId userErrors { message field } }
      }`, { id }, "discountAutomaticDelete");
    if (deleted.deletedAutomaticDiscountId !== id)
      throw new Error("Shopify did not delete the loyalty discount");
    return;
  }
  const deleted = await run(admin, `#graphql
    mutation LoyaltyCodeDelete($id: ID!) {
      discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { message field } }
    }`, { id }, "discountCodeDelete");
  if (deleted.deletedCodeDiscountId !== id)
    throw new Error("Shopify did not delete the loyalty code");
}

async function findAutomaticDiscountDetails(admin: Admin, instruction: Pick<DiscountInstruction, "checkoutToken" | "customerId"> & { redemptionId?: string }) {
  let after: string | null = null;
  do {
    const response = await admin.graphql(`#graphql
      query LoyaltyAutomaticRecovery($query: String!, $after: String) {
        discountNodes(first: 100, after: $after, query: $query) {
          nodes { id metafield(namespace: "loyalty_discount", key: "configuration") { value }
            discount { ... on DiscountAutomaticApp { title } } }
          pageInfo { hasNextPage endCursor }
        }
      }`, { variables: { query: `title:'Project Loyalty points'`, after } });
    const result = await response.json();
    if (result.errors?.length) throw new Error("Could not verify automatic discount issuance");
    const connection = result.data?.discountNodes;
    for (const node of connection?.nodes ?? []) {
      if (node.discount?.title !== "Project Loyalty points") continue;
      try {
        const configuration = JSON.parse(node.metafield?.value ?? "{}");
        if (configuration.checkoutToken === instruction.checkoutToken &&
          (!instruction.redemptionId || configuration.redemptionId === instruction.redemptionId) &&
          (!instruction.customerId || configuration.customerId === instruction.customerId) &&
          /^[0-9a-f-]{36}$/i.test(configuration.redemptionId))
          return { id: node.id as string, redemptionId: configuration.redemptionId as string };
      } catch { /* Ignore unrelated discounts. */ }
    }
    after = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return null;
}

export async function findAutomaticDiscount(admin: Admin, instruction: DiscountInstruction) {
  return (await findAutomaticDiscountDetails(admin, instruction))?.id ?? null;
}

export async function findAutomaticDiscountForRelease(admin: Admin, checkoutToken: string, customerId: string) {
  return findAutomaticDiscountDetails(admin, { checkoutToken, customerId });
}

export async function issueAutomaticDiscount(admin: Admin, customerId: string, instruction: DiscountInstruction) {
  if (!instruction.checkoutToken || !/^[A-Za-z0-9_-]{16,100}$/.test(instruction.checkoutToken))
    throw new Error("The automatic reservation has no checkout token");
  if (!/^\+\d{8,15}$/.test(instruction.verifiedPhone))
    throw new Error("The reward reservation has no verified phone");
  if (instruction.status === "ACTIVE" && instruction.discountId)
    return { discountId: instruction.discountId };
  const existing = await findAutomaticDiscount(admin, instruction);
  if (existing) return { discountId: existing };
  const customerGid = customerId.startsWith("gid://") ? customerId : `gid://shopify/Customer/${customerId}`;
  const configuration = JSON.stringify({
    kind: instruction.variantId ? "PRODUCT" : "ORDER",
    customerId: customerGid,
    verifiedPhone: instruction.verifiedPhone,
    variantId: instruction.variantId,
    amount: instruction.discountAmount,
    minimumSubtotal: instruction.minimumSubtotal,
    checkoutToken: instruction.checkoutToken,
    redemptionId: instruction.redemptionId,
  });
  try {
    const created = await run(admin, `#graphql
      mutation LoyaltyAutomaticDiscount($input: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $input) {
          automaticAppDiscount { discountId }
          userErrors { message field }
        }
      }`, { input: {
        title: "Project Loyalty points",
        startsAt: new Date().toISOString(),
        endsAt: instruction.expiresAt,
        context: { customers: { add: [customerGid] } },
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
        functionHandle: "loyalty-discount",
        discountClasses: [instruction.variantId ? "PRODUCT" : "ORDER"],
        metafields: [{ namespace: "loyalty_discount", key: "configuration", type: "json", value: configuration }],
      } }, "discountAutomaticAppCreate");
    return { discountId: created.automaticAppDiscount.discountId as string };
  } catch (error) {
    const recovered = await findAutomaticDiscount(admin, instruction);
    if (recovered) return { discountId: recovered };
    throw error;
  }
}

export async function issueDiscount(
  admin: Admin,
  customerId: string,
  instruction: DiscountInstruction,
) {
  if (!instruction.code)
    throw new Error(
      "The reward reservation has no recovery code; retry after it expires",
    );
  if (!/^\+\d{8,15}$/.test(instruction.verifiedPhone))
    throw new Error("The reward reservation has no verified phone");
  if (
    !instruction.variantId &&
    (!Number.isFinite(Number(instruction.minimumSubtotal)) ||
      Number(instruction.minimumSubtotal) <= 0)
  )
    throw new Error("The reward reservation has no valid checkout limit");
  const recover = async () => {
    const response = await admin.graphql(
      `#graphql
      query LoyaltyDiscountRecovery($code: String!) {
        codeDiscountNodeByCode(code: $code) { id codeDiscount { ... on DiscountCodeBasic { title } ... on DiscountCodeApp { title } } }
      }
    `,
      { variables: { code: instruction.code } },
    );
    const result = await response.json();
    if (result.errors?.length)
      throw new Error("Could not verify reward code issuance");
    const existing = result.data?.codeDiscountNodeByCode;
    if (!existing) return null;
    if (
      existing.codeDiscount?.title !==
      "Project Loyalty " + instruction.redemptionId
    )
      throw new Error("Reward code is already assigned to another redemption");
    return { code: instruction.code!, discountId: existing.id as string };
  };
  const existing = await recover();
  if (existing) return existing;
  if (instruction.status === "ACTIVE")
    throw new Error("The active loyalty coupon could not be found in Shopify");
  try {
    return await createDiscount(admin, customerId, instruction);
  } catch (error) {
    const recovered = await recover();
    if (recovered) return recovered;
    throw error;
  }
}

export async function issueBasicDiscount(
  admin: Admin,
  customerId: string,
  instruction: DiscountInstruction,
) {
  if (!instruction.code || !/^[A-Za-z0-9_-]{8,100}$/.test(instruction.code))
    throw new Error("The reward reservation has no recovery code");
  const amount = Number(instruction.discountAmount);
  const minimum = Number(instruction.minimumSubtotal);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(minimum) || minimum < amount)
    throw new Error("The reward reservation has no valid checkout limit");
  const recover = async () => {
    const response = await admin.graphql(`#graphql
      query LoyaltyBasicDiscountRecovery($code: String!) {
        codeDiscountNodeByCode(code: $code) {
          id
          codeDiscount { ... on DiscountCodeBasic { title } }
        }
      }`, { variables: { code: instruction.code } });
    const result = await response.json();
    if (result.errors?.length) throw new Error("Could not verify reward code issuance");
    const existing = result.data?.codeDiscountNodeByCode;
    if (!existing) return null;
    if (existing.codeDiscount?.title !== `Project Loyalty ${instruction.redemptionId}`)
      throw new Error("Reward code is already assigned to another redemption");
    return { code: instruction.code!, discountId: existing.id as string };
  };
  const existing = await recover();
  if (existing) return existing;
  const customerGid = customerId.startsWith("gid://") ? customerId : `gid://shopify/Customer/${customerId}`;
  try {
    const created = await run(admin, `#graphql
      mutation LoyaltyBasicDiscount($input: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $input) {
          codeDiscountNode { id }
          userErrors { message field }
        }
      }`, { input: {
        title: `Project Loyalty ${instruction.redemptionId}`,
        code: instruction.code,
        startsAt: new Date().toISOString(),
        endsAt: instruction.expiresAt,
        context: { customers: { add: [customerGid] } },
        usageLimit: 1,
        appliesOncePerCustomer: true,
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
        customerGets: {
          value: { discountAmount: { amount: instruction.discountAmount, appliesOnEachItem: false } },
          items: { all: true },
        },
        minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: instruction.minimumSubtotal } },
      } }, "discountCodeBasicCreate");
    return { code: instruction.code, discountId: created.codeDiscountNode.id as string };
  } catch (error) {
    const recovered = await recover();
    if (recovered) return recovered;
    throw error;
  }
}
