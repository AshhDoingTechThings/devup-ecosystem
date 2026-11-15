"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Collaboration, financeApi, INCOME_LABEL, IncomeSource, inr, Revenue, today } from "@/lib/api/finance";
import { Bars, Button, Empty, ErrorNote, Field, Modal, PageHeader, Panel, StatCard, inputCls, useFinance } from "@/components/finance/ui";

/**
 * Money coming in — counted when it's received — and collaborations.
 * Startups paying DevUp's internal bills are not income, and nothing here
 * says anyone is "profitable": there's no accrual accounting behind it.
 */

const fmt = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export default function RevenuePage() {
  const { me, scope, scopeName, period, custom } = useFinance();
  const [tab, setTab] = useState<"income" | "collab">("income");
  const [rev, setRev] = useState<Revenue | null>(null);
  const [collabs, setCollabs] = useState<Collaboration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<"income" | "collab" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => {
    const p = period === "custom" && custom.from && custom.to ? { scope, period, ...custom } : { scope, period: period === "custom" ? "month" as const : period };
    Promise.all([financeApi.revenue(p), financeApi.collaborations()]).then(([r, c]) => { setRev(r); setCollabs(c); setError(null); }).catch((e) => setError(e.message));
  }, [scope, period, custom]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <PageHeader title="Money in & collaborations" sub={`What ${scopeName} actually received, and the partnerships it runs. Payments startups make to DevUp are internal and not counted here.`}>
        {me.canManageAnything && tab === "income" && <Button kind="primary" onClick={() => setAdding("income")}><Plus className="h-4 w-4" />Record money received</Button>}
        {me.isCfo && tab === "collab" && <Button kind="primary" onClick={() => setAdding("collab")}><Plus className="h-4 w-4" />New collaboration</Button>}
      </PageHeader>
      <div className="mb-4 flex gap-1 rounded-lg border border-white/[0.08] p-1 w-fit text-[12.5px]">
        <button onClick={() => setTab("income")} className={`rounded-md px-3 py-1.5 ${tab === "income" ? "bg-white/10 text-white" : "text-[#8b8b8b]"}`}>Money received</button>
        <button onClick={() => setTab("collab")} className={`rounded-md px-3 py-1.5 ${tab === "collab" ? "bg-white/10 text-white" : "text-[#8b8b8b]"}`}>Collaborations</button>
      </div>
      <ErrorNote message={error} />
      {tab === "income" ? <IncomeTab rev={rev} /> : <CollabTab rows={collabs} onOpen={setOpen} />}
      {adding === "income" && <IncomeForm collabs={collabs ?? []} onClose={() => setAdding(null)} onSaved={load} />}
      {adding === "collab" && <CollabForm onClose={() => setAdding(null)} onSaved={load} />}
      {open && <CollabDetail id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}

function IncomeTab({ rev }: { rev: Revenue | null }) {
  if (!rev) return <div className="h-32 animate-pulse rounded-xl bg-white/[0.03]" />;
  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label="Received" value={inr(rev.receivedPaise, { compact: true })} hint="Money that actually arrived from outside DevUp in the period — sponsorships, partners, clients, B2B work." tone="good" />
        <StatCard label="B2B work invoiced, not yet received" value={inr(rev.b2b.invoicedNotReceivedPaise, { compact: true })} hint="Client invoices sent from the B2B engagements but not paid. Not income until paid." />
        <StatCard label="From B2B client work" value={inr(rev.b2b.receivedPaise, { compact: true })} hint="Payments recorded against B2B engagements in the period." />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Where it came from" className="lg:col-span-1">
          {rev.bySource.length ? <Bars rows={rev.bySource.map((s) => ({ label: INCOME_LABEL[s.source], value: s.amountPaise }))} format={(v) => inr(v, { compact: true })} /> : <p className="text-[12.5px] text-[#6b6b6b]">Nothing received in this period.</p>}
        </Panel>
        <Panel title="Received" className="lg:col-span-2">
          {rev.entries.length + rev.b2b.payments.length === 0 ? <Empty title="Nothing recorded">Record sponsorships, partner contributions and client payments as they arrive.</Empty> : (
            <ul className="divide-y divide-white/5 text-[13px]">
              {rev.entries.map((e) => <li key={e.id} className="flex justify-between gap-3 py-2"><span><span className="text-[#e4e4e4]">{e.title}</span> <span className="text-[11.5px] text-[#6b6b6b]">{INCOME_LABEL[e.source]} · {e.payer} · {fmt(e.receivedOn)} · {e.startup?.name ?? "Central DevUp"}{e.collaboration ? ` · ${e.collaboration.name}` : ""}</span></span><span className="tabular-nums text-[#c8f135]">{inr(e.amountPaise)}</span></li>)}
              {rev.b2b.payments.map((p) => <li key={p.id} className="flex justify-between gap-3 py-2"><span><span className="text-[#e4e4e4]">{p.engagement.title}</span> <span className="text-[11.5px] text-[#6b6b6b]">B2B · {p.engagement.clientCompany} · {fmt(p.paidOn)}</span></span><span className="tabular-nums text-[#c8f135]">{inr(p.amountPaise)}</span></li>)}
            </ul>
          )}
        </Panel>
      </div>
      <p className="mt-3 text-[11.5px] text-[#6b6b6b]">Money in is counted when it arrives (cash basis). This page doesn&apos;t say whether anyone is profitable: that needs proper accounts.</p>
    </>
  );
}

function CollabTab({ rows, onOpen }: { rows: Collaboration[] | null; onOpen: (id: string) => void }) {
  if (!rows) return <div className="h-32 animate-pulse rounded-xl bg-white/[0.03]" />;
  if (!rows.length) return <Empty title="No collaborations yet">Track joint projects with partners: budget, what each startup agreed to put in, costs and money received.</Empty>;
  return (
    <ul className="space-y-2">
      {rows.map((c) => (
        <li key={c.id}><button onClick={() => onOpen(c.id)} className="flex w-full flex-wrap items-center gap-3 rounded-xl border border-white/[0.07] bg-[#0f0f0f] p-4 text-left hover:border-white/15">
          <div className="min-w-0 flex-1"><div className="text-[14px] text-[#e4e4e4]">{c.name}</div><div className="text-[11.5px] text-[#6b6b6b]">{c.partnerName} · {c.shares.map((s) => s.startup.name).join(", ") || "no startups yet"} · {c.status.toLowerCase()}</div></div>
          <div className="grid grid-cols-3 gap-4 text-right text-[12px]">
            <div><div className="text-[#6b6b6b]">Spent</div><div className="tabular-nums text-white">{inr(c.spentPaise, { compact: true })}</div></div>
            <div><div className="text-[#6b6b6b]">Received</div><div className="tabular-nums text-[#c8f135]">{inr(c.incomePaise, { compact: true })}</div></div>
            <div><div className="text-[#6b6b6b]">Budget left</div><div className="tabular-nums text-white">{c.budgetLeftPaise == null ? "—" : inr(c.budgetLeftPaise, { compact: true })}</div></div>
          </div>
        </button></li>
      ))}
    </ul>
  );
}

function CollabDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [c, setC] = useState<Collaboration | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { financeApi.collaboration(id).then(setC).catch((e) => setError(e.message)); }, [id]);
  if (!c) return <Modal title="Collaboration" onClose={onClose}><ErrorNote message={error} /></Modal>;
  return (
    <Modal title={c.name} onClose={onClose} wide>
      <p className="text-[12.5px] text-[#8b8b8b]">With {c.partnerName}{c.budgetPaise != null ? ` · budget ${inr(c.budgetPaise)}` : ""} · {c.status.toLowerCase()}</p>
      {c.description && <p className="mt-2 text-[13px] text-[#cfcfcf]">{c.description}</p>}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 text-[12px]">
        <div><div className="text-[#6b6b6b]">Spent</div><div className="tabular-nums text-white">{inr(c.spentPaise)}</div></div>
        <div><div className="text-[#6b6b6b]">Approved, not paid</div><div className="tabular-nums text-sky-300">{inr(c.committedPaise)}</div></div>
        <div><div className="text-[#6b6b6b]">Received</div><div className="tabular-nums text-[#c8f135]">{inr(c.incomePaise)}</div></div>
        <div><div className="text-[#6b6b6b]">Received − spent</div><div className="tabular-nums text-white">{inr(c.netPaise)}</div></div>
      </div>
      <h3 className="mt-5 mb-2 text-[#a1a1a1]" style={{ fontSize: 12, fontWeight: 600 }}>Startups and what they agreed to put in</h3>
      <ul className="space-y-1 text-[13px]">{c.shares.map((s) => <li key={s.id} className="flex justify-between"><span className="text-[#cfcfcf]">{s.startup.name}</span><span className="tabular-nums">{s.agreedContributionPaise != null ? inr(s.agreedContributionPaise) : "—"}</span></li>)}</ul>
      <h3 className="mt-5 mb-2 text-[#a1a1a1]" style={{ fontSize: 12, fontWeight: 600 }}>Costs</h3>
      <ul className="space-y-1 text-[13px]">{(c.costs ?? []).map((x) => <li key={x.id} className="flex justify-between gap-3"><span className="text-[#cfcfcf]">{x.title} <span className="text-[11px] text-[#6b6b6b]">{x.number} · {x.startup?.name ?? "Central DevUp"} · {x.status.toLowerCase()}</span></span><span className="tabular-nums">{inr(x.amountPaise)}</span></li>)}{!(c.costs ?? []).length && <li className="text-[#6b6b6b]">None yet.</li>}</ul>
      <p className="mt-4 text-[11.5px] text-[#6b6b6b]">Costs go through Expenses &amp; claims like any expense; money received is recorded under Money received.</p>
      <div className="mt-4 flex justify-end"><Button kind="ghost" onClick={() => { onChanged(); onClose(); }}>Close</Button></div>
    </Modal>
  );
}

function IncomeForm({ collabs, onClose, onSaved }: { collabs: Collaboration[]; onClose: () => void; onSaved: () => void }) {
  const { me, scope } = useFinance();
  const scopes = [...(me.isCfo ? [{ value: "central", label: "Central DevUp" }] : []), ...me.startups.filter((s) => me.isCfo || me.roles.some((r) => r.role === "STARTUP_FINANCE_MANAGER" && r.startupId === s.id)).map((s) => ({ value: s.id, label: s.name }))];
  const [f, setF] = useState({ scope: scopes.some((x) => x.value === scope) ? scope : scopes[0]?.value ?? "", source: "SPONSORSHIP" as IncomeSource, title: "", payer: "", amount: "", receivedOn: today(), reference: "", collaborationId: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Record money received" onClose={onClose}>
      <div className="grid gap-3">
        <Field label="Received by" required><select className={inputCls} value={f.scope} onChange={set("scope")}>{scopes.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
        <Field label="Kind"><select className={inputCls} value={f.source} onChange={set("source")}>{(Object.keys(INCOME_LABEL) as Array<keyof typeof INCOME_LABEL>).filter((k) => k !== "B2B_CLIENT_WORK").map((k) => <option key={k} value={k}>{INCOME_LABEL[k]}</option>)}</select></Field>
        <Field label="What for" required><input className={inputCls} value={f.title} onChange={set("title")} /></Field>
        <Field label="Who paid" required><input className={inputCls} value={f.payer} onChange={set("payer")} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount (₹)" required><input className={inputCls} inputMode="decimal" value={f.amount} onChange={set("amount")} /></Field>
          <Field label="Received on" required><input type="date" className={inputCls} max={today()} value={f.receivedOn} onChange={set("receivedOn")} /></Field>
        </div>
        <Field label="Bank reference"><input className={inputCls} value={f.reference} onChange={set("reference")} /></Field>
        {collabs.length > 0 && <Field label="Part of a collaboration?"><select className={inputCls} value={f.collaborationId} onChange={set("collaborationId")}><option value="">No</option>{collabs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
      </div>
      <div className="mt-3"><ErrorNote message={error} /></div>
      <div className="mt-4 flex justify-end gap-2"><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy || !f.title || !f.payer || !f.amount} onClick={async () => {
        setBusy(true); setError(null);
        try { await financeApi.addIncome({ ...f, reference: f.reference || null, collaborationId: f.collaborationId || null }); onSaved(); onClose(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
      }}>Save</Button></div>
    </Modal>
  );
}

function CollabForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { me } = useFinance();
  const [f, setF] = useState({ name: "", partnerName: "", budget: "", description: "" });
  const [shares, setShares] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="New collaboration" onClose={onClose} wide>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name" required><input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Partner" required><input className={inputCls} value={f.partnerName} onChange={(e) => setF({ ...f, partnerName: e.target.value })} /></Field>
        <Field label="Budget (₹)"><input className={inputCls} inputMode="decimal" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} /></Field>
        <Field label="Description"><input className={inputCls} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
      <h3 className="mt-4 mb-2 text-[#a1a1a1]" style={{ fontSize: 12, fontWeight: 600 }}>Startups taking part, and what each agreed to put in</h3>
      <ul className="space-y-2">{me.startups.map((s) => (
        <li key={s.id} className="flex items-center gap-3">
          <label className="flex flex-1 items-center gap-2 text-[13px] text-[#cfcfcf]"><input type="checkbox" checked={s.id in shares} onChange={(e) => { const n = { ...shares }; if (e.target.checked) n[s.id] = ""; else delete n[s.id]; setShares(n); }} />{s.name}</label>
          {s.id in shares && <input className={`${inputCls} w-36 text-right`} inputMode="decimal" placeholder="₹ (optional)" value={shares[s.id]} onChange={(e) => setShares({ ...shares, [s.id]: e.target.value })} />}
        </li>
      ))}</ul>
      <div className="mt-3"><ErrorNote message={error} /></div>
      <div className="mt-4 flex justify-end gap-2"><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy || f.name.trim().length < 2 || f.partnerName.trim().length < 2} onClick={async () => {
        setBusy(true); setError(null);
        try {
          await financeApi.createCollaboration({ ...f, budget: f.budget || null, description: f.description || null, shares: Object.entries(shares).map(([startupId, v]) => ({ startupId, agreedContribution: v || null })) });
          onSaved(); onClose();
        } catch (e: any) { setError(e.message); } finally { setBusy(false); }
      }}>Create</Button></div>
    </Modal>
  );
}
