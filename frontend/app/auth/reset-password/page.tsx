'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Eye, EyeOff } from 'lucide-react'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

/**
 * The token, taken from the fragment once per page load and kept outside
 * component state, for the same reason as on /auth/verify-email: the fragment
 * is wiped as soon as it is read, and the page may remount afterwards.
 */
let capturedToken: string | null = null
function takeToken() {
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('token')
  if (fromHash) {
    capturedToken = fromHash
    window.history.replaceState(null, '', window.location.pathname)
  }
  return capturedToken
}

/**
 * Lands from the "Reset your password" email.
 *
 * The token travels in the URL fragment, which browsers never send to a
 * server, and is removed from the address bar once read. Setting the password
 * signs the account out everywhere.
 */
export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [status, setStatus] = useState<'ready' | 'submitting' | 'done' | 'invalid'>('ready')
  const [error, setError] = useState('')

  useEffect(() => {
    const t = takeToken()
    if (t) setToken(t)
    else setStatus('invalid')
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (password.length < 8) return setError('Password must be at least 8 characters')
    if (password !== confirm) return setError('Passwords do not match')

    setStatus('submitting')
    try {
      const res = await fetch(`${API}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok) {
        capturedToken = null
        setToken(null)
        setPassword('')
        setConfirm('')
        return setStatus('done')
      }
      if (body.code === 'INVALID_VERIFICATION_LINK') {
        capturedToken = null
        setToken(null)
        return setStatus('invalid')
      }
      setError(body.error || 'Something went wrong. Please try again.')
      setStatus('ready')
    } catch {
      setError('Something went wrong. Please try again.')
      setStatus('ready')
    }
  }

  const input = {
    width: '100%', background: '#111111', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10,
    padding: '12px 16px', fontFamily: 'Inter, sans-serif', fontSize: 15, color: '#e4e4e4', outline: 'none',
    boxSizing: 'border-box' as const,
  }
  const label = { display: 'block', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#6b6b6b', marginBottom: 6 }
  const heading = { fontFamily: 'Syne, sans-serif', fontSize: 24, color: '#fff', margin: '0 0 8px' }
  const text = { fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#9a9a9a', lineHeight: 1.6, margin: '0 0 20px' }
  const button = {
    width: '100%', background: '#c8f135', color: '#0a0a0a', border: 'none', borderRadius: 10, padding: '12px 16px',
    fontFamily: 'Inter, sans-serif', fontSize: 15, fontWeight: 600, cursor: 'pointer',
  }

  let body: React.ReactNode
  if (status === 'done') {
    body = (
      <div role="status">
        <h1 style={heading}>Password changed</h1>
        <p style={text}>Sign in with your new password. You have been signed out on every other device.</p>
        <Link href="/login" style={{ ...button, display: 'block', textAlign: 'center', textDecoration: 'none' }}>
          Sign in
        </Link>
      </div>
    )
  } else if (status === 'invalid') {
    body = (
      <>
        <h1 style={heading}>This link has expired</h1>
        <p style={text}>Reset links work once and expire after an hour. Ask for a new one and use the newest email.</p>
        <Link href="/forgot-password" style={{ ...button, display: 'block', textAlign: 'center', textDecoration: 'none' }}>
          Send a new link
        </Link>
      </>
    )
  } else {
    body = (
      <form onSubmit={submit}>
        <h1 style={heading}>Choose a new password</h1>
        <p style={text}>Use at least 8 characters.</p>
        <label htmlFor="reset-password" style={label}>New password</label>
        <div style={{ position: 'relative', marginBottom: 12 }}>
          <input
            id="reset-password" type={show ? 'text' : 'password'} autoComplete="new-password"
            value={password} onChange={(e) => setPassword(e.target.value)} style={input}
          />
          <button
            type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}
            style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#6b6b6b', cursor: 'pointer' }}
          >
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <label htmlFor="reset-confirm" style={label}>Confirm new password</label>
        <input
          id="reset-confirm" type={show ? 'text' : 'password'} autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ ...input, marginBottom: 12 }}
        />
        {error && (
          <p role="alert" style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#ef4444', margin: '0 0 12px' }}>{error}</p>
        )}
        <button type="submit" disabled={status === 'submitting' || !token} style={{ ...button, opacity: status === 'submitting' ? 0.6 : 1 }}>
          {status === 'submitting' ? 'Saving…' : 'Set new password'}
        </button>
      </form>
    )
  }

  return (
    <main style={{ minHeight: '100vh', background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 420 }}>{body}</div>
    </main>
  )
}
