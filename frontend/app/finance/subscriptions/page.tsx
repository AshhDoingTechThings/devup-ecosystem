"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { financeApi, Frequency, FREQ_LABEL, inr, SubAlert, Subscription, today } from "@/lib/api/finance";
import { Button, Empty, ErrorNote, Field, Modal, PageHeader, Panel, StatCard, StatusPill, inputCls, useFinance } from "@/components/finance/ui";

/**
 * Software and services, what they cost, and who uses each seat. A seat is
 * only counted as used when someone is assigned to it here.
 */

type Data = Awaited<ReturnType<typeof financeApi.subscriptions>>;
type Usage = Awaited<ReturnType<typeof financeApi.seatUsage>>;
const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
const ALERT_LABEL: Record<SubAlert["kind"], string> = {
  RENEWAL_SOON: "Renews soon", UNASSIGNED_SEATS: "Seats nobody uses", CHARGED_AFTER_CANCEL: "Charged after cancelling", COST_INCREASE: "Price went up", POSSIBLE_DUPLICATE: "Possible duplicate",
};

export default function SubscriptionsPage() {
  const { me, scope, scopeName } = useFinance();
  const [data, setData] = useState<Data | null>(null);
  const [usage, setUsage] = useState<Usage>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => Promise.all([financeApi.subscriptions(scope), financeApi.seatUsage(scope)]).then(([d, u]) => { setData(d); setUsage(u); setError(null); }).catch((e) => setError(e.message)), [scope]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <PageHeader title="Subscriptions" sub={`Software and services paid for ${scopeName}, and who is using them.`}>
        {me.canManageAnything && <Button kind="primary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" />Add subscription</Button>}
      </PageHeader>
      <ErrorNote message={error} />
      {!data ? <div className="h-40 animate-pulse rounded-xl bg-white/[0.03]" /> : (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <StatCard label="Per month" value={inr(data.totals.monthlyPaise, { compact: true })} hint="What active subscriptions cost in an average month (yearly plans divided by 12)." />
            <StatCard label="Per year" value={inr(data.totals.yearlyPaise, { compact: true })} hint="The monthly figure times 12." />
            <StatCard label="Active subscriptions" value={String(data.totals.activeCount)} hint="Subscriptions not paused or cancelled." />
          </div>
          {data.alerts.length > 0 && (
            <Panel title="Needs attention" className="mb-4">
              <ul className="space-y-2">
                {data.alerts.map((a, i) => (
                  <li key={i}><button onClick={() => setOpen(a.subscriptionId)} className="flex w-full items-start gap-2 text-left text-[13px]">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                    <span><span className="text-[#e4e4e4]">{a.name}</span> <span className="text-amber-200">— {ALERT_LABEL[a.kind]}:</span> <span className="text-[#a1a1a1]">{a.message}</span></span>
                  </button></li>
                ))}
              </ul>
            </Panel>
          )}
          {data.subscriptions.length === 0 ? <Empty title="No subscriptions recorded yet">Add each paid tool once — Claude, ChatGPT, Cursor, GitHub, Figma, hosting — with its cost, renewal date and who uses it.</Empty> : (
            <SubTable rows={data.subscriptions} onOpen={setOpen} />
          )}
          <Panel title="Who uses what" hint="Only people assigned to a seat appear here. A paid seat with nobody assigned isn't assumed to be in use." className="mt-4">
            {usage.length === 0 ? <p className="text-[12.5px] text-[#6b6b6b]">No seats assigned yet.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-[13px]">
                  <thead className="text-left text-[11.5px] text-[#6b6b6b]"><tr><th className="pb-2 font-medium">Software</th><th className="pb-2 font-medium">Startup</th><th className="pb-2 font-medium">Person</th><th className="pb-2 font-medium">Plan</th><th className="pb-2 font-medium">Renews</th></tr></thead>
                  <tbody>{usage.map((u, i) => <tr key={i} className="border-t border-white/5"><td className="py-2 text-[#e4e4e4]">{u.software}</td><td className="py-2 text-[#a1a1a1]">{u.startup}</td><td className="py-2 text-[#a1a1a1]">{u.person}</td><td className="py-2 text-[#a1a1a1]">{u.plan ?? "—"}</td><td className="py-2 text-[#a1a1a1]">{fmt(u.renewalOn)}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
      {adding && <SubForm onClose={() => setAdding(false)} onSaved={load} />}
      {open && <SubDetail id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}

function SubTable({ rows, onOpen }: { rows: Subscription[]; onOpen: (id: string) => void }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/[0.07]">
      <table className="w-full min-w-[760px] text-[13px]">
        <thead className="bg-white/[0.02] text-left text-[11.5px] text-[#6b6b6b]"><tr><th className="px-4 py-2.5 font-medium">Subscription</th><th className="px-4 py-2.5 font-medium">For</th><th className="px-4 py-2.5 font-medium">Seats used</th><th className="px-4 py-2.5 font-medium">Renews</th><th className="px-4 py-2.5 text-right font-medium">Per month</th></tr></thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} onClick={() => onOpen(s.id)} className={`cursor-pointer border-t border-white/5 hover:bg-white/[0.02] ${s.status === "ACTIVE" ? "" : "opacity-50"}`}>
              <td className="px-4 py-3"><div className="text-[#e4e4e4]">{s.name}</div><div className="text-[11.5px] text-[#6b6b6b]">{s.provider}{s.plan ? ` · ${s.plan}` : ""} · {FREQ_LABEL[s.billingCycle].toLowerCase()}{s.status !== "ACTIVE" ? ` · ${s.status.toLowerCase()}` : ""}</div></td>
              <td className="px-4 py-3 text-[#a1a1a1]">{s.startup?.name ?? "Central DevUp"}</td>
              <td className="px-4 py-3 text-[#a1a1a1]">{s.seatsPurchased != null ? `${s.seatsAssigned} of ${s.seatsPurchased}` : s.seatsAssigned || "—"}</td>
              <td className="px-4 py-3 text-[#a1a1a1]">{fmt(s.renewalOn)}</td>
              <td className="px-4 py-3 text-right tabular-nums text-white">{inr(s.monthlyPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SubDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { me } = useFinance();
  const [s, setS] = useState<Subscription | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seat, setSeat] = useState({ name: "", email: "" });
  const [charge, setCharge] = useState({ on: today(), amount: "", paymentRef: "", paid: me.isCfo });
  const load = useCallback(() => financeApi.subscription(id).then(setS).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); await load(); onChanged(); } catch (e: any) { setError(e.message); } };
  if (!s) return <Modal title="Subscription" onClose={onClose}><ErrorNote message={error} /></Modal>;
  const live = s.status !== "CANCELLED";
  return (
    <Modal title={s.name} onClose={onClose} wide>
      <p className="text-[12.5px] text-[#8b8b8b]">{s.provider}{s.plan ? ` · ${s.plan}` : ""} · {inr(s.costPaise)} {FREQ_LABEL[s.billingCycle].toLowerCase()} · renews {fmt(s.renewalOn)}{s.paymentMethodNote ? ` · paid by ${s.paymentMethodNote}` : ""}</p>
      <h3 className="mt-5 mb-2 text-[#a1a1a1]" style={{ fontSize: 12, fontWeight: 600 }}>Seats — {s.seatsPurchased != null ? `${s.seatsAssigned} of ${s.seatsPurchased} assigned` : `${s.seatsAssigned} assigned`}</h3>
      <ul className="space-y-1 text-[13px]">
        {s.seats.map((x) => <li key={x.id} className="flex items-center justify-between"><span className="text-[#e4e4e4]">{x.name}{x.email ? <span className="text-[#6b6b6b]"> · {x.email}</span> : null}</span>{me.canManageAnything && <Button kind="ghost" aria-label="Remove seat" onClick={() => run(() => financeApi.removeSeat(x.id))}><Trash2 className="h-3.5 w-3.5" /></Button>}</li>)}
        {!s.seats.length && <li className="text-[#6b6b6b]">Nobody assigned yet.</li>}
      </ul>
      {me.canManageAnything && live && (
        <div className="mt-2 flex flex-wrap gap-2">
          <input className={`${inputCls} flex-1`} placeholder="Name" value={seat.name} onChange={(e) => setSeat({ ...seat, name: e.target.value })} />
          <input className={`${inputCls} flex-1`} placeholder="Email (optional)" value={seat.email} onChange={(e) => setSeat({ ...seat, email: e.target.value })} />
          <Button disabled={seat.name.trim().length < 2} onClick={() => run(() => financeApi.assignSeat(s.id, { name: seat.name, email: seat.email || undefined }).then(() => setSeat({ name: "", email: "" })))}>Assign seat</Button>
        </div>
      )}
      <h3 className="mt-5 mb-2 text-[#a1a1a1]" style={{ fontSize: 12, fontWeight: 600 }}>Payments</h3>
      <ul className="space-y-1 text-[13px]">
        {(s.charges ?? []).map((c) => <li key={c.id} className="flex items-center justify-between gap-3"><span className="text-[#a1a1a1]">{fmt(c.incurredOn)} · {c.number}</span><span className="flex items-center gap-2"><StatusPill status={c.status} /><span className="tabular-nums text-white">{inr(c.amountPaise)}</span></span></li>)}
        {!(s.charges ?? []).length && <li className="text-[#6b6b6b]">No payments recorded.</li>}
      </ul>
      {me.canManageAnything && (
        <div className="mt-2 grid gap-2 sm:grid-cols-4">
          <input type="date" className={inputCls} value={charge.on} onChange={(e) => setCharge({ ...charge, on: e.target.value })} aria-label="Payment date" />
          <input className={inputCls} inputMode="decimal" placeholder={`₹ ${s.costPaise / 100}`} value={charge.amount} onChange={(e) => setCharge({ ...charge, amount: e.target.value })} aria-label="Amount" />
          <input className={inputCls} placeholder="Reference" value={charge.paymentRef} onChange={(e) => setCharge({ ...charge, paymentRef: e.target.value })} />
          <Button onClick={() => run(() => financeApi.recordCharge(s.id, { on: charge.on, amount: charge.amount || undefined, paid: charge.paid, paymentRef: charge.paymentRef || undefined }))}>Record payment</Button>
        </div>
      )}
      <ErrorNote message={error} />
      {me.canManageAnything && live && (
        <div className="mt-5 flex justify-end"><Button kind="danger" onClick={() => run(() => financeApi.updateSubscription(s.id, { status: "CANCELLED" }))}>Mark as cancelled</Button></div>
      )}
    </Modal>
  );
}

function SubForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { me, scope } = useFinance();
  const scopes = [...(me.isCfo ? [{ value: "central", label: "Central DevUp" }] : []), ...me.startups.filter((s) => me.isCfo || me.roles.some((r) => r.role === "STARTUP_FINANCE_MANAGER" && r.startupId === s.id)).map((s) => ({ value: s.id, label: s.name }))];
  const [f, setF] = useState({ scope: scopes.some((x) => x.value === scope) ? scope : scopes[0]?.value ?? "", name: "", provider: "", plan: "", billingCycle: "MONTHLY" as Frequency, cost: "", seatsPurchased: "", renewalOn: "", paymentMethodNote: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Add a subscription" onClose={onClose} wide>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Paid for" required><select className={inputCls} value={f.scope} onChange={set("scope")}>{scopes.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
        <Field label="Name" required><input className={inputCls} value={f.name} onChange={set("name")} placeholder="e.g. Claude Team" /></Field>
        <Field label="Provider" required><input className={inputCls} value={f.provider} onChange={set("provider")} placeholder="e.g. Anthropic" /></Field>
        <Field label="Plan"><input className={inputCls} value={f.plan} onChange={set("plan")} placeholder="e.g. Team, Pro" /></Field>
        <Field label="Billed"><select className={inputCls} value={f.billingCycle} onChange={set("billingCycle")}>{(Object.keys(FREQ_LABEL) as Frequency[]).map((k) => <option key={k} value={k}>{FREQ_LABEL[k]}</option>)}</select></Field>
        <Field label="Cost per bill (₹)" required hint="In rupees. For a dollar plan, enter what it costs in rupees."><input className={inputCls} inputMode="decimal" value={f.cost} onChange={set("cost")} /></Field>
        <Field label="Seats bought"><input className={inputCls} inputMode="numeric" value={f.seatsPurchased} onChange={set("seatsPurchased")} /></Field>
        <Field label="Next renewal"><input type="date" className={inputCls} value={f.renewalOn} onChange={set("renewalOn")} /></Field>
        <div className="md:col-span-2"><Field label="How it's paid" hint="A description like 'Company card ending 4242'. Never the full card number."><input className={inputCls} value={f.paymentMethodNote} onChange={set("paymentMethodNote")} /></Field></div>
      </div>
      <div className="mt-3"><ErrorNote message={error} /></div>
      <div className="mt-4 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button kind="primary" disabled={busy || !f.name || !f.provider || !f.cost} onClick={async () => {
          setBusy(true); setError(null);
          try {
            await financeApi.createSubscription({ ...f, plan: f.plan || null, seatsPurchased: f.seatsPurchased ? Number(f.seatsPurchased) : null, renewalOn: f.renewalOn || null, paymentMethodNote: f.paymentMethodNote || null });
            onSaved(); onClose();
          } catch (e: any) { setError(e.message); } finally { setBusy(false); }
        }}>{busy ? "Saving…" : "Add subscription"}</Button>
      </div>
    </Modal>
  );
}
