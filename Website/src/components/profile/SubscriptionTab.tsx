import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { COACH_API_URL } from '../../lib/constants'
import { formatDate } from '../../lib/formatDate'
import { Button } from '../ui/Button'
import type { AccountStatus } from '../../lib/accountStatus'
import { accountStatusColor } from '../../lib/accountStatus'

type Plan = 'monthly' | 'annual'

type SubscriptionRow = {
  plan: Plan
  status: string
  current_period_end: string | null
  cancel_at_period_end: boolean
}

type DiscountCodeRow = {
  code: string
  purpose: 'coach_discount_for_course_buyer' | 'course_discount_for_annual_subscriber'
}

// Matches the statuses upsert_subscription_from_stripe treats as a genuinely
// live subscription (see db/migrations/0013's corrected exclusion set).
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due'])

// upsert_subscription_from_stripe sets reviews_limit to 100000 for paid
// accounts ("effectively unlimited") rather than adding tier-branching to
// the quota check. Any real launch-tier limit (10 trial, 25 pilot) is far
// below this, so treating it as a threshold is safe.
const UNLIMITED_THRESHOLD = 10000

// The plan name now appears only in the meter's scope line ("Annual plan
// renews on ..."), which replaced a separate Plan row.
const PLAN_NAME: Record<Plan, string> = {
  monthly: 'Monthly',
  annual: 'Annual',
}

// Polls up to 5 times over ~10 seconds after a successful checkout, since
// success_url returns here before the subscription webhook is guaranteed to
// have landed. See stripe-billing-build-spec.md Part 8b item 4.
const ACTIVATION_POLL_ATTEMPTS = 5
const ACTIVATION_POLL_INTERVAL_MS = 2000

/**
 * Usage meter: how many reviews have been used, out of how many. The
 * `scope` line under the label carries the access window (trial expiry,
 * renewal date, or "No expiration") — pairing the two limits, count and
 * deadline, as one fact instead of two rows. It also avoids showing a paid
 * subscriber two near-identical dates, which is what a separate
 * "Access expires on" row did alongside the plan's own renewal date.
 *
 * Unlimited accounts get no progress bar: there's no proportion to show, so
 * a bar would be decoration at best and misleading at worst.
 */
function UsageMeter({
  used,
  limit,
  unlimited,
  scope,
  scopeTone,
}: {
  used: number
  limit: number
  unlimited: boolean
  scope: string
  scopeTone: string
}) {
  const exhausted = !unlimited && used >= limit
  const pct = unlimited || limit <= 0 ? 0 : Math.min(100, Math.round((used / limit) * 100))

  return (
    <div className="rounded-xl border border-border px-5 py-4">
      <p className="font-heading font-bold text-ink">Reviews used</p>
      <p className={`mt-0.5 text-sm ${scopeTone}`}>{scope}</p>

      <p className="mt-4 font-heading text-3xl font-bold text-ink">
        {used}
        <span className="text-xl font-semibold text-muted">
          {' / '}
          {unlimited ? '∞' : limit}
        </span>
      </p>

      {!unlimited && (
        <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-border">
          <div
            className={`h-full rounded-full ${exhausted ? 'bg-brick' : 'bg-primary-dark'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  )
}

/**
 * The dark-green "pick a plan" callout. Shared by two states that ask the same
 * question but answer it through different mechanisms: a trial/expired account
 * starts a new subscription via Checkout, while a canceling one clears its
 * pending cancellation in place. Only the copy and the handler differ.
 */
function PlanChoiceBlock({
  headline,
  note,
  busyPlan,
  error,
  onChoose,
}: {
  headline: string
  note?: string
  busyPlan?: Plan | null
  error?: string | null
  onChoose: (plan: Plan) => void
}) {
  const busy = busyPlan != null
  return (
    <div className="mt-5 rounded-xl bg-primary-dark px-5 py-5">
      <p className="font-heading font-semibold text-white">{headline}</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button variant="onDark" disabled={busy} onClick={() => onChoose('annual')}>
          {busyPlan === 'annual' ? 'Working…' : 'Go annual ($97/yr)'}
        </Button>
        <Button variant="onDarkMuted" disabled={busy} onClick={() => onChoose('monthly')}>
          {busyPlan === 'monthly' ? 'Working…' : 'Go monthly ($19/mo)'}
        </Button>
      </div>
      {note && <p className="mt-3 text-sm text-white/80">{note}</p>}
      {error && (
        <p className="mt-3 rounded-lg bg-surface px-3 py-2 text-sm text-brick">{error}</p>
      )}
    </div>
  )
}

export function SubscriptionTab({
  userId,
  accountStatus,
  loadingAccount,
  reviewsRemaining,
  reviewsLimit,
  formattedExpiresAt,
  expiresSoon,
}: {
  userId: string | undefined
  accountStatus: AccountStatus | null
  /** Profile.tsx's own profile-fetch loading flag — governs the meter, whose
   *  data comes from `profiles`, not from this component's own (separately
   *  loading) subscription fetch. */
  loadingAccount: boolean
  /** From the live remaining_reviews() RPC. `used` is derived from this rather
   *  than read off the denormalized profiles.reviews_used column, so the
   *  number shown can never disagree with what can_request_review() actually
   *  enforces. */
  reviewsRemaining: number | null
  reviewsLimit: number | undefined
  formattedExpiresAt: string | null
  expiresSoon: boolean
}) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const checkoutStatus = params.get('checkout')

  const [subscription, setSubscription] = useState<SubscriptionRow | null>(null)
  const [discountCodes, setDiscountCodes] = useState<DiscountCodeRow[]>([])
  const [loading, setLoading] = useState(true)
  const [portalLoading, setPortalLoading] = useState(false)
  const [portalError, setPortalError] = useState<string | null>(null)
  const [reactivatingPlan, setReactivatingPlan] = useState<Plan | null>(null)
  const [reactivateError, setReactivateError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase || !userId) {
      setLoading(false)
      return
    }

    let cancelled = false
    let attempts = 0

    async function load() {
      if (!supabase) return
      const [subRes, codesRes] = await Promise.all([
        supabase
          .from('subscriptions')
          .select('plan, status, current_period_end, cancel_at_period_end')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase.from('user_discount_codes').select('code, purpose').eq('user_id', userId),
      ])
      if (cancelled) return

      const sub = (subRes.data as SubscriptionRow) ?? null
      setSubscription(sub)
      setDiscountCodes((codesRes.data as DiscountCodeRow[]) ?? [])
      setLoading(false)

      const isLive = sub != null && LIVE_STATUSES.has(sub.status)
      if (checkoutStatus === 'success' && !isLive && attempts < ACTIVATION_POLL_ATTEMPTS) {
        attempts += 1
        setTimeout(load, ACTIVATION_POLL_INTERVAL_MS)
      }
    }

    load()
    return () => {
      cancelled = true
    }
    // checkoutStatus intentionally excluded: it's read once from the URL this
    // tab mounted with, not something that should restart the poll loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  /**
   * Stripe is the source of truth the moment the reactivate call returns, but
   * our `subscriptions` row only catches up when the resulting
   * customer.subscription.updated webhook lands. Poll our own row until the
   * pending cancellation clears rather than optimistically faking it locally:
   * a plan switch also moves current_period_end (the billing anchor resets),
   * and guessing that date would put a wrong renewal date on screen.
   */
  async function pollUntilRenewing(attempt = 0) {
    if (!supabase || !userId) return
    const { data } = await supabase
      .from('subscriptions')
      .select('plan, status, current_period_end, cancel_at_period_end')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const row = (data as SubscriptionRow) ?? null
    if (row) setSubscription(row)

    if (row?.cancel_at_period_end && attempt < ACTIVATION_POLL_ATTEMPTS) {
      setTimeout(() => pollUntilRenewing(attempt + 1), ACTIVATION_POLL_INTERVAL_MS)
      return
    }
    setReactivatingPlan(null)
  }

  async function reactivate(plan: Plan) {
    if (!supabase || reactivatingPlan) return
    setReactivatingPlan(plan)
    setReactivateError(null)
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('Not signed in')

      const res = await fetch(`${COACH_API_URL}/api/reactivate-subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ plan }),
      })
      const data = (await res.json()) as { error?: string; code?: string }

      if (!res.ok) {
        // The subscription already lapsed to `canceled`, which can't be
        // updated back to life — that case genuinely does need a new Checkout
        // session, and there's no double-billing risk once nothing is active.
        if (data.code === 'needs_checkout') {
          navigate(`/checkout?plan=${plan}`)
          return
        }
        throw new Error(data.error || `Reactivation failed: ${res.status}`)
      }

      await pollUntilRenewing()
    } catch (err) {
      console.error('Failed to reactivate subscription:', err)
      setReactivateError(
        err instanceof Error ? err.message : 'Something went wrong. Try again.',
      )
      setReactivatingPlan(null)
    }
  }

  async function openBillingPortal() {
    if (!supabase || portalLoading) return
    setPortalLoading(true)
    setPortalError(null)
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('Not signed in')

      const res = await fetch(`${COACH_API_URL}/api/create-billing-portal-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      })
      const data = (await res.json()) as { url?: string; error?: string }
      if (!res.ok || !data.url) {
        throw new Error(data.error || `Billing portal request failed: ${res.status}`)
      }
      window.location.href = data.url
    } catch (err) {
      console.error('Failed to open billing portal:', err)
      setPortalError(
        err instanceof Error ? err.message : 'Something went wrong opening billing.',
      )
      setPortalLoading(false)
    }
  }

  const isLive = subscription != null && LIVE_STATUSES.has(subscription.status)
  const isCanceling = isLive && subscription!.cancel_at_period_end
  const showActivatingBanner = checkoutStatus === 'success' && !isLive
  // Based on the reviews_limit sentinel, not accountStatus: a pilot account is
  // also "Unlimited" by status but has a real, finite limit (25) that should
  // still get a proper bar.
  const isUnlimited = (reviewsLimit ?? 0) >= UNLIMITED_THRESHOLD
  const limit = reviewsLimit ?? 0
  // remaining_reviews() already clamps at 0, so this can't go negative even if
  // an account somehow consumed more than its limit.
  const used = reviewsRemaining == null ? 0 : Math.max(0, limit - reviewsRemaining)

  // The plan name rides in the scope line rather than getting its own row, so
  // "Annual plan cancels on August 20" reads as one fact.
  let scope = 'No expiration'
  let scopeTone = 'text-muted'
  if (accountStatus === 'Expired' && formattedExpiresAt) {
    scope = `Access ended ${formattedExpiresAt}`
    scopeTone = 'text-brick'
  } else if (isLive && subscription?.current_period_end) {
    const when = formatDate(subscription.current_period_end)
    if (isCanceling) {
      scope = `${PLAN_NAME[subscription.plan]} plan cancels on ${when}`
      scopeTone = 'text-brick'
    } else {
      scope = `${PLAN_NAME[subscription.plan]} plan renews on ${when}`
    }
  } else if (formattedExpiresAt) {
    scope = `Free access until ${formattedExpiresAt}`
    if (expiresSoon) scopeTone = 'text-brick'
  }

  return (
    <div className="space-y-6">
      {showActivatingBanner && (
        <div className="rounded-2xl border border-primary/30 bg-band-emerald px-5 py-4 text-sm text-primary-dark">
          Payment received. We're setting up your account now, this usually takes just a
          moment.
        </div>
      )}

      <div className="rounded-2xl border border-border bg-surface p-7 shadow-sm">
        <h2 className="font-heading text-xl font-semibold">
          Subscription
          {accountStatus && (
            <>
              <span className="text-muted"> - </span>
              <span className={accountStatusColor(accountStatus)}>{accountStatus}</span>
            </>
          )}
        </h2>

        <div className="mt-5">
          {loadingAccount ? (
            <div className="h-32 w-full animate-pulse rounded-xl bg-band-emerald/60" />
          ) : (
            <UsageMeter
              used={used}
              limit={limit}
              unlimited={isUnlimited}
              scope={scope}
              scopeTone={scopeTone}
            />
          )}
        </div>

        {loading ? (
          <div className="mt-5 h-10 w-40 animate-pulse rounded-full bg-band-emerald/60" />
        ) : isCanceling && subscription ? (
          // Same callout as a trial sees, because the decision is the same one:
          // pick a plan. The buttons do NOT go through /checkout though — this
          // subscription is still active, and a Checkout session would create a
          // SECOND one and bill twice. They clear the pending cancellation in
          // place instead. See api/reactivate-subscription.js.
          <PlanChoiceBlock
            headline="I don't want to lose access to the Stay Fully Funded Email Coach!"
            note={`Picking ${
              subscription.plan === 'annual' ? 'Monthly' : 'Annual'
            } switches your plan and bills it today, with credit for the time you haven't used.`}
            busyPlan={reactivatingPlan}
            error={reactivateError}
            onChoose={reactivate}
          />
        ) : isLive && subscription ? (
          <div className="mt-5">
            {subscription.status === 'past_due' && (
              <p className="mb-4 rounded-lg bg-band-brick px-3 py-2 text-sm text-brick">
                We couldn't charge your card for this billing period. Update your payment
                method to keep your access going.
              </p>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={openBillingPortal}
              disabled={portalLoading}
            >
              {portalLoading ? 'Opening…' : 'Manage billing'}
            </Button>
            {portalError && <p className="mt-2 text-sm text-brick">{portalError}</p>}
          </div>
        ) : (
          <PlanChoiceBlock
            headline="Ready for unlimited reviews before every send?"
            onChoose={(plan) => navigate(`/checkout?plan=${plan}`)}
          />
        )}
      </div>

      {discountCodes.length > 0 && (
        <div className="rounded-2xl border border-border bg-band-emerald px-5 py-4">
          {discountCodes.map((dc) => (
            <p key={dc.code} className="text-sm text-primary-dark">
              {dc.purpose === 'coach_discount_for_course_buyer' ? (
                <>
                  You have a $50 discount code for the annual Coach plan:{' '}
                  <strong>{dc.code}</strong>
                </>
              ) : (
                <>
                  You have a discount code for the Course: <strong>{dc.code}</strong>
                </>
              )}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
