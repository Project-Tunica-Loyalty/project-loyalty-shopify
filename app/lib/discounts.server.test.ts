import { describe, expect, it, vi } from "vitest";
import { issueAutomaticDiscount, issueBasicDiscount, issueDiscount } from "./discounts.server";
const instruction = {
  redemptionId: "redemption-1",
  status: "PENDING",
  code: "PLSINGLEUSE",
  discountAmount: "25.00",
  minimumSubtotal: "100.00",
  verifiedPhone: "+15551234567",
  variantId: null,
  expiresAt: "2030-01-01T00:00:00.000Z",
};
describe("Shopify discount issuance", () => {
  it("creates a customer-restricted automatic points discount without a coupon", async () => {
    const graphql = vi.fn()
      .mockResolvedValueOnce(Response.json({data: {discountNodes: {nodes: [], pageInfo: {hasNextPage: false}}}}))
      .mockResolvedValueOnce(Response.json({data: {discountAutomaticAppCreate: {
        automaticAppDiscount: {discountId: "gid://shopify/DiscountAutomaticNode/1"}, userErrors: [],
      }}}));
    await expect(issueAutomaticDiscount({graphql}, "123", {
      ...instruction, code: null, checkoutToken: "token-1234567890123456",
    })).resolves.toEqual({discountId: "gid://shopify/DiscountAutomaticNode/1"});
    const input = graphql.mock.calls[1][1].variables.input;
    expect(input.code).toBeUndefined();
    expect(input.context.customers.add).toEqual(["gid://shopify/Customer/123"]);
    expect(JSON.parse(input.metafields[0].value)).toMatchObject({
      checkoutToken: "token-1234567890123456", redemptionId: "redemption-1",
    });
  });
  it("creates a one-use customer-restricted native cart discount", async () => {
    const graphql = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { codeDiscountNodeByCode: null } }))
      .mockResolvedValueOnce(Response.json({ data: { discountCodeBasicCreate: {
        codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/1" }, userErrors: [],
      } } }));
    await expect(issueBasicDiscount({ graphql }, "123", instruction)).resolves.toMatchObject({
      code: "PLSINGLEUSE", discountId: "gid://shopify/DiscountCodeNode/1",
    });
    const input = graphql.mock.calls[1][1].variables.input;
    expect(input.context.customers.add).toEqual(["gid://shopify/Customer/123"]);
    expect(input.usageLimit).toBe(1);
    expect(input.customerGets.value.discountAmount).toEqual({ amount: "25.00", appliesOnEachItem: false });
    expect(input.minimumRequirement.subtotal.greaterThanOrEqualToSubtotal).toBe("100.00");
  });
  it("enforces the backend's bill cap at Shopify checkout", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ data: { codeDiscountNodeByCode: null } }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            discountCodeAppCreate: {
              codeAppDiscount: { discountId: "discount-1" },
              userErrors: [],
            },
          },
        }),
      );
    await issueDiscount({ graphql }, "123", instruction);
    const input = graphql.mock.calls[1][1].variables.input;
    expect(input.code).toBe("PLSINGLEUSE");
    expect(input.discountClasses).toEqual(["ORDER"]);
    expect(JSON.parse(input.metafields[0].value)).toMatchObject({
      kind: "ORDER", amount: "25.00", minimumSubtotal: "100.00",
      verifiedPhone: "+15551234567", customerId: "gid://shopify/Customer/123",
    });
    expect(input.usageLimit).toBe(1);
    expect(input.context.customers.add).toEqual(["gid://shopify/Customer/123"]);
    expect(input.combinesWith).toEqual({
      orderDiscounts: false,
      productDiscounts: false,
      shippingDiscounts: false,
    });
  });
  it("recovers an issued code on retry instead of creating another benefit", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(
        Response.json({
          data: {
            codeDiscountNodeByCode: {
              id: "discount-1",
              codeDiscount: { title: "Project Loyalty redemption-1" },
            },
          },
        }),
      );
    await expect(
      issueDiscount({ graphql }, "123", instruction),
    ).resolves.toEqual({ code: "PLSINGLEUSE", discountId: "discount-1" });
    expect(graphql).toHaveBeenCalledTimes(1);
  });
  it("recovers a create request whose response was lost", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ data: { codeDiscountNodeByCode: null } }),
      )
      .mockRejectedValueOnce(new Error("Connection reset"))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            codeDiscountNodeByCode: {
              id: "discount-1",
              codeDiscount: { title: "Project Loyalty redemption-1" },
            },
          },
        }),
      );
    await expect(
      issueDiscount({ graphql }, "123", instruction),
    ).resolves.toMatchObject({ discountId: "discount-1" });
  });
  it("refuses monetary rewards without a backend-provided checkout constraint", async () => {
    await expect(
      issueDiscount({ graphql: vi.fn() }, "123", {
        ...instruction,
        minimumSubtotal: "0",
      }),
    ).rejects.toThrow("checkout limit");
  });
});
