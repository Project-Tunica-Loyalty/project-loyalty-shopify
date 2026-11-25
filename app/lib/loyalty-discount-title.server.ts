import { createHash } from "node:crypto";

export const LEGACY_AUTOMATIC_DISCOUNT_TITLE = "Project Loyalty points";

export function automaticDiscountTitle(checkoutToken: string) {
  const suffix = createHash("sha256").update(checkoutToken).digest("hex").slice(0, 16).toUpperCase();
  return `${LEGACY_AUTOMATIC_DISCOUNT_TITLE} ${suffix}`;
}
