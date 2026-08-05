import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { supabase, supabaseConfigured } from '../../lib/supabase'
import { Button } from '../ui/Button'
import { LogoMark } from '../ui/LogoMark'

type Mode = 'signup' | 'login'
type Status = 'idle' | 'sending' | 'sent' | 'error' | 'redirecting'

/** Google's brand mark, inlined so the modal has no external asset to wait on. */
function GoogleG({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  )
}

type AuthModalContextValue = { open: (mode?: Mode) => void }
const AuthModalContext = createContext<AuthModalContextValue | null>(null)

/** Open the shared magic-link modal from anywhere (CTAs, header, etc.). */
export function useAuthModal() {
  const ctx = useContext(AuthModalContext)
  if (!ctx) throw new Error('useAuthModal must be used within <AuthModalProvider>')
  return ctx
}

export function AuthModalProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('signup')

  const open = useCallback((m: Mode = 'signup') => {
    setMode(m)
    setIsOpen(true)
  }, [])

  return (
    <AuthModalContext.Provider value={{ open }}>
      {children}
      {isOpen && <Modal mode={mode} onClose={() => setIsOpen(false)} />}
    </AuthModalContext.Provider>
  )
}

function Modal({ mode, onClose }: { mode: Mode; onClose: () => void }) {
  const [firstName, setFirstName] = useState('')
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const firstNameRef = useRef<HTMLInputElement>(null)
  const emailRef = useRef<HTMLInputElement>(null)

  // Either path in flight disables both, so a slow magic-link request can't be
  // raced by a click on the Google button (or the reverse).
  const busy = status === 'sending' || status === 'redirecting'

  // Focus the first field for the mode (first name on signup, email on
  // login, since login is for existing users who already have a name on
  // file); close on Escape.
  useEffect(() => {
    ;(mode === 'signup' ? firstNameRef.current : emailRef.current)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, mode])

  /**
   * OAuth needs no email-existence check the way login mode does: Supabase
   * links a Google identity to the existing user whenever the email matches
   * and is verified, so a returning user lands on their own account (trial,
   * subscription, and reviews intact) rather than a duplicate. The tradeoff
   * is that someone brand new who opens this in login mode gets an account
   * created instead of the "we can't find an account" message.
   *
   * On success the browser leaves for Google, so there's no success state to
   * set here. Only the error path comes back to us.
   */
  async function handleGoogle() {
    if (!supabase) {
      setStatus('error')
      setErrorMsg('Sign-in isn’t configured yet. Please try again shortly.')
      return
    }
    setStatus('redirecting')
    setErrorMsg('')
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
    if (error) {
      setStatus('error')
      setErrorMsg(error.message)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!supabase) {
      setStatus('error')
      setErrorMsg('Sign-in isn’t configured yet. Please try again shortly.')
      return
    }
    setStatus('sending')
    setErrorMsg('')
    const trimmedEmail = email.trim()
    const trimmedFirstName = firstName.trim()

    if (mode === 'login') {
      const { data: hasAccount, error: checkError } = await supabase.rpc(
        'email_has_account',
        { p_email: trimmedEmail },
      )
      if (checkError) {
        setStatus('error')
        setErrorMsg(checkError.message)
        return
      }
      if (!hasAccount) {
        setStatus('error')
        setErrorMsg('Sorry, we can’t find an account associated with that email address.')
        return
      }
    }

    const { error } = await supabase.auth.signInWithOtp({
      email: trimmedEmail,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        // Only meaningful the moment an account is first created — the
        // handle_new_user trigger reads it off auth.users' metadata.
        ...(mode === 'signup' && trimmedFirstName
          ? { data: { first_name: trimmedFirstName } }
          : {}),
      },
    })
    if (error) {
      setStatus('error')
      setErrorMsg(error.message)
    } else {
      setStatus('sent')
    }
  }

  const heading =
    mode === 'login' ? (
      'Welcome back'
    ) : (
      <>
        Start your <span className="text-primary">free trial</span>
      </>
    )
  // Both lines used to open with "Enter your email", which now describes only
  // one of the two ways in. Reworded to stay accurate with Google present.
  const sub =
    mode === 'login'
      ? 'Sign in with Google, or we’ll email you a magic link.'
      : 'Get 10 free credits to use in 90 days.'

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
    >
      {/* Backdrop */}
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
      />

      <div className="relative w-full max-w-md rounded-2xl bg-surface p-7 shadow-xl sm:p-8">
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 rounded-full p-1.5 text-muted transition hover:bg-ink/5 hover:text-ink"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        {status === 'sent' ? (
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-band-emerald text-primary-dark">
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7l9 6 9-6M4 6h16v12H4z" />
              </svg>
            </div>
            <h2 id="auth-modal-title" className="text-2xl font-semibold">
              Check your inbox
            </h2>
            <p className="mt-2 text-muted">
              We sent a magic link to <span className="font-medium text-ink">{email}</span>.
              Click it to finish signing in. You can close this window.
            </p>
          </div>
        ) : (
          <>
            <div className="mb-5 flex items-center gap-2.5">
              <LogoMark className="h-8 w-8 text-primary" />
              <span className="font-heading text-lg font-semibold">Stay Fully Funded</span>
            </div>
            <h2 id="auth-modal-title" className="text-2xl font-semibold">
              {heading}
            </h2>
            <p className="mt-2 text-muted">{sub}</p>

            {!supabaseConfigured && (
              <p className="mt-4 rounded-lg bg-band-brick px-3 py-2 text-sm text-brick">
                Auth isn’t configured in this environment yet.
              </p>
            )}

            <Button
              type="button"
              variant="outline"
              size="lg"
              className="mt-5 w-full"
              onClick={handleGoogle}
              disabled={busy}
            >
              <GoogleG className="h-5 w-5" />
              {status === 'redirecting' ? 'Taking you to Google…' : 'Continue with Google'}
            </Button>
            <p className="mt-2 text-center text-xs text-muted">
              Google will show a supabase.co address during sign-in.
            </p>

            <div className="my-4 flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-xs font-medium uppercase tracking-wide text-muted">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>

            <form onSubmit={handleSubmit}>
              {mode === 'signup' && (
                <>
                  <label htmlFor="auth-first-name" className="sr-only">
                    First name
                  </label>
                  <input
                    ref={firstNameRef}
                    id="auth-first-name"
                    type="text"
                    required
                    autoComplete="given-name"
                    placeholder="First name"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="mb-3 w-full rounded-xl border-0 bg-band-emerald px-4 py-3 text-ink placeholder:text-muted/70 focus:outline-none"
                  />
                </>
              )}
              <label htmlFor="auth-email" className="sr-only">
                Email address
              </label>
              <input
                ref={emailRef}
                id="auth-email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@ministry.org"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-xl border-0 bg-band-emerald px-4 py-3 text-ink placeholder:text-muted/70 focus:outline-none"
              />
              {status === 'error' && (
                <p className="mt-2 text-sm text-brick">{errorMsg}</p>
              )}
              <Button
                type="submit"
                size="lg"
                className="mt-4 w-full"
                disabled={busy}
              >
                {status === 'sending'
                  ? 'Sending…'
                  : mode === 'signup'
                    ? 'Start my free trial'
                    : 'Send me a magic link'}
              </Button>
            </form>
            {mode === 'signup' && (
              <p className="mt-3 text-center text-xs text-muted">
                No credit card required.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
