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

const PLAN_LABEL: Record<SubscriptionRow['plan'], string> = {
  monthly: 'Monthly ($19/mo)',
  annual: 'Annual ($97/yr)',
}

// Polls up to 5 times over ~10 seconds after a successful checkout, since
// success_url returns here before the subscription webhook is guaranteed to
// have landed. See stripe-billing-build-spec.md Part 8b item 4.
const ACTIVATION_POLL_ATTEMPTS = 5
const ACTIVATION_POLL_INTERVAL_MS = 2000

export function SubscriptionTab({
  userId,
  accountStatus,
}: {
  userId: string | undefined
  accountStatus: AccountStatus | null
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

  return (
    <div className="space-y-6">
      {showActivatingBanner && (
        <div className="rounded-2xl border border-primary/30 bg-band-emerald px-5 py-4 text-sm text-primary-dark">
          Payment received. We're setting up your account now, this usually takes just a
          moment.
        </div>
      )}

      <div className="rounded-2xl border border-border bg-surface p-7 shadow-sm">
        <h2 className="font-heading text-xl font-semibold">Subscription</h2>
        <p className={`mt-2 text-lg font-semibold ${accountStatusColor(accountStatus)}`}>
          {accountStatus ?? 'Unknown'}
        </p>

        {loading ? (
          <div className="mt-5 space-y-3">
            <div className="h-5 w-1/2 animate-pulse rounded bg-band-emerald/60" />
            <div className="h-10 w-40 animate-pulse rounded-full bg-band-emerald/60" />
          </div>
        ) : isLive && subscription ? (
          <div className="mt-5">
            <dl className="divide-y divide-border">
              <div className="flex items-center justify-between gap-4 py-3">
                <dt className="text-sm font-medium text-muted">Plan</dt>
                <dd className="text-right font-semibold text-ink">
                  {PLAN_LABEL[subscription.plan]}
                </dd>
              </div>
              {subscription.current_period_end && (
                <div className="flex items-center justify-between gap-4 py-3">
                  <dt className="text-sm font-medium text-muted">
                    {subscription.cancel_at_period_end ? 'Cancels on' : 'Renews on'}
                  </dt>
                  <dd className="text-right font-semibold text-ink">
                    {formatDate(subscription.current_period_end)}
                  </dd>
                </div>
              )}
            </dl>

            {subscription.status === 'past_due' && (
              <p className="mt-3 rounded-lg bg-band-brick px-3 py-2 text-sm text-brick">
                We couldn't charge your card for this billing period. Update your payment
                method to keep your access going.
              </p>
            )}

            <Button
              variant="outline"
              size="sm"
              className="mt-5"
              onClick={openBillingPortal}
              disabled={portalLoading}
            >
              {portalLoading ? 'Opening…' : 'Manage billing'}
            </Button>
            {portalError && (
              <p className="mt-2 text-sm text-brick">{portalError}</p>
            )}
          </div>
        ) : (
          <div className="mt-5">
            <p className="leading-relaxed text-muted">
              Ready for unlimited reviews before every send?
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button onClick={() => navigate('/checkout?plan=annual')}>
                Go annual ($97/yr)
              </Button>
              <Button variant="outline" onClick={() => navigate('/checkout?plan=monthly')}>
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
