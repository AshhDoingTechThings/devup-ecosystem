'use client'

import { useState } from 'react'
import Link from 'next/link'
import { MailCheck } from 'lucide-react'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

/**
 * "Forgot password?" on the sign-in page.
 *
 * The answer is the same whether or not the address has an account, so this
 * page cannot be used to find out who is registered. The email carries a link
 * to /auth/reset-password.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const to = email.trim().toLowerCase()
    if (!to) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`${API}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: to }),
      })
      if (res.status === 202) return setSentTo(to)
      const body = await res.json().catch(() => ({}))
      setError(body.error || 'Something went wrong. Please try again.')
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const input = {
    width: '100%', background: '#111111', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10,
    padding: '12px 16px', fontFamily: 'Inter, sans-serif', fontSize: 15, color: '#e4e4e4', outline: 'none',
    boxSizing: 'border-box' as const,
  }
  const heading = { fontFamily: 'Syne, sans-serif', fontSize: 24, color: '#fff', margin: '0 0 8px' }
  const text = { fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#9a9a9a', lineHeight: 1.6, margin: '0 0 20px' }
  const button = {
    width: '100%', background: '#c8f135', color: '#0a0a0a', border: 'none', borderRadius: 10, padding: '12px 16px',
    fontFamily: 'Inter, sans-serif', fontSize: 15, fontWeight: 600, cursor: 'pointer',
  }

  return (
    <main style={{ minHeight: '100vh', background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 420 }}>
        {sentTo ? (
          <div style={{ textAlign: 'center' }} role="status">
            <MailCheck size={28} color="#c8f135" style={{ marginBottom: 16 }} />
            <h1 style={heading}>Check your inbox</h1>
            <p style={text}>
              If <strong style={{ color: '#e4e4e4' }}>{sentTo}</strong> has a DevUp account, a link to choose a new
              password is on its way. The link works once, so use the newest one.
            </p>
            <Link href="/login" style={{ ...button, display: 'block', textAlign: 'center', textDecoration: 'none' }}>
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={submit}>
            <h1 style={heading}>Reset your password</h1>
            <p style={text}>Enter the email you use for DevUp. If it has an account, we will send a link to choose a new password.</p>
            <label htmlFor="forgot-email" style={{ display: 'block', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#6b6b6b', marginBottom: 6 }}>
              Email address
            </label>
            <input
              id="forgot-email" type="email" required autoComplete="email" placeholder="you@example.com"
              value={email} onChange={(e) => setEmail(e.target.value)} style={{ ...input, marginBottom: 12 }}
            />
            {error && (
              <p role="alert" style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#ef4444', margin: '0 0 12px' }}>{error}</p>
            )}
            <button type="submit" disabled={busy} style={{ ...button, opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            <p style={{ ...text, margin: '16px 0 0', textAlign: 'center' }}>
              <Link href="/login" style={{ color: '#c8f135', textDecoration: 'none' }}>Back to sign in</Link>
            </p>
          </form>
        )}
      </div>
    </main>
  )
}
