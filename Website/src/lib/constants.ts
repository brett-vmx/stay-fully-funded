/**
 * Placeholder external links, referenced once here so they're easy to swap.
 */
export const SAMPLE_REPORT_PDF = '/6-Salvations-through-Storying-Report.pdf'
export const DEMO_LOOM_URL = 'https://www.loom.com/embed/adcc954bac6e486d9dc08d571a1bb60f'
// A static frame pulled from Loom's own oEmbed thumbnail, cropped to 16:9 and
// converted to WebP, for the click-to-play facade in SeeItWork.tsx. Nothing
// from Loom (its ~4MB player SDK) loads until this poster is actually clicked.
export const DEMO_LOOM_POSTER = '/loom-poster.webp'

// Must match Webhook/wrangler.toml's REVIEW_DOMAIN.
export const REVIEW_DOMAIN = 'review.stayfullyfunded.com'

// The deployed Cloudflare Worker's base URL (Webhook/wrangler.toml's `name`).
// No custom route/domain is configured for it yet, so this is the workers.dev
// URL Cloudflare assigns — update this if a custom domain is ever added.
export const COACH_API_URL = 'https://forever-funded-email-coach.brett-66b.workers.dev'
