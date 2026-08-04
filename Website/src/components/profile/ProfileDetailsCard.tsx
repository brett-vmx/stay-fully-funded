import { ProfileDetailsForm, type DeclaredFields } from './ProfileDetailsForm'

export function ProfileDetailsCard({
  loading,
  profile,
}: {
  loading: boolean
  profile: DeclaredFields | null
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-7 shadow-sm">
      <h2 className="font-heading text-xl font-semibold">Your details (optional)</h2>
      <p className="mt-2 leading-relaxed text-muted">
        This gives the Coach helpful context for your reports.
      </p>
      {loading ? (
        <div className="mt-5 space-y-4">
          <div className="h-9 animate-pulse rounded-lg bg-band-emerald/60" />
          <div className="h-9 animate-pulse rounded-lg bg-band-emerald/60" />
          <div className="h-24 animate-pulse rounded-lg bg-band-emerald/60" />
        </div>
      ) : profile ? (
        <ProfileDetailsForm
          initial={{
            first_name: profile.first_name,
            last_name: profile.last_name,
            city: profile.city,
            country: profile.country,
            ministry_title: profile.ministry_title,
            organization_name: profile.organization_name,
            college_campus: profile.college_campus,
            coach_instructions: profile.coach_instructions,
          }}
        />
      ) : null}
    </div>
  )
}
