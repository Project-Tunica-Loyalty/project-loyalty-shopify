import '@shopify/ui-extensions/preact';
import {useBillingAddress, useCustomer, usePhone, useShippingAddress} from '@shopify/ui-extensions/checkout/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';
import {LoyaltyAccess} from './LoyaltyAccess.jsx';

const API = 'https://shopify.reglrs.ai/checkout/loyalty';

export default function extension() {
  render(<LoyaltyCheckout />, document.body);
}

function LoyaltyCheckout() {
  const customer = useCustomer();
  const customerId = customer?.id;
  const checkoutPhone = usePhone() || useShippingAddress()?.phone || useBillingAddress()?.phone;
  const [data, setData] = useState(null);
  const [points, setPoints] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [activeCode, setActiveCode] = useState('');
  const [refreshIndex, setRefreshIndex] = useState(0);
  const canApply = shopify.instructions.value.discounts.canUpdateDiscountCodes;
  const cartLines = shopify.lines.value;

  useEffect(() => {
    if (!customerId) {
      setData(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const token = await shopify.sessionToken.get();
        const response = await fetch(API, {headers: {Authorization: `Bearer ${token}`}});
        const body = await response.json();
        if (alive) setData(response.ok ? body : {error: body.error});
      } catch {
        if (alive) setData({error: 'Could not load loyalty points.'});
      }
    })();
    return () => { alive = false; };
  }, [customerId, refreshIndex]);

  if (!customer) return <s-banner tone="info">Log in to your Shopify customer account at the top of checkout to use loyalty points.</s-banner>;
  if (!data) return <s-skeleton-paragraph />;
  if (data.error) return <s-banner tone="warning">{data.error}</s-banner>;
  if (!data.linked) return <LoyaltyAccess onLinked={() => setRefreshIndex((value) => value + 1)} />;

  const available = Number(data.balance?.currentPoints ?? 0);
  const rewards = (data.rewards?.products ?? []).filter((reward) =>
    cartLines.some((line) => line.merchandise?.id === reward.variantId));
  const canRedeem = data.compatible && canApply && checkoutPhone &&
    data.balance?.hasVerifiedPhone && !activeCode && shopify.discountCodes.value.length === 0;

  async function apply(kind, rewardProductId) {
    setBusy(true);
    setMessage('');
    let issued = null;
    try {
      const token = await shopify.sessionToken.get();
      const response = await fetch(API, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
        body: JSON.stringify({
          kind, rewardProductId, checkoutPhone,
          points: Number(points),
          cartSubtotal: Number(shopify.cost.subtotalAmount.value.amount),
          idempotencyKey: crypto.randomUUID().replace(/-/g, ''),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not reserve points.');
      issued = result;
      const change = await shopify.applyDiscountCodeChange({type: 'addDiscountCode', code: result.code});
      if (change.type !== 'success') throw new Error('The discount could not be applied. Try again before placing the order.');
      setActiveCode(result.code);
      setMessage('Points applied to this checkout. They will be deducted when you place the order.');
    } catch (error) {
      if (issued?.redemptionId && issued?.code) {
        try {
          const token = await shopify.sessionToken.get();
          await fetch(API, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
            body: JSON.stringify({action: 'RELEASE', redemptionId: issued.redemptionId, code: issued.code}),
          });
        } catch { /* The reservation expires automatically. */ }
      }
      setMessage(error.message || 'Could not apply points.');
    } finally {
      setBusy(false);
    }
  }

  return <s-section heading="Project Loyalty points">
    <s-stack gap="base">
      <s-text>{available} points available</s-text>
      {!data.compatible && <s-banner tone="warning">Points redemption requires a Plus checkout.</s-banner>}
      {!checkoutPhone && <s-banner tone="info">Add your linked phone to the checkout contact or delivery address to use points.</s-banner>}
      {!canApply && <s-banner tone="warning">This checkout does not allow discount changes, so points cannot be applied here.</s-banner>}
      {shopify.discountCodes.value.length > 0 && <s-banner tone="info">Remove the existing discount code before applying loyalty points.</s-banner>}
      {data.rewards?.redemptionType === 'PARTIAL' && <s-stack gap="base">
        <s-number-field label="Points to apply" value={points} min={1} max={available}
          onChange={(event) => setPoints(String('value' in event.currentTarget ? event.currentTarget.value : ''))} />
        <s-button disabled={!canRedeem || busy || Number(points) <= 0 || Number(points) > available}
          onClick={() => apply('ORDER')}>Apply Points</s-button>
      </s-stack>}
      {rewards.map((reward) => <s-button key={reward.id}
        disabled={!canRedeem || busy || Number(reward.pointsCost) > available}
        onClick={() => apply('PRODUCT', reward.id)}>
        Redeem {reward.title} for {reward.pointsCost} points
      </s-button>)}
      {message && <s-banner tone={activeCode ? 'success' : 'warning'}>{message}</s-banner>}
    </s-stack>
  </s-section>;
}
