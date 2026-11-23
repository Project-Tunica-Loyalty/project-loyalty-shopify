import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
} from "../generated/api";
import type {
  CartInput,
  CartLinesDiscountsGenerateRunResult,
} from "../generated/api";

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  if (!input.discount.discountClasses.includes(DiscountClass.Product)) {
    return { operations: [] };
  }

  const variantId = input.discount.metafield?.value;
  if (!variantId) {
    return { operations: [] };
  }

  const line = input.cart.lines.find(
    ({ merchandise }) =>
      merchandise.__typename === "ProductVariant" &&
      merchandise.id === variantId,
  );
  if (!line) {
    return { operations: [] };
  }

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
