import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SimplePage } from './SimplePage'
import { supabase } from '../lib/supabase'
import { COACH_API_URL } from '../lib/constants'

/**
 * Starts a Stripe Checkout session for the signed-in user and redirects them
 * there. Route is wrapped in ProtectedRoute (see App.tsx), so a session is
 * guaranteed to exist by the time this mounts.
 *
 * The `cancelled` flag alone (no extra mounted-once ref) is the correct
 * StrictMode-safe pattern here, matching every other data-fetching effect in
 * this codebase (SubscriptionTab.tsx, ReportDialog.tsx): React's dev-only
 * double-invoke reuses the same ref object across its fake unmount/remount,
 * so a ref-based "only run once" guard blocks the SECOND, real, surviving
 * mount from ever running — while the FIRST, fake mount's own call is the
 * one that actually fires, and its result gets discarded by `cancelled` on
 * cleanup. Net effect with a ref guard: the UI never updates after the real
 * mount takes over, in dev only. Letting both mounts fire independently, and
 * only the still-mounted one's `cancelled` stay false, is what everything
 * else here already does — this creates one extra abandoned Checkout
 * Session per dev-mode page load, which is harmless.
 */
export function Checkout() {
  const [params] = useSearchParams()
  const plan = params.get('plan') === 'annual' ? 'annual' : 'monthly'
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function startCheckout() {
      if (!supabase) {
        setError('Checkout is unavailable right now.')
        return
      }

      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) {
        setError('Your session expired. Sign in again and try once more.')
        return
      }

      try {
        const res = await fetch(`${COACH_API_URL}/api/create-checkout-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ plan }),
        })
        const data = (await res.json()) as { url?: string; error?: string }
        if (!res.ok || !data.url) {
          throw new Error(data.error || `Checkout request failed: ${res.status}`)
        }
        if (cancelled) return
        window.location.href = data.url
      } catch (err) {
        console.error('Failed to start checkout:', err)
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Something went wrong starting checkout.',
          )
        }
      }
    }

    startCheckout()
    return () => {
      cancelled = true
    }
  }, [plan])

  return (
    <SimplePage title={error ? 'Checkout ran into a problem' : 'Setting up your checkout'}>
      {error ? (
        <>
          <p className="rounded-lg bg-band-brick px-3 py-2 text-sm text-brick">{error}</p>
          <p>
            Refresh this page to try again, or reach out and we'll get you sorted.
          </p>
        </>
      ) : (
        <p>
          Redirecting you to a secure Stripe checkout page for the{' '}
          {plan === 'annual' ? 'annual ($97/yr)' : 'monthly ($19/mo)'} plan.
        </p>
      )}
    </SimplePage>
  )
}
