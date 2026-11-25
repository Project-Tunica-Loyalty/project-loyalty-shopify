import { describe, expect, it, vi } from "vitest";
import { orderSnapshot } from "./orders.server";

function order(taxesIncluded = true) {
  const money = (amount: string) => ({ shopMoney: { amount } });
  return {
    id: "gid://shopify/Order/1",
    customer: { id: "gid://shopify/Customer/2" },
    fullyPaid: true,
    displayFinancialStatus: "PARTIALLY_REFUNDED",
    displayFulfillmentStatus: "FULFILLED",
    taxesIncluded,
    subtotalPriceSet: money(taxesIncluded ? "118" : "100"),
    currentSubtotalPriceSet: money(taxesIncluded ? "59" : "50"),
    totalTaxSet: money("25"),
    currentTotalTaxSet: money("12.5"),
    currencyCode: "INR",
    discountCodes: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-02T00:00:00Z",
    lineItems: {
      nodes: [{ taxLines: [{ priceSet: money("18") }] }],
      pageInfo: { hasNextPage: false },
    },
    refunds: [
      {
        refundLineItems: {
          nodes: [
            {
              totalTaxSet: money("9"),
              lineItem: { variant: { id: "variant" } },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    ],
  };
}

describe("Shopify order earning snapshot", () => {
  it("reports an automatic redemption only when Shopify applied the loyalty discount", async () => {
    const withDiscount = {
      ...order(),
      customAttributes: [{key: "project_loyalty_redemption", value: "token-1234567890123456"}],
      discountApplications: {nodes: [{__typename: "AutomaticDiscountApplication", title: "Project Loyalty points"}]},
    };
    const graphql = vi.fn().mockImplementation(async () => Response.json({data: {order: withDiscount}}));
    await expect(orderSnapshot({graphql}, "1")).resolves.toMatchObject({
      automaticRedemptionToken: "token-1234567890123456", automaticDiscountApplied: true,
    });
    withDiscount.discountApplications.nodes[0].title = "Another discount";
    await expect(orderSnapshot({graphql}, "1")).resolves.toMatchObject({
      automaticDiscountApplied: false,
    });
  });
  it("uses the shipping phone when Shopify leaves the order phone empty", async () => {
    const withAddressPhone = {
      ...order(),
      phone: null,
      shippingAddress: { phone: "+15551234567" },
      billingAddress: { phone: "+15557654321" },
    };
    const graphql = vi.fn().mockResolvedValue(
      Response.json({ data: { order: withAddressPhone } }),
    );
    await expect(orderSnapshot({ graphql }, "1")).resolves.toMatchObject({
      contactPhone: "+15551234567",
    });
  });

  it.each([true, false])(
    "separates merchandise tax from shipping tax (included=%s)",
    async (taxesIncluded) => {
      const graphql = vi
        .fn()
        .mockResolvedValue(
          Response.json({ data: { order: order(taxesIncluded) } }),
        );
      await expect(orderSnapshot({ graphql }, "1")).resolves.toMatchObject({
        merchandiseAfterDiscounts: "100.00",
        refundedMerchandise: "50.00",
        merchandiseTax: "18.00",
        refundedMerchandiseTax: "9.00",
        customerId: "2",
        sourceUpdatedAt: "2026-11-02T00:00:00Z",
      });
    },
  );

  it("includes every merchandise page", async () => {
    const first = order();
    first.lineItems.pageInfo = {
      hasNextPage: true,
      endCursor: "next",
    } as never;
    const second = order();
    second.lineItems.nodes = [];
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: { order: first } }))
      .mockResolvedValueOnce(Response.json({ data: { order: second } }));
    expect((await orderSnapshot({ graphql }, "1")).merchandiseTax).toBe(
      "18.00",
    );
    expect(graphql.mock.calls[1][1].variables.after).toBe("next");
  });
});
