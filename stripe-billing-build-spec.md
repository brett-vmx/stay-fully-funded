# Build Spec — Stripe Billing (Stay Fully Funded)

**For:** Brett (Part 1–2, Dashboard/account work) and Claude Code (Part 3 onward)
**Goal:** Add real billing on top of the existing `profiles.tier = 'paid'` gap —
Checkout, webhooks, the Billing Portal, per-user discount codes in both
directions with the Course, and an expiry-reminder email sequence — following
the same RLS/security-definer discipline as the rest of the schema.

> **Revision note (Aug 2026).** This spec was reviewed against the live
> codebase and against current Stripe docs, and corrected in place. The
> original draft targeted Stripe's pre-2025 object shapes and assumed the
> Worker had no cron trigger or `scheduled()` export. Both were wrong. Where a
> correction is non-obvious, the reasoning is left inline as a comment so
> nobody helpfully reverts it later. The Stripe-side facts below were verified
> against `2025-03-31.basil`, `2025-09-30.clover`, and the current default
> `2026-07-29.dahlia`.
>
> **Everything in this document is the spec.** There is no separate layer of
> review commentary to filter out — inline notes explain *why* a thing is the
> way it is, and are as binding as the code blocks they sit next to.
>
> **The three API changes that matter most**, because a new Stripe account in
> 2026 defaults to `dahlia` and `stripe@22.x` pins that version regardless of
> your account default:
>
> 1. `subscription.current_period_end` was **removed** (basil). It now lives at
>    `subscription.items.data[0].current_period_end`.
> 2. `invoice.subscription` was **removed** (basil). It's now
>    `invoice.parent.subscription_details.subscription`.
> 3. Promotion code creation no longer takes a top-level `coupon` (clover).
>    It's `promotion[type]=coupon` + `promotion[coupon]=<id>`.
>
> And one platform fact: `stripe.webhooks.constructEvent()` **throws** on
> Cloudflare Workers (no synchronous HMAC in workerd). You must use
> `await constructEventAsync()`.

---

## Decisions locked this session

- **Pricing:** Monthly $19/mo, Annual $97/yr. Monthly is intentionally the high
  anchor pushing people toward annual.
- **Discount, direction 1 (Course → Coach):** Course buyers get $50 off the
  **annual** Coach plan only. Never offered on monthly.
- **Discount, direction 2 (Coach → Course):** Annual Coach subscribers get a
  discount on the Course ($79 or $97, not yet decided) once it exists. This
  side is **deferred** — the mechanism is built now but stays dormant until the
  Course has a real Stripe product/price to discount.
- **Checkout:** hosted Stripe Checkout. Embedded mode is a documented option to
  revisit later, not built now.
- **"Unlimited" reviews for paid:** reuse the existing `reviews_limit` counting
  logic with a large constant, rather than adding tier-branching to
  `can_request_review`. No metering.
- **Expiry reminder emails:** 7 days before / 3 days before / day-of / 1 week
  after / 1 month after `access_expires_at`, sent only to accounts that
  actually need a nudge (trial, pilot, or a paid subscription that's lapsing) —
  **not** to someone whose subscription is happily auto-renewing, and **not**
  to someone mid-dunning on a failed card (see the next bullet).

## Decisions locked during the code review

- **`access_expires_at` is a high-water mark.** `upsert_subscription_from_stripe`
  uses `greatest()`, so paying can only ever extend access, never shorten it.
  The accepted consequence: a trial or pilot user who subscribes and then
  cancels keeps the remainder of their original free window. That costs
  nothing real — the access was already granted for free, so they land exactly
  where they'd have been had they never paid — and the alternative penalizes
  people for paying, which is a far worse failure.

  **The consequence that actually matters:** `access_expires_at` is now
  monotonically non-decreasing *through the billing path*. Nothing in Parts
  5–8 can shorten someone's access, including a case where you need to cut
  someone off early. The escape hatch is a direct service-role
  `update public.profiles set access_expires_at = ... where id = ...` from the
  SQL Editor. That's intentional and fine, but write it down here rather than
  rediscovering it under pressure.

- **`past_due` accounts get no reminder emails.** Stripe's dunning sequence
  already owns that conversation while it retries the card. Ours would arrive
  alongside it saying the more fatalistic version of the same thing. They
  rejoin the sequence automatically once Stripe gives up — see the comment in
  `get_expiry_reminder_candidates`.

- **Google auth and identity linking is an open pre-flight item**, not a
  billing decision. See the Open Items section at the end.

---

## Part 1 — Stripe Dashboard setup (do this yourself, no code)

Do this in **test mode** first (the toggle is top-right in the Dashboard).
Everything below has a live-mode mirror you repeat once you're ready to charge
real cards.

1. **Account basics.** If you haven't already: Settings → Business details →
   enter VMX Media as the legal entity, add a bank account for payouts.
   Payouts/live charges need this activated; test mode works without it.

2. **Create the Product.** Product catalog → + Add product →
   "Stay Fully Funded — Email Coach". Add two **Prices** under it:
   - Recurring, $19.00 USD, billed monthly
   - Recurring, $97.00 USD, billed yearly

   Copy both **Price IDs** (`price_...`) — you'll paste these into Cloudflare
   secrets in step 6.

3. **Create the $50-off coupon (direction 1 only, for now).** Product catalog →
   Coupons → + New. Amount off: $50.00 USD. Duration: **Once** (applies to a
   single invoice — correct for a one-time discount on the annual charge).
   Copy the **Coupon ID**. **Don't** create a shared Promotion Code for it in
   the Dashboard — codes are generated per-user by the Worker (Part 4), never
   shared.

   Leave the reverse coupon (Course discount for annual subscribers) for
   later — you can't scope it sensibly until the Course has its own product in
   Stripe.

4. **API keys.** Developers → API keys. Copy the **Secret key** (`sk_test_...`
   for now). Never put this in frontend code — it goes into a Cloudflare
   Worker secret only (step 6).

5. **Webhook endpoint — don't create this yet.** There is only one
   Worker, and it serves production. Pointing a test-mode Stripe endpoint at it
   would mean putting `sk_test_...` into the live Worker's secrets while you
   test, which takes real checkout offline for the duration.

   Instead, all of Part 10's testing runs locally against `wrangler dev` with
   the Stripe CLI forwarding events (see Part 10). You create the real
   Dashboard endpoint only at go-live, in **live mode**, with:

   - URL: `https://forever-funded-email-coach.brett-66b.workers.dev/webhooks/stripe`
     (verified — this matches `COACH_API_URL` in
     `Website/src/lib/constants.ts`, which the live Reports tab already calls.
     See the rename checklist's landmine #1: never rename this Worker, both
     Postmark and this new webhook depend on it.)
   - Events to send: `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`,
     **`invoice.paid`**

   The original draft said `invoice.payment_succeeded`. Both
   events still exist and neither is deprecated, but `invoice.paid` is a strict
   superset (it also fires when an invoice is marked paid out-of-band) and it's
   what Stripe's own subscription-webhooks guide uses. Part 6 is written
   against `invoice.paid`.

   - Copy the **Signing secret** (`whsec_...`) shown after creation.

6. **Cloudflare Worker secrets.** Two changes from the original:
   these run from `Webhook/` (where `wrangler.toml` lives), not the repo root;
   and price/coupon IDs are **not secrets** — they're visible in every Checkout
   session, and keeping them in `wrangler.toml` makes them committed,
   diffable, and reviewable instead of invisible server-side state.

   Real secrets (`cd Webhook` first):
   ```bash
   wrangler secret put STRIPE_SECRET_KEY
   wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

   Non-secret IDs go in the existing `[vars]` block in `Webhook/wrangler.toml`,
   alongside `ANTHROPIC_MODEL` / `FROM_EMAIL` / `REVIEW_DOMAIN`:
   ```toml
   STRIPE_PRICE_MONTHLY = "price_..."
   STRIPE_PRICE_ANNUAL  = "price_..."
   STRIPE_COUPON_ANNUAL_DISCOUNT = "..."
   # STRIPE_COUPON_COURSE_DISCOUNT intentionally unset — see Part 4, direction 2
   ```

   For local testing, put the test-mode values in `Webhook/.dev.vars` (same
   file the existing Anthropic/Postmark/Supabase secrets use locally; see
   `.dev.vars.example`). That file is gitignored and never reaches production,
   which is what keeps test mode off the live Worker.

7. **Customer Billing Portal.** Settings → Billing → Customer portal.
   - Under "Products," add both the monthly and annual prices as ones
     customers are allowed to switch between.
   - Enable "Cancel subscriptions."
   - This is what gives you a full self-serve cancel/switch-plan/update-card
     UI for free — no custom screens to build.

---

## Part 2 — Stripe MCP setup for Claude Code (step by step)

**This whole part is optional — skip it unless you want it.**
Nothing in Parts 3–8 needs the Stripe MCP; the SQL and Worker code are plain
specs. Two practical notes: `claude mcp add` and `/mcp` both require an
interactive `claude` terminal session (they can't run from the desktop app),
and the OAuth consent flow needs a browser. So this is a "do it yourself in a
terminal, once, if you want it" step, not something to hand to Claude Code.

This lets Claude Code query and create things in your actual Stripe account
(products, prices, coupons) through natural-language requests instead of you
clicking through the Dashboard for every change. It authorizes via OAuth, not
by handing over your secret key.

1. In your project directory, run:
   ```bash
   claude mcp add --transport http stripe https://mcp.stripe.com/
   ```
2. Then run:
   ```bash
   claude /mcp
   ```
   This opens a browser OAuth consent screen. Log into Stripe and approve —
   confirm you're approving it against the **same account** (and test vs. live
   mode) you intend to work in.
3. Verify it connected: `/mcp` inside a Claude Code session should list
   `stripe` as connected.
4. You can revoke access anytime from Stripe Dashboard → your user Settings →
   OAuth sessions.

**A caution worth knowing, not just for setup:** the Stripe MCP gives Claude
Code real write access to your account (it can create refunds, cancel
subscriptions, etc.). Anthropic's guidance and Stripe's own docs both
recommend keeping "confirm before executing" behavior on for write actions —
don't ask Claude Code to run in a fully unattended/auto-approve mode against a
live Stripe account. For the schema/webhook build below, you don't strictly
need the MCP at all — the SQL and Worker code are handed to Claude Code as
plain specs — but it's genuinely useful for step 2/3 above if you'd rather say
"create the Product and two Prices" in chat than click through the Dashboard.

---

## Part 3 — Database schema additions

Run in the Supabase SQL Editor, wrapped in `BEGIN`/`COMMIT` as usual — not via
CLI. Also save it to the repo as
`Webhook/db/migrations/0012_stripe_billing.sql`; the migrations there run
`0002`–`0011` and this is the next one. Running it in the editor matches house
style, but the file is still the record of what was run.

```sql
begin;

-- ---------- Stripe customer mapping ----------
alter table public.profiles
  add column stripe_customer_id text unique;

-- ---------- Subscriptions (history-friendly; a user could cancel and resubscribe) ----------
create type public.stripe_plan as enum ('monthly', 'annual');

-- 'paused' added. Stripe has EIGHT subscription statuses; the
-- original draft listed seven. If a subscription ever gets pause_collection
-- set, an insert with 'paused' would fail the enum check, the webhook would
-- 500, and Stripe would retry that event for days. Cheap to include now.
create type public.subscription_status as enum (
  'active', 'trialing', 'past_due', 'canceled', 'unpaid',
  'incomplete', 'incomplete_expired', 'paused'
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

grant select on public.subscriptions to authenticated; -- permissions ≠ RLS: don't skip this

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
  created_at               timestamptz not null default now(),

  -- One code per user per direction. Part 4's direction-2 trigger
  -- guards with a read-then-write ("does a row already exist?"), which races
  -- under Stripe's webhook retries — two concurrent deliveries both read
  -- "no row" and both mint a promo code. The constraint makes that free.
  unique (user_id, purpose)
);

create index user_discount_codes_user_id_idx on public.user_discount_codes (user_id);

alter table public.user_discount_codes enable row level security;

-- Users CAN see their own codes (e.g. "Your $50 annual-plan code: SFF-4K2Q" on /profile)
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
revoke all on public.access_expiry_reminders from anon, authenticated; -- Worker-internal only

-- ---------- Core upgrade function, called ONLY by the Worker (service role) ----------
-- Not security-definer, not granted to `authenticated` — a user must never call
-- this themselves, same trust boundary as the Worker's direct writes to `reviews`.
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
set search_path = public   -- every function in 0002 sets this; Supabase's advisor flags the ones that don't
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
  -- that date passes. No changes needed to can_request_review itself.
  --
  -- access_expires_at uses greatest(), not a bare assignment.
  -- The original draft set it to p_current_period_end unconditionally, which
  -- SHORTENS access for a trial user who upgrades: someone 5 days into their
  -- 90-day window (expiring ~Nov 1) who buys the $19 monthly plan would have
  -- had their expiry moved BACK to ~Sep 2. They'd pay and get less. For a
  -- renewing subscription greatest() behaves identically, since each period
  -- end is later than the last.
  if p_status in ('active', 'trialing') then
    update public.profiles
    set tier              = 'paid',
        reviews_limit     = greatest(reviews_limit, 100000), -- effectively unlimited
        access_expires_at = greatest(
                              coalesce(access_expires_at, p_current_period_end),
                              p_current_period_end
                            )
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
set search_path = public   -- consistency with 0002's functions
as $$
  select p.id, p.email, m.milestone, p.access_expires_at
  from public.profiles p
  cross join lateral (
    values (7,'7_days_before'), (3,'3_days_before'), (0,'day_of'),
           (-7,'1_week_after'), (-30,'1_month_after')
  ) as m(days_offset, milestone)
  where p.access_expires_at is not null
    and p.email is not null            -- profiles.email is nullable
    and date_trunc('day', p.access_expires_at)
      = date_trunc('day', now() + (m.days_offset || ' days')::interval)
    -- Exclude anyone Stripe is still actively handling — either currently
    -- renewing, or mid-dunning on a failed card. Neither group should hear
    -- from us.
    --
    -- The original draft also required
    --   s.current_period_end = p.access_expires_at
    -- — exact timestamptz equality between two columns written independently
    -- by two different code paths. Any drift at all (the greatest() fix in
    -- upsert_subscription_from_stripe, a manual pilot extension, a mid-cycle
    -- proration moving the period boundary) silently breaks the exclusion and
    -- emails happily-paying subscribers "your access ends in 7 days." That's
    -- the single worst false positive this system can produce, and it would
    -- fail quietly. Status alone is the real question being asked here.
    --
    -- 'past_due' is in the exclusion set deliberately. Stripe's
    -- dunning sequence already owns that conversation, and it's still trying
    -- to save the subscription — our "your access ends in 7 days" arriving
    -- alongside it is a second, more fatalistic email about the same failed
    -- card. This resolves itself with no extra logic: while Stripe retries,
    -- we stay quiet; when it gives up and flips the subscription to
    -- 'canceled' or 'unpaid', the user drops out of this exclusion, by which
    -- point the 7_days_before/day_of date windows have already passed. What
    -- they receive is the 1_week_after / 1_month_after win-back sequence,
    -- which is exactly the right message at that point.
    and not exists (
      select 1 from public.subscriptions s
      where s.user_id = p.id
        and s.status in ('active','trialing','past_due')
        and s.cancel_at_period_end = false
    )
    -- don't resend a milestone already sent for this exact expiry date
    and not exists (
      select 1 from public.access_expiry_reminders r
      where r.user_id = p.id
        and r.milestone = m.milestone
        and r.access_expires_at = p.access_expires_at
    );
$$;

commit;
```

**Note on `get_expiry_reminder_candidates`:** it's not `security definer` and
not granted to `authenticated`/`anon`, so only a service-role connection (the
Worker's cron job, which already bypasses RLS entirely) can call it. Nothing
extra to lock down.

**Two consequences of the `reviews_limit = 100000` sentinel**, both
worth knowing before you see them in the wild:

- It's a one-way door. Nothing ever lowers it back, so a subscriber who
  cancels and lapses keeps `reviews_limit = 100000` on their profile forever.
  Access still cuts off correctly (that's `access_expires_at`'s job), so this
  isn't a security hole — but if you later grant that person a pilot window,
  they'd get unlimited reviews with it. Fine for now; just don't forget.
- `remaining_reviews()` returns `reviews_limit - count(reviews)`, so the
  Profile page will cheerfully render **"99,987 reviews left."** The UI needs
  to special-case a limit at/over the sentinel and show "Unlimited" instead.
  That's part of the Website work in Part 8b.

---

### A convention note for Parts 4, 6, and 8

The code blocks below reference `supabaseServiceRole` as if it
were a variable in scope. It isn't, and there's nothing in the codebase by
that name. `Webhook/lib/supabase.js` deliberately keeps its service-role
client **private** — `getClient(env)` is not exported — and exposes only
narrow, named wrappers (`getProfileBySlug`, `insertReceivedReview`,
`completeReview`, …), each building the client per-request from `env`. The
only exported client factory is `getUserClient(env, accessToken)`, which is
the anon-key/RLS-scoped one and is the wrong tool here.

**Decide this once, before writing any of Parts 4–8**, or you'll get three
inconsistent approaches across three handoff prompts. Recommended: stay with
the house style and add named wrappers to `lib/supabase.js` — something like
`getStripeCustomerId`, `setStripeCustomerId`, `upsertSubscriptionFromStripe`,
`insertDiscountCode`, `findDiscountCode`, `getExpiryReminderCandidates`,
`recordExpiryReminder`. Every call site then reads like the rest of the
Worker, and the service-role client stays unexported. Read the pseudo-code
below as "do this, through a wrapper," not as literal code to paste.

---

## Part 4 — Per-user discount codes (the mechanism)

This is the part you asked "is it possible and easy" about — the answer is
yes, and Stripe already does the hard part. A **Promotion Code** created with
a `customer` field is redeemable by *only that Stripe customer* — anyone
else's checkout session simply won't accept it, no matter who it's shared
with. Add `max_redemptions: 1` and it's single-use even for the intended
person.

> **The one prerequisite that makes this work, and it's easy to miss.** A
> customer-restricted code is only accepted if the Checkout Session it's
> entered into is already attached to that same customer. If you *don't* pass
> `customer` when creating a subscription-mode session, Checkout mints a brand
> new Customer during the flow — and that new customer isn't the restricted
> one, so the code gets rejected and the user sees "invalid code" with no
> explanation. Part 5 sets `customer` correctly. Don't remove it.

```js
// lib/discountCodes.js — reusable for BOTH directions
async function generateUserPromoCode(env, supabaseServiceRole, { userId, stripeCustomerId, couponId, purpose }) {
  const code = `SFF-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;

  const res = await fetch('https://api.stripe.com/v1/promotion_codes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    // Stripe 2025-09-30.clover made the coupon reference
    // polymorphic: a top-level `coupon` param is no longer accepted and this
    // request would 400. A new account defaults past that version, so the
    // original form of this call never worked.
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

  await supabaseServiceRole.from('user_discount_codes').insert({
    user_id: userId,
    purpose,
    stripe_coupon_id: couponId,
    stripe_promotion_code_id: promo.id,
    code: promo.code,
  });

  return promo.code;
}
```

(Leaving `code` blank lets Stripe auto-generate one, which is the absolute
simplest path if you don't care how it looks. The `SFF-XXXXXX` format above is
barely more code and reads better in an email — your call, either works.)

### Direction 1 — Course buyer → $50 off annual Coach (buildable now, mechanism-only)

The Course doesn't have a checkout yet, so there's no live trigger point to
wire today. What Claude Code should build now is just the call site, ready to
drop into wherever the Course purchase webhook eventually lands:

```js
await generateUserPromoCode(env, supabaseServiceRole, {
  userId,
  stripeCustomerId,
  couponId: env.STRIPE_COUPON_ANNUAL_DISCOUNT, // the $50-off coupon from Part 1
  purpose: 'coach_discount_for_course_buyer',
});
```

Come back and call this from the real Course-purchase webhook once that
system exists.

### Direction 2 — Annual Coach subscriber → Course discount (dormant until Course launches)

This one *does* have a live trigger point already — the Stripe subscription
webhook (Part 6) — so wire it now, gated on an env var that won't be set until
the Course coupon exists:

```js
// Inside the webhook handler, after upsert_subscription_from_stripe succeeds:
if (env.STRIPE_COUPON_COURSE_DISCOUNT && plan === 'annual' && ['active', 'trialing'].includes(sub.status)) {
  const { data: existing } = await supabaseServiceRole
    .from('user_discount_codes')
    .select('id')
    .eq('user_id', userId)
    .eq('purpose', 'course_discount_for_annual_subscriber')
    .maybeSingle();

  if (!existing) {
    await generateUserPromoCode(env, supabaseServiceRole, {
      userId,
      stripeCustomerId: sub.customer,
      couponId: env.STRIPE_COUPON_COURSE_DISCOUNT,
      purpose: 'course_discount_for_annual_subscriber',
    });
    // + send an email letting them know, once you're ready to announce it
  }
}
```

**Why gate on an unset env var rather than build it later:** the code ships
now, does nothing until `STRIPE_COUPON_COURSE_DISCOUNT` is set, and activates
the moment you create that coupon post-launch — no second Claude Code session
needed to "come back and add this." One thing you *will* need at that point:
a one-time backfill script to generate codes for people who became annual
subscribers *before* the Course existed (the webhook only fires on new
subscription events, not retroactively) — flagging that now so it's not a
surprise later.

---

## Part 5 — Checkout session creation endpoint

**Two structural requirements the original draft omitted**, both of
which will fail on the first real call:

1. **CORS.** This is called from the browser at `stayfullyfunded.com`. Every
   existing browser-facing endpoint in this Worker declares a `CORS_HEADERS`
   const and handles the `OPTIONS` preflight — copy the pattern verbatim from
   the top of `Webhook/api/report-chat.js`. Without it the fetch never
   reaches your handler.
2. **Route registration.** New endpoints don't route themselves. `api/inbound.js`
   dispatches by `url.pathname` in its `fetch` export (see the existing
   `/api/report-pdf` and `/api/report-chat` branches around lines 55–70); add
   the new paths there, in the same style, as a targeted insertion.

Put the handler in its own file (`api/checkout.js` or similar) the way
`report-pdf.js` and `report-chat.js` do, rather than inlining it in
`inbound.js`.

```js
// POST /api/create-checkout-session   { plan: "monthly" | "annual" }
// Auth: verify the Supabase JWT first, same as other authenticated routes.

const PRICE_IDS = {
  monthly: env.STRIPE_PRICE_MONTHLY,
  annual:  env.STRIPE_PRICE_ANNUAL,
};

// 1. Look up profiles.stripe_customer_id for this user via service role.
// 2. If null, resolve a Stripe customer and store it. Check
//    Stripe for an existing customer with this email BEFORE creating one:
//
//      const found = await stripe.customers.list({ email: user.email, limit: 1 });
//      const customer = found.data[0]
//        ?? await stripe.customers.create({
//             email: user.email,
//             metadata: { supabase_user_id: user.id },
//           });
//      → service-role UPDATE profiles set stripe_customer_id = customer.id
//
//    Why the lookup: if the same human ever ends up with two auth.users rows
//    (see the Google auth / identity-linking item in Open Items), a bare
//    create() gives them two Stripe customers and two live subscriptions.
//    Reusing by email doesn't fix a split profile, but it stops the
//    double-billing, which is the part that reaches a support inbox.
// 3. Create the session:

const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  customer: stripeCustomerId,
  line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
  subscription_data: {
    metadata: { supabase_user_id: user.id }, // rides along on every subscription webhook
  },
  // Only offer the promo box on annual — this is the whole mechanism keeping
  // the $50 discount off the monthly plan, no coupon-scoping needed.
  allow_promotion_codes: plan === 'annual',
  success_url: 'https://stayfullyfunded.com/profile?checkout=success',
  cancel_url:  'https://stayfullyfunded.com/profile?checkout=canceled',
});

return { url: session.url }; // frontend redirects the browser here
```

Putting `supabase_user_id` in `subscription_data.metadata` means every
`customer.subscription.*` event carries it directly — no need to also handle
`checkout.session.completed` just to correlate the user.

**But metadata only rides along on subscriptions created through
*this* session.** The moment you create a subscription any other way — comping
someone from the Dashboard, fixing a botched signup by hand, a Billing Portal
plan switch that creates a new subscription — that subscription has no
`supabase_user_id`, and Part 6's handler hits its `if (!userId) break;` and
silently does nothing. No error, no record, no access granted, and you find out
when the customer emails you.

The fix is small and belongs in Part 6: when metadata is missing, fall back to
looking the user up by `profiles.stripe_customer_id = sub.customer`. Since
step 2 above stores that mapping for every customer you create, the fallback
is reliable. It's written into Part 6 below.

**Note on `allow_promotion_codes`:** setting it to `false` for monthly is fine
and is the right mechanism here. The thing to avoid is passing **both**
`allow_promotion_codes` and `discounts` on the same session — Stripe rejects
that with "You may only specify one of these parameters," and it errors even
when one of them is explicitly `null`. If you ever add auto-applied discounts,
build the params object conditionally and omit the unused key entirely rather
than setting it to null.

---

## Part 6 — Webhook handler

**This part was rewritten.** The original draft would have thrown
on every single event. Four separate problems, all real:

1. `stripe.webhooks.constructEvent()` **throws** in a Worker — workerd has no
   synchronous HMAC, only promise-based WebCrypto. The SDK detects this and
   its error message literally tells you to use `constructEventAsync`. It also
   needs the **raw body string** (`await request.text()`), never a parsed
   object. Related good news: `Stripe.createFetchHttpClient()` is no longer
   needed — modern stripe-node auto-detects Workers via package export
   conditions, so `new Stripe(key)` is enough.
2. `sub.current_period_end` **doesn't exist** as of `2025-03-31.basil`. It's
   `sub.items.data[0].current_period_end`. The original would produce
   `new Date(undefined * 1000)` → `new Date(NaN)` → `.toISOString()` throws
   `RangeError: Invalid time value`, 500ing the webhook on every delivery.
3. `invoice.subscription` **doesn't exist** as of the same version. It's
   `invoice.parent.subscription_details.subscription`.
4. Stripe delivers events **out of order**, and `on conflict do update`
   overwrites blindly — a stale `customer.subscription.updated` arriving late
   can revert a newer status. The cheap fix at your volume: never trust the
   event payload's subscription object, always re-fetch by ID and write the
   fresh truth. That collapses the invoice-vs-subscription shape difference
   into one code path too, so it's simpler *and* more correct.

Also add `stripe` to `Webhook/package.json` — it isn't a dependency yet.

```js
// POST /webhooks/stripe
// No CORS here — this is a server-to-server endpoint, not browser-called.

const sig = request.headers.get('stripe-signature');
const rawBody = await request.text();          // raw string, NOT request.json()

let event;
try {
  // constructEventAsync, not constructEvent — see note 1 above.
  event = await stripe.webhooks.constructEventAsync(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
} catch (err) {
  console.error('Stripe signature verification failed:', err);
  return new Response('Invalid signature', { status: 400 });  // 400 = don't retry
}

// Resolve the subscription ID from whichever event shape we got, then ALWAYS
// re-fetch. Never read state off event.data.object (note 4).
let subscriptionId = null;
if (event.type.startsWith('customer.subscription.')) {
  subscriptionId = event.data.object.id;
} else if (event.type === 'invoice.paid') {
  const invoice = event.data.object;
  if (invoice.parent?.type === 'subscription_details') {
    subscriptionId = invoice.parent.subscription_details.subscription;
  }
}
if (!subscriptionId) return Response.json({ received: true });

const sub = await stripe.subscriptions.retrieve(subscriptionId);

// Deleted subscriptions come back with status 'canceled' already, so there's
// no separate branch to write — the re-fetch tells the truth either way.
const item     = sub.items.data[0];
const priceId  = item.price.id;
const plan     = priceId === env.STRIPE_PRICE_ANNUAL ? 'annual' : 'monthly';
const periodEnd = new Date(item.current_period_end * 1000).toISOString(); // item-level (note 2)

// Prefer metadata; fall back to the customer mapping for subscriptions
// created outside Checkout (Dashboard comps, manual fixes) — see Part 5.
let userId = sub.metadata?.supabase_user_id ?? null;
if (!userId) {
  userId = await findUserIdByStripeCustomerId(env, sub.customer);
}
if (!userId) {
  console.error('Stripe webhook: no user for subscription', sub.id, 'customer', sub.customer);
  return Response.json({ received: true });   // 200: retrying won't fix it
}

await upsertSubscriptionFromStripe(env, {
  userId,
  subscriptionId:    sub.id,
  priceId,
  plan,
  status:            sub.status,
  currentPeriodEnd:  periodEnd,
  cancelAtPeriodEnd: sub.cancel_at_period_end,
});

// Direction 2 discount trigger — see Part 4. Dormant until the env var is set.
if (env.STRIPE_COUPON_COURSE_DISCOUNT && plan === 'annual' && ['active','trialing'].includes(sub.status)) {
  // ...(generateUserPromoCode call from Part 4; the unique(user_id, purpose)
  //     constraint added in Part 3 is what makes a retry safe here)
}

return Response.json({ received: true });
```

**Status codes matter here.** Return 400 only for a failed signature check
(Stripe won't retry, correctly — a bad signature never becomes good). Return
200 for "valid event, nothing for us to do," including the no-user case;
returning 500 there would make Stripe retry the same doomed event for days and
bury real failures in the noise. Genuine transient failures (Supabase down)
*should* 500, so the retry actually helps.

**Why `invoice.paid` is included alongside the subscription events:** relying
only on `customer.subscription.updated` to catch renewals is a known gap —
Stripe doesn't reliably fire it on every renewal in every account
configuration. Re-fetching on `invoice.paid` closes that. The `on conflict` in
the upsert function makes reprocessing the same subscription from multiple
event types safe either way.

---

## Part 7 — Billing Portal endpoint ("Manage billing" button)

```js
// POST /api/create-billing-portal-session
// Auth: verify JWT, look up profiles.stripe_customer_id (service role).

const session = await stripe.billingPortal.sessions.create({
  customer: stripeCustomerId,
  return_url: 'https://stayfullyfunded.com/profile',
});

return { url: session.url };
```

This is the entire "cancel / switch plan / update card" UI — Stripe hosts it,
configured back in Part 1 step 7.

Same two requirements as Part 5: CORS headers plus an `OPTIONS`
branch (copy from `report-chat.js`), and a `url.pathname` branch registered in
`api/inbound.js`'s `fetch` export. Also handle the case where
`profiles.stripe_customer_id` is null (a user who never checked out clicking
"Manage billing"): return a clean 400 rather than passing `null` to Stripe.

---

## Part 8 — Expiry reminder email cron

> ### ⚠️ Read this before touching `wrangler.toml`
>
> **A cron trigger and a `scheduled()` export already exist.** The original
> draft was written as if neither did. `Webhook/wrangler.toml` ends with:
>
> ```toml
> [triggers]
> crons = ["0 6 */3 * *"]  # 06:00 UTC every 3rd day
> ```
>
> That's the Supabase keep-alive: a trivial read every three days so the
> Free-tier project never hits 7 days of total inactivity and gets
> auto-paused. It's handled by an existing `scheduled()` export in
> `api/inbound.js` (~line 213).
>
> **If someone "adds" this section by replacing the `[triggers]` block, the
> keep-alive dies silently and Supabase pauses the project a week later.**
> That is the single most damaging mistake available in this entire build.
>
> Two rules:
> 1. **Append** to the `crons` array. Don't replace it.
> 2. **Branch on `event.cron`** inside the existing `scheduled()` export.
>    Cloudflare gives a Worker one `scheduled()` handler for *all* its cron
>    expressions — without a branch, both jobs run on both schedules.

**Cloudflare Cron Trigger** — edit the existing block in `wrangler.toml`:

```toml
[triggers]
crons = [
  "0 6 */3 * *",   # existing: Supabase keep-alive, 06:00 UTC every 3rd day
  "0 13 * * *",    # new: expiry reminder sweep, daily 13:00 UTC
]
```

**Worker scheduled handler** — extend the existing export in `api/inbound.js`
with a branch. Targeted edit; do not rewrite the handler:

```js
export default {
  async fetch(request, env, ctx) { /* existing handler, unchanged */ },

  async scheduled(event, env, ctx) {
    // Both crons land here. Dispatch on the expression that fired.
    if (event.cron === '0 13 * * *') {
      ctx.waitUntil(runExpiryReminderSweep(env));
      return;
    }
    // existing keep-alive body, unchanged
  },
};

async function runExpiryReminderSweep(env) {
  const { data: candidates, error } = await supabaseServiceRole
    .rpc('get_expiry_reminder_candidates');
  if (error) { console.error(error); return; }

  // Two of the original subject lines used em dashes, which
  // CLAUDE.md forbids in production copy (emails included) — the whole
  // promise of this product is helping people not sound AI-written.
  const SUBJECTS = {
    '7_days_before':  'Your Stay Fully Funded access ends in 7 days',
    '3_days_before':  'Your Stay Fully Funded access ends in 3 days',
    'day_of':         'Your Stay Fully Funded access ends today',
    '1_week_after':   "It's been a week. Your access has expired.",
    '1_month_after':  "It's been a month. Pick up where you left off.",
  };

  for (const c of candidates) {
    await sendPostmarkEmail({
      to: c.email,
      subject: SUBJECTS[c.milestone],
      // template linking to https://stayfullyfunded.com/profile?tab=subscription
      // (NOT a raw Stripe Checkout link — the user needs to be authenticated
      // first, so the link goes to the portal, which then creates the session)
    });

    await supabaseServiceRole.from('access_expiry_reminders').insert({
      user_id: c.user_id,
      milestone: c.milestone,
      access_expires_at: c.access_expires_at,
    });
  }
}
```

The `unique(user_id, milestone, access_expires_at)` constraint on the table
means a duplicate insert (e.g. the cron running twice in one day) fails
silently-safe rather than double-sending — worth wrapping that insert in a
try/catch that ignores the unique-violation error specifically.

**Insert before you send, not after.** As written, a Postmark
failure partway through the loop leaves earlier recipients emailed but
unrecorded, and the next day's run emails them again. Insert the
`access_expiry_reminders` row first and treat a unique-violation as "already
handled, skip" — then send. Worst case you drop one email; the alternative is
duplicates, which is worse for this audience.

---

## Part 8b — Website work

The original spec covered the Worker and the database and stopped there. But
the site already has surfaces that assume this feature exists, and the emails
in Part 8 link to one that doesn't. None of this is optional.

1. **`Website/src/pages/Checkout.tsx` is a placeholder.** It currently reads
   `?plan=` and renders "Checkout is coming soon," with a
   `TODO(post-launch): wire Stripe checkout` comment. Paid CTAs already point
   at it. Replace the body with a call to `/api/create-checkout-session`
   (attaching the Supabase access token, same as the Reports tab does) and a
   redirect to the returned `session.url`.

2. **Fill out `SubscriptionTab.tsx`.** Good news: the tab already exists and
   is already wired into `Profile.tsx:160`. It's a stub — its own comment says
   *"Billing/Stripe management lands later"* — and renders only the derived
   account status. It needs: current plan and renewal/expiry date from
   `subscriptions`, a "Manage billing" button hitting
   `/api/create-billing-portal-session`, an upgrade CTA for trial users, and
   any `user_discount_codes` row the user holds (that's what the `select_own`
   RLS policy in Part 3 is for).

3. **The tab isn't URL-addressable, so the reminder emails' link is dead.**
   `Profile.tsx:43` holds the active tab in `useState<Tab>('Account')` with no
   URL involvement, so `/profile?tab=subscription` — the link in every Part 8
   email — just lands on Account. Add a `useSearchParams` read to seed the
   initial tab. Small change, but without it the entire reminder sequence
   points at the wrong screen.

4. **Handle the `?checkout=success` race.** `success_url` returns the user to
   `/profile` immediately, but the `customer.subscription.created` webhook may
   not have landed yet — so a freshly-paid customer can see "Trial" on the
   page they were just redirected to. Don't leave that to chance. Either poll
   the profile a few times over ~10 seconds, or render an explicit "Payment
   received, activating your account" state until `tier` flips to `paid`.

5. **Render the unlimited sentinel as "Unlimited."**
   `AccountTab.tsx:104` renders `{remaining ?? profile.reviews_limit}` under a
   "Reviews remaining" label, so a paid account will literally display
   **99,987**. Special-case it there. (`getAccountStatus()` in
   `lib/accountStatus.ts` already maps a non-trial, unexpired account to the
   string "Unlimited," so the status line itself is fine — it's only the
   numeric credit row that needs handling.)

6. **`COACH_API_URL`** already exists in `Website/src/lib/constants.ts` and is
   what the Reports tab uses. Reuse it; don't introduce a second base URL.

---

## Part 9 — Claude Code handoff prompts

Hand these to Claude Code **one at a time**, in order, with a checkpoint after
each before moving on. Each is self-contained — paste the relevant SQL/code
block from Parts 3, 4, 5, 6, 7, or 8 above directly into the prompt.

0. **Groundwork, first and on its own.** *"Add `stripe` to
   `Webhook/package.json`. Then add the service-role wrapper functions for
   Stripe billing to `lib/supabase.js`, following the existing wrapper
   pattern exactly (private `getClient(env)`, one named export per operation)
   — see the convention note at the end of Part 3 for the list. Nothing else
   yet."** Everything after this depends on it, and doing it inline three
   separate times is how you get three inconsistent versions.
1. **"Run the schema migration in Part 3 via the Supabase SQL Editor, wrapped
   in BEGIN/COMMIT, and save it as
   `Webhook/db/migrations/0012_stripe_billing.sql`. Report back the
   verification queries' results before I confirm anything further."**
2. **"Add the `/api/create-checkout-session` endpoint from Part 5 as a new
   file following the `api/report-chat.js` pattern (CORS const + OPTIONS
   handler), and register its path in `api/inbound.js`'s `fetch` export with
   a targeted edit — do not replace the whole file. Stop before deploying."**
3. **"Add the `/webhooks/stripe` handler from Part 6 (including the Part 4
   discount-trigger snippet). Note it uses `constructEventAsync` and the raw
   request body, re-fetches the subscription rather than trusting the event
   payload, and reads `current_period_end` at the item level. Register the
   path with a targeted edit. Stop before deploying."**
4. **"Add the `/api/create-billing-portal-session` endpoint from Part 7, same
   file/CORS/routing pattern as step 2. Stop before deploying."**
5. **"Add the expiry sweep from Part 8. `wrangler.toml` already
   has a `[triggers] crons` array and `api/inbound.js` already has a
   `scheduled()` export for the Supabase keep-alive — APPEND to the array and
   BRANCH on `event.cron` inside the existing handler. Do not replace either.
   Stop before deploying."**
6. **"Do the Website work in Part 8b."** Worth its own checkpoint,
   and it's the only part you can actually see. Note that `/profile` needs
   real Supabase auth, so verifying it end-to-end means signing in yourself.
7. **Final deploy checkpoint:** re-run local boot, confirm the Postmark
   webhook URL is unaffected (per the existing pre-deploy checklist), confirm
   the keep-alive cron is **still present** in `wrangler.toml`, then deploy.

---

## Part 10 — Testing checklist (test mode)

**Run all of this against `wrangler dev`, not production.** There
is only one Worker and it serves live traffic; putting `sk_test_...` into its
secrets to run this checklist would take real checkout offline for as long as
testing lasts. Instead:

```bash
cd Webhook && npx wrangler dev          # reads test values from .dev.vars
```
```bash
stripe listen --forward-to localhost:8787/webhooks/stripe
```

`stripe listen` prints its own `whsec_...` — that's the one that goes in
`.dev.vars` as `STRIPE_WEBHOOK_SECRET` for local runs, not the Dashboard
endpoint's. You can replay individual events with `stripe trigger
customer.subscription.updated` instead of clicking through Checkout each time.

Create the real Dashboard webhook endpoint (Part 1 step 5) only once this
checklist passes and you're switching to live mode.

1. Create a Checkout session for the annual plan → confirm the promo box
   appears; for monthly → confirm it does **not**.
2. Complete a test checkout (`4242 4242 4242 4242`, any future date/CVC) →
   confirm `subscriptions` row appears and `profiles.tier` flips to `paid`
   with `access_expires_at` ~1 period out.
3. Generate a promo code for a test customer (Part 4) → attempt to redeem it
   on a *different* test customer's Checkout session → confirm Stripe rejects
   it.
4. Cancel the test subscription from the Billing Portal → confirm the
   `customer.subscription.deleted` webhook fires and `subscriptions.status`
   updates to `canceled`.
5. Manually backdate a test profile's `access_expires_at` to trigger each of
   the 5 milestones → run `get_expiry_reminder_candidates()` directly in SQL
   Editor → confirm the right rows appear and re-running doesn't return
   duplicates.
6. Confirm an authenticated test user **cannot** update their own
   `reviews_limit`, **cannot** read another user's `subscriptions` or
   `user_discount_codes` rows, and **cannot** call
   `upsert_subscription_from_stripe` or `get_expiry_reminder_candidates`
   directly (no grants exist for `authenticated`).

**Seven more, covering the bugs this review found.** Each one maps to
a specific failure the original spec would have shipped:

7. **Trial upgrade doesn't shorten access.** Take a test profile with
   `access_expires_at` ~80 days out, subscribe it to **monthly**, and confirm
   `access_expires_at` is still ~80 days out — not pulled back to ~30. (The
   `greatest()` fix in Part 3.)
8. **Active subscribers get no expiry emails.** Set a paid, auto-renewing test
   profile's `access_expires_at` to exactly 7 days from now and run
   `get_expiry_reminder_candidates()`. It must return **zero rows** for them.
   Then nudge `access_expires_at` by one second so it no longer matches
   `subscriptions.current_period_end` and run it again — still zero rows. That
   second check is the whole point of the rewritten exclusion.
9. **`past_due` accounts get no reminder either, but do get the win-back.**
   Set a test subscription's status to `past_due` with `access_expires_at`
   7 days out and confirm `get_expiry_reminder_candidates()` returns nothing
   for them. Then flip the status to `canceled`, backdate
   `access_expires_at` by 7 days, and confirm the `1_week_after` row now
   appears. That's the full dunning handoff: quiet while Stripe retries,
   win-back once Stripe gives up.
10. **The keep-alive cron survived.** After deploying, confirm
   `wrangler.toml` still lists `"0 6 */3 * *"` alongside the new daily cron,
   and that the Worker's `scheduled()` handler branches on `event.cron`.
   Trigger both locally: `wrangler dev --test-scheduled` then
   `curl "localhost:8787/__scheduled?cron=0+6+*/3+*+*"` and
   `curl "localhost:8787/__scheduled?cron=0+13+*+*+*"` — each should run only
   its own job.
11. **Webhook signature failure returns 400, not 500.** `curl` the endpoint
    with a garbage `stripe-signature` header. A 500 here would make Stripe
    retry a permanently-doomed event for days.
12. **A subscription with no metadata still resolves.** Create one directly in
    the Stripe Dashboard for a test customer whose ID is already in
    `profiles.stripe_customer_id`. Confirm the customer-mapping fallback finds
    the user and grants access. This is the "comping someone" path.
13. **A paused subscription doesn't 500 the webhook.** Set `pause_collection`
    on a test subscription and confirm the `paused` status writes cleanly
    rather than failing the enum.

---

## Open items still needing your input later

- Course price ($79 vs $97) and the discount amount for annual-subscriber →
  Course — not needed until you build the Course's own checkout.
- Whether existing pilot users get an automatic upgrade prompt at their
  30-day window or a manual nudge from you (doesn't block anything above).
- The actual Course-purchase webhook that Direction 1 hangs off — doesn't
  exist yet, so that call site is ready but unwired.
- **Sales tax.** Deliberately not in scope above, and probably
  right to defer for a $19 SaaS at this stage. One thing to know before you
  eventually turn on Stripe Tax: it only charges tax in jurisdictions where
  you've added an active registration, and with none configured it calculates
  **zero tax silently** — no error, no warning. So `automatic_tax: { enabled:
  true }` can look like it's working while collecting nothing. If you do
  enable it later, also set `billing_address_collection: 'required'`, or
  renewal invoices can stall at `automatic_tax.status = 'requires_inputs'`
  when the stored address isn't specific enough.
- **A direction-1 backfill.** The original spec flagged this for
  direction 2; it applies to direction 1 too. Any Course buyer who purchases
  before that webhook is wired gets no code, so keep a list or plan a
  one-time script.

- **Google auth and identity linking — verify this before Google
  sign-in goes live.** Billing is keyed to `profiles.id`, which is 1:1 with
  `auth.users`. If one human ends up with **two** `auth.users` rows, they get
  two profiles, two review slugs, and two `stripe_customer_id` values — and
  the failure surfaces as a support ticket from someone who already paid but
  is looking at an unpaid account.

  Nothing is wrong today. Verified against production during the code review:
  15 auth users, 15 identities, provider `email` across the board, zero
  duplicate email addresses. So this is a pre-flight check, not a defect.

  Supabase's documented default is to automatically link identities that share
  a **verified** email, which would make this a non-event. But that hinges on
  the provider actually returning the address as verified, and it isn't worth
  betting a paying customer on a docs reading. **Test it empirically** — five
  minutes and completely definitive:

  1. Sign up a throwaway address by magic link.
  2. Sign in to that same address with Google.
  3. `select count(*) from auth.users where email = '...'`

  One user with two rows in `auth.identities` means linking works and this
  item closes. Two users means it's a signup-flow problem to solve at the auth
  layer before Google ships — not something to work around in billing.

  Independent of the outcome, Part 5 step 2 reuses an existing Stripe customer
  by email rather than blindly creating one, which caps the blast radius at a
  split profile instead of a double charge.
