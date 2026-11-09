'use client'
import { motion } from 'framer-motion'
import { useLiveStats, compactCount } from '@/lib/hooks/useLiveStats'

export default function HeroStatChips() {
  // The startup and student counts are live; they used to be fixed at "23+"
  // and "1.2K" whatever the database said. The funding and city figures are
  // published copy, not counts.
  const live = useLiveStats()
  const CHIPS = [
    { label: 'Active Startups', value: live ? `${live.totalStartups}+` : '—', top: '8%', left: '4%', delay: 0.2 },
    { label: 'Funding Unlocked', value: '₹4Cr+', top: '70%', left: '2%', delay: 0.35 },
    { label: 'Student Builders', value: live ? compactCount(live.totalUsers) : '—', top: '12%', left: '78%', delay: 0.5 },
    { label: 'Cities', value: '6', top: '72%', left: '80%', delay: 0.65 },
  ]

  return (
    <>
      <style>
        {`
          @keyframes float-chip {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-8px); }
          }
          .chip-float-0 { animation: float-chip 4s ease-in-out infinite; }
          .chip-float-1 { animation: float-chip 5s ease-in-out infinite 1s; }
          .chip-float-2 { animation: float-chip 4.5s ease-in-out infinite 0.5s; }
          .chip-float-3 { animation: float-chip 6s ease-in-out infinite 2s; }
        `}
      </style>
      {CHIPS.map((chip, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ 
            duration: 0.6, delay: chip.delay, 
            ease: [0.16, 1, 0.3, 1] 
          }}
          className={`chip-float-${i % 4}`}
          style={{
            position: 'absolute',
            top: chip.top,
            left: chip.left,
            background: 'rgba(17,17,17,0.85)',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 10,
            padding: '8px 14px',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        >
          <div style={{
            fontFamily: 'Syne', fontSize: 18, fontWeight: 800,
            color: '#ffffff', lineHeight: 1,
          }}>
            {chip.value}
          </div>
          <div style={{
            fontFamily: 'Inter', fontSize: 10, color: '#6b6b6b',
            marginTop: 2, whiteSpace: 'nowrap',
          }}>
            {chip.label}
          </div>
        </motion.div>
      ))}
    </>
  )
}
