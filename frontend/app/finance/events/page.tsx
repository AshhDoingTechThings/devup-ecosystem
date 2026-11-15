"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Category, EVENT_KIND_LABEL, EventKind, FinanceEvent, financeApi, inr, today } from "@/lib/api/finance";
import { Button, Empty, ErrorNote, Field, Modal, PageHeader, StatusPill, inputCls, useFinance } from "@/components/finance/ui";

/**
 * Meetings, get-togethers, workshops and trips. One event holds many costs
 * (food, travel, venue…), each approved and paid like any expense.
 */

const fmt = (d: string) => new Date(d).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export default function EventsPage() {
  const { me, scope, scopeName } = useFinance();
  const [rows, setRows] = useState<FinanceEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => financeApi.events(scope).then((r) => { setRows(r); setError(null); }).catch((e) => setError(e.message)), [scope]);
  useEffect(() => { load(); }, [load]);
  const total = (rows ?? []).filter((e) => e.status !== "CANCELLED").reduce((s, e) => s + e.totalPaise, 0);

  return (
    <>
      <PageHeader title="Meetings & events" sub={`What meetings, get-togethers and trips cost for ${scopeName}. Add the event once, then each cost — food, travel, venue — under it.`}>
        {me.canManageAnything && <Button kind="primary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" />Add event</Button>}
      </PageHeader>
      <ErrorNote message={error} />
      {rows && rows.length > 0 && <p className="mb-3 text-[13px] text-[#8b8b8b]">{rows.length} event(s) · {inr(total)} in total</p>}
      {!rows ? <div className="h-32 animate-pulse rounded-xl bg-white/[0.03]" /> : rows.length === 0 ? (
        <Empty title="No events yet">Team dinners, client meetings, workshops, trips — add one, then its costs.</Empty>
      ) : (
        <ul className="space-y-2">
          {rows.map((e) => (
            <li key={e.id}><button onClick={() => setOpen(e.id)} className={`flex w-full flex-wrap items-center gap-3 rounded-xl border border-white/[0.07] bg-[#0f0f0f] p-4 text-left hover:border-white/15 ${e.status === "CANCELLED" ? "opacity-50" : ""}`}>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] text-[#e4e4e4]">{e.name}</div>
                <div className="text-[11.5px] text-[#6b6b6b]">{EVENT_KIND_LABEL[e.kind]} · {fmt(e.date)}{e.startTime ? ` ${e.startTime}` : ""}{e.location ? ` · ${e.location}` : ""} · {e.startup?.name ?? "Central DevUp"} · {e.participants.length} people{e.status === "CANCELLED" ? " · cancelled" : ""}</div>
              </div>
              <div className="text-right">
                <div className="text-[15px] font-semibold tabular-nums text-white">{inr(e.totalPaise)}</div>
                <div className="text-[11px] text-[#6b6b6b]">{e.costCount} cost(s){e.pendingPaise ? ` · ${inr(e.pendingPaise)} not paid yet` : ""}</div>
              </div>
            </button></li>
          ))}
        </ul>
      )}
      {adding && <EventForm onClose={() => setAdding(false)} onSaved={load} />}
      {open && <EventDetail id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}

function EventDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { me } = useFinance();
  const [e, setE] = useState<FinanceEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => financeApi.event(id).then(setE).catch((x) => setError(x.message)), [id]);
  useEffect(() => { load(); }, [load]);
  if (!e) return <Modal title="Event" onClose={onClose}><ErrorNote message={error} /></Modal>;
  return (
    <Modal title={e.name} onClose={onClose} wide>
      <p className="text-[12.5px] text-[#8b8b8b]">{EVENT_KIND_LABEL[e.kind]} · {fmt(e.date)}{e.startTime ? ` ${e.startTime}` : ""}{e.location ? ` · ${e.location}` : ""} · {e.startup?.name ?? "Central DevUp"}</p>
      {e.purpose && <p className="mt-2 text-[13px] text-[#cfcfcf]">{e.purpose}</p>}
      {e.participants.length > 0 && <p className="mt-2 text-[12.5px] text-[#a1a1a1]">With: {e.participants.map((p) => p.name).join(", ")}</p>}
      <div className="mt-4 grid grid-cols-3 gap-2 text-[12px]">
        <div><div className="text-[#6b6b6b]">Total</div><div className="text-[16px] font-semibold tabular-nums text-white">{inr(e.totalPaise)}</div></div>
        <div><div className="text-[#6b6b6b]">Paid</div><div className="tabular-nums text-[#c8f135]">{inr(e.paidPaise)}</div></div>
        <div><div className="text-[#6b6b6b]">Not paid yet</div><div className="tabular-nums text-sky-300">{inr(e.pendingPaise)}</div></div>
      </div>
      <ul className="mt-4 divide-y divide-white/5 text-[13px]">
        {(e.costs ?? []).map((c) => <li key={c.id} className="flex items-center justify-between gap-3 py-2"><span><span className="text-[#e4e4e4]">{c.title}</span> <span className="text-[11.5px] text-[#6b6b6b]">{c.category.name} · {c.number}</span></span><span className="flex items-center gap-2"><StatusPill status={c.status} /><span className="tabular-nums text-white">{inr(c.amountPaise)}</span></span></li>)}
        {!(e.costs ?? []).length && <li className="py-2 text-[#6b6b6b]">No costs yet.</li>}
      </ul>
      <p className="mt-2 text-[11.5px] text-[#6b6b6b]">Costs are approved and paid from Expenses &amp; claims, like any expense.</p>
      <ErrorNote message={error} />
      {me.canManageAnything && e.status !== "CANCELLED" && (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button kind="ghost" onClick={() => financeApi.updateEvent(e.id, { status: "CANCELLED" }).then(() => { load(); onChanged(); }).catch((x) => setError(x.message))}>Cancel event</Button>
          {e.status === "PLANNED" && <Button onClick={() => financeApi.updateEvent(e.id, { status: "DONE" }).then(() => { load(); onChanged(); }).catch((x) => setError(x.message))}>Mark as done</Button>}
          <Button kind="primary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" />Add a cost</Button>
        </div>
      )}
      {adding && <CostForm event={e} onClose={() => setAdding(false)} onSaved={() => { load(); onChanged(); }} />}
    </Modal>
  );
}

function CostForm({ event, onClose, onSaved }: { event: FinanceEvent; onClose: () => void; onSaved: () => void }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [f, setF] = useState({ title: "", categoryId: "", amount: "", incurredOn: event.date.slice(0, 10) > today() ? today() : event.date.slice(0, 10), payee: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { financeApi.categories().then((c) => setCategories(c.filter((x) => ["Meetings & events", "Travel", "Office & operations", "Other"].includes(x.group)))).catch(() => {}); }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={`Add a cost — ${event.name}`} onClose={onClose}>
      <div className="grid gap-3">
        <Field label="What for" required><input className={inputCls} value={f.title} onChange={set("title")} placeholder="Food, cabs, venue, decorations…" /></Field>
        <Field label="Category" required><select className={inputCls} value={f.categoryId} onChange={set("categoryId")}><option value="">Choose…</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount (₹)" required><input className={inputCls} inputMode="decimal" value={f.amount} onChange={set("amount")} /></Field>
          <Field label="Date" required><input type="date" className={inputCls} max={today()} value={f.incurredOn} onChange={set("incurredOn")} /></Field>
        </div>
        <Field label="Paid to"><input className={inputCls} value={f.payee} onChange={set("payee")} /></Field>
      </div>
      <div className="mt-3"><ErrorNote message={error} /></div>
      <div className="mt-4 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button kind="primary" disabled={busy || !f.title || !f.categoryId || !f.amount} onClick={async () => {
          setBusy(true); setError(null);
          try { await financeApi.addEventCost(event.id, { ...f, payee: f.payee || null }); onSaved(); onClose(); } catch (x: any) { setError(x.message); } finally { setBusy(false); }
        }}>{busy ? "Saving…" : "Add cost"}</Button>
      </div>
    </Modal>
  );
}

function EventForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { me, scope } = useFinance();
  const scopes = [...(me.isCfo ? [{ value: "central", label: "Central DevUp" }] : []), ...me.startups.filter((s) => me.isCfo || me.roles.some((r) => r.role === "STARTUP_FINANCE_MANAGER" && r.startupId === s.id)).map((s) => ({ value: s.id, label: s.name }))];
  const [f, setF] = useState({ scope: scopes.some((x) => x.value === scope) ? scope : scopes[0]?.value ?? "", name: "", kind: "TEAM_MEETING" as EventKind, date: today(), startTime: "", location: "", purpose: "", people: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Add a meeting or event" onClose={onClose} wide>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="For" required><select className={inputCls} value={f.scope} onChange={set("scope")}>{scopes.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
        <Field label="Name" required><input className={inputCls} value={f.name} onChange={set("name")} placeholder="e.g. Team dinner — November" /></Field>
        <Field label="Kind"><select className={inputCls} value={f.kind} onChange={set("kind")}>{(Object.keys(EVENT_KIND_LABEL) as EventKind[]).map((k) => <option key={k} value={k}>{EVENT_KIND_LABEL[k]}</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Date" required><input type="date" className={inputCls} value={f.date} onChange={set("date")} /></Field>
          <Field label="Time"><input type="time" className={inputCls} value={f.startTime} onChange={set("startTime")} /></Field>
        </div>
        <Field label="Where"><input className={inputCls} value={f.location} onChange={set("location")} /></Field>
        <Field label="Purpose"><input className={inputCls} value={f.purpose} onChange={set("purpose")} /></Field>
        <div className="md:col-span-2"><Field label="Who was there" hint="Names, separated by commas."><textarea className={`${inputCls} min-h-[60px]`} value={f.people} onChange={set("people")} /></Field></div>
      </div>
      <div className="mt-3"><ErrorNote message={error} /></div>
      <div className="mt-4 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button kind="primary" disabled={busy || f.name.trim().length < 2} onClick={async () => {
          setBusy(true); setError(null);
          try {
            const participants = f.people.split(",").map((n) => n.trim()).filter(Boolean).map((name) => ({ name }));
            await financeApi.createEvent({ scope: f.scope, name: f.name, kind: f.kind, date: f.date, startTime: f.startTime || null, location: f.location || null, purpose: f.purpose || null, participants });
            onSaved(); onClose();
          } catch (x: any) { setError(x.message); } finally { setBusy(false); }
        }}>{busy ? "Saving…" : "Add event"}</Button>
      </div>
    </Modal>
  );
}
