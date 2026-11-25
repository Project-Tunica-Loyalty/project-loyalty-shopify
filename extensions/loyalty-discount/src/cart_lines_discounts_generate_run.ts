import {
  DiscountClass,
  OrderDiscountSelectionStrategy,
  ProductDiscountSelectionStrategy,
} from "../generated/api";
import type {
  CartInput,
  CartLinesDiscountsGenerateRunResult,
} from "../generated/api";

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  const empty = { operations: [] };
  let config: {
    kind: "ORDER" | "PRODUCT";
    customerId: string;
    verifiedPhone: string;
    variantId?: string;
    amount?: string;
    minimumSubtotal?: string;
  };
  try {
    config = JSON.parse(input.discount.metafield?.value ?? "");
  } catch {
    return empty;
  }
  const buyer = input.cart.buyerIdentity;
  const phone = (value: string | null | undefined) =>
    value?.startsWith("+") ? value.replace(/\D/g, "") : null;
  const verifiedPhone = phone(config.verifiedPhone);
  const checkoutPhones = [
    buyer?.phone,
    ...input.cart.deliveryGroups.map((group) => group.deliveryAddress?.phone),
    input.cart.billingAddress?.phone,
  ];
  if (
    !buyer?.isAuthenticated ||
    !buyer.customer?.id ||
    buyer.customer.id !== config.customerId ||
    !verifiedPhone ||
    !checkoutPhones.some((checkoutPhone) => phone(checkoutPhone) === verifiedPhone)
  ) return empty;

  if (config.kind === "ORDER") {
    if (!input.discount.discountClasses.includes(DiscountClass.Order)) return empty;
    const amount = Number(config.amount);
    const minimum = Number(config.minimumSubtotal);
    const subtotal = Number(input.cart.cost.subtotalAmount.amount);
    if (!Number.isFinite(amount) || amount <= 0 ||
        !Number.isFinite(minimum) || minimum <= 0 ||
        !Number.isFinite(subtotal) || subtotal < minimum || subtotal < amount)
      return empty;
    return { operations: [{ orderDiscountsAdd: {
      selectionStrategy: OrderDiscountSelectionStrategy.First,
      candidates: [{
        targets: [{ orderSubtotal: { excludedCartLineIds: [] } }],
        message: "Project Loyalty points",
        value: { fixedAmount: { amount: amount.toFixed(2) } },
      }],
    } }] };
  }
  if (config.kind !== "PRODUCT" ||
      !input.discount.discountClasses.includes(DiscountClass.Product) ||
      !config.variantId) return empty;

  const line = input.cart.lines.find(
    ({ merchandise }) =>
      merchandise.__typename === "ProductVariant" &&
      merchandise.id === config.variantId,
  );
  if (!line) return empty;

  return {
    operations: [
      {
        productDiscountsAdd: {
          selectionStrategy: ProductDiscountSelectionStrategy.First,
          candidates: [
            {
              targets: [{ cartLine: { id: line.id, quantity: 1 } }],
              message: "Project Loyalty product reward",
              value: { percentage: { value: "100.0" } },
            },
          ],
        },
      },
    ],
  };
}
