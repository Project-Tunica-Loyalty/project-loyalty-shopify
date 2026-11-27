import { automaticDiscountTitle, LEGACY_AUTOMATIC_DISCOUNT_TITLE } from "./loyalty-discount-title.server";

type Admin = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

const amount = (value: unknown) => Number(value ?? 0);
const money = (value: { shopMoney?: { amount?: string } } | null | undefined) =>
  amount(value?.shopMoney?.amount);
const fixed = (value: number) =>
  Math.max(0, Math.round(value * 100) / 100).toFixed(2);

export async function orderSnapshot(admin: Admin, orderId: string) {
  let after: string | null = null;
  let itemTax = 0;
  const lineItems: Array<{
    id: string;
    name: string;
    variantId?: string;
    quantity: number;
    unitPrice: string;
    discountedTotal: string;
    tax: string;
  }> = [];
  let order;
  do {
    const response = await admin.graphql(
      `#graphql
    query LoyaltyOrder($id: ID!, $after: String) {
      order(id: $id) {
        id createdAt updatedAt currencyCode cancelledAt fullyPaid phone
        shippingAddress { phone }
        billingAddress { phone }
        displayFulfillmentStatus displayFinancialStatus discountCodes
        customAttributes { key value }
        discountApplications(first: 20) { nodes {
          __typename
          ... on AutomaticDiscountApplication { title }
        } }
        customer { id }
        taxesIncluded
        subtotalPriceSet { shopMoney { amount } }
        currentSubtotalPriceSet { shopMoney { amount } }
        totalTaxSet { shopMoney { amount } }
        currentTotalTaxSet { shopMoney { amount } }
        lineItems(first: 250, after: $after) { nodes {
          id name quantity variant { id }
          originalUnitPriceSet { shopMoney { amount } }
          priceAfterAllDiscountsBeforeTaxesSet { shopMoney { amount } }
          taxLines { priceSet { shopMoney { amount } } }
        } pageInfo { hasNextPage endCursor } }
        refunds { refundLineItems(first: 250) { nodes {
          quantity subtotalSet { shopMoney { amount } }
          totalTaxSet { shopMoney { amount } }
          lineItem { id quantity variant { id } }
        } pageInfo { hasNextPage } } }
      }
    }
  `,
      { variables: { id: orderId, after } },
    );
    const result = await response.json();
    if (result.errors?.length)
      throw new Error(
        result.errors
          .map((error: { message: string }) => error.message)
          .join("; "),
      );
    order = result.data?.order;
    if (!order) throw new Error("Shopify order not found");
    if (
      order.refunds?.some(
        (refund: {
          refundLineItems: { pageInfo?: { hasNextPage: boolean } };
        }) => refund.refundLineItems.pageInfo?.hasNextPage,
      )
    )
      throw new Error(
        "Refund exceeds supported line count; retry through order reconciliation after review",
      );
    itemTax += (order.lineItems?.nodes ?? []).reduce(
      (
        sum: number,
        line: {
          taxLines: Array<{ priceSet: { shopMoney: { amount: string } } }>;
        },
      ) =>
        sum +
        line.taxLines.reduce((total, tax) => total + money(tax.priceSet), 0),
      0,
    );
    for (const line of order.lineItems?.nodes ?? []) {
      lineItems.push({
        id: line.id,
        name: line.name,
        variantId: line.variant?.id,
        quantity: line.quantity,
        unitPrice: fixed(money(line.originalUnitPriceSet)),
        discountedTotal: fixed(money(line.priceAfterAllDiscountsBeforeTaxesSet)),
        tax: fixed((line.taxLines ?? []).reduce(
          (sum: number, tax: { priceSet: { shopMoney: { amount: string } } }) =>
            sum + money(tax.priceSet), 0,
        )),
      });
    }
    after = order.lineItems?.pageInfo.hasNextPage
      ? order.lineItems.pageInfo.endCursor
      : null;
  } while (after);
  const refundedTax = (order.refunds ?? []).reduce(
    (
      sum: number,
      refund: {
        refundLineItems: {
          nodes: Array<{ totalTaxSet: { shopMoney: { amount: string } } }>;
        };
      },
    ) =>
      sum +
      refund.refundLineItems.nodes.reduce(
        (total, line) => total + money(line.totalTaxSet),
        0,
      ),
    0,
  );
  const currentItemTax = Math.max(0, itemTax - refundedTax);
  const refundedLines: Array<{
    quantity: number;
    subtotalSet: { shopMoney: { amount: string } };
    lineItem?: { id: string; quantity: number; variant?: { id: string } };
  }> = (order.refunds ?? []).flatMap(
    (refund: { refundLineItems: { nodes: Array<{
      quantity: number;
      subtotalSet: { shopMoney: { amount: string } };
      lineItem?: { id: string; quantity: number; variant?: { id: string } };
    }> } }) => refund.refundLineItems.nodes,
  );
  const refundedQuantity = new Map<string, number>();
  for (const line of refundedLines) {
    if (line.lineItem?.id)
      refundedQuantity.set(line.lineItem.id,
        (refundedQuantity.get(line.lineItem.id) ?? 0) + line.quantity);
  }
  const original =
    money(order.subtotalPriceSet) - (order.taxesIncluded ? itemTax : 0);
  const current =
    money(order.currentSubtotalPriceSet) -
    (order.taxesIncluded ? currentItemTax : 0);
  const refund = Math.max(0, original - current);
  const automaticRedemptionToken = (order.customAttributes ?? []).find(
    (attribute: { key: string; value: string }) => attribute.key === "project_loyalty_redemption" &&
      /^[A-Za-z0-9_-]{16,100}$/.test(attribute.value),
  )?.value as string | undefined;
  return {
    orderId: order.id as string,
    customerId: order.customer?.id
      ? String(order.customer.id).split("/").pop()
      : undefined,
    contactPhone:
      order.phone ||
      order.shippingAddress?.phone ||
      order.billingAddress?.phone ||
      undefined,
    lineItems,
    paid:
      Boolean(order.fullyPaid) ||
      ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(
        order.displayFinancialStatus,
      ),
    fullyFulfilled: order.displayFulfillmentStatus === "FULFILLED",
    cancelled: Boolean(order.cancelledAt),
    currency: order.currencyCode as string,
    merchandiseAfterDiscounts: fixed(original),
    refundedMerchandise: fixed(refund),
    merchandiseTax: fixed(itemTax),
    refundedMerchandiseTax: fixed(refundedTax),
    refundedVariantIds: refundedLines
      .filter((line) => line.lineItem?.variant?.id && (
        money(line.subtotalSet) === 0 ||
        (refundedQuantity.get(line.lineItem.id) ?? 0) >= line.lineItem.quantity
      ))
      .map((line) => line.lineItem?.variant?.id)
      .filter((id): id is string => Boolean(id)),
    discountCodes: order.discountCodes as string[],
    automaticRedemptionToken,
    automaticDiscountApplied: Boolean(automaticRedemptionToken && (order.discountApplications?.nodes ?? []).some(
      (discount: { __typename: string; title?: string }) =>
        discount.__typename === "AutomaticDiscountApplication" &&
        (discount.title === LEGACY_AUTOMATIC_DISCOUNT_TITLE ||
          discount.title === automaticDiscountTitle(automaticRedemptionToken)),
    )),
    occurredAt: order.createdAt as string,
    sourceUpdatedAt: order.updatedAt as string,
  };
}
