import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/config/api'
import { TopBar } from '@/components/Layout/TopBar'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useAuth } from '@/hooks/useAuth'
import { Landmark, Search, ShieldCheck, ShieldAlert, UserPlus } from 'lucide-react'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

/**
 * Who may use the DevUp finance portal (/finance on the main site).
 *
 * Super admins only. Finance access is separate from being an admin: granting
 * it here is the only way in, it only goes to accounts with a verified email,
 * and nobody can grant it to themselves. Every grant and revoke is recorded.
 */

type RoleKind = 'ECOSYSTEM_CFO' | 'STARTUP_FINANCE_MANAGER' | 'FINANCE_VIEWER'

interface FinanceRoleRow {
  id: string
  role: RoleKind
  startup: { id: string; name: string; code: string | null } | null
  note: string | null
  grantedAt: string
  revokedAt: string | null
  active: boolean
  user: { id: string; name: string | null; email: string; verified: boolean; lastLoginAt: string | null }
}

interface Candidate {
  id: string
  name: string | null
  email: string
  platformRole: string
  verified: boolean
  lastLoginAt: string | null
  canGrant: boolean
  whyNot: string | null
}

const ROLE_LABEL: Record<RoleKind, string> = {
  ECOSYSTEM_CFO: 'CFO — everything, approves and pays',
  STARTUP_FINANCE_MANAGER: 'Startup finance manager — one startup, cannot approve',
  FINANCE_VIEWER: 'Finance viewer — read only, never sees pay',
}

const errorOf = (e: any, fallback: string) => e?.response?.data?.error ?? fallback

export default function FinanceAccess() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const [granting, setGranting] = useState(false)
  const isSuper = user?.role === 'SUPER_ADMIN'

  const roles = useQuery<FinanceRoleRow[]>({
    queryKey: ['finance-roles'],
    queryFn: async () => (await api.get('/api/finance/roles')).data.data,
    enabled: isSuper,
  })

  const revoke = useMutation({
    mutationFn: async (row: FinanceRoleRow) => {
      const reason = prompt(`Remove ${row.user.name ?? row.user.email}'s finance access? Say why (kept on record):`)
      if (reason === null) throw new Error('cancelled')
      return (await api.post(`/api/finance/roles/${row.id}/revoke`, { reason })).data.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['finance-roles'] })
      toast.success('Access removed')
    },
    onError: (e: any) => {
      if (e.message !== 'cancelled') toast.error(errorOf(e, 'Could not remove access'))
    },
  })

  if (!isSuper) {
    return (
      <div>
        <TopBar title="Finance access" />
        <div className="p-6 text-sm text-gray-400">Only a super admin can manage finance access.</div>
      </div>
    )
  }

  const rows = roles.data ?? []
  const active = rows.filter((r) => r.active)
  const past = rows.filter((r) => !r.active)

  return (
    <div>
      <TopBar title="Finance access" />
      <div className="p-6 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <p className="max-w-2xl text-sm text-gray-400">
            Who can open the DevUp finance portal. Being an admin gives no finance access on its own. Access only goes to
            accounts whose email is verified, and you cannot give it to yourself.
          </p>
          <Button onClick={() => setGranting(true)}><UserPlus className="w-4 h-4 mr-1.5 inline" />Give access</Button>
        </div>

        <section className="rounded-xl border border-white/5 bg-[#0c0c0c]">
          <h2 className="px-5 pt-4 text-sm font-semibold text-white">Current access ({active.length})</h2>
          {roles.isLoading ? (
            <div className="p-5 text-sm text-gray-500">Loading…</div>
          ) : active.length === 0 ? (
            <div className="p-5 text-sm text-gray-500">Nobody has finance access yet. Start by giving the CFO role to DevUp's CFO. There can be more than one CFO; each action is recorded under the person who took it.</div>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {active.map((r) => (
                  <tr key={r.id} className="border-t border-white/5">
                    <td className="px-5 py-3">
                      <div className="text-white">{r.user.name ?? '—'}</div>
                      <div className="text-xs text-gray-500">{r.user.email}</div>
                    </td>
                    <td className="px-5 py-3 text-gray-300">
                      <span className="inline-flex items-center gap-1.5">{r.role === 'ECOSYSTEM_CFO' && <Landmark className="w-3.5 h-3.5 text-emerald-400" />}{ROLE_LABEL[r.role].split(' — ')[0]}</span>
                      <div className="text-xs text-gray-500">{r.startup ? r.startup.name : r.role === 'ECOSYSTEM_CFO' ? 'All startups and central DevUp' : 'Everything (read only)'}</div>
                    </td>
                    <td className="px-5 py-3 text-xs text-gray-500">Since {format(new Date(r.grantedAt), 'd MMM yyyy')}{r.note ? ` · ${r.note}` : ''}</td>
                    <td className="px-5 py-3 text-right">
                      <Button variant="ghost" size="sm" onClick={() => revoke.mutate(r)} disabled={revoke.isPending}>Remove</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {past.length > 0 && (
          <section className="rounded-xl border border-white/5 bg-[#0c0c0c]">
            <h2 className="px-5 pt-4 text-sm font-semibold text-white">Past access</h2>
            <table className="w-full text-sm">
              <tbody>
                {past.map((r) => (
                  <tr key={r.id} className="border-t border-white/5 text-gray-500">
                    <td className="px-5 py-2.5">{r.user.name ?? r.user.email}</td>
                    <td className="px-5 py-2.5">{ROLE_LABEL[r.role].split(' — ')[0]}{r.startup ? ` · ${r.startup.name}` : ''}</td>
                    <td className="px-5 py-2.5 text-xs">{format(new Date(r.grantedAt), 'd MMM yyyy')} – {r.revokedAt ? format(new Date(r.revokedAt), 'd MMM yyyy') : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>

      <GrantModal isOpen={granting} onClose={() => setGranting(false)} onDone={() => qc.invalidateQueries({ queryKey: ['finance-roles'] })} selfId={user?.id} />
    </div>
  )
}

function GrantModal({ isOpen, onClose, onDone, selfId }: { isOpen: boolean; onClose: () => void; onDone: () => void; selfId?: string }) {
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<Candidate | null>(null)
  const [role, setRole] = useState<RoleKind>('ECOSYSTEM_CFO')
  const [startupId, setStartupId] = useState('')
  const [note, setNote] = useState('')

  const people = useQuery<Candidate[]>({
    queryKey: ['finance-candidates', q],
    queryFn: async () => (await api.get(`/api/finance/roles/candidates?q=${encodeURIComponent(q.trim())}`)).data.data,
    enabled: isOpen && q.trim().length >= 2,
  })
  const startups = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['startups-for-finance'],
    queryFn: async () => (await api.get('/api/finance/roles/startups')).data.data,
    enabled: isOpen,
  })

  const grant = useMutation({
    mutationFn: async () =>
      (await api.post('/api/finance/roles', { userId: picked!.id, role, startupId: role === 'ECOSYSTEM_CFO' ? null : startupId || null, note: note || null })).data.data,
    onSuccess: () => {
      toast.success('Finance access given')
      onDone()
      close()
    },
    onError: (e: any) => toast.error(errorOf(e, 'Could not give access')),
  })

  const close = () => {
    setQ('')
    setPicked(null)
    setNote('')
    setStartupId('')
    onClose()
  }

  const needsStartup = role === 'STARTUP_FINANCE_MANAGER'
  const input = 'w-full rounded-lg border border-white/10 bg-[#0a0a0a] px-3 py-2 text-sm text-white outline-none focus:border-indigo-500/50'

  return (
    <Modal isOpen={isOpen} onClose={close} title="Give finance access">
      <div className="space-y-4">
        {!picked ? (
          <>
            <div className="relative">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-500" />
              <input autoFocus className={`${input} pl-9`} placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <ul className="space-y-1 max-h-72 overflow-y-auto">
              {(people.data ?? []).map((c) => {
                const self = c.id === selfId
                const ok = c.canGrant && !self
                return (
                  <li key={c.id}>
                    <button disabled={!ok} onClick={() => setPicked(c)} className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60">
                      <div className="flex items-center gap-2 text-sm text-white">
                        {c.verified ? <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> : <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />}
                        {c.name ?? '—'} <span className="text-xs text-gray-500">{c.email}</span>
                      </div>
                      <div className="ml-5.5 text-xs text-gray-500">
                        {self ? 'This is you — another super admin must give you access' : c.whyNot ?? `${c.platformRole.toLowerCase()} · ${c.lastLoginAt ? `last signed in ${format(new Date(c.lastLoginAt), 'd MMM yyyy')}` : 'never signed in'}`}
                      </div>
                    </button>
                  </li>
                )
              })}
              {q.trim().length >= 2 && people.data?.length === 0 && <li className="px-3 py-2 text-sm text-gray-500">No account found.</li>}
            </ul>
          </>
        ) : (
          <>
            <div className="rounded-lg border border-white/10 p-3">
              <div className="flex items-center gap-2 text-sm text-white"><ShieldCheck className="w-4 h-4 text-emerald-400" />{picked.name ?? '—'}</div>
              <div className="text-xs text-gray-500">{picked.email} · email verified</div>
              <button onClick={() => setPicked(null)} className="mt-1 text-xs text-indigo-400 hover:underline">Choose someone else</button>
            </div>
            <label className="block text-sm">
              <span className="mb-1 block text-gray-400">Role</span>
              <select className={input} value={role} onChange={(e) => setRole(e.target.value as RoleKind)}>
                {(Object.keys(ROLE_LABEL) as RoleKind[]).map((k) => <option key={k} value={k}>{ROLE_LABEL[k]}</option>)}
              </select>
            </label>
            {role !== 'ECOSYSTEM_CFO' && (
              <label className="block text-sm">
                <span className="mb-1 block text-gray-400">Startup{needsStartup ? '' : ' (leave empty for everything, read only)'}</span>
                <select className={input} value={startupId} onChange={(e) => setStartupId(e.target.value)}>
                  <option value="">{needsStartup ? 'Choose a startup…' : 'Everything'}</option>
                  {(startups.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            )}
            <label className="block text-sm">
              <span className="mb-1 block text-gray-400">Note (optional)</span>
              <input className={input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. CFO from November 2026" />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button onClick={() => grant.mutate()} disabled={grant.isPending || (needsStartup && !startupId)}>{grant.isPending ? 'Saving…' : 'Give access'}</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
