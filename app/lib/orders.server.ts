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
  let order;
  do {
    const response = await admin.graphql(
      `#graphql
    query LoyaltyOrder($id: ID!, $after: String) {
      order(id: $id) {
        id createdAt updatedAt currencyCode cancelledAt fullyPaid
        displayFulfillmentStatus displayFinancialStatus discountCodes
        customer { id }
        taxesIncluded
        subtotalPriceSet { shopMoney { amount } }
        currentSubtotalPriceSet { shopMoney { amount } }
        totalTaxSet { shopMoney { amount } }
        currentTotalTaxSet { shopMoney { amount } }
        lineItems(first: 250, after: $after) { nodes { taxLines { priceSet { shopMoney { amount } } } } pageInfo { hasNextPage endCursor } }
        refunds { refundLineItems(first: 250) { nodes { totalTaxSet { shopMoney { amount } } lineItem { variant { id } } } pageInfo { hasNextPage } } }
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
  const original =
    money(order.subtotalPriceSet) - (order.taxesIncluded ? itemTax : 0);
  const current =
    money(order.currentSubtotalPriceSet) -
    (order.taxesIncluded ? currentItemTax : 0);
  const refund = Math.max(0, original - current);
  return {
    orderId: order.id as string,
    customerId: order.customer?.id
      ? String(order.customer.id).split("/").pop()
      : undefined,
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
    refundedVariantIds: (order.refunds ?? []).flatMap(
      (item: {
        refundLineItems: {
          nodes: Array<{ lineItem?: { variant?: { id: string } } }>;
        };
      }) =>
        item.refundLineItems.nodes
          .map((node) => node.lineItem?.variant?.id)
          .filter(Boolean),
    ),
    discountCodes: order.discountCodes as string[],
    occurredAt: order.createdAt as string,
    sourceUpdatedAt: order.updatedAt as string,
  };
}
