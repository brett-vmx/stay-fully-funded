// api/stripe-webhook.js — POST /webhooks/stripe: Stripe's own webhook
// delivery, not browser-called, so no CORS here (see
// stripe-billing-build-spec.md Part 6).
//
// Never trusts the event payload's subscription/invoice object — always
// re-fetches the subscription by ID and writes that. Stripe delivers events
// out of order, and upsert_subscription_from_stripe's `on conflict do
// update` would otherwise let a late, stale `customer.subscription.updated`
// overwrite a newer status. Re-fetching also collapses the
// invoice-vs-subscription shape difference into one code path.

import { getStripeClient } from '../lib/stripe.js';
import {
  upsertSubscriptionFromStripe,
  findUserIdByStripeCustomerId,
  findDiscountCode,
} from '../lib/supabase.js';
import { generateUserPromoCode } from '../lib/discountCodes.js';

const DISCOUNT_PURPOSE_COURSE = 'course_discount_for_annual_subscriber';

export async function handleStripeWebhook(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const sig = request.headers.get('stripe-signature');
  const rawBody = await request.text(); // raw string, NOT request.json() — signature verification needs the exact bytes Stripe signed

  const stripe = getStripeClient(env);

  let event;
  try {
    // constructEventAsync, not constructEvent — workerd has no synchronous
    // HMAC, only promise-based WebCrypto, and the SDK's own error message
    // for calling the sync form here says as much.
    event = await stripe.webhooks.constructEventAsync(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook: signature verification failed:', err);
    return new Response('Invalid signature', { status: 400 }); // 400 = Stripe won't retry, correctly
  }

  // Resolve the subscription ID from whichever event shape we got, then
  // ALWAYS re-fetch — never read state off event.data.object.
  let subscriptionId = null;
  if (event.type.startsWith('customer.subscription.')) {
    subscriptionId = event.data.object.id;
  } else if (event.type === 'invoice.paid') {
    // invoice.subscription doesn't exist as of 2025-03-31.basil.
    const invoice = event.data.object;
    if (invoice.parent?.type === 'subscription_details') {
      subscriptionId = invoice.parent.subscription_details.subscription;
    }
  }
  if (!subscriptionId) {
    return Response.json({ received: true }); // an event type we don't act on
  }

  const sub = await stripe.subscriptions.retrieve(subscriptionId);

  // Deleted subscriptions come back with status 'canceled' already, so
  // there's no separate branch to write for customer.subscription.deleted —
  // the re-fetch tells the truth either way.
  const item = sub.items.data[0];
  const priceId = item.price.id;
  const plan = priceId === env.STRIPE_PRICE_ANNUAL ? 'annual' : 'monthly';
  const currentPeriodEnd = new Date(item.current_period_end * 1000).toISOString(); // item-level, not sub-level (removed in basil)

  // Prefer metadata; fall back to the customer mapping for subscriptions
  // created outside Checkout (Dashboard comps, manual fixes) — see Part 5's
  // stripe_customer_id lookup/reuse.
  let userId = sub.metadata?.supabase_user_id ?? null;
  if (!userId) {
    userId = await findUserIdByStripeCustomerId(env, sub.customer);
  }
  if (!userId) {
    console.error('Stripe webhook: no user for subscription', sub.id, 'customer', sub.customer);
    return Response.json({ received: true }); // 200: retrying won't fix a subscription with no matching profile
  }

  // Stripe expresses "a cancellation is scheduled" TWO ways, and which one it
  // uses depends on the subscription's billing mode. Classic mode sets
  // `cancel_at_period_end: true`. Flexible mode — the DEFAULT for new
  // subscriptions as of 2025-09-30.clover, so ours — instead sets `cancel_at`
  // to a date and leaves `cancel_at_period_end` false when a customer cancels
  // through the Billing Portal.
  //
  // Reading only cancel_at_period_end would therefore miss most real
  // cancellations, with two consequences: the Subscription tile would never
  // show its canceling state, and worse, get_expiry_reminder_candidates'
  // `and s.cancel_at_period_end = false` clause would treat a canceling
  // subscriber as happily auto-renewing and suppress their expiry reminders
  // entirely. So this column carries "is a cancellation scheduled", from
  // either field.
  const cancellationScheduled = Boolean(sub.cancel_at_period_end || sub.cancel_at);

  await upsertSubscriptionFromStripe(env, {
    userId,
    subscriptionId: sub.id,
    priceId,
    plan,
    status: sub.status,
    currentPeriodEnd,
    cancelAtPeriodEnd: cancellationScheduled,
  });

  // Direction 2 discount trigger (Part 4) — dormant until
  // STRIPE_COUPON_COURSE_DISCOUNT is set in wrangler.toml, which happens
  // once the Course has a real Stripe coupon to discount with. The
  // unique(user_id, purpose) constraint (0013) is what makes a concurrent
  // retry here safe: a second delivery's findDiscountCode may still see no
  // row and call generateUserPromoCode again, but insertDiscountCode's
  // insert then throws on the constraint instead of duplicating — an extra,
  // harmless Stripe-side promotion code, never a second stored/redeemable one.
  if (env.STRIPE_COUPON_COURSE_DISCOUNT && plan === 'annual' && ['active', 'trialing'].includes(sub.status)) {
    const existing = await findDiscountCode(env, { userId, purpose: DISCOUNT_PURPOSE_COURSE });
    if (!existing) {
      await generateUserPromoCode(env, {
        userId,
        stripeCustomerId: sub.customer,
        couponId: env.STRIPE_COUPON_COURSE_DISCOUNT,
        purpose: DISCOUNT_PURPOSE_COURSE,
      });
      // TODO once the Course is ready to announce this: send an email
      // letting the subscriber know they have a Course discount code.
    }
  }

  return Response.json({ received: true });
}
