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
  if (instruction.status === "ACTIVE" && instruction.code)
    return { code: instruction.code, discountId: "" };
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
  if (instruction.variantId) {
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
          discountClasses: ["PRODUCT"],
          metafields: [
            {
              namespace: "loyalty_discount",
              key: "configuration",
              type: "single_line_text_field",
              value: instruction.variantId,
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
  const result = await run(
    admin,
    `#graphql
    mutation LoyaltyOrderDiscount($input: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $input) {
        codeDiscountNode { id }
        userErrors { message field }
      }
    }`,
    {
      input: {
        ...common,
        minimumRequirement: {
          subtotal: {
            greaterThanOrEqualToSubtotal: instruction.minimumSubtotal,
          },
        },
        customerGets: {
          value: {
            discountAmount: {
              amount: instruction.discountAmount,
              appliesOnEachItem: false,
            },
          },
          items: { all: true },
        },
      },
    },
    "discountCodeBasicCreate",
  );
  return {
    code: common.code,
    discountId: result.codeDiscountNode.id as string,
  };
}

export async function deactivateDiscount(admin: Admin, id: string) {
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

export async function issueDiscount(
  admin: Admin,
  customerId: string,
  instruction: DiscountInstruction,
) {
  if (!instruction.code)
    throw new Error(
      "The reward reservation has no recovery code; retry after it expires",
    );
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
  try {
    return await createDiscount(admin, customerId, instruction);
  } catch (error) {
    const recovered = await recover();
    if (recovered) return recovered;
    throw error;
  }
}
