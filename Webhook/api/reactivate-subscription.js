// api/reactivate-subscription.js — POST /api/reactivate-subscription
// No request body.
//
// Clears a scheduled cancellation on the caller's own active/trialing
// subscription, leaving its plan and price untouched. This exists INSTEAD of
// sending the caller back through Checkout: their subscription is still
// `active` (whether or not it's also scheduled to end), and
// mode:'subscription' Checkout does not look at existing subscriptions — it
// would create a SECOND concurrent one and bill them twice. Stripe's only
// guard against that is an opt-in Dashboard setting, not an API parameter, so
// the safe path is to update the existing subscription in place.
//
// This used to also switch plans (monthly <-> annual). That's gone with the
// monthly plan: there is only one price to be on, so the only thing left to
// undo is the cancellation. Deliberately NOT re-pointing a legacy monthly
// subscription at the annual price here — that would reset the billing anchor
// and immediately invoice them (proration_behavior: 'always_invoice') for a
// switch they never asked for, just because they clicked "Don't cancel".
//
// The subscription ID is always derived server-side from the caller's own
// stripe_customer_id. It is never accepted from the request body: taking an ID
// from the client here would let anyone cancel someone else's subscription.

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

    const target = subs.find((s) => s.status === 'active' || s.status === 'trialing');

    if (!target) {
      // Nothing active at all — the subscription already lapsed to
      // `canceled`, and a canceled subscription can't be updated back to
      // life, so that genuinely does need a fresh Checkout Session.
      return Response.json(
        {
          error: 'This subscription has already ended. Start a new one to get access again.',
          code: 'needs_checkout',
        },
        { status: 409, headers: CORS_HEADERS },
      );
    }

    const isCanceling = Boolean(target.cancel_at_period_end || target.cancel_at);

    if (!isCanceling) {
      // Not scheduled to end — nothing to undo.
      return Response.json(
        { error: 'Your subscription is already set to renew.', code: 'already_active' },
        { status: 409, headers: CORS_HEADERS },
      );
    }

    // Clear whichever cancellation field is actually set. Classic-billing-mode
    // subscriptions use cancel_at_period_end; flexible mode (the default for
    // new subscriptions since 2025-09-30.clover) records a portal cancellation
    // in cancel_at instead. Stripe rejects a request that sets BOTH in the same
    // call ("Received both cancel_at_period_end and cancel_at parameters") even
    // when one of them is just being cleared, so exactly one goes in `params` —
    // never both.
    const params = target.cancel_at ? { cancel_at: '' } : { cancel_at_period_end: false };

    const updated = await stripe.subscriptions.update(target.id, params);

    // Our `subscriptions` row syncs from the customer.subscription.updated
    // webhook this triggers; no direct write here, so there's exactly one
    // writer for that table.
    return Response.json(
      { ok: true, status: updated.status },
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
