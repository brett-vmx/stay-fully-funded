const VARIANT_SRC = {
  color: '/SFF-Logo-transparent.png',
  white: '/SFF-Logo-white.png',
  whiteOnDark: '/SFF-Logo-transparent-white.png',
}

/**
 * Mark variants: `color` is the gradient mark on a transparent background,
 * for use on light backgrounds. `whiteOnDark` is a white mark on a
 * transparent background, for use on dark/colored backgrounds. `white` is
 * the mark on a solid white square, for contexts needing a card behind it
 * (so it gets rounded corners).
 */
export function LogoMark({
  className = '',
  variant = 'color',
}: {
  className?: string
  variant?: 'color' | 'white' | 'whiteOnDark'
}) {
  return (
    <img
      src={VARIANT_SRC[variant]}
      alt="Stay Fully Funded"
      className={`object-contain ${variant === 'white' ? 'rounded-2xl' : ''} ${className}`}
    />
  )
}

/** Mark + "Stay Fully Funded" wordmark, used in header and footer. */
export function Logo({
  className = '',
  markVariant = 'color',
  wordClassName = 'text-ink',
}: {
  className?: string
  markVariant?: 'color' | 'white' | 'whiteOnDark'
  wordClassName?: string
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark className="h-8 w-8 shrink-0" variant={markVariant} />
      <span
        className={`font-heading text-xl font-semibold tracking-tight ${wordClassName}`}
      >
        Stay Fully Funded
      </span>
    </span>
  )
}
