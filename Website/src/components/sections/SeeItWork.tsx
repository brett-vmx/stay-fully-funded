import { useState } from 'react'
import { Section } from '../ui/Section'
import { DEMO_LOOM_URL, DEMO_LOOM_POSTER, SAMPLE_REPORT_PDF } from '../../lib/constants'

// Toggle the whole section between the light look (white band + pale-emerald
// report panel) and a full dark-green band. Flip to compare; keep whichever.
const FULL_GREEN = true

const LEGEND = [
  { icon: '✅', label: 'good', tone: 'text-primary-dark' },
  { icon: '🟠', label: 'worth considering', tone: 'text-brown' },
  { icon: '🔴', label: 'needs fixing', tone: 'text-brick' },
]

/**
 * Click-to-play facade: a static poster + play button stand in for the real
 * Loom iframe until someone actually clicks. The iframe used to mount
 * unconditionally, pulling in ~4MB of Loom's vendor JS and video segments for
 * every visitor who scrolled anywhere near this section, whether or not they
 * ever watched. Now that cost is paid only on real intent to watch, and the
 * poster gives this section real visible content immediately instead of a
 * blank rectangle while an iframe boots up.
 */
function VideoEmbed() {
  const [playing, setPlaying] = useState(false)

  if (!DEMO_LOOM_URL) {
    // TODO(placeholder): paste the real Loom embed URL into DEMO_LOOM_URL.
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/30">
          <svg viewBox="0 0 24 24" className="h-7 w-7 translate-x-0.5" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
        <p className="text-sm font-medium text-white/80">Play the walkthrough</p>
        <p className="text-xs text-white/40">[ Loom embed placeholder ]</p>
      </div>
    )
  }

  if (!playing) {
    return (
      <button
        type="button"
        onClick={() => setPlaying(true)}
        aria-label="Play video: Stay Fully Funded walkthrough"
        className="group absolute inset-0 h-full w-full cursor-pointer"
      >
        <img
          src={DEMO_LOOM_POSTER}
          alt=""
          loading="lazy"
          width={1024}
          height={576}
          className="h-full w-full object-cover"
        />
        <span className="absolute inset-0 flex items-center justify-center bg-ink/25 transition-colors group-hover:bg-ink/35">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/95 shadow-lg transition-transform group-hover:scale-105">
            <svg
              viewBox="0 0 24 24"
              className="h-7 w-7 translate-x-0.5 text-primary-dark"
              fill="currentColor"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </span>
      </button>
    )
  }

  const autoplaySrc = `${DEMO_LOOM_URL}${DEMO_LOOM_URL.includes('?') ? '&' : '?'}autoplay=1`
  return (
    <iframe
      src={autoplaySrc}
      title="Stay Fully Funded walkthrough"
      allow="autoplay; fullscreen"
      allowFullScreen
      className="absolute inset-0 h-full w-full"
    />
  )
}

export function SeeItWork() {
  // Intro (heading + subtext) sits on the section band, so it goes white when
  // the band is dark green. The report panel keeps its own pale-emerald look
  // with dark text either way.
  const introHeading = FULL_GREEN ? 'text-white' : ''
  const introBody = FULL_GREEN ? 'text-white/75' : 'text-muted'

  return (
    <Section id="see-it-work" tint={FULL_GREEN ? 'forest' : 'white'}>
      {/* Demo intro + video */}
      <div className="mx-auto max-w-2xl text-center">
        <h2 className={`text-3xl font-bold sm:text-4xl ${introHeading}`}>
          Watch this real draft get better.
        </h2>
        <p className={`mt-4 text-lg leading-relaxed ${introBody}`}>
          Here’s one of my actual drafts before and after a Coach review.
        </p>
      </div>

      <div className="mx-auto mt-10 max-w-3xl">
        <div className="relative aspect-video overflow-hidden rounded-2xl border border-border bg-ink/95 shadow-lg">
          <VideoEmbed />
        </div>
      </div>

      {/* The Coach's Report */}
      <div className="mx-auto mt-12 max-w-3xl rounded-3xl border border-border bg-band-emerald p-8 text-center sm:p-10">
        <h3 className="font-heading text-2xl font-bold sm:text-3xl">
          The <span className="text-primary">Coach’s Report</span>
        </h3>
        <p className="mx-auto mt-8 max-w-xl text-left text-lg leading-relaxed text-muted">
          The <strong className="font-semibold text-ink">Overall Impression</strong> should
          read like a note from a mentor, not a spreadsheet of scores.
          <br />
          <br />
          The <strong className="font-semibold text-ink">Detailed Pass</strong> is specific,
          actionable, and scannable. Every finding is marked so you can skim straight to
          what matters:
        </p>

        <ul className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row">
          {LEGEND.map((item) => (
            <li
              key={item.label}
              className="flex items-center justify-center gap-2 rounded-xl border border-border bg-surface px-5 py-3 shadow-sm"
            >
              <span className="text-xl" aria-hidden="true">
                {item.icon}
              </span>
              <span className={`font-heading font-semibold ${item.tone}`}>{item.label}</span>
            </li>
          ))}
        </ul>

        <a
          href={SAMPLE_REPORT_PDF}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-8 inline-block font-heading font-semibold text-primary-dark hover:underline"
        >
          See a full sample report (PDF) →
        </a>
      </div>
    </Section>
  )
}
