// api/billing-portal.js — POST /api/create-billing-portal-session: the
// entire "cancel / switch plan / update card" UI, hosted by Stripe (see
// stripe-billing-build-spec.md Part 7 and Part 1 step 7's Dashboard config).
//
// Authorization is RLS, same pattern as checkout.js: the caller's own access
// token builds an RLS-scoped Supabase client, and a bare select on `profiles`
// returns exactly one row — the caller's own — via profiles_select_own.

import { getUserClient } from '../lib/supabase.js';
import { getStripeClient } from '../lib/stripe.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const MARKETING_URL = 'https://stayfullyfunded.com';

export async function handleCreateBillingPortalSession(request, env) {
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

    const supabase = getUserClient(env, accessToken);
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .maybeSingle();

    if (error) {
      console.error('billing-portal: profile lookup failed:', error);
      return Response.json({ error: 'Lookup failed' }, { status: 500, headers: CORS_HEADERS });
    }
    // No row = an invalid/expired token, since a signed-in user always has a
    // profile (handle_new_user() creates one on signup).
    if (!profile) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS_HEADERS });
    }
    // Someone who never checked out has no Stripe customer to manage — a
    // clean 400 rather than passing null to Stripe.
    if (!profile.stripe_customer_id) {
      return Response.json(
        { error: 'No billing account yet — subscribe first to manage billing.' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    const stripe = getStripeClient(env);
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${MARKETING_URL}/profile`,
    });

    return Response.json({ url: session.url }, { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    console.error('billing-portal error:', err);
    return Response.json(
      { error: 'Internal error creating billing portal session' },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
