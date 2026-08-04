import { createClient } from '@supabase/supabase-js';

// Service-role client — this function runs server-side and needs full
// read/write access, so we deliberately use the service role key, not the
// public anon key. Never expose this key to a browser/client context.
//
// On Cloudflare Workers, secrets arrive on the `env` object passed into each
// request (there is no global process.env), so the client is created
// per-request from env rather than once at module load. It's a lightweight
// HTTP wrapper, so this costs essentially nothing.
function getClient(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }, // no browser session storage in a Worker
  });
}

/**
 * User-scoped client — anon key + the caller's own access token attached as
 * the Authorization header, so Postgres sees auth.uid() as THAT user and RLS
 * enforces "only your own rows" automatically. Use this (never the
 * service-role client above) for any endpoint that reads data on behalf of a
 * signed-in user, e.g. /api/report-pdf — the RLS check IS the entire
 * authorization logic; there is nothing else to get wrong.
 */
export function getUserClient(env, accessToken) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * Looks up a subscriber by the token found in the recipient address.
 * Returns null if no match — the webhook should handle that as
 * "unknown/invalid review address" rather than erroring loudly.
 */
export async function getSubscriberByToken(env, token) {
  const { data, error } = await getClient(env)
    .from('subscribers')
    .select('*')
    .eq('review_token', token)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** Records the submitted draft. Returns the new submission's id. */
export async function saveSubmission(env, { subscriberId, subject, text, html, contextNote, isForwardedEmail }) {
  const { data, error } = await getClient(env)
    .from('submissions')
    .insert({
      subscriber_id: subscriberId,
      raw_subject: subject,
      raw_text: text,
      raw_html: html,
      context_note: contextNote,
      is_forwarded: isForwardedEmail,
    })
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}

/** Records the generated report against its submission. */
export async function saveReport(env, { submissionId, reportHtml, reportText }) {
  const { error } = await getClient(env).from('reports').insert({
    submission_id: submissionId,
    report_html: reportHtml,
    report_text: reportText,
  });

  if (error) throw error;
}

/** Increments the subscriber's usage counter by one. */
export async function incrementReviewUsage(env, subscriberId, currentUsed) {
  const { error } = await getClient(env)
    .from('subscribers')
    .update({ reviews_used: currentUsed + 1 })
    .eq('id', subscriberId);

  if (error) throw error;
}

// TODO (v2 — see README "What's intentionally NOT built yet"): a real
// updateDerivedProfile() that asks Claude to synthesize recurring patterns
// across a subscriber's submission history, so future reports can say
// things like "you've buried the lead three letters running." v1 ships
// without this — the Coach still evaluates each letter well on its own
// merits, it just isn't longitudinal yet.

// =========================================================
// v2 (profiles / reviews, Supabase-Auth-based) — used only once the
// 0002_profiles_reviews.sql migration has been applied live. The inbound
// pipeline tries these first and falls back to the v1 functions above for
// any recipient slug that isn't a v2 profile, so existing subscribers are
// unaffected.
// =========================================================

/** Looks up a v2 profile by its review_slug. Returns null if no match. */
export async function getProfileBySlug(env, slug) {
  const { data, error } = await getClient(env)
    .from('profiles')
    .select('*')
    .eq('review_slug', slug)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** Wraps the can_request_review(uuid) RPC defined in the migration. */
export async function canRequestReview(env, userId) {
  const { data, error } = await getClient(env).rpc('can_request_review', {
    p_user_id: userId,
  });

  if (error) throw error;
  return data === true;
}

/**
 * Reserves a quota slot by inserting a 'received' review row. Relies on
 * the unique postmark_message_id index (see the migration) so a Postmark
 * retry of the same inbound message can never reserve a second slot: a
 * plain insert() has no way to pass ON CONFLICT DO NOTHING through
 * PostgREST, so a retry instead raises a Postgres unique-violation
 * (error code 23505), which we catch here and treat as the expected
 * "already handled" signal rather than a real error. Returns the new
 * review's id, or null on that duplicate case.
 */
export async function insertReceivedReview(env, {
  userId, postmarkMessageId, fromEmail, subject, wordCount, draftBody,
}) {
  const { data, error } = await getClient(env)
    .from('reviews')
    .insert({
      user_id: userId,
      status: 'received',
      postmark_message_id: postmarkMessageId,
      from_email: fromEmail,
      subject,
      word_count: wordCount,
      draft_body: draftBody, // the parsed letter text, matching v1's raw_text
    })
    .select('id')
    .maybeSingle();

  if (error && error.code !== '23505') throw error;
  return data ? data.id : null;
}

export async function markReviewProcessing(env, reviewId) {
  const { error } = await getClient(env)
    .from('reviews')
    .update({ status: 'processing' })
    .eq('id', reviewId);

  if (error) throw error;
}

export async function completeReview(env, reviewId, { reportBody, flags }) {
  const { error } = await getClient(env)
    .from('reviews')
    .update({
      status: 'completed',
      report_body: reportBody,
      flags: flags || {},
      completed_at: new Date().toISOString(),
    })
    .eq('id', reviewId);

  if (error) throw error;
}

/** Marks a review failed, which releases its quota slot (see remaining_reviews()). */
export async function failReview(env, reviewId, errorMessage) {
  const { error } = await getClient(env)
    .from('reviews')
    .update({ status: 'failed', error: String(errorMessage).slice(0, 2000) })
    .eq('id', reviewId);

  if (error) throw error;
}

/**
 * Reads one review's chat history, oldest first. Service-role — ownership is
 * confirmed separately via an RLS-scoped lookup on `reviews` before this is
 * ever called (see api/report-chat.js), so this just needs the review_id.
 */
export async function getReviewMessages(env, reviewId) {
  const { data, error } = await getClient(env)
    .from('review_messages')
    .select('role, content')
    .eq('review_id', reviewId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

/**
 * Records one chat exchange (a user row and the assistant's reply) in a
 * single insert. Service-role only — review_messages has no insert policy
 * for clients (see db/migrations/0011_review_messages.sql); all writes go
 * through here, matching the rest of the pipeline's read-via-RLS,
 * write-via-service-role split.
 */
export async function insertReviewMessages(env, rows) {
  const { error } = await getClient(env).from('review_messages').insert(rows);
  if (error) throw error;
}

/**
 * Trivial, read-only query used ONLY by the keep-alive Cron Trigger (see
 * api/inbound.js's scheduled() handler) to prevent Supabase Free-tier's
 * 7-day-inactivity auto-pause. Never writes, never touches review/quota
 * logic — just proves the connection and database are alive.
 */
export async function keepAliveQuery(env) {
  const { data, error } = await getClient(env)
    .from('profiles')
    .select('id')
    .limit(1);

  if (error) throw error;
  return data;
}

// =========================================================
// Stripe billing (db/migrations/0012_stripe_billing.sql + 0013's
// corrections) — see stripe-billing-build-spec.md. All service-role, same
// division of labor as the rest of this file: the Worker writes here
// directly, `authenticated` only ever gets the SELECT policies the
// migration grants (subscriptions, user_discount_codes — both read-own).
// =========================================================

/** Returns profiles.stripe_customer_id for this user, or null if unset. */
export async function getStripeCustomerId(env, userId) {
  const { data, error } = await getClient(env)
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data?.stripe_customer_id ?? null;
}

/**
 * Records a Stripe customer against this profile. stripe_customer_id is
 * UNIQUE, so this throws a Postgres 23505 if that customer is already
 * attached to a different profile — deliberately not swallowed here. The
 * caller (the checkout-session endpoint) is where that error becomes a
 * plain message to the person mid-checkout; see stripe-billing-build-spec.md
 * Part 5's note on why a split auth identity should fail loudly here rather
 * than silently double-bill.
 */
export async function setStripeCustomerId(env, userId, stripeCustomerId) {
  const { error } = await getClient(env)
    .from('profiles')
    .update({ stripe_customer_id: stripeCustomerId })
    .eq('id', userId);

  if (error) throw error;
}

/**
 * The webhook's fallback path when a subscription event carries no
 * supabase_user_id metadata (comped from the Dashboard, fixed by hand, or
 * any subscription not created through our own Checkout session). Returns
 * null if no profile has claimed this customer.
 */
export async function findUserIdByStripeCustomerId(env, stripeCustomerId) {
  const { data, error } = await getClient(env)
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle();

  if (error) throw error;
  return data?.id ?? null;
}

/** Thin wrapper over the upsert_subscription_from_stripe(...) RPC. */
export async function upsertSubscriptionFromStripe(env, {
  userId, subscriptionId, priceId, plan, status, currentPeriodEnd, cancelAtPeriodEnd,
}) {
  const { error } = await getClient(env).rpc('upsert_subscription_from_stripe', {
    p_user_id: userId,
    p_stripe_subscription_id: subscriptionId,
    p_stripe_price_id: priceId,
    p_plan: plan,
    p_status: status,
    p_current_period_end: currentPeriodEnd,
    p_cancel_at_period_end: cancelAtPeriodEnd,
  });

  if (error) throw error;
}

/**
 * Records a newly-minted per-user discount code. `unique(user_id, purpose)`
 * means a second insert for the same user+purpose throws 23505 rather than
 * duplicating — expected under Stripe's webhook retries (the direction-2
 * trigger in the webhook handler treats that as "already minted, fine," not
 * a real error).
 */
export async function insertDiscountCode(env, { userId, purpose, stripeCouponId, stripePromotionCodeId, code }) {
  const { error } = await getClient(env).from('user_discount_codes').insert({
    user_id: userId,
    purpose,
    stripe_coupon_id: stripeCouponId,
    stripe_promotion_code_id: stripePromotionCodeId,
    code,
  });

  if (error) throw error;
}

/** Looks up an existing discount code for this user+purpose, or null. */
export async function findDiscountCode(env, { userId, purpose }) {
  const { data, error } = await getClient(env)
    .from('user_discount_codes')
    .select('id, code')
    .eq('user_id', userId)
    .eq('purpose', purpose)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** Thin wrapper over the get_expiry_reminder_candidates() RPC. */
export async function getExpiryReminderCandidates(env) {
  const { data, error } = await getClient(env).rpc('get_expiry_reminder_candidates');
  if (error) throw error;
  return data || [];
}

/**
 * Records that a reminder milestone was sent, so the sweep never resends it.
 * Returns false (not true) on a duplicate rather than throwing — the
 * `unique(user_id, milestone, access_expires_at)` constraint makes a
 * double-send from the cron running twice, or a retry after a partial
 * failure, a safe no-op instead of an error. See the "insert before you
 * send" note in stripe-billing-build-spec.md Part 8: call this BEFORE
 * sending the email, so a crash mid-sweep drops at most one email rather
 * than risking a duplicate.
 */
export async function recordExpiryReminder(env, { userId, milestone, accessExpiresAt }) {
  const { error } = await getClient(env).from('access_expiry_reminders').insert({
    user_id: userId,
    milestone,
    access_expires_at: accessExpiresAt,
  });

  if (error) {
    if (error.code === '23505') return false;
    throw error;
  }
  return true;
}
