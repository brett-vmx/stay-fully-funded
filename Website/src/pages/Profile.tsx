import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useSession } from '../lib/useSession'
import { REVIEW_DOMAIN } from '../lib/constants'
import { Logo } from '../components/ui/LogoMark'
import { Button } from '../components/ui/Button'
import { type DeclaredFields } from '../components/profile/ProfileDetailsForm'
import { AccountDetailsCard } from '../components/profile/AccountDetailsCard'
import { ProfileDetailsCard } from '../components/profile/ProfileDetailsCard'
import { ReportsTab } from '../components/profile/ReportsTab'
import { SubscriptionTab } from '../components/profile/SubscriptionTab'
import { getAccountStatus } from '../lib/accountStatus'
import { formatDate } from '../lib/formatDate'

type ProfileRow = {
  review_slug: string
  reviews_limit: number
  access_expires_at: string | null
  tier: string
} & DeclaredFields

// Subscription info lives on the Account tab now (identity, usage, and
// billing together, rather than split across tabs) — see AccountDetailsCard,
// SubscriptionTab, and ProfileDetailsCard, composed below in that order.
const TABS = ['Account', 'Reports'] as const
type Tab = (typeof TABS)[number]

/**
 * Seeds the initial tab from ?tab=. Read once at mount, not kept in sync on
 * every click — this is about landing on the right tab, not full URL
 * routing. An unmatched value (e.g. a stale bookmark or email link) just
 * falls through to Account.
 */
function initialTabFrom(params: URLSearchParams): Tab {
  const requested = params.get('tab')?.toLowerCase()
  return TABS.find((t) => t.toLowerCase() === requested) ?? 'Account'
}

/** Whole days from now until `iso` (negative if already past). */
function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now()
  return Math.ceil(ms / (1000 * 60 * 60 * 24))
}

export function Profile() {
  const { session } = useSession()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const email = session?.user.email
  const userId = session?.user.id

  const [profile, setProfile] = useState<ProfileRow | null>(null)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  // null while unresolved; true only on someone's very first /profile visit.
  const [isFirstVisit, setIsFirstVisit] = useState<boolean | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>(() => initialTabFrom(searchParams))

  useEffect(() => {
    if (!supabase || !userId) {
      setLoading(false)
      return
    }
    setLoading(true)
    Promise.all([
      supabase
        .from('profiles')
        .select(
          'review_slug, reviews_limit, access_expires_at, tier, first_name, last_name, city, country, ministry_title, organization_name, college_campus, coach_instructions',
        )
        .eq('id', userId)
        .maybeSingle(),
      supabase.rpc('remaining_reviews', { p_user_id: userId }),
      supabase.rpc('mark_profile_seen'),
    ]).then(([profileRes, remainingRes, seenRes]) => {
      setProfile((profileRes.data as ProfileRow) ?? null)
      setRemaining(typeof remainingRes.data === 'number' ? remainingRes.data : null)
      setIsFirstVisit(seenRes.data === true)
      setLoading(false)
    })
  }, [userId])

  const reviewAddress = profile ? `${profile.review_slug}@${REVIEW_DOMAIN}` : null
  // Falls back to email for accounts created before first-name capture existed.
  const greetingName = profile?.first_name || email

  async function copyAddress() {
    if (!reviewAddress) return
    try {
      await navigator.clipboard.writeText(reviewAddress)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be blocked (e.g. insecure context); fail quietly.
    }
  }

  async function signOut() {
    await supabase?.auth.signOut()
    navigate('/', { replace: true })
  }

  const expiresSoon =
    profile?.access_expires_at != null && daysUntil(profile.access_expires_at) <= 7
  const formattedExpiresAt = profile?.access_expires_at
    ? formatDate(profile.access_expires_at)
    : null
  const accountStatus = profile ? getAccountStatus(profile) : null

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 w-full max-w-4xl items-center justify-between px-5 sm:px-8">
          <Logo />
          <Button variant="ghost" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-16 sm:px-8">
        <h1 className="text-3xl font-bold sm:text-4xl">
          {loading ? (
            'Welcome'
          ) : (
            <>
              {isFirstVisit ? 'You’re in' : 'Welcome back'}
              {greetingName ? ',' : '.'}{' '}
              {greetingName && <span className="text-primary">{greetingName}</span>}
            </>
          )}
        </h1>
        {/* Skip when greetingName already IS the email (no first_name set
            yet) — showing it twice in a row would be redundant. */}
        {!loading && email && email !== greetingName && (
          <p className="mt-2 text-base text-muted">{email}</p>
        )}
        {isFirstVisit && (
          <p className="mt-4 text-lg leading-relaxed text-muted">
            Welcome to Stay Fully Funded. You’re all set to start sending drafts to the Coach.
          </p>
        )}

        <div role="tablist" aria-label="Profile sections" className="mt-8 flex gap-6 border-b border-border">
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => setActiveTab(tab)}
              className={`-mb-px border-b-2 px-1 pb-3 text-sm font-semibold transition-colors ${
                activeTab === tab
                  ? 'border-primary text-primary-dark'
                  : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <div role="tabpanel" className="mt-6">
          {activeTab === 'Account' && (
            <div className="space-y-6">
              <AccountDetailsCard
                loading={loading}
                hasProfile={profile != null}
                reviewAddress={reviewAddress}
                copied={copied}
                onCopyAddress={copyAddress}
              />
              <SubscriptionTab
                userId={userId}
                accountStatus={accountStatus}
                loadingAccount={loading}
                reviewsRemaining={remaining}
                reviewsLimit={profile?.reviews_limit}
                formattedExpiresAt={formattedExpiresAt}
                expiresSoon={expiresSoon}
              />
              <ProfileDetailsCard loading={loading} profile={profile} />
            </div>
          )}
          {activeTab === 'Reports' && <ReportsTab userId={userId} />}
        </div>
      </main>
    </div>
  )
}
