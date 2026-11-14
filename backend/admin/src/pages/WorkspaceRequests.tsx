import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import api from '@/config/api'
import { TopBar } from '@/components/Layout/TopBar'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { SlideOver } from '@/components/ui/SlideOver'

/**
 * Employee / intern requests to join a startup workspace, across every startup.
 * DevUp admins can decide them here; the backend applies exactly the same rules
 * as the startup's own Team Requests page (one approval path, one audit trail).
 */

type RequestStatus = 'PENDING' | 'NEEDS_INFO' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
type Kind = 'EMPLOYEE' | 'INTERN'
type Startup = { id: string; name: string; code: string | null; logoUrl: string | null }

interface RequestRow {
  id: string
  kind: Kind
  status: RequestStatus
  fullName: string
  email: string
  emailVerified: boolean
  designation: string | null
  department: string | null
  college: string | null
  submittedAt: string
  reviewedAt: string | null
  reviewedBy: string | null
  reviewNote: string | null
  offerStatus: 'SENDING' | 'SENT' | 'FAILED' | 'READY' | null
  offerError: string | null
  startup: Startup
}

interface RequestDetail extends Omit<RequestRow, 'startup' | 'emailVerified'> {
  phone: string | null
  joiningDate: string | null
  endDate: string | null
  note: string | null
  user: { emailVerified: boolean }
  offer: { status: string | null; documentNo: string | null; error: string | null; message: string | null; attempts: number } | null
  history: Array<{ action: string; at: string; by: string | null; note: string | null }>
  startup: Startup
}

const tabs: Array<{ key: 'OPEN' | RequestStatus | 'ALL'; label: string }> = [
  { key: 'OPEN', label: 'Awaiting decision' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'NEEDS_INFO', label: 'Needs info' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'ALL', label: 'All' },
]

const statusLabel: Record<RequestStatus, string> = {
  PENDING: 'PENDING',
  NEEDS_INFO: 'NEEDS INFO',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'WITHDRAWN',
}
const statusVariant: Record<RequestStatus, string> = {
  PENDING: 'warning',
  NEEDS_INFO: 'primary',
  APPROVED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'default',
}

const historyLabel: Record<string, string> = {
  'affiliation.requested': 'Requested',
  'affiliation.resubmitted': 'Resubmitted',
  'affiliation.updated': 'Edited',
  'affiliation.cancelled': 'Withdrawn',
  'affiliation.approved': 'Approved',
  'affiliation.rejected': 'Rejected',
  'affiliation.info_requested': 'More information requested',
  'affiliation.offer_sent': 'Offer letter emailed',
  'affiliation.offer_failed': 'Offer letter failed',
}

const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString() : '—')
const errorText = (e: unknown) =>
  (e as { response?: { data?: { error?: string; message?: string } } })?.response?.data?.error ||
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ||
  (e instanceof Error ? e.message : 'Something went wrong')

const inputCls =
  'w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-500'

export default function WorkspaceRequests() {
  const [tab, setTab] = useState<(typeof tabs)[number]['key']>('OPEN')
  const [startupFilter, setStartupFilter] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['workspace-requests', tab],
    queryFn: async () => {
      const res = await api.get(`/api/admin/affiliations/requests?status=${tab}`)
      return res.data.data as { items: RequestRow[]; counts: Partial<Record<RequestStatus, number>> }
    },
  })

  const items = useMemo(() => data?.items ?? [], [data])
  const startups = useMemo(() => {
    const seen = new Map<string, Startup>()
    items.forEach((i) => seen.set(i.startup.id, i.startup))
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [items])
  const rows = startupFilter ? items.filter((i) => i.startup.id === startupFilter) : items
  const openCount = (data?.counts.PENDING ?? 0) + (data?.counts.NEEDS_INFO ?? 0)

  return (
    <div className="flex flex-col">
      <TopBar title="Workspace Requests" />
      <div className="p-6 space-y-6">
        <p className="text-sm text-gray-500 -mt-2">
          People asking to join a startup as an employee or intern. Approving here is the same as the startup approving it
          on its Team Requests page: their record and access are created, and interns are emailed their offer letter.
        </p>

        <div className="flex items-center gap-2 flex-wrap">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${
                tab === t.key
                  ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30'
                  : 'text-gray-500 hover:text-white bg-white/5 border border-white/5'
              }`}
            >
              {t.label}
              {t.key === 'OPEN' && openCount > 0 && (
                <span className="ml-1.5 rounded-full bg-yellow-500/20 px-1.5 text-[11px] text-yellow-400">{openCount}</span>
              )}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-3">
            <select
              aria-label="Filter by startup"
              value={startupFilter}
              onChange={(e) => setStartupFilter(e.target.value)}
              className="rounded-lg bg-white/5 border border-white/10 px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
            >
              <option value="">All startups</option>
              {startups.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <Badge label={`${rows.length} shown`} />
          </div>
        </div>

        <div className="bg-white/[0.03] border border-white/5 rounded-2xl overflow-x-auto">
          {isLoading ? (
            <div className="p-8 space-y-3">
              {[...Array(4)].map((_, i) => <div key={i} className="h-12 bg-white/5 rounded-lg animate-pulse" />)}
            </div>
          ) : isError ? (
            <div className="p-16 text-center">
              <p className="text-red-400 text-lg">Could not load workspace requests</p>
              <p className="text-gray-500 text-sm mt-1">{errorText(error)}</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="p-16 text-center">
              <p className="text-gray-500 text-lg">No requests here</p>
              <p className="text-gray-700 text-sm mt-1">
                When someone chooses “Join your startup workspace” on their dashboard, their request appears here.
              </p>
            </div>
          ) : (
            <table className="w-full min-w-[900px]">
              <thead>
                <tr className="border-b border-white/5">
                  {['Person', 'Startup', 'Joining as', 'Submitted', 'Status', 'Actions'].map((h) => (
                    <th key={h} className={`${h === 'Actions' ? 'text-right' : 'text-left'} text-xs font-semibold text-gray-500 uppercase tracking-wider px-6 py-3`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                    <td className="px-6 py-4">
                      <div className="font-medium text-white">{r.fullName}</div>
                      <div className="text-xs text-gray-500">
                        {r.email}
                        {!r.emailVerified && <span className="ml-2 text-yellow-500">· email not verified</span>}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-300">
                      <div className="flex items-center gap-2">
                        {r.startup.logoUrl ? (
                          <img src={r.startup.logoUrl} alt="" className="w-6 h-6 rounded object-cover bg-white" />
                        ) : (
                          <span className="w-6 h-6 rounded bg-white/10 text-[11px] flex items-center justify-center text-gray-400">{r.startup.name[0]}</span>
                        )}
                        {r.startup.name}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-400">
                      <Badge label={r.kind === 'INTERN' ? 'Intern' : 'Employee'} variant={r.kind === 'INTERN' ? 'primary' : 'default'} />
                      {r.designation && <div className="text-xs text-gray-500 mt-1">{r.designation}</div>}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-400">{fmtDate(r.submittedAt)}</td>
                    <td className="px-6 py-4">
                      <Badge label={statusLabel[r.status]} variant={statusVariant[r.status]} />
                      {r.offerStatus === 'FAILED' && <div className="text-[11px] text-red-400 mt-1">Offer letter failed</div>}
                      {r.offerStatus === 'SENT' && <div className="text-[11px] text-emerald-400 mt-1">Offer letter sent</div>}
                      {r.offerStatus === 'READY' && <div className="text-[11px] text-sky-400 mt-1">Revised letter ready to send</div>}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Button variant="ghost" size="sm" onClick={() => setSelectedId(r.id)}>Review</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <SlideOver isOpen={Boolean(selectedId)} onClose={() => setSelectedId(null)} title="Review workspace request">
        {selectedId && (
          <ReviewPanel
            // A fresh panel per request: never carry one person's half-filled
            // approval form over to the next.
            key={selectedId}
            id={selectedId}
            onDone={() => {
              queryClient.invalidateQueries({ queryKey: ['workspace-requests'] })
              setSelectedId(null)
            }}
          />
        )}
      </SlideOver>
    </div>
  )
}

function ReviewPanel({ id, onDone }: { id: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const { data: r, isLoading, isError, error } = useQuery({
    queryKey: ['workspace-request', id],
    queryFn: async () => (await api.get(`/api/admin/affiliations/requests/${id}`)).data.data as RequestDetail,
  })

  const [mode, setMode] = useState<'approve' | 'info' | 'reject' | null>(null)
  const [form, setForm] = useState({ designation: '', department: '', joiningDate: '', endDate: '', stipend: '', ctc: '', workMode: 'OFFICE', location: '', issueOfferLetter: true })
  const [note, setNote] = useState('')

  const act = useMutation({
    mutationFn: async (action: 'approve' | 'info' | 'reject' | 'offer') => {
      const base = `/api/admin/affiliations/requests/${id}`
      if (action === 'approve') {
        const isIntern = r?.kind === 'INTERN'
        const body: Record<string, unknown> = {
          designation: form.designation || undefined,
          department: form.department || undefined,
          joiningDate: form.joiningDate || undefined,
          endDate: isIntern ? form.endDate || undefined : undefined,
          issueOfferLetter: form.issueOfferLetter,
          workMode: form.workMode,
          location: form.location || undefined,
          ...(isIntern ? { stipend: form.stipend || undefined } : { ctc: form.ctc || undefined }),
        }
        return (await api.post(`${base}/approve`, body)).data.data
      }
      if (action === 'info') return (await api.post(`${base}/request-info`, { message: note })).data.data
      if (action === 'reject') return (await api.post(`${base}/reject`, { reason: note })).data.data
      return (await api.post(`${base}/offer`, {})).data.data
    },
    onSuccess: (result, action) => {
      if (action === 'approve') {
        const offer = result?.offer
        if (offer?.status === 'FAILED') toast.error(`Approved — but the offer letter was not sent: ${offer.message ?? offer.error}`)
        else if (offer?.status === 'SENT') toast.success('Approved. The offer letter has been emailed.')
        else toast.success('Approved. They now have access to the workspace.')
      } else if (action === 'offer') {
        if (result?.status === 'SENT') toast.success('Offer letter emailed')
        else toast.error(result?.message ?? 'The offer letter could not be sent')
      } else toast.success(action === 'reject' ? 'Request rejected' : 'Asked for more information')
      queryClient.invalidateQueries({ queryKey: ['workspace-request', id] })
      if (action !== 'offer') onDone()
    },
    onError: (e) => toast.error(errorText(e)),
  })

  if (isLoading) return <div className="space-y-3">{[...Array(5)].map((_, i) => <div key={i} className="h-10 bg-white/5 rounded-lg animate-pulse" />)}</div>
  if (isError || !r) return <p className="text-red-400 text-sm">{errorText(error)}</p>

  const isIntern = r.kind === 'INTERN'
  const open = r.status === 'PENDING' || r.status === 'NEEDS_INFO'
  const field = (k: keyof typeof form, label: string, type = 'text', placeholder = '') => (
    <label className="block">
      <span className="text-xs text-gray-500">{label}</span>
      <input
        type={type}
        value={String(form[k])}
        placeholder={placeholder}
        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
        className={`${inputCls} mt-1`}
      />
    </label>
  )
  const startEdit = () => {
    setForm({
      designation: r.designation ?? '',
      department: r.department ?? '',
      joiningDate: r.joiningDate ? r.joiningDate.slice(0, 10) : '',
      endDate: r.endDate ? r.endDate.slice(0, 10) : '',
      stipend: '',
      ctc: '',
      workMode: 'OFFICE',
      location: '',
      issueOfferLetter: isIntern,
    })
    setMode('approve')
  }

  return (
    <div className="space-y-6">
      <section className="space-y-1">
        <p className="text-xs text-indigo-400">{r.startup.name}{r.startup.code ? ` · ${r.startup.code}` : ''}</p>
        <h3 className="text-xl font-bold text-white">{r.fullName}</h3>
        <div className="flex items-center gap-2">
          <Badge label={isIntern ? 'Intern' : 'Employee'} variant={isIntern ? 'primary' : 'default'} />
          <Badge label={statusLabel[r.status]} variant={statusVariant[r.status]} />
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 text-sm">
        <div className="col-span-2">
          <p className="text-xs text-gray-600">Email</p>
          <a className="text-indigo-300 break-all" href={`mailto:${r.email}`}>{r.email}</a>
          {!r.user.emailVerified && <p className="text-xs text-yellow-500 mt-0.5">Not verified yet — approval is blocked until they verify.</p>}
        </div>
        <div><p className="text-xs text-gray-600">Phone</p><p className="text-gray-300">{r.phone || '—'}</p></div>
        <div><p className="text-xs text-gray-600">Designation</p><p className="text-gray-300">{r.designation || '—'}</p></div>
        <div><p className="text-xs text-gray-600">Department</p><p className="text-gray-300">{r.department || '—'}</p></div>
        {isIntern && <div><p className="text-xs text-gray-600">College</p><p className="text-gray-300">{r.college || '—'}</p></div>}
        <div><p className="text-xs text-gray-600">Joining</p><p className="text-gray-300">{fmtDate(r.joiningDate)}</p></div>
        {isIntern && <div><p className="text-xs text-gray-600">Ends</p><p className="text-gray-300">{fmtDate(r.endDate)}</p></div>}
        <div><p className="text-xs text-gray-600">Submitted</p><p className="text-gray-300">{fmtDate(r.submittedAt)}</p></div>
      </section>

      {r.note && (
        <section>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Their note</p>
          <p className="text-sm leading-6 text-gray-300 whitespace-pre-wrap">{r.note}</p>
        </section>
      )}
      {r.reviewNote && (
        <section>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">{r.status === 'REJECTED' ? 'Reason given' : 'Message sent'}</p>
          <p className="text-sm leading-6 text-gray-300 whitespace-pre-wrap">{r.reviewNote}</p>
        </section>
      )}

      {r.offer && (
        <section className="rounded-xl border border-white/10 p-4 space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Offer letter</p>
          <p className="text-sm text-gray-300">
            {r.offer.status === 'SENT' ? 'Emailed' : r.offer.status === 'FAILED' ? 'Not sent' : r.offer.status === 'SENDING' ? 'Sending…' : 'Not requested'}
            {r.offer.documentNo && <span className="text-gray-500"> · {r.offer.documentNo}</span>}
          </p>
          {r.offer.status === 'FAILED' && <p className="text-xs text-red-400">{r.offer.message ?? r.offer.error}</p>}
          {r.status === 'APPROVED' && r.offer.status !== 'SENT' && r.offer.status !== 'SENDING' && (
            <Button size="sm" variant="outline" isLoading={act.isPending} onClick={() => act.mutate('offer')}>
              {r.offer.status === 'FAILED' ? 'Retry sending' : 'Send offer letter'}
            </Button>
          )}
        </section>
      )}
      {!r.offer && r.status === 'APPROVED' && (
        <Button size="sm" variant="outline" isLoading={act.isPending} onClick={() => act.mutate('offer')}>Send offer letter</Button>
      )}

      {open && (
        <section className="space-y-3 border-t border-white/5 pt-5">
          {mode === null && (
            <div className="grid grid-cols-3 gap-2">
              <Button variant="success" onClick={startEdit} disabled={!r.user.emailVerified}>Approve</Button>
              <Button variant="outline" onClick={() => { setNote(''); setMode('info') }}>Ask for info</Button>
              <Button variant="danger" onClick={() => { setNote(''); setMode('reject') }}>Reject</Button>
            </div>
          )}

          {mode === 'approve' && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-white">Approve {r.fullName} as {isIntern ? 'an intern' : 'an employee'} at {r.startup.name}</p>
              <div className="grid grid-cols-2 gap-3">
                {field('designation', 'Designation')}
                {field('department', 'Department')}
                {field('joiningDate', 'Joining date', 'date')}
                {isIntern ? field('endDate', 'End date', 'date') : field('ctc', 'CTC (printed on the letter)', 'text', 'e.g. Rs 6,00,000 / year')}
                {isIntern && field('stipend', 'Stipend (printed on the letter)', 'text', 'e.g. Rs 10,000 / month')}
                <label className="block">
                  <span className="text-xs text-gray-500">Work mode</span>
                  <select value={form.workMode} onChange={(e) => setForm({ ...form, workMode: e.target.value })} className={`${inputCls} mt-1`}>
                    <option value="OFFICE">Office</option>
                    <option value="HYBRID">Hybrid</option>
                    <option value="REMOTE">Remote</option>
                  </select>
                </label>
                {field('location', 'Location')}
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={form.issueOfferLetter} onChange={(e) => setForm({ ...form, issueOfferLetter: e.target.checked })} />
                Email the offer letter now
              </label>
              <div className="flex gap-2">
                <Button variant="success" className="flex-1" isLoading={act.isPending} onClick={() => act.mutate('approve')}>Confirm approval</Button>
                <Button variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
              </div>
            </div>
          )}

          {(mode === 'info' || mode === 'reject') && (
            <div className="space-y-3">
              <label className="block text-sm font-medium text-white">
                {mode === 'reject' ? 'Reason (shown to them)' : 'What do you need from them? (shown to them)'}
              </label>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} className={inputCls} />
              <div className="flex gap-2">
                <Button
                  variant={mode === 'reject' ? 'danger' : 'primary'}
                  className="flex-1"
                  disabled={note.trim().length < 3}
                  isLoading={act.isPending}
                  onClick={() => act.mutate(mode)}
                >
                  {mode === 'reject' ? 'Reject request' : 'Send request for info'}
                </Button>
                <Button variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
              </div>
            </div>
          )}
        </section>
      )}

      {r.history.length > 0 && (
        <section className="border-t border-white/5 pt-5">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">History</p>
          <ol className="space-y-2">
            {r.history.map((h, i) => (
              <li key={i} className="text-sm">
                <span className="text-gray-300">{historyLabel[h.action] ?? h.action}</span>
                <span className="text-gray-600"> · {new Date(h.at).toLocaleString()}{h.by ? ` · ${h.by}` : ''}</span>
                {h.note && <p className="text-xs text-gray-500 mt-0.5">{h.note}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}
