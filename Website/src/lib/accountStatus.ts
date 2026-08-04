export type AccountStatus = 'Trial' | 'Unlimited' | 'Expired'

/**
 * Derives the account's current status from tier + access_expires_at.
 * Expiration wins regardless of tier (a paid/pilot account can still lapse
 * if its access window has passed); otherwise trial vs. everything else.
 */
export function getAccountStatus(profile: {
  tier: string
  access_expires_at: string | null
}): AccountStatus {
  const isExpired =
    profile.access_expires_at != null &&
    new Date(profile.access_expires_at).getTime() <= Date.now()

  if (isExpired) return 'Expired'
  if (profile.tier === 'trial') return 'Trial'
  return 'Unlimited'
}

export function accountStatusColor(status: AccountStatus | null): string {
  switch (status) {
    case 'Unlimited':
      return 'text-primary-dark'
    // Green too, one step lighter than Unlimited: a trial is a live, healthy
    // account, so neutral ink read as inert next to the other two states. The
    // two greens aren't meant to be told apart at a glance — the word does
    // that — they just both need to read as "you're fine".
    case 'Trial':
      return 'text-primary'
    case 'Expired':
      return 'text-brick'
    default:
      return 'text-ink'
  }
}
