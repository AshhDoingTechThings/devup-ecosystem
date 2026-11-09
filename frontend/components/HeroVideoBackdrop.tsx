'use client'
import { useEffect, useRef, useState } from 'react'
import { getMediaUrl } from '@/lib/mediaMap'

/** The same look for the moving and the still backdrop. */
const BACKDROP_STYLE = {
  position: 'absolute',
  top: '50%', left: '50%',
  width: '100%', height: '100%',
  objectFit: 'cover',
  transform: 'translate(-50%, -50%) scale(1.35)',
  // Desaturate + darken toward the site palette via filter —
  // raw space footage is too bright/colorful for this dark UI
  filter: 'brightness(0.45) saturate(0.55) contrast(1.05)',
} as const

export default function HeroVideoBackdrop() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [loaded, setLoaded] = useState(false)
  /*
   * The video is 5.7MB (WebM) / 7.5MB (MP4). It used to load on every device:
   * phones on mobile data, Save-Data connections, and people who asked for
   * reduced motion (it was paused for them, but still downloaded). Those now
   * get the poster image only.
   */
  const [playVideo, setPlayVideo] = useState(false)
  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const smallScreen = window.matchMedia('(max-width: 767px)').matches
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true
    setPlayVideo(!reducedMotion && !smallScreen && !saveData)
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          video.play().catch(() => {})
        } else {
          video.pause()
        }
      },
      { threshold: 0.1 }
    )

    const heroSection = video.closest('section')
    if (heroSection) observer.observe(heroSection)

    return () => observer.disconnect()
  }, [playVideo])

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      overflow: 'hidden',
      zIndex: 0,
    }}>
      {playVideo ? (
        <video
          ref={videoRef}
          autoPlay
          loop
          muted
          playsInline
          poster={getMediaUrl('video/hero-space-poster.jpg')}
          onLoadedData={() => setLoaded(true)}
          style={{ ...BACKDROP_STYLE, opacity: loaded ? 1 : 0, transition: 'opacity 1.2s ease' }}
        >
          <source src={getMediaUrl('video/hero-space-trimmed.webm')} type="video/webm" />
          <source src={getMediaUrl('video/hero-space-trimmed.mp4')} type="video/mp4" />
        </video>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- a decorative full-bleed backdrop, sized by CSS
        <img src={getMediaUrl('video/hero-space-poster.jpg')} alt="" aria-hidden="true" style={BACKDROP_STYLE} />
      )}

      {/* Vignette + color-match overlay — pulls the video toward
          the site's near-black background at the edges so it blends
          into surrounding sections instead of having a hard video-rect
          boundary visible */}
      <div style={{
        position: 'absolute', inset: 0,
        background: `
          radial-gradient(ellipse 100% 100% at 50% 0%, 
            transparent 0%, transparent 50%, rgba(10,10,10,0.95) 100%),
          linear-gradient(to bottom, 
            transparent 0%, transparent 70%, 
            rgba(10,10,10,1) 100%)
        `,
        pointerEvents: 'none',
      }} />

      {/* Lime tint wash — ties the cold space footage back into
          your brand color so it doesn't feel like a stock asset
          dropped in unrelated to the rest of the site */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'rgba(200,241,53,0.025)',
        mixBlendMode: 'overlay',
        pointerEvents: 'none',
      }} />
    </div>
  )
}
