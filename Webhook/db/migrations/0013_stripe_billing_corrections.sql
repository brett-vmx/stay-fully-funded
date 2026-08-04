-- Corrections to 0012_stripe_billing.sql, applied 2026-08-04, same day.
-- 0012 was run from an earlier draft of stripe-billing-build-spec.md, before
-- a code review caught three logic bugs and two hardening gaps in it. This
-- brings the live schema in line with the spec's corrected Part 3. Nothing
-- destructive: no rows exist yet in any of subscriptions, user_discount_codes,
-- or access_expiry_reminders, so there is no data to migrate.

begin;

-- ---------- 1. Add the missing subscription_status value ----------
-- Stripe has EIGHT subscription statuses; 0012 only created seven. Without
-- this, a subscription that ever gets pause_collection set would fail the
-- enum check on insert, 500ing the webhook, and Stripe would retry that
-- event for days.
alter type public.subscription_status add value 'paused';

-- ---------- 2. Fix access_expires_at shortening a trial user's access ----------
-- 0012's version set access_expires_at = p_current_period_end unconditionally.
-- That SHORTENS access for a trial/pilot user who subscribes: someone 5 days
-- into a 90-day window (expiring ~Nov 1) who buys the $19 monthly plan would
-- have had their expiry moved BACK to ~Sep 2 — paying and getting less.
-- greatest() makes it a high-water mark instead: paying can only ever extend
-- access, never shorten it. For a renewing subscription this behaves
-- identically to before, since each period end is later than the last.
create or replace function public.upsert_subscription_from_stripe(
  p_user_id uuid,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_plan public.stripe_plan,
  p_status public.subscription_status,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean
)
returns void
language plpgsql
set search_path = public
as $$
begin
  insert into public.subscriptions (
    user_id, stripe_subscription_id, stripe_price_id, plan,
    status, current_period_end, cancel_at_period_end
  )
  values (
    p_user_id, p_stripe_subscription_id, p_stripe_price_id, p_plan,
    p_status, p_current_period_end, p_cancel_at_period_end
  )
  on conflict (stripe_subscription_id) do update
    set status               = excluded.status,
        current_period_end   = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        stripe_price_id      = excluded.stripe_price_id,
        plan                 = excluded.plan;

  -- Only extend access on a genuinely active/trialing period. We deliberately
  -- do NOT revoke tier/limit on past_due/canceled here — access_expires_at
  -- simply stops being extended, and the existing can_request_review check
  -- (already gated on access_expires_at) handles the cutoff naturally once
  -- that date passes.
  if p_status in ('active', 'trialing') then
    update public.profiles
    set tier              = 'paid',
        reviews_limit     = greatest(reviews_limit, 100000),
        access_expires_at = greatest(
                              coalesce(access_expires_at, p_current_period_end),
                              p_current_period_end
                            )
    where id = p_user_id;
  end if;
end;
$$;

-- ---------- 3. Fix the reminder query's exact-match fragility ----------
-- 0012's version had two fragile exact-equality checks:
--   (a) date_trunc('day', access_expires_at) = date_trunc('day', now() + offset)
--       — a single missed cron run permanently skips that day's milestone
--       for everyone; there is no catch-up, the day just passes.
--   (b) s.current_period_end = p.access_expires_at
--       — exact timestamptz equality between two columns written
--       independently. Any drift (e.g. the greatest() fix above, a manual
--       pilot extension, a mid-cycle proration) silently breaks the
--       exclusion and emails happily-paying subscribers "your access ends
--       in 7 days." The single worst false positive this system can produce.
-- Fixed by widening (a) to a 2-day window — the unique(user_id, milestone,
-- access_expires_at) constraint already makes re-matching free, so a missed
-- day self-heals on the next run — and by dropping (b) entirely in favor of
-- a status-only exclusion, which also now includes 'past_due': Stripe's own
-- dunning sequence already owns that conversation while it retries a failed
-- card, and a past_due user rejoins this exclusion's opposite (loses it,
-- becomes eligible) once Stripe gives up and the subscription lapses.
create or replace function public.get_expiry_reminder_candidates()
returns table (
  user_id           uuid,
  email             text,
  milestone         text,
  access_expires_at timestamptz
)
language sql
stable
set search_path = public
as $$
  select p.id, p.email, m.milestone, p.access_expires_at
  from public.profiles p
  cross join lateral (
    values (7,'7_days_before'), (3,'3_days_before'), (0,'day_of'),
           (-7,'1_week_after'), (-30,'1_month_after')
  ) as m(days_offset, milestone)
  where p.access_expires_at is not null
    and p.email is not null
    and date_trunc('day', p.access_expires_at)
        <= date_trunc('day', now() + (m.days_offset || ' days')::interval)
    and date_trunc('day', p.access_expires_at)
        >  date_trunc('day', now() + ((m.days_offset - 2) || ' days')::interval)
    and not exists (
      select 1 from public.subscriptions s
      where s.user_id = p.id
        and s.status in ('active','trialing','past_due')
        and s.cancel_at_period_end = false
    )
    and not exists (
      select 1 from public.access_expiry_reminders r
      where r.user_id = p.id
        and r.milestone = m.milestone
        and r.access_expires_at = p.access_expires_at
    );
$$;

-- ---------- 4. Prevent a double-mint race on discount codes ----------
-- Part 4's direction-2 trigger guards with a read-then-write ("does a row
-- already exist?"), which races under Stripe's webhook retries — two
-- concurrent deliveries can both read "no row" and both mint a promo code.
alter table public.user_discount_codes
  add constraint user_discount_codes_user_id_purpose_key unique (user_id, purpose);

commit;
