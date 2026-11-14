import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * A post-login destination taken from the URL, kept on this site.
 * `?redirect=https://evil.example` or `//evil.example` would otherwise turn
 * the sign-in page into an open redirect; anything that is not a plain
 * same-site path falls back.
 */
export function safeRedirect(value: string | null | undefined, fallback = '/dashboard'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback
  return value
}
