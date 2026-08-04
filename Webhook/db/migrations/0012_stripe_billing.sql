-- Stripe billing schema — reconstructed record of what was actually applied
-- via the Supabase SQL Editor on 2026-08-04 (Part 3 of
-- stripe-billing-build-spec.md). It was run before the spec's later
-- corrections landed, so this file intentionally matches the AS-RUN state,
-- not the corrected one. See 0013_stripe_billing_corrections.sql for the
-- fixes applied on top: the missing 'paused' status, the access_expires_at
-- shortening bug in upsert_subscription_from_stripe, the exact-day/exact-
-- timestamp fragility in get_expiry_reminder_candidates, and the missing
-- unique(user_id, purpose) constraint on user_discount_codes.
--
-- Do not re-run this file against the live database — it already applied.
-- It exists so `db/migrations/` has a continuous, honest record.

begin;

-- ---------- Stripe customer mapping ----------
alter table public.profiles
  add column stripe_customer_id text unique;

-- ---------- Subscriptions (history-friendly; a user could cancel and resubscribe) ----------
create type public.stripe_plan as enum ('monthly', 'annual');
create type public.subscription_status as enum (
  'active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired'
);

create table public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles(id) on delete cascade,
  stripe_subscription_id text not null unique,
  stripe_price_id        text not null,
  plan                   public.stripe_plan not null,
  status                 public.subscription_status not null,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index subscriptions_user_id_idx   on public.subscriptions (user_id);
create index subscriptions_stripe_id_idx on public.subscriptions (stripe_subscription_id);

alter table public.subscriptions enable row level security;

create policy "subscriptions_select_own"
  on public.subscriptions for select
  using (auth.uid() = user_id);

grant select on public.subscriptions to authenticated;

create trigger subscriptions_set_updated_at
before update on public.subscriptions
for each row execute function public.set_updated_at();

-- ---------- Per-user discount codes (both directions with the Course) ----------
create table public.user_discount_codes (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references public.profiles(id) on delete cascade,
  purpose                  text not null check (
                             purpose in ('coach_discount_for_course_buyer',
                                         'course_discount_for_annual_subscriber')
                           ),
  stripe_coupon_id         text not null,
  stripe_promotion_code_id text not null unique,
  code                     text not null,
  created_at               timestamptz not null default now()
);

create index user_discount_codes_user_id_idx on public.user_discount_codes (user_id);

alter table public.user_discount_codes enable row level security;

create policy "user_discount_codes_select_own"
  on public.user_discount_codes for select
  using (auth.uid() = user_id);

grant select on public.user_discount_codes to authenticated;

-- ---------- Expiry reminder tracking (prevents duplicate sends) ----------
create table public.access_expiry_reminders (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  milestone         text not null check (
                      milestone in ('7_days_before','3_days_before','day_of',
                                    '1_week_after','1_month_after')
                    ),
  access_expires_at timestamptz not null,
  sent_at           timestamptz not null default now(),
  unique (user_id, milestone, access_expires_at)
);

alter table public.access_expiry_reminders enable row level security;
revoke all on public.access_expiry_reminders from anon, authenticated;

-- ---------- Core upgrade function, called ONLY by the Worker (service role) ----------
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

  if p_status in ('active', 'trialing') then
    update public.profiles
    set tier              = 'paid',
        reviews_limit     = greatest(reviews_limit, 100000),
        access_expires_at = p_current_period_end
    where id = p_user_id;
  end if;
end;
$$;

-- ---------- Reminder candidates, called ONLY by the Worker (service role bypasses RLS) ----------
create or replace function public.get_expiry_reminder_candidates()
returns table (
  user_id           uuid,
  email             text,
  milestone         text,
  access_expires_at timestamptz
)
language sql
stable
as $$
  select p.id, p.email, m.milestone, p.access_expires_at
  from public.profiles p
  cross join lateral (
    values (7,'7_days_before'), (3,'3_days_before'), (0,'day_of'),
           (-7,'1_week_after'), (-30,'1_month_after')
  ) as m(days_offset, milestone)
  where p.access_expires_at is not null
    and date_trunc('day', p.access_expires_at)
      = date_trunc('day', now() + (m.days_offset || ' days')::interval)
    and not exists (
      select 1 from public.subscriptions s
      where s.user_id = p.id
        and s.status in ('active','trialing')
        and s.cancel_at_period_end = false
        and s.current_period_end = p.access_expires_at
    )
    and not exists (
      select 1 from public.access_expiry_reminders r
      where r.user_id = p.id
        and r.milestone = m.milestone
        and r.access_expires_at = p.access_expires_at
    );
$$;

commit;
