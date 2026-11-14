'use client'

import { useAuth } from '@/lib/auth/AuthProvider'
import { useAuthGate } from '@/hooks/useAuthGate'
import { ReactNode } from 'react'
import { Lock, RefreshCw, LogIn } from 'lucide-react'
import { motion } from 'framer-motion'

interface ProtectedContentProps {
  children: ReactNode
  blurRadius?: number
  message?: string
}

export default function ProtectedContent({ 
  children, 
  blurRadius = 12,
  message = "Unlock to Continue" 
}: ProtectedContentProps) {
  const { user, session, loading, profileError, retryProfile, signOut } = useAuth()
  const { openAuthGate } = useAuthGate()

  // Signed in with Supabase, profile not loaded yet and no error (e.g. a new
  // account being created on the callback page): still loading, not "logged out".
  if (loading || (session?.user && !user && !profileError)) {
    return (
      <div style={{ position: 'relative', minHeight: 100 }}>
        {children}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(10,10,10,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <div style={{
            width: 24, height: 24, borderRadius: '50%',
            border: '2px solid rgba(200,241,53,0.2)',
            borderTopColor: '#c8f135',
            animation: 'spin 0.8s linear infinite'
          }} />
        </div>
      </div>
    )
  }

  // Fully authenticated, show normal content
  if (user) {
    return <>{children}</>
  }

  // Signed in, but the DevUp account could not be loaded. Never shown as
  // "logged out": the session is kept and the person can retry (or, if the API
  // rejected the session, sign in again). The content stays locked until the
  // profile — and with it the person's permissions — has loaded.
  if (session?.user && profileError) {
    const expired = profileError === 'session'
    return (
      <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 'inherit' }}>
        <div style={{ filter: `blur(${blurRadius}px) brightness(0.5)`, userSelect: 'none', pointerEvents: 'none' }} aria-hidden>
          {children}
        </div>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, padding: 16 }}>
          <div role="alert" style={{
            maxWidth: 380, width: '100%', padding: '20px 22px', borderRadius: 16,
            background: 'rgba(17,17,17,0.95)', border: '1px solid rgba(255,255,255,0.12)',
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)', textAlign: 'center',
            fontFamily: 'var(--font-inter), sans-serif',
          }}>
            <p style={{ color: '#ffffff', fontSize: 15, fontWeight: 600, margin: 0 }}>
              {expired ? 'Your session has expired' : "We couldn't load your account"}
            </p>
            <p style={{ color: '#9a9a9a', fontSize: 13, lineHeight: 1.5, margin: '8px 0 16px' }}>
              {expired
                ? 'Please sign in again to continue.'
                : "You're signed in, but DevUp's servers didn't respond. They may be waking up — this can take up to a minute."}
            </p>
            {expired ? (
              <button
                onClick={async () => { await signOut(); openAuthGate() }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderRadius: 999, background: '#c8f135', color: '#0a0a0a', fontSize: 14, fontWeight: 600, border: 'none', cursor: 'pointer' }}
              >
                <LogIn size={16} /> Sign in again
              </button>
            ) : (
              <button
                onClick={() => { void retryProfile() }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderRadius: 999, background: '#c8f135', color: '#0a0a0a', fontSize: 14, fontWeight: 600, border: 'none', cursor: 'pointer' }}
              >
                <RefreshCw size={16} /> Retry
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Unauthenticated - show blurred content with unlock overlay
  return (
    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 'inherit' }}>
      <div style={{
        filter: `blur(${blurRadius}px) brightness(0.7)`,
        userSelect: 'none',
        pointerEvents: 'none',
        transition: 'filter 0.3s ease',
      }}>
        {children}
      </div>

      <div style={{
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
        background: 'rgba(0,0,0,0.1)'
      }}>
        <motion.button
          onClick={openAuthGate}
          whileHover={{ scale: 1.05, y: -2 }}
          whileTap={{ scale: 0.95 }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 24px',
            background: 'rgba(17,17,17,0.9)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: '999px',
            color: '#ffffff',
            fontFamily: 'var(--font-inter), sans-serif',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 10px 30px rgba(0,0,0,0.5), 0 0 20px rgba(200,241,53,0.1)',
            backdropFilter: 'blur(8px)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'rgba(200,241,53,0.4)';
            e.currentTarget.style.color = '#c8f135';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)';
            e.currentTarget.style.color = '#ffffff';
          }}
        >
          <Lock size={16} />
          {message}
        </motion.button>
      </div>
    </div>
  )
}
