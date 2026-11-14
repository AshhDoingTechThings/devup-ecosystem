'use client'

import { safeRedirect } from '@/lib/utils'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/lib/auth/AuthProvider'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { motion } from 'framer-motion'
import { Suspense } from 'react'

type Stage = 'session' | 'syncing' | 'slow' | 'error'

/** How long the account sync may take. The API sleeps on Render's free tier
 *  and a cold start has been measured at 20+ seconds, so this is generous —
 *  but still a budget, never an endless wait. */
const SYNC_BUDGET_MS = 60_000
/** After this long in sync, say why it is slow instead of just spinning. */
const SLOW_HINT_MS = 4_000

function CallbackContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { refreshProfile } = useAuth()
  const started = useRef(false)
  const [status, setStatus] = useState<Stage>('session')
  const [errorMsg, setErrorMsg] = useState('')
  const [canRetry, setCanRetry] = useState(false)

  const withTimeout = <T,>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
    Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
    ])

  const fail = (message: string, retry: boolean) => {
    setStatus('error')
    setErrorMsg(message)
    setCanRetry(retry)
  }

  const run = useCallback(async () => {
    setStatus('session')
    setErrorMsg('')

    // Google (or the visitor) said no: there is no code to finish with.
    const providerError = searchParams.get('error_description') || searchParams.get('error')
    if (providerError) {
      fail('Google sign-in was cancelled or refused. Please try again.', false)
      return
    }

    let session
    try {
      /*
       * The client swaps ?code= for a session by itself while it starts up
       * (PKCE, with the verifier it stored before leaving for Google), and
       * getSession() resolves once that is done. There used to be a second,
       * explicit exchange here; it could only ever fail, because a code is
       * spent once and the library had already spent it.
       */
      const got = await withTimeout(createClient().auth.getSession(), 15_000, 'Sign in')
      session = got.data.session
    } catch {
      fail('Sign in is taking too long. Please try again.', true)
      return
    }
    if (!session) {
      fail('This sign-in link has expired or was already used. Please sign in again.', false)
      return
    }

    // Create or update the DevUp account behind this Google identity.
    setStatus('syncing')
    const slow = setTimeout(() => setStatus((s) => (s === 'syncing' ? 'slow' : s)), SLOW_HINT_MS)
    const controller = new AbortController()
    const abort = setTimeout(() => controller.abort(), SYNC_BUDGET_MS)
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/auth/google/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        signal: controller.signal,
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'We could not finish setting up your account.')
      }
    } catch (err: any) {
      fail(
        err?.name === 'AbortError'
          ? 'Our servers are taking too long to respond. Please try again.'
          : err?.message || 'We could not finish setting up your account.',
        true
      )
      return
    } finally {
      clearTimeout(slow)
      clearTimeout(abort)
    }

    // The account exists now (a new user's profile did not before the sync).
    // Load it in the background; the next page shows its own loading state.
    void refreshProfile()
    router.replace(safeRedirect(searchParams.get('redirect')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, searchParams, refreshProfile])

  useEffect(() => {
    if (started.current) return
    started.current = true
    void run()
  }, [run])

  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#0a0a0a',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      {/* Beacon */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 600,
          height: '60vh',
          background:
            'radial-gradient(ellipse, rgba(200,241,53,0.05) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4 }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 24,
          position: 'relative',
          zIndex: 10,
        }}
      >
        {status === 'error' ? (
          <>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: 'rgba(239,68,68,0.1)',
                border: '2px solid rgba(239,68,68,0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 24,
              }}
            >
              ✕
            </div>
            <p
              style={{
                fontFamily: 'Inter, sans-serif',
                fontSize: 15,
                color: '#ef4444',
                textAlign: 'center',
              }}
            >
              {errorMsg}
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
              {canRetry && (
                <button
                  onClick={() => void run()}
                  style={{
                    padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                    background: '#c8f135', color: '#000', fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: 700,
                  }}
                >
                  Try again
                </button>
              )}
              <button
                onClick={() => router.replace('/login')}
                style={{
                  padding: '10px 20px', borderRadius: 10, cursor: 'pointer',
                  background: 'transparent', color: '#e4e4e4', border: '1px solid rgba(255,255,255,0.12)',
                  fontFamily: 'Inter, sans-serif', fontSize: 14,
                }}
              >
                Back to sign in
              </button>
            </div>
          </>
        ) : (
          <>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                border: '3px solid rgba(200,241,53,0.15)',
                borderTopColor: '#c8f135',
                animation: 'spin 0.7s linear infinite',
              }}
            />
            <div style={{ textAlign: 'center' }}>
              <p
                style={{
                  fontFamily: 'Syne, sans-serif',
                  fontSize: 20,
                  fontWeight: 700,
                  color: '#ffffff',
                  marginBottom: 6,
                }}
              >
                {status === 'session' ? 'Signing you in...' : 'Setting up your account...'}
              </p>
              <p
                style={{
                  fontFamily: 'Inter, sans-serif',
                  fontSize: 13,
                  color: '#6b6b6b',
                }}
              >
                {status === 'slow'
                  ? 'Waking up DevUp\u2019s servers. After a quiet spell this can take up to a minute.'
                  : 'Please wait a moment'}
              </p>
            </div>
          </>
        )}
      </motion.div>
    </main>
  )
}

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: '100vh',
            background: '#0a0a0a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              border: '2px solid rgba(200,241,53,0.2)',
              borderTopColor: '#c8f135',
              animation: 'spin 0.8s linear infinite',
            }}
          />
        </div>
      }
    >
      <CallbackContent />
    </Suspense>
  )
}
