import { useEffect, useState } from 'react'

export type LiveCounts = {
  totalStartups: number
  totalUsers: number
  totalJobs: number
  activeHackathons: number
}

/** One request per page load, shared by every component that shows the counts. */
let pending: Promise<LiveCounts | null> | null = null

function load() {
  pending ??= fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/stats`)
    .then((res) => res.json())
    .then((body) => (body?.success && body.data ? (body.data as LiveCounts) : null))
    .catch(() => null)
  return pending
}

/**
 * The platform's real counts from /api/stats, or null until they arrive (and
 * if they never do). Callers show a dash for null — never a made-up number.
 */
export function useLiveStats(): LiveCounts | null {
  const [counts, setCounts] = useState<LiveCounts | null>(null)
  useEffect(() => {
    let alive = true
    load().then((c) => {
      if (alive) setCounts(c)
    })
    return () => {
      alive = false
    }
  }, [])
  return counts
}

/** 1234 → "1.2K", 120 → "120". */
export function compactCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K` : String(n)
}
