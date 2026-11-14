'use client'
import {
  createContext, useContext, useEffect,
  useState, useCallback, useRef
} from 'react'
import { createClient } from '@/lib/supabase'
import { safeRedirect } from '@/lib/utils'
import { useRouter } from 'next/navigation'
import type { User, Session } from '@supabase/supabase-js'

/** Supabase provider ids. LinkedIn uses the OIDC variant. */
export type OAuthProvider = 'google' | 'github' | 'linkedin_oidc'

export const OAUTH_PROVIDERS: { id: OAuthProvider; label: string }[] = [
  { id: 'google', label: 'Google' },
  { id: 'github', label: 'GitHub' },
  { id: 'linkedin_oidc', label: 'LinkedIn' },
]

export type UserRole =
  | 'ADMIN' 
  | 'SUPER_ADMIN' 
  | 'FOUNDER' 
  | 'STARTUP_MEMBER' 
  | 'STUDENT' 
  | 'INVESTOR' 
  | 'MENTOR' 
  | 'JUDGE'

export interface UserProfile {
  id: string
  email: string
  name: string
  role: UserRole
  avatarUrl?: string
  college?: string
  city?: string
  provider?: string
  lastLoginAt?: string
  startups?: any[]
}

interface AuthContextType {
  user: UserProfile | null
  session: Session | null
  loading: boolean
  signUp: (data: SignUpData) => Promise<{ error?: string; verificationSent?: boolean }>
  signIn: (email: string, password: string, redirectTo?: string) => Promise<{ error?: string }>
  signInWithGoogle: (redirectTo?: string) => Promise<void>
  signInWithOAuth: (provider: OAuthProvider, redirectTo?: string) => Promise<void>
  signOut: () => Promise<void>
  updateProfile: (data: Partial<UserProfile>) => Promise<void>
  refreshProfile: () => Promise<void>
  /**
   * Signed in with Supabase, but the DevUp profile could not be loaded:
   *  - 'unavailable': the API failed or timed out (5xx, network, cold start).
   *    The session is kept; the UI offers Retry.
   *  - 'session': the API rejected the token (expired or invalid). The UI
   *    offers "Sign in again"; nothing signs the person out by itself.
   * null when there is no session, while loading, and once the profile is in.
   */
  profileError: ProfileError
  retryProfile: () => Promise<void>
}

export type ProfileError = null | 'unavailable' | 'session'

interface SignUpData {
  email: string
  password: string
  name: string
  role: 'FOUNDER' | 'STUDENT' | 'INVESTOR'
  college?: string
  city?: string
}

const AuthContext = createContext<AuthContextType | null>(null)

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

/** The backend's User + Profile, in the shape the UI uses. */
function toProfile(userData: any): UserProfile {
  return {
    id: userData.id,
    email: userData.email,
    role: userData.role,
    name: userData.profile?.name || 'User',
    avatarUrl: userData.avatarUrl || userData.profile?.avatarUrl,
    college: userData.profile?.college,
    city: userData.profile?.city,
    provider: userData.authProvider,
    lastLoginAt: userData.lastLoginAt,
    startups: userData.startupMemberships?.map((m: any) => m.startup) || [],
  }
}

/**
 * No screen may say "loading" forever because one request stalled. Longer than
 * a typical Render cold start (~22 s), so waking the API doesn't flash an error.
 */
const LOADING_CEILING_MS = 30_000

/** Covers a Render cold start (~22 s) with room to spare. */
const PROFILE_TIMEOUT_MS = 45_000

/** The OAuth callback creates the account itself; never race it. */
const onCallbackPage = () => typeof window !== 'undefined' && window.location.pathname.startsWith('/auth/callback')

async function fetchWithTimeout(url: string, init: RequestInit, ms: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [profileError, setProfileError] = useState<ProfileError>(null)
  const router = useRouter()
  const supabase = createClient()
  const sessionRef = useRef<Session | null>(null)
  const loadedFor = useRef<string | null>(null)
  const inFlight = useRef<{ userId: string; promise: Promise<void> } | null>(null)
  /** Accounts we already tried to create from here (once per page load). */
  const syncAttempted = useRef<Set<string>>(new Set())

  /**
   * Loads the signed-in person's profile with the token we were handed.
   *
   * It never calls back into the Supabase client: doing that from inside an
   * auth event deadlocked the OAuth callback. The library swaps ?code= for a
   * session during its own start-up and waits for every listener before it
   * finishes; a listener awaiting getSession() waits for that same start-up,
   * so neither ever finished. Sign-in sat on "Signing you in..." until the
   * page's timeouts gave up, and the account sync never ran.
   *
   * Concurrent calls for the same person share one request.
   */
  const loadProfile = useCallback((s: Session, force = false): Promise<void> => {
    const userId = s.user.id
    if (!force && loadedFor.current === userId) return Promise.resolve()
    if (inFlight.current?.userId === userId) return inFlight.current.promise

    const entry: { userId: string; promise: Promise<void> } = { userId, promise: Promise.resolve() }
    entry.promise = (async () => {
      const auth = { Authorization: `Bearer ${s.access_token}` }
      const fetchProfile = () => fetchWithTimeout(`${API_URL}/api/users/${userId}`, { headers: auth }, PROFILE_TIMEOUT_MS)
      try {
        let response = await fetchProfile()

        // Signed in, but no DevUp account behind the identity — e.g. a Google
        // sign-in whose account sync never ran. Create it once, then re-read.
        // Not on the callback page: it runs this same sync itself.
        if (response.status === 401) {
          const body = await response.clone().json().catch(() => ({}))
          const provider = s.user.app_metadata?.provider
          if (body?.code === 'USER_NOT_FOUND') {
            if (onCallbackPage()) return // the callback syncs, then calls refreshProfile()
            if (provider && provider !== 'email' && !syncAttempted.current.has(userId)) {
              syncAttempted.current.add(userId)
              const synced = await fetchWithTimeout(`${API_URL}/api/auth/google/sync`, {
                method: 'POST',
                headers: { ...auth, 'Content-Type': 'application/json' },
              }, PROFILE_TIMEOUT_MS)
              if (synced.ok) response = await fetchProfile()
            }
          }
        }

        if (response.ok) {
          const { data } = await response.json()
          loadedFor.current = userId
          setUser(toProfile(data))
          setProfileError(null)
          return
        }

        // A failed request is never treated as being signed out. 401/403 mean
        // the API rejected this session; anything else is the API's problem.
        setProfileError(response.status === 401 || response.status === 403 ? 'session' : 'unavailable')
        console.error(`Profile request failed: HTTP ${response.status}`)
      } catch (error) {
        setProfileError('unavailable')
        console.error('Profile request failed:', error instanceof Error && error.name === 'AbortError' ? 'timed out' : 'network error')
      } finally {
        if (inFlight.current === entry) inFlight.current = null
        setLoading(false)
      }
    })()
    inFlight.current = entry
    return entry.promise
  }, [])

  useEffect(() => {
    // Still nothing after the ceiling: say so (with Retry) rather than spin.
    // The request keeps going; if it lands later, the profile appears.
    const ceiling = setTimeout(() => {
      if (sessionRef.current?.user && !loadedFor.current && !onCallbackPage()) setProfileError((e) => e ?? 'unavailable')
      setLoading(false)
    }, LOADING_CEILING_MS)

    // One listener, and it awaits nothing. INITIAL_SESSION fires on subscribe,
    // so there is no separate getSession() call (that used to fetch the
    // profile twice on every page load).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, next) => {
      sessionRef.current = next
      setSession(next)

      if (event === 'SIGNED_OUT' || !next?.user) {
        loadedFor.current = null
        setUser(null)
        setProfileError(null)
        setLoading(false)
        if (event === 'SIGNED_OUT') router.push('/')
        return
      }

      // A refreshed token is the same person: keep the profile we have.
      if (event === 'TOKEN_REFRESHED' && loadedFor.current === next.user.id) return

      // Deferred so it runs after the library has finished its own work.
      setTimeout(() => { void loadProfile(next) }, 0)
    })

    return () => {
      clearTimeout(ceiling)
      subscription.unsubscribe()
    }
  }, [loadProfile, router, supabase.auth])

  /**
   * Make sure the profile is loaded — e.g. right after the OAuth sync created
   * it. Reuses a fetch already under way and only goes back to the API if that
   * one came back empty (a brand-new account), so a returning user's sign-in
   * costs one profile request, not two.
   */
  const refreshProfile = useCallback(async () => {
    const s = sessionRef.current ?? (await supabase.auth.getSession()).data.session
    if (!s?.user) return
    sessionRef.current = s
    if (inFlight.current?.userId === s.user.id) await inFlight.current.promise
    if (loadedFor.current !== s.user.id) {
      // Signed in but no profile yet (a brand-new account): stay "loading"
      // rather than flash the signed-out view while it is fetched.
      setLoading(true)
      await loadProfile(s, true)
    }
  }, [loadProfile, supabase.auth])

  /** The Retry button: same session, one more attempt. */
  const retryProfile = useCallback(async () => {
    const s = sessionRef.current
    if (!s?.user) return
    setProfileError(null)
    setLoading(true)
    await loadProfile(s, true)
  }, [loadProfile])

  const signUp = async (data: SignUpData) => {
    try {
      // Register via backend (creates Supabase user + DB profile)
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/auth/register`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        }
      )
      
      const result = await response.json()
      
      if (!response.ok) {
        return { error: result.error || result.message || 'Registration failed' }
      }

      // No sign-in yet: the account cannot be used until the owner of the
      // address follows the link we just emailed. The answer is the same
      // whether or not the address already had an account.
      return { verificationSent: true }
    } catch {
      return { error: 'Something went wrong. Please try again.' }
    }
  }

  const signIn = async (email: string, password: string, redirectTo = '/dashboard') => {
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      
      if (error) return { error: error.message }
      
      // The dashboard carries "Join your startup workspace"; sign-in never waits on it.
      router.push(safeRedirect(redirectTo))
      return {}
    } catch {
      return { error: 'Something went wrong. Please try again.' }
    }
  }

  const signInWithOAuth = async (provider: OAuthProvider, redirectTo?: string) => {
    const callbackUrl = `${window.location.origin}/auth/callback${redirectTo ? `?redirect=${encodeURIComponent(redirectTo)}` : ''}`

    // GitHub and LinkedIn expose profile data we want for autofill, so request
    // the scopes that carry it. Google: let people pick an account, but do not
    // force the consent screen on every sign-in — nothing here uses Google's
    // own refresh tokens, so prompt=consent only added a screen each time.
    const perProvider: Record<OAuthProvider, Record<string, unknown>> = {
      google: { queryParams: { prompt: 'select_account' } },
      github: { scopes: 'read:user user:email' },
      linkedin_oidc: { scopes: 'openid profile email' },
    }

    await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: callbackUrl, ...perProvider[provider] },
    })
  }

  const signInWithGoogle = async (redirectTo?: string) => signInWithOAuth('google', redirectTo)

  const signOut = async () => {
    await supabase.auth.signOut()
    setUser(null)
    setSession(null)

    // Clear Supabase cookies
    document.cookie.split(';').forEach((c) => {
      const name = c.trim().split('=')[0]
      if (name.startsWith('sb-')) {
        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`
      }
    })
  }

  const updateProfile = async (data: Partial<UserProfile>) => {
    if (!user || !session) return
    
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/users/${user.id}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(data),
      }
    )
    
    if (response.ok) {
      // PATCH answers with the backend's User shape; re-read and map it like every other read.
      await loadProfile(session, true)
    }
  }

  return (
    <AuthContext.Provider value={{
      user, session, loading,
      signUp, signIn, signInWithGoogle, signInWithOAuth, signOut, updateProfile, refreshProfile,
      profileError, retryProfile,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
