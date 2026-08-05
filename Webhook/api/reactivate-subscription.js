// api/reactivate-subscription.js — POST /api/reactivate-subscription
// { plan: "monthly" | "annual" }
//
// Clears a scheduled cancellation on the caller's own subscription, optionally
// switching plan at the same time. This exists INSTEAD of sending a canceling
// subscriber back through Checkout: their subscription is still `active` (just
// scheduled to end), and mode:'subscription' Checkout does not look at existing
// subscriptions — it would create a SECOND concurrent one and bill them twice.
// Stripe's only guard against that is an opt-in Dashboard setting, not an API
// parameter, so the safe path is to update the existing subscription in place.
//
// The subscription ID is always derived server-side from the caller's own
// stripe_customer_id. It is never accepted from the request body: taking an ID
// from the client here would let anyone cancel or re-plan someone else's
// subscription.

import { getUserClient } from '../lib/supabase.js';
import { getStripeClient } from '../lib/stripe.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function handleReactivateSubscription(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: CORS_HEADERS });
  }

  try {
    const authHeader = request.headers.get('Authorization') || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!accessToken) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS_HEADERS });
    }

    let plan;
    try {
      ({ plan } = await request.json());
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: CORS_HEADERS });
    }
    if (plan !== 'monthly' && plan !== 'annual') {
      return Response.json(
        { error: 'plan must be "monthly" or "annual"' },
        { status: 400, headers: CORS_HEADERS },
      );
    }
    const targetPriceId = plan === 'annual' ? env.STRIPE_PRICE_ANNUAL : env.STRIPE_PRICE_MONTHLY;

    // RLS scopes this to the caller's own row, which also validates the JWT.
    const supabase = getUserClient(env, accessToken);
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .maybeSingle();

    if (error) {
      console.error('reactivate: profile lookup failed:', error);
      return Response.json({ error: 'Lookup failed' }, { status: 500, headers: CORS_HEADERS });
    }
    if (!profile) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS_HEADERS });
    }
    if (!profile.stripe_customer_id) {
      return Response.json(
        { error: 'No billing account to reactivate.' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    const stripe = getStripeClient(env);

    // Re-fetch live from Stripe rather than trusting our own `subscriptions`
    // mirror, same reasoning as the webhook: the mirror can lag, and acting on
    // stale state here would mean a wrong charge.
    const { data: subs } = await stripe.subscriptions.list({
      customer: profile.stripe_customer_id,
      status: 'all',
      limit: 20,
    });

    const target = subs.find(
      (s) =>
        (s.status === 'active' || s.status === 'trialing') &&
        Boolean(s.cancel_at_period_end || s.cancel_at),
    );

    if (!target) {
      // Either nothing is scheduled to cancel (nothing to do), or the
      // subscription already lapsed to `canceled` — and a canceled
      // subscription can't be updated back to life, so that genuinely does
      // need a fresh Checkout Session. Distinguish the two so the UI can send
      // them to the right place.
      const alreadyLive = subs.some(
        (s) =>
          (s.status === 'active' || s.status === 'trialing') &&
          !s.cancel_at_period_end &&
          !s.cancel_at,
      );
      if (alreadyLive) {
        return Response.json(
          { error: 'Your subscription is already set to renew.', code: 'already_active' },
          { status: 409, headers: CORS_HEADERS },
        );
      }
      return Response.json(
        {
          error: 'This subscription has already ended. Start a new one to get access again.',
          code: 'needs_checkout',
        },
        { status: 409, headers: CORS_HEADERS },
      );
    }

    const currentItem = target.items.data[0];
    const switchingPlan = currentItem.price.id !== targetPriceId;

    // Clear whichever cancellation field is actually set. Classic-billing-mode
    // subscriptions use cancel_at_period_end; flexible mode (the default for
    // new subscriptions since 2025-09-30.clover) records a portal
    // cancellation in cancel_at instead. Stripe rejects a request that sets
    // BOTH in the same call ("Received both cancel_at_period_end and
    // cancel_at parameters") even when one of them is just being cleared, so
    // exactly one goes in `params` — never both.
    const params = target.cancel_at ? { cancel_at: '' } : { cancel_at_period_end: false };

    if (switchingPlan) {
      // The existing item's id MUST be passed. Omitting it ADDS a second item
      // instead of replacing, which would bill them monthly AND annually on
      // one subscription. Quantity has to be re-sent too, or it silently
      // resets to 1.
      params.items = [
        { id: currentItem.id, price: targetPriceId, quantity: currentItem.quantity ?? 1 },
      ];
      // Switching between different intervals resets the billing anchor and
      // charges the new plan now. always_invoice credits their unused time
      // against that charge and collects it immediately, so the money and the
      // access agree. create_prorations would leave the credit dangling.
      params.proration_behavior = 'always_invoice';
    }

    const updated = await stripe.subscriptions.update(target.id, params);

    // Our `subscriptions` row syncs from the customer.subscription.updated
    // webhook this triggers; no direct write here, so there's exactly one
    // writer for that table.
    return Response.json(
      { ok: true, plan, switched: switchingPlan, status: updated.status },
      { status: 200, headers: CORS_HEADERS },
    );
  } catch (err) {
    console.error('reactivate error:', err);
    return Response.json(
      { error: 'Internal error reactivating the subscription' },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
