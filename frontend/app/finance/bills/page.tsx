"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Category, financeApi, Frequency, FREQ_LABEL, inr, RecurringBill, today } from "@/lib/api/finance";
import { Button, Empty, ErrorNote, Field, Modal, PageHeader, StatCard, StatusPill, inputCls, useFinance } from "@/components/finance/ui";

/**
 * Regular bills — rent, electricity, internet, housekeeping. Each due date
 * becomes one expense, a few days ahead, created by the daily job (or the
 * button here). Nothing is ever created twice.
 */

const MONTHS_PER: Record<Frequency, number> = { WEEKLY: 12 / 52, MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };
const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");

export default function BillsPage() {
  const { me, scope, scopeName } = useFinance();
  const [rows, setRows] = useState<RecurringBill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<RecurringBill | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => financeApi.recurring(scope).then((r) => { setRows(r); setError(null); }).catch((e) => setError(e.message)), [scope]);
  useEffect(() => { load(); }, [load]);

  const monthly = useMemo(() => (rows ?? []).filter((b) => b.isActive).reduce((s, b) => s + Math.round(b.amountPaise / MONTHS_PER[b.frequency]), 0), [rows]);
  const generate = async () => {
    setBusy(true); setNote(null); setError(null);
    try {
      const r = await financeApi.generateRecurring();
      setNote(r.created.length ? `Created ${r.created.length} bill(s): ${r.created.map((c) => c.number).join(", ")}` : "Nothing new is due yet.");
      load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader title="Regular bills" sub={`Bills that come back every month or year for ${scopeName}. Each one becomes an expense a few days before it's due — you only approve and pay.`}>
        {me.canManageAnything && <Button disabled={busy} onClick={generate}><RefreshCw className="h-4 w-4" />Create due bills now</Button>}
        {me.canManageAnything && <Button kind="primary" onClick={() => setEditing("new")}><Plus className="h-4 w-4" />Add a regular bill</Button>}
      </PageHeader>
      <ErrorNote message={error} />
      {note && <p className="mb-3 text-[13px] text-[#c8f135]">{note}</p>}
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard label="Regular bills, per month" value={inr(monthly, { compact: true })} hint="What the active regular bills cost in an average month (yearly bills divided by 12)." />
        <StatCard label="Active bills" value={String((rows ?? []).filter((b) => b.isActive).length)} hint="Bills currently being created on schedule." />
        <StatCard label="Paused" value={String((rows ?? []).filter((b) => !b.isActive).length)} hint="Paused bills create nothing until resumed." tone="muted" />
      </div>
      {!rows ? <div className="h-32 animate-pulse rounded-xl bg-white/[0.03]" /> : rows.length === 0 ? (
        <Empty title="No regular bills yet">Add rent, electricity, internet, housekeeping — once — and they turn up each month ready to approve.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/[0.07]">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead className="bg-white/[0.02] text-left text-[11.5px] text-[#6b6b6b]">
              <tr><th className="px-4 py-2.5 font-medium">Bill</th><th className="px-4 py-2.5 font-medium">How often</th><th className="px-4 py-2.5 font-medium">Next due</th><th className="px-4 py-2.5 font-medium">Recent</th><th className="px-4 py-2.5 text-right font-medium">Amount</th></tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} onClick={() => me.canManageAnything && setEditing(b)} className={`border-t border-white/5 ${me.canManageAnything ? "cursor-pointer hover:bg-white/[0.02]" : ""} ${b.isActive ? "" : "opacity-50"}`}>
                  <td className="px-4 py-3"><div className="text-[#e4e4e4]">{b.title}</div><div className="text-[11.5px] text-[#6b6b6b]">{b.startup?.name ?? "Central DevUp"}{b.payee ? ` · ${b.payee}` : ""}{b.autoApprove ? " · approved automatically" : ""}{b.isActive ? "" : " · paused"}</div></td>
                  <td className="px-4 py-3 text-[#a1a1a1]">{FREQ_LABEL[b.frequency]}<div className="text-[11px] text-[#6b6b6b]">{b.frequency === "WEEKLY" ? `weekday ${b.dueDay}` : `on day ${b.dueDay}`}</div></td>
                  <td className="px-4 py-3 text-[#a1a1a1]">{fmt(b.nextDue)}</td>
                  <td className="px-4 py-3"><div className="flex flex-wrap gap-1">{b.recent.map((r) => r.expense ? <StatusPill key={r.dueDate} status={r.expense.status} /> : null)}{!b.recent.length && <span className="text-[11.5px] text-[#6b6b6b]">None yet</span>}</div></td>
                  <td className="px-4 py-3 text-right tabular-nums text-white">{inr(b.amountPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <BillForm bill={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}
    </>
  );
}

type BillFormState = {
  scope: string; title: string; categoryId: string; payee: string; amount: string; frequency: Frequency; dueDay: string;
  startsOn: string; endsOn: string; leadDays: string; autoApprove: boolean; notes: string;
};

/** A new bill: today's start, due on the 5th, created 5 days ahead, in the view's scope if the person can manage it. */
function blankBill(scope: string, manageable: Array<{ value: string }>): BillFormState {
  const own = manageable.some((m) => m.value === scope);
  return {
    scope: own ? scope : manageable[0]?.value ?? "", title: "", categoryId: "", payee: "", amount: "", frequency: "MONTHLY", dueDay: "5",
    startsOn: today(), endsOn: "", leadDays: "5", autoApprove: false, notes: "",
  };
}

function fromBill(b: RecurringBill): BillFormState {
  return {
    scope: b.startupId ?? "central", title: b.title, categoryId: b.categoryId, payee: b.payee ?? "", amount: String(b.amountPaise / 100),
    frequency: b.frequency, dueDay: String(b.dueDay), startsOn: b.startsOn.slice(0, 10), endsOn: b.endsOn?.slice(0, 10) ?? "",
    leadDays: String(b.leadDays), autoApprove: b.autoApprove, notes: b.notes ?? "",
  };
}

function BillForm({ bill, onClose, onSaved }: { bill: RecurringBill | null; onClose: () => void; onSaved: () => void }) {
  const { me, scope } = useFinance();
  const manageable = useMemo(() => [...(me.isCfo ? [{ value: "central", label: "Central DevUp operations" }] : []), ...me.startups.filter((s) => me.isCfo || me.roles.some((r) => r.role === "STARTUP_FINANCE_MANAGER" && r.startupId === s.id)).map((s) => ({ value: s.id, label: s.name }))], [me]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [f, setF] = useState<BillFormState>(() => (bill ? fromBill(bill) : blankBill(scope, manageable)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { financeApi.categories().then(setCategories).catch(() => {}); }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy(true); setError(null);
    try {
      const body = { ...f, dueDay: Number(f.dueDay), leadDays: Number(f.leadDays), endsOn: f.endsOn || null, payee: f.payee || null, notes: f.notes || null, ...extra };
      if (bill) await financeApi.updateRecurring(bill.id, body); else await financeApi.createRecurring(body);
      onSaved(); onClose();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal title={bill ? `Edit — ${bill.title}` : "Add a regular bill"} onClose={onClose} wide>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Whose bill" required><select className={inputCls} value={f.scope} onChange={set("scope")}>{manageable.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>
        <Field label="Bill name" required><input className={inputCls} value={f.title} onChange={set("title")} placeholder="e.g. Office rent" /></Field>
        <Field label="Category" required>
          <select className={inputCls} value={f.categoryId} onChange={set("categoryId")}><option value="">Choose…</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.group} — {c.name}</option>)}</select>
        </Field>
        <Field label="Paid to"><input className={inputCls} value={f.payee} onChange={set("payee")} placeholder="Landlord, electricity board…" /></Field>
        <Field label="Usual amount (₹)" required hint="For bills that vary (electricity), the expense is created with this amount; correct it to the real bill before approving."><input className={inputCls} inputMode="decimal" value={f.amount} onChange={set("amount")} /></Field>
        <Field label="How often"><select className={inputCls} value={f.frequency} onChange={set("frequency")}>{(Object.keys(FREQ_LABEL) as Frequency[]).map((k) => <option key={k} value={k}>{FREQ_LABEL[k]}</option>)}</select></Field>
        <Field label={f.frequency === "WEEKLY" ? "Weekday it's due (1 = Monday)" : "Day of the month it's due (1–28)"} required><input className={inputCls} inputMode="numeric" value={f.dueDay} onChange={set("dueDay")} /></Field>
        <Field label="Create it this many days before" hint="The expense appears this early so it can be approved and paid on time."><input className={inputCls} inputMode="numeric" value={f.leadDays} onChange={set("leadDays")} /></Field>
        <Field label="Starts on" required><input type="date" className={inputCls} value={f.startsOn} onChange={set("startsOn")} /></Field>
        <Field label="Ends on (optional)"><input type="date" className={inputCls} value={f.endsOn} onChange={set("endsOn")} /></Field>
        {me.isCfo && (
          <label className="md:col-span-2 flex items-center gap-2 text-[13px] text-[#cfcfcf]">
            <input type="checkbox" checked={f.autoApprove} onChange={(e) => setF({ ...f, autoApprove: e.target.checked })} />
            Approve automatically (for fixed bills like rent — each one still needs marking as paid)
          </label>
        )}
      </div>
      <div className="mt-3"><ErrorNote message={error} /></div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {bill && <Button kind="ghost" disabled={busy} onClick={() => save({ isActive: !bill.isActive })}>{bill.isActive ? "Pause" : "Resume"}</Button>}
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button kind="primary" disabled={busy || !f.title || !f.categoryId || !f.amount} onClick={() => save()}>{busy ? "Saving…" : bill ? "Save" : "Add bill"}</Button>
      </div>
    </Modal>
  );
}
