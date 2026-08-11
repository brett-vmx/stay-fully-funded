// api/checkout.js — POST /api/create-checkout-session: starts a Stripe
// Checkout session for the caller's own account (see
// stripe-billing-build-spec.md Part 5).
//
// Authorization is RLS, same pattern as report-pdf.js/report-chat.js: the
// Supabase client is built with the CALLER's own access token, and a bare
// select on `profiles` (no .eq needed) returns exactly one row because
// `profiles_select_own` (auth.uid() = id) restricts it to the caller's own —
// which also doubles as verifying the JWT, since an invalid/expired token
// fails the query outright.

import { getUserClient, getStripeCustomerId, setStripeCustomerId } from '../lib/supabase.js';
import { getStripeClient } from '../lib/stripe.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const MARKETING_URL = 'https://stayfullyfunded.com';

export async function handleCreateCheckoutSession(request, env) {
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

    // Annual is the only plan sold, so there's no plan to read off the body
    // and no price map to choose from. Any body the caller sends is ignored.
    if (!env.STRIPE_PRICE_ANNUAL) {
      return Response.json(
        { error: 'Checkout is not configured' },
        { status: 500, headers: CORS_HEADERS },
      );
    }

    const supabase = getUserClient(env, accessToken);
    // No .eq(): profiles_select_own's RLS (auth.uid() = id) already scopes
    // this to exactly one row, the caller's own.
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, email, stripe_customer_id')
      .maybeSingle();

    if (error) {
      console.error('checkout: profile lookup failed:', error);
      return Response.json({ error: 'Lookup failed' }, { status: 500, headers: CORS_HEADERS });
    }
    // No row = an invalid/expired token, since a signed-in user always has a
    // profile (handle_new_user() creates one on signup).
    if (!profile) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS_HEADERS });
    }

    const stripe = getStripeClient(env);
    let stripeCustomerId = profile.stripe_customer_id;

    if (!stripeCustomerId) {
      // Reuse an existing Stripe customer for this email before minting a
      // new one. If the same person ever ends up with two auth.users rows
      // (see the Google auth / identity-linking Open Item), a bare create()
      // would give them two Stripe customers and two live subscriptions;
      // reusing by email doesn't fix a split profile, but it stops the
      // double-billing, which is the part that reaches a support inbox.
      const found = await stripe.customers.list({ email: profile.email, limit: 1 });
      const customer =
        found.data[0] ??
        (await stripe.customers.create({
          email: profile.email,
          metadata: { supabase_user_id: profile.id },
        }));
      stripeCustomerId = customer.id;

      try {
        await setStripeCustomerId(env, profile.id, stripeCustomerId);
      } catch (err) {
        // stripe_customer_id is UNIQUE on profiles. Reaching this means a
        // split identity: the customer found/created above by email is
        // already attached to a DIFFERENT profile. Fail loudly here with a
        // plain message rather than letting a raw 500 (or, worse, a second
        // live subscription under a mismatched profile) reach the person
        // mid-checkout.
        if (err?.code === '23505') {
          return Response.json(
            {
              error:
                "This email already has a subscription. Sign in with the method you used originally, or reply to any of our emails and we'll sort it out.",
            },
            { status: 409, headers: CORS_HEADERS },
          );
        }
        throw err;
      }
    }

    // The promo box used to be gated to annual, which was the whole mechanism
    // keeping the $50 discount off the monthly plan. Annual is now the only
    // plan, so it's unconditional. Never pass this alongside `discounts` on
    // the same session — Stripe rejects that even when one side is explicitly
    // null.
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: env.STRIPE_PRICE_ANNUAL, quantity: 1 }],
      subscription_data: {
        // Rides along on every customer.subscription.* event, so the webhook
        // never has to also handle checkout.session.completed just to
        // correlate the user.
        metadata: { supabase_user_id: profile.id },
      },
      allow_promotion_codes: true,
      success_url: `${MARKETING_URL}/profile?checkout=success`,
      cancel_url: `${MARKETING_URL}/profile?checkout=canceled`,
    });

    return Response.json({ url: session.url }, { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    console.error('checkout error:', err);
    return Response.json(
      { error: 'Internal error creating checkout session' },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
