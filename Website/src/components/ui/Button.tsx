import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'outline' | 'onDark' | 'onDarkMuted'
type Size = 'sm' | 'md' | 'lg'

const base =
  'inline-flex items-center justify-center gap-2 rounded-full font-heading font-semibold transition-all duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60 disabled:pointer-events-none'

const variants: Record<Variant, string> = {
  primary:
    'bg-primary text-white shadow-sm hover:bg-primary-dark hover:shadow-md active:translate-y-px',
  ghost: 'text-ink hover:text-primary-dark hover:bg-primary/5',
  outline:
    'border border-ink/80 text-ink bg-surface hover:border-primary hover:text-primary-dark',
  // The two below are for use ON a dark (primary-dark) surface, where the
  // normal variants would disappear or clash. Declared as real variants
  // rather than className overrides so they can't lose a Tailwind
  // source-order fight with the variant they'd be overriding.
  onDark:
    'bg-surface text-primary-dark shadow-sm hover:bg-band-emerald hover:shadow-md active:translate-y-px',
  onDarkMuted:
    'bg-band-emerald text-primary-dark shadow-sm hover:bg-white hover:shadow-md active:translate-y-px',
}

const sizes: Record<Size, string> = {
  sm: 'text-sm px-4 py-2',
  md: 'text-[0.95rem] px-5 py-2.5',
  lg: 'text-base px-7 py-3.5',
}

type CommonProps = {
  variant?: Variant
  size?: Size
  children: ReactNode
  className?: string
}

/** Anchor flavor — for smooth-scroll links and external/route links. */
export function ButtonLink({
  href,
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  ...rest
}: CommonProps & { href: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={href}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...rest}
    >
      {children}
    </a>
  )
}

/** Button flavor — for real actions (opening auth, submitting). */
export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  ...rest
}: CommonProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
