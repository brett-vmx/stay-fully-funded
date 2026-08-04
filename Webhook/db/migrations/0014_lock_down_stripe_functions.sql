-- Closes a real privilege-escalation hole found during Part 10 testing,
-- applied directly against the live database on 2026-08-04 (same day as
-- 0012/0013), recorded here for provenance.
--
-- upsert_subscription_from_stripe and get_expiry_reminder_candidates were
-- created with no explicit grants at all, on the assumption (stated in the
-- spec's own comments) that omitting `grant execute ... to authenticated`
-- was sufficient to keep them private. It is not: Postgres grants EXECUTE
-- on a new function to PUBLIC by default, and `authenticated`/`anon` are
-- ordinary roles that inherit PUBLIC grants like anyone else. Both functions
-- were callable by any signed-in user, unauthenticated request, the whole
-- time these migrations have been live.
--
-- Concretely, before this fix, any authenticated client could run:
--   supabase.rpc('upsert_subscription_from_stripe', {
--     p_user_id: '<any uuid, not even their own>',
--     p_stripe_subscription_id: 'fake', p_stripe_price_id: 'fake',
--     p_plan: 'annual', p_status: 'active',
--     p_current_period_end: '2099-01-01', p_cancel_at_period_end: false,
--   })
-- and grant themselves — or overwrite anyone else's account, since
-- p_user_id is never checked against auth.uid() — paid tier and the
-- 100000 "unlimited" sentinel, for free, with no Stripe involvement at all.
-- get_expiry_reminder_candidates() being open let any authenticated caller
-- enumerate every user's email, milestone, and access_expires_at.
--
-- service_role lost the same implicit PUBLIC access when it was revoked
-- below, so it needs its own explicit grant — the Worker calls both via
-- lib/supabase.js's getClient(env), which authenticates as service_role.

begin;

revoke execute on function public.upsert_subscription_from_stripe(
  uuid, text, text, public.stripe_plan, public.subscription_status, timestamptz, boolean
) from public, authenticated, anon;

revoke execute on function public.get_expiry_reminder_candidates()
  from public, authenticated, anon;

grant execute on function public.upsert_subscription_from_stripe(
  uuid, text, text, public.stripe_plan, public.subscription_status, timestamptz, boolean
) to service_role;

grant execute on function public.get_expiry_reminder_candidates()
  to service_role;

commit;

-- Not fixed here, flagged for a separate decision: can_request_review(uuid)
-- and remaining_reviews(uuid) have the same "no explicit grant" shape and
-- are callable by anon (not just authenticated) — but they predate this
-- migration (0002), are read-only (a quota-count information leak, not a
-- write/privilege-escalation path), and take p_user_id as a bare parameter
-- never checked against auth.uid() either. Worth its own pass.
