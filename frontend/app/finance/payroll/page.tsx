"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, FileSpreadsheet, Plus, Trash2 } from "lucide-react";
import { saveText } from "@/lib/api/client";
import { AdjustmentKind, financeApi, inr, METHOD_LABEL, PaymentMethod, PayrollKind, PayrollLine, PayrollRun, PayrollRunSummary, RUN_STATUS_LABEL, today } from "@/lib/api/finance";
import { Button, Empty, ErrorNote, Field, Modal, PageHeader, inputCls, useFinance } from "@/components/finance/ui";

/**
 * Monthly salary and stipend runs — the CFO only.
 * Draft → review → approve → bank file → confirm each payment.
 * Nothing here moves money: payments are made in the bank and confirmed here.
 */

const month = (d: string) => new Date(d).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const LINE_TONE: Record<PayrollLine["status"], string> = { PENDING: "text-[#a1a1a1]", ON_HOLD: "text-amber-300", PAID: "text-[#c8f135]", FAILED: "text-red-300" };
const LINE_LABEL: Record<PayrollLine["status"], string> = { PENDING: "Not paid", ON_HOLD: "On hold", PAID: "Paid", FAILED: "Failed" };

export default function PayrollPage() {
  const { me, scope } = useFinance();
  const [runs, setRuns] = useState<PayrollRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const startup = scope !== "all" && scope !== "central" ? scope : undefined;
  const load = useCallback(() => financeApi.payrollRuns(startup).then((r) => { setRuns(r); setError(null); }).catch((e) => setError(e.message)), [startup]);
  useEffect(() => { if (me.isCfo) load(); }, [load, me.isCfo]);
  if (!me.isCfo) return <Empty title="Only the CFO runs payroll" />;

  return (
    <>
      <PageHeader title="Payroll" sub="Each month's salaries and stipends, per startup. Prepare, check, approve, then pay in the bank and confirm each payment here. Nothing is ever paid twice.">
        <Button kind="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />Prepare a month</Button>
      </PageHeader>
      <ErrorNote message={error} />
      {!runs ? <div className="h-32 animate-pulse rounded-xl bg-white/[0.03]" /> : runs.length === 0 ? (
        <Empty title="No payroll prepared yet">Confirm pay in Salaries &amp; stipends first, then prepare a month here.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/[0.07]">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead className="bg-white/[0.02] text-left text-[11.5px] text-[#6b6b6b]"><tr><th className="px-4 py-2.5 font-medium">Month</th><th className="px-4 py-2.5 font-medium">Startup</th><th className="px-4 py-2.5 font-medium">Status</th><th className="px-4 py-2.5 font-medium">People</th><th className="px-4 py-2.5 text-right font-medium">Total</th><th className="px-4 py-2.5 text-right font-medium">Still to pay</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} onClick={() => setOpen(r.id)} className={`cursor-pointer border-t border-white/5 hover:bg-white/[0.02] ${r.status === "CANCELLED" ? "opacity-50" : ""}`}>
                  <td className="px-4 py-3 text-[#e4e4e4]">{month(r.periodStart)} <span className="text-[11.5px] text-[#6b6b6b]">· {r.kind === "SALARY" ? "Salaries" : "Stipends"}</span></td>
                  <td className="px-4 py-3 text-[#a1a1a1]">{r.startup.name}</td>
                  <td className="px-4 py-3 text-[#a1a1a1]">{RUN_STATUS_LABEL[r.status]}{r.failed ? <span className="text-red-300"> · {r.failed} failed</span> : null}</td>
                  <td className="px-4 py-3 text-[#a1a1a1]">{r.people}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-white">{inr(r.netPaise)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-[#a1a1a1]">{inr(r.unpaidPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CreateRun onClose={() => setCreating(false)} onCreated={(id) => { load(); setOpen(id); }} />}
      {open && <RunDetail id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}

function CreateRun({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { me, scope } = useFinance();
  const now = new Date();
  const [f, setF] = useState({ kind: "SALARY" as PayrollKind, startupId: scope !== "all" && scope !== "central" ? scope : me.startups[0]?.id ?? "", ym: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`, basis: "FIXED" as "FIXED" | "ATTENDANCE" });
  const [skipped, setSkipped] = useState<Array<{ name: string; reason: string }> | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true); setError(null);
    try {
      const [y, m] = f.ym.split("-").map(Number);
      const r = await financeApi.createPayrollRun({ kind: f.kind, startupId: f.startupId, year: y, month: m, basis: f.kind === "STIPEND" ? f.basis : undefined });
      setCreated(r.id);
      if (r.skipped.length) setSkipped(r.skipped); else { onCreated(r.id); onClose(); }
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  if (skipped && created) {
    return (
      <Modal title="Prepared — some people were left out" onClose={() => { onCreated(created); onClose(); }}>
        <ul className="space-y-1.5 text-[13px]">{skipped.map((s, i) => <li key={i}><span className="text-[#e4e4e4]">{s.name}</span> <span className="text-[#8b8b8b]">— {s.reason}</span></li>)}</ul>
        <div className="mt-4 flex justify-end"><Button kind="primary" onClick={() => { onCreated(created); onClose(); }}>Open the run</Button></div>
      </Modal>
    );
  }
  return (
    <Modal title="Prepare a month" onClose={onClose}>
      <div className="grid gap-3">
        <Field label="What"><select className={inputCls} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as PayrollKind })}><option value="SALARY">Salaries (employees)</option><option value="STIPEND">Stipends (interns)</option></select></Field>
        <Field label="Startup" required><select className={inputCls} value={f.startupId} onChange={(e) => setF({ ...f, startupId: e.target.value })}>{me.startups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Month" required><input type="month" className={inputCls} value={f.ym} onChange={(e) => setF({ ...f, ym: e.target.value })} /></Field>
        {f.kind === "STIPEND" && (
          <Field label="Stipend based on" hint="Fixed: the confirmed monthly stipend for the days of the internship in the month. Attendance: the workspace's attendance rules.">
            <select className={inputCls} value={f.basis} onChange={(e) => setF({ ...f, basis: e.target.value as any })}><option value="FIXED">Fixed monthly stipend</option><option value="ATTENDANCE">Attendance</option></select>
          </Field>
        )}
      </div>
      <p className="mt-3 text-[12px] text-[#6b6b6b]">Only confirmed pay is used. People joining or leaving mid-month are paid for their days.</p>
      <div className="mt-3"><ErrorNote message={error} /></div>
      <div className="mt-4 flex justify-end gap-2"><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy || !f.startupId} onClick={create}>{busy ? "Preparing…" : "Prepare"}</Button></div>
    </Modal>
  );
}

function RunDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [run, setRun] = useState<PayrollRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<PayrollLine | null>(null);
  const [paying, setPaying] = useState<PayrollLine | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => financeApi.payrollRun(id).then(setRun).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  if (!run) return <Modal title="Payroll" onClose={onClose}><ErrorNote message={error} /></Modal>;
  const editable = run.status === "DRAFT" || run.status === "REVIEW";
  const payable = ["APPROVED", "PROCESSING", "PARTIALLY_PAID"].includes(run.status);
  return (
    <Modal title={`${run.kind === "SALARY" ? "Salaries" : "Stipends"} — ${run.startup.name} — ${month(run.periodStart)}`} onClose={onClose} wide>
      <p className="text-[12.5px] text-[#8b8b8b]">{RUN_STATUS_LABEL[run.status]} · {run.totals.people} people · total {inr(run.totals.netPaise)} · still to pay {inr(run.totals.unpaidPaise)}{run.totals.missingBank ? ` · ${run.totals.missingBank} without bank details` : ""}</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[680px] text-[13px]">
          <thead className="text-left text-[11.5px] text-[#6b6b6b]"><tr><th className="pb-2 font-medium">Person</th><th className="pb-2 font-medium">Days</th><th className="pb-2 text-right font-medium">Base</th><th className="pb-2 text-right font-medium">Net</th><th className="pb-2 font-medium pl-4">Status</th><th /></tr></thead>
          <tbody>
            {run.lines.map((l) => (
              <tr key={l.id} className="border-t border-white/5 align-top">
                <td className="py-2.5"><div className="text-[#e4e4e4]">{l.name}{l.isFinalSettlement && <span className="ml-1.5 text-[11px] text-amber-300">final month</span>}</div><div className="text-[11px] text-[#6b6b6b]">{l.code}{l.adjustments.length ? ` · ${l.adjustments.map((x) => `${x.kind === "DEDUCTION" ? "−" : "+"}${inr(x.amountPaise)} ${x.label}`).join(", ")}` : ""}</div></td>
                <td className="py-2.5 text-[#a1a1a1]">{l.workedDays}/{l.periodDays}</td>
                <td className="py-2.5 text-right tabular-nums text-[#a1a1a1]">{inr(l.basePaise)}</td>
                <td className="py-2.5 text-right tabular-nums text-white">{inr(l.netPaise)}</td>
                <td className={`py-2.5 pl-4 ${LINE_TONE[l.status]}`}>{LINE_LABEL[l.status]}{l.paymentRef ? <div className="text-[11px] text-[#6b6b6b]">{l.paymentRef}</div> : null}{l.failureReason ? <div className="text-[11px]">{l.failureReason}</div> : null}{!l.bankLast4 && l.status !== "PAID" ? <div className="text-[11px] text-amber-300">No bank details</div> : null}</td>
                <td className="py-2.5 text-right whitespace-nowrap">
                  {editable && <Button kind="ghost" onClick={() => setEditing(l)}>Adjust</Button>}
                  {payable && l.status !== "PAID" && l.status !== "ON_HOLD" && <Button kind="ghost" onClick={() => setPaying(l)}>Paid / failed</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <p className="mt-3 text-[12.5px] text-[#c8f135]">{note}</p>}
      <ErrorNote message={error} />
      <RunActions run={run} busy={busy} act={act} onNote={setNote} />
      {editing && <AdjustLine run={run} line={editing} onClose={() => setEditing(null)} onSaved={() => { load(); onChanged(); }} />}
      {paying && <PayLine run={run} line={paying} onClose={() => setPaying(null)} onSaved={() => { load(); onChanged(); }} />}
    </Modal>
  );
}

function RunActions({ run, busy, act, onNote }: { run: PayrollRun; busy: boolean; act: (fn: () => Promise<unknown>) => void; onNote: (n: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const s = run.status;
  const bank = () => act(async () => {
    const f = await financeApi.bankFile(run.id);
    saveText(f.csv, f.filename);
    onNote(`Bank file: ${f.included} payment(s), ${inr(f.totalPaise)}.${f.missing.length ? ` Not included (no bank details): ${f.missing.join(", ")}.` : ""}`);
  });
  const report = () => act(async () => { const r = await financeApi.payrollReport(run.id); saveText(r.csv, r.filename); });
  const cancel = () => { const reason = prompt("Why is this run being cancelled?"); if (reason && reason.trim().length >= 3) act(() => financeApi.cancelPayroll(run.id, reason)); };
  return (
    <div className="mt-5 space-y-3 border-t border-white/5 pt-4">
      {s === "REVIEW" && (
        <label className="flex items-center gap-2 text-[13px] text-[#cfcfcf]"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />I&apos;ve checked every line, amount and person in this run.</label>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button kind="ghost" disabled={busy} onClick={report}><FileSpreadsheet className="h-4 w-4" />Report</Button>
        {["DRAFT", "REVIEW", "APPROVED", "PROCESSING"].includes(s) && run.totals.paidPaise === 0 && <Button kind="ghost" disabled={busy} onClick={cancel}>Cancel run</Button>}
        {(s === "REVIEW" || s === "APPROVED") && <Button disabled={busy} onClick={() => act(() => financeApi.payrollAction(run.id, "reopen"))}>Back to draft</Button>}
        {s === "DRAFT" && <Button kind="primary" disabled={busy} onClick={() => act(() => financeApi.payrollAction(run.id, "submit"))}>Send for review</Button>}
        {s === "REVIEW" && <Button kind="primary" disabled={busy || !confirm} onClick={() => act(() => financeApi.approvePayroll(run.id))}>Approve</Button>}
        {["APPROVED", "PROCESSING", "PARTIALLY_PAID"].includes(s) && <Button kind="primary" disabled={busy} onClick={bank}><Download className="h-4 w-4" />Bank transfer file</Button>}
      </div>
      {["APPROVED", "PROCESSING", "PARTIALLY_PAID"].includes(s) && <p className="text-right text-[11.5px] text-[#6b6b6b]">Upload the file in your bank, make the transfers, then confirm each payment with its reference.</p>}
    </div>
  );
}

type AdjRow = { kind: AdjustmentKind; label: string; amount: string };
const ADJ_LABEL: Record<AdjustmentKind, string> = { INCENTIVE: "Incentive", BONUS: "Bonus", REIMBURSEMENT: "Reimbursement", SETTLEMENT: "Final settlement", DEDUCTION: "Deduction" };

function AdjustLine({ run, line, onClose, onSaved }: { run: PayrollRun; line: PayrollLine; onClose: () => void; onSaved: () => void }) {
  const [rows, setRows] = useState<AdjRow[]>(line.adjustments.map((a) => ({ kind: a.kind, label: a.label, amount: String(a.amountPaise / 100) })));
  const [hold, setHold] = useState(line.status === "ON_HOLD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (i: number, patch: Partial<AdjRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Modal title={`Adjust — ${line.name}`} onClose={onClose}>
      <p className="mb-3 text-[12.5px] text-[#8b8b8b]">Base for {line.workedDays} of {line.periodDays} days: {inr(line.basePaise)}{run.kind === "STIPEND" ? " · stipend adjustments are whole rupees" : ""}</p>
      {rows.map((r, i) => (
        <div key={i} className="mb-2 flex gap-2">
          <select className={`${inputCls} w-40`} value={r.kind} onChange={(e) => set(i, { kind: e.target.value as AdjustmentKind })}>{(Object.keys(ADJ_LABEL) as AdjustmentKind[]).map((k) => <option key={k} value={k}>{ADJ_LABEL[k]}</option>)}</select>
          <input className={inputCls} placeholder="What for" value={r.label} onChange={(e) => set(i, { label: e.target.value })} />
          <input className={`${inputCls} w-32 text-right`} inputMode="decimal" placeholder="₹" value={r.amount} onChange={(e) => set(i, { amount: e.target.value })} />
          <Button kind="ghost" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      ))}
      <Button kind="ghost" onClick={() => setRows([...rows, { kind: "BONUS", label: "", amount: "" }])}><Plus className="h-3.5 w-3.5" />Add a line</Button>
      <label className="mt-3 flex items-center gap-2 text-[13px] text-[#cfcfcf]"><input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} />Hold this payment (left out of the bank file)</label>
      <div className="mt-3"><ErrorNote message={error} /></div>
      <div className="mt-4 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button kind="primary" disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          try { await financeApi.changePayrollLine(run.id, line.id, { adjustments: rows.filter((r) => r.label && r.amount), hold }); onSaved(); onClose(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
        }}>Save</Button>
      </div>
    </Modal>
  );
}

function PayLine({ run, line, onClose, onSaved }: { run: PayrollRun; line: PayrollLine; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ paidOn: today(), paymentRef: "", method: "BANK_TRANSFER" as PaymentMethod, reason: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); onSaved(); onClose(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  return (
    <Modal title={`${line.name} — ${inr(line.netPaise)}`} onClose={onClose}>
      <p className="mb-3 text-[12.5px] text-[#8b8b8b]">Record a transfer you&apos;ve made in the bank. This doesn&apos;t send money.</p>
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Paid on"><input type="date" className={inputCls} max={today()} value={f.paidOn} onChange={(e) => setF({ ...f, paidOn: e.target.value })} /></Field>
          <Field label="How"><select className={inputCls} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as PaymentMethod })}>{(Object.keys(METHOD_LABEL) as PaymentMethod[]).map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select></Field>
        </div>
        <Field label="Bank reference (UTR)" hint="So the payment can be traced. Strongly recommended."><input className={inputCls} value={f.paymentRef} onChange={(e) => setF({ ...f, paymentRef: e.target.value })} /></Field>
      </div>
      <div className="mt-3"><ErrorNote message={error} /></div>
      <div className="mt-4 flex justify-end gap-2"><Button kind="primary" disabled={busy} onClick={() => go(() => financeApi.payLine(run.id, line.id, { paidOn: f.paidOn, paymentRef: f.paymentRef || undefined, paymentMethod: f.method }))}>Mark as paid</Button></div>
      <div className="mt-5 border-t border-white/5 pt-4">
        <Field label="Or: the transfer failed — why?"><input className={inputCls} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Account closed, wrong IFSC" /></Field>
        <div className="mt-2 flex justify-end"><Button kind="danger" disabled={busy || f.reason.trim().length < 3} onClick={() => go(() => financeApi.failLine(run.id, line.id, f.reason))}>Mark as failed</Button></div>
      </div>
    </Modal>
  );
}
