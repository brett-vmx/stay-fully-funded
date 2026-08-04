import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { COACH_API_URL } from '../../lib/constants'
import { formatDate } from '../../lib/formatDate'
import { Button } from '../ui/Button'
import type { AccountStatus } from '../../lib/accountStatus'
import { accountStatusColor } from '../../lib/accountStatus'

type SubscriptionRow = {
  plan: 'monthly' | 'annual'
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

const PLAN_LABEL: Record<SubscriptionRow['plan'], string> = {
  monthly: 'Monthly ($19/mo)',
  annual: 'Annual ($97/yr)',
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
  const showActivatingBanner = checkoutStatus === 'success' && !isLive
  // Based on the reviews_limit sentinel, not accountStatus: a pilot account is
  // also "Unlimited" by status but has a real, finite limit (25) that should
  // still get a proper bar.
  const isUnlimited = (reviewsLimit ?? 0) >= UNLIMITED_THRESHOLD
  const limit = reviewsLimit ?? 0
  // remaining_reviews() already clamps at 0, so this can't go negative even if
  // an account somehow consumed more than its limit.
  const used = reviewsRemaining == null ? 0 : Math.max(0, limit - reviewsRemaining)

  let scope = 'No expiration'
  let scopeTone = 'text-muted'
  if (accountStatus === 'Expired' && formattedExpiresAt) {
    scope = `Access ended ${formattedExpiresAt}`
    scopeTone = 'text-brick'
  } else if (isLive && subscription?.current_period_end) {
    scope = `${subscription.cancel_at_period_end ? 'Cancels' : 'Renews'} ${formatDate(
      subscription.current_period_end,
    )}`
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
        ) : isLive && subscription ? (
          <div className="mt-5">
            <dl className="divide-y divide-border">
              <div className="flex items-center justify-between gap-4 py-3">
                <dt className="text-sm font-medium text-muted">Plan</dt>
                <dd className="text-right font-semibold text-ink">
                  {PLAN_LABEL[subscription.plan]}
                </dd>
              </div>
            </dl>

            {subscription.status === 'past_due' && (
              <p className="mt-3 rounded-lg bg-band-brick px-3 py-2 text-sm text-brick">
                We couldn't charge your card for this billing period. Update your payment
                method to keep your access going.
              </p>
            )}

            {/* Same destination either way (Stripe's portal handles both
                reactivating and card/plan changes), but the label and weight
                follow what the person most likely came here to do. With a
                cancellation already scheduled, "Manage billing" buries the one
                action that matters; Stripe's own portal calls it "Renew
                subscription", so the wording matches what they'll see next. */}
            <Button
              variant={subscription.cancel_at_period_end ? 'primary' : 'outline'}
              size="sm"
              className="mt-5"
              onClick={openBillingPortal}
              disabled={portalLoading}
            >
              {portalLoading
                ? 'Opening…'
                : subscription.cancel_at_period_end
                  ? 'Renew subscription'
                  : 'Manage billing'}
            </Button>
            {portalError && <p className="mt-2 text-sm text-brick">{portalError}</p>}
          </div>
        ) : (
          <div className="mt-5 rounded-xl bg-primary-dark px-5 py-5">
            <p className="font-heading font-semibold text-white">
              Ready for unlimited reviews before every send?
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button variant="onDark" onClick={() => navigate('/checkout?plan=annual')}>
                Go annual ($97/yr)
              </Button>
              <Button variant="onDarkMuted" onClick={() => navigate('/checkout?plan=monthly')}>
                Go monthly ($19/mo)
              </Button>
            </div>
          </div>
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
