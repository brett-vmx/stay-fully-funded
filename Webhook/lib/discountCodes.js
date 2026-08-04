// lib/discountCodes.js — mints a per-user Stripe Promotion Code and records
// it, for either direction of the Course<->Coach discount (see
// stripe-billing-build-spec.md Part 4).
//
// A Promotion Code created with a `customer` field is redeemable by ONLY
// that Stripe customer — anyone else's checkout session rejects it, no
// matter who it's shared with. `max_redemptions: 1` makes it single-use even
// for the intended person.
//
// Uses Stripe's REST API directly via fetch rather than the `stripe` SDK
// client: this is the one call site in the billing work that doesn't need
// the SDK's webhook-signature or Workers-runtime handling, and a bare fetch
// keeps it that way.
//
// Raw fetch, not the SDK, so the API version isn't pinned by the SDK's
// default — Stripe uses the account's default API version, which as of
// 2025-09-30.clover made promotion-code coupon references polymorphic (see
// the `promotion[type]` / `promotion[coupon]` fields below, not a bare
// `coupon` field).
import { insertDiscountCode } from './supabase.js';

/**
 * @param {object} env - Worker env (needs STRIPE_SECRET_KEY)
 * @param {object} params
 * @param {string} params.userId - Supabase profiles.id
 * @param {string} params.stripeCustomerId
 * @param {string} params.couponId - Stripe Coupon ID (not a Promotion Code)
 * @param {'coach_discount_for_course_buyer'|'course_discount_for_annual_subscriber'} params.purpose
 * @returns {Promise<string>} the redeemable code, e.g. "SFF-4K2Q1A"
 */
export async function generateUserPromoCode(env, { userId, stripeCustomerId, couponId, purpose }) {
  const code = `SFF-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;

  const res = await fetch('https://api.stripe.com/v1/promotion_codes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'promotion[type]': 'coupon',
      'promotion[coupon]': couponId,
      customer: stripeCustomerId,
      code,
      max_redemptions: '1',
    }),
  });
  const promo = await res.json();
  if (!res.ok) throw new Error(`Stripe promo code creation failed: ${promo.error?.message}`);

  await insertDiscountCode(env, {
    userId,
    purpose,
    stripeCouponId: couponId,
    stripePromotionCodeId: promo.id,
    code: promo.code,
  });

  return promo.code;
}
