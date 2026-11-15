"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Mail, Plus, Trash2 } from "lucide-react";
import { financeApi, FinanceInvoice, inr, InvoiceStatus, today } from "@/lib/api/finance";
import { Button, Empty, ErrorNote, Field, Modal, PageHeader, StatCard, inputCls, useFinance } from "@/components/finance/ui";

/**
 * Money startups owe DevUp — shared rent, tools, staff — and its collection.
 * Internal: a startup paying DevUp is never counted as DevUp revenue.
 */

const STATUS: Record<InvoiceStatus, string> = { DRAFT: "Draft", ISSUED: "Sent", PART_PAID: "Partly paid", PAID: "Paid", CANCELLED: "Cancelled" };
const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");

export default function InvoicesPage() {
  const { me, scope, scopeName } = useFinance();
  const [data, setData] = useState<Awaited<ReturnType<typeof financeApi.invoices>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => financeApi.invoices(scope).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)), [scope]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <PageHeader title="Money expected from startups" sub={`Bills DevUp sends its startups for shared costs, and what's been paid — ${scopeName}. These are internal: they never count as DevUp's income.`}>
        {me.isCfo && <Button kind="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New bill</Button>}
      </PageHeader>
      <ErrorNote message={error} />
      {data && (
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <StatCard label="Still owed" value={inr(data.totals.outstandingPaise, { compact: true })} hint="What startups still owe on bills that have been sent." />
          <StatCard label="Overdue" value={inr(data.totals.overduePaise, { compact: true })} sub={`${data.totals.overdueCount} bill(s) past due`} hint="Sent bills not fully paid by their due date." tone={data.totals.overdueCount ? "warn" : "default"} />
          <StatCard label="Bills" value={String(data.invoices.length)} hint="All bills in this view, including paid and drafts." />
        </div>
      )}
      {!data ? <div className="h-32 animate-pulse rounded-xl bg-white/[0.03]" /> : data.invoices.length === 0 ? (
        <Empty title="No bills yet">{me.isCfo ? "Bill a startup for its share of rent, tools or staff — you can start from the shared costs already split to it." : "No bills for this startup."}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/[0.07]">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead className="bg-white/[0.02] text-left text-[11.5px] text-[#6b6b6b]"><tr><th className="px-4 py-2.5 font-medium">Bill</th><th className="px-4 py-2.5 font-medium">Startup</th><th className="px-4 py-2.5 font-medium">Due</th><th className="px-4 py-2.5 font-medium">Status</th><th className="px-4 py-2.5 text-right font-medium">Amount</th><th className="px-4 py-2.5 text-right font-medium">Still owed</th></tr></thead>
            <tbody>
              {data.invoices.map((i) => (
                <tr key={i.id} onClick={() => setOpen(i.id)} className={`cursor-pointer border-t border-white/5 hover:bg-white/[0.02] ${i.status === "CANCELLED" ? "opacity-50" : ""}`}>
                  <td className="px-4 py-3"><div className="text-[#e4e4e4]">{i.title}</div><div className="text-[11.5px] text-[#6b6b6b]">{i.number}{i.flag ? <span className="text-amber-300"> · {i.flag === "DISPUTED" ? "disputed" : "under reconciliation"}</span> : null}</div></td>
                  <td className="px-4 py-3 text-[#a1a1a1]">{i.recipient.name}</td>
                  <td className={`px-4 py-3 ${i.isOverdue ? "text-amber-300" : "text-[#a1a1a1]"}`}>{fmt(i.dueDate)}{i.isOverdue ? " · overdue" : ""}</td>
                  <td className="px-4 py-3 text-[#a1a1a1]">{STATUS[i.status]}{i.reminderCount ? <span className="text-[11px] text-[#6b6b6b]"> · {i.reminderCount} reminder(s)</span> : null}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-white">{inr(i.amountPaise)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-[#a1a1a1]">{inr(i.outstandingPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <InvoiceForm onClose={() => setCreating(false)} onSaved={(id) => { load(); setOpen(id); }} />}
      {open && <InvoiceDetail id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}

function InvoiceForm({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const { me, scope } = useFinance();
  const firstDay = today().slice(0, 8) + "01";
  const [f, setF] = useState({ recipientStartupId: scope !== "all" && scope !== "central" ? scope : me.startups[0]?.id ?? "", title: "", from: firstDay, to: today(), billingEmail: "" });
  const [lines, setLines] = useState<Array<{ label: string; amount: string }>>([{ label: "", amount: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const prefill = async () => {
    setError(null);
    try {
      const s = await financeApi.suggestInvoice(f.recipientStartupId, f.from, f.to);
      if (!s.length) setError("No shared costs were split to this startup in those dates."); else setLines(s);
    } catch (e: any) { setError(e.message); }
  };
  return (
    <Modal title="New bill to a startup" onClose={onClose} wide>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Startup" required><select className={inputCls} value={f.recipientStartupId} onChange={(e) => setF({ ...f, recipientStartupId: e.target.value })}>{me.startups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Title" required><input className={inputCls} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Shared costs — November" /></Field>
        <Field label="Covering from"><input type="date" className={inputCls} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="to"><input type="date" className={inputCls} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <div className="md:col-span-2"><Field label="Send reminders to" hint="Leave empty to use the startup's founders."><input className={inputCls} value={f.billingEmail} onChange={(e) => setF({ ...f, billingEmail: e.target.value })} placeholder="accounts@startup.com" /></Field></div>
      </div>
      <div className="mt-4 flex items-center justify-between">
        <span className="text-[12px] text-[#a1a1a1]">Lines</span>
        <Button kind="ghost" onClick={prefill}>Fill from this startup&apos;s share of shared costs</Button>
      </div>
      {lines.map((l, i) => (
        <div key={i} className="mt-2 flex gap-2">
          <input className={inputCls} placeholder="What for" value={l.label} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
          <input className={`${inputCls} w-36 text-right`} inputMode="decimal" placeholder="₹" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
          <Button kind="ghost" aria-label="Remove" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      ))}
      <div className="mt-2 flex justify-between"><Button kind="ghost" onClick={() => setLines([...lines, { label: "", amount: "" }])}><Plus className="h-3.5 w-3.5" />Add a line</Button><span className="text-[13px] tabular-nums text-white">Total ₹{total.toLocaleString("en-IN")}</span></div>
      <div className="mt-3"><ErrorNote message={error} /></div>
      <div className="mt-4 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button kind="primary" disabled={busy || f.title.trim().length < 2 || !lines.some((l) => l.label && l.amount)} onClick={async () => {
          setBusy(true); setError(null);
          try {
            const r = await financeApi.createInvoice({ recipientStartupId: f.recipientStartupId, title: f.title, lines: lines.filter((l) => l.label && l.amount), periodStart: f.from || null, periodEnd: f.to || null, billingEmail: f.billingEmail || null });
            onSaved(r.id); onClose();
          } catch (e: any) { setError(e.message); } finally { setBusy(false); }
        }}>Save as draft</Button>
      </div>
    </Modal>
  );
}

function InvoiceDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { me } = useFinance();
  const [i, setI] = useState<FinanceInvoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pay, setPay] = useState({ amount: "", receivedOn: today(), reference: "" });
  const load = useCallback(() => financeApi.invoice(id).then(setI).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, done?: string) => { setError(null); setNote(null); try { await fn(); await load(); onChanged(); if (done) setNote(done); } catch (e: any) { setError(e.message); } };
  if (!i) return <Modal title="Bill" onClose={onClose}><ErrorNote message={error} /></Modal>;
  const open = i.status === "ISSUED" || i.status === "PART_PAID";
  return (
    <Modal title={`${i.number} — ${i.recipient.name}`} onClose={onClose} wide>
      <p className="text-[12.5px] text-[#8b8b8b]">{STATUS[i.status]} · issued {fmt(i.issueDate)} · due {fmt(i.dueDate)}{i.isOverdue ? " · overdue" : ""} · reminders {i.reminderCount} of {i.maxReminders}</p>
      {i.flag && <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] p-3 text-[12.5px] text-amber-100">{i.flag === "DISPUTED" ? "Disputed" : "Under reconciliation"}: {i.flagNote} — reminders are paused.</div>}
      <ul className="mt-4 space-y-1 text-[13px]">{i.lines.map((l, k) => <li key={k} className="flex justify-between"><span className="text-[#cfcfcf]">{l.label}</span><span className="tabular-nums text-white">{inr(l.amountPaise)}</span></li>)}</ul>
      <div className="mt-2 flex justify-between border-t border-white/5 pt-2 text-[13px]"><span className="text-[#a1a1a1]">Total · paid · still owed</span><span className="tabular-nums text-white">{inr(i.amountPaise)} · {inr(i.receivedPaise)} · {inr(i.outstandingPaise)}</span></div>
      {i.receipts.length > 0 && (
        <ul className="mt-3 space-y-1 text-[12.5px]">{i.receipts.map((r) => (
          <li key={r.id} className={`flex items-center justify-between ${r.reversedAt ? "line-through opacity-50" : ""}`}>
            <span className="text-[#a1a1a1]">Paid {fmt(r.receivedOn)}{r.reference ? ` · ${r.reference}` : ""}{r.reverseReason ? ` · reversed: ${r.reverseReason}` : ""}</span>
            <span className="flex items-center gap-2"><span className="tabular-nums">{inr(r.amountPaise)}</span>{me.isCfo && !r.reversedAt && <Button kind="ghost" onClick={() => { const why = prompt("Why is this payment reversed?"); if (why && why.trim().length >= 3) run(() => financeApi.reverseReceipt(i.id, r.id, why)); }}>Reverse</Button>}</span>
          </li>
        ))}</ul>
      )}
      {i.reminders.length > 0 && (
        <details className="mt-3 text-[12px] text-[#a1a1a1]"><summary className="cursor-pointer">Reminder history ({i.reminders.length})</summary>
          <ul className="mt-2 space-y-1">{i.reminders.map((r) => <li key={r.id}>{new Date(r.createdAt).toLocaleString("en-IN")} · #{r.level} {r.automatic ? "automatic" : "by hand"} · to {r.sentTo} · {r.delivery.toLowerCase()}{r.error ? ` (${r.error})` : ""}</li>)}</ul>
        </details>
      )}
      {note && <p className="mt-3 text-[12.5px] text-[#c8f135]">{note}</p>}
      <ErrorNote message={error} />
      {me.isCfo && open && (
        <div className="mt-4 grid gap-2 sm:grid-cols-4">
          <input className={inputCls} inputMode="decimal" placeholder={`₹ up to ${i.outstandingPaise / 100}`} value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} aria-label="Amount received" />
          <input type="date" className={inputCls} value={pay.receivedOn} onChange={(e) => setPay({ ...pay, receivedOn: e.target.value })} aria-label="Received on" />
          <input className={inputCls} placeholder="Reference" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
          <Button disabled={!pay.amount} onClick={() => run(() => financeApi.recordReceipt(i.id, { amount: pay.amount, receivedOn: pay.receivedOn, reference: pay.reference || undefined }).then(() => setPay({ ...pay, amount: "", reference: "" })))}>Record payment</Button>
        </div>
      )}
      {me.isCfo && <InvoiceActions i={i} run={run} />}
    </Modal>
  );
}

function InvoiceActions({ i, run }: { i: FinanceInvoice; run: (fn: () => Promise<unknown>, done?: string) => void }) {
  const open = i.status === "ISSUED" || i.status === "PART_PAID";
  const flag = (kind: "DISPUTED" | "UNDER_RECONCILIATION") => { const n = prompt(kind === "DISPUTED" ? "What does the startup dispute?" : "What's being checked?"); if (n && n.trim()) run(() => financeApi.flagInvoice(i.id, kind, n)); };
  return (
    <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-white/5 pt-4">
      {i.status !== "DRAFT" && <Button kind="ghost" onClick={() => navigator.clipboard.writeText(i.viewUrl).then(() => run(async () => undefined, "Link copied — the startup can view the bill without signing in."))}><Copy className="h-3.5 w-3.5" />Copy link for the startup</Button>}
      {(i.status === "DRAFT" || i.status === "ISSUED") && <Button kind="ghost" onClick={() => { const why = prompt("Why is this bill cancelled?"); if (why && why.trim().length >= 3) run(() => financeApi.cancelInvoice(i.id, why)); }}>Cancel bill</Button>}
      {open && !i.flag && <Button kind="ghost" onClick={() => flag("DISPUTED")}>Mark disputed</Button>}
      {open && !i.flag && <Button kind="ghost" onClick={() => flag("UNDER_RECONCILIATION")}>Under reconciliation</Button>}
      {i.flag && <Button onClick={() => run(() => financeApi.flagInvoice(i.id, null))}>Clear {i.flag === "DISPUTED" ? "dispute" : "reconciliation"}</Button>}
      {open && !i.flag && <Button onClick={() => run(async () => { const r = await financeApi.remind(i.id); if (r.delivery === "FAILED") throw new Error(`The reminder couldn't be delivered (${r.error}).`); }, "Reminder sent.")}><Mail className="h-3.5 w-3.5" />Send reminder now</Button>}
      {i.status === "DRAFT" && <Button kind="primary" onClick={() => { const due = prompt("Due date (YYYY-MM-DD) — leave empty for 15 days from today", ""); if (due !== null) run(() => financeApi.issueInvoice(i.id, due.trim() || undefined), "Bill sent. Copy the link to share it."); }}>Send bill</Button>}
    </div>
  );
}
