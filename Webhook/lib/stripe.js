import Stripe from 'stripe';

/**
 * Builds a Stripe client per request, same reasoning as getClient() in
 * supabase.js: Workers have no module-level persistent state to cache a
 * singleton in anyway, and the SDK is a lightweight HTTP wrapper.
 *
 * No httpClient/cryptoProvider config needed — modern stripe-node
 * auto-detects the Workers runtime via package export conditions
 * (`workerd`/`worker`), so `new Stripe(key)` alone is enough. See
 * stripe-billing-build-spec.md's revision note for how this was verified.
 */
export function getStripeClient(env) {
  return new Stripe(env.STRIPE_SECRET_KEY);
}
