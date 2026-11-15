"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Landmark, Plus, Trash2 } from "lucide-react";
import { Bank, financeApi, inr, PaySetup, today } from "@/lib/api/finance";
import { Button, Empty, ErrorNote, Field, Modal, PageHeader, Panel, StatCard, inputCls, useFinance } from "@/components/finance/ui";

/**
 * Salaries and stipends — the CFO only.
 *
 * Figures from HR are shown as suggestions with the reasoning behind them.
 * Nothing is used for payroll until it is confirmed here.
 */
export default function PayPage() {
  const { me, scope } = useFinance();
  const [data, setData] = useState<PaySetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emp, setEmp] = useState<PaySetup["employees"][number] | null>(null);
  const [intern, setIntern] = useState<PaySetup["interns"][number] | null>(null);
  const [bank, setBank] = useState<{ kind: "employee" | "intern"; id: string; name: string; current: Bank | null } | null>(null);

  const startup = scope !== "all" && scope !== "central" ? scope : undefined;
  const load = useCallback(() => financeApi.paySetup(startup).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)), [startup]);
  useEffect(() => { if (me.canSeePay) load(); }, [load, me.canSeePay]);

  if (!me.canSeePay) return <Empty title="Only the CFO can see salaries and stipends" />;

  return (
    <>
      <PageHeader title="Salaries & stipends" sub="Confirm what each person is paid and where to send it. Figures from HR are suggestions until you confirm them — payroll only ever uses confirmed figures." />
      <ErrorNote message={error} />
      {scope === "central" && <p className="mb-4 text-[13px] text-[#8b8b8b]">Central DevUp has no employees or interns on record, so everyone across all startups is shown.</p>}

      {!data ? (
        <div className="h-40 animate-pulse rounded-xl bg-white/[0.03]" />
      ) : (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Employees with confirmed pay" value={`${data.summary.employeesConfirmed} of ${data.summary.employees}`} hint="Only confirmed pay is used for salaries." tone={data.summary.employeesConfirmed < data.summary.employees ? "warn" : "good"} />
            <StatCard label="Interns with confirmed stipend" value={`${data.summary.internsConfirmed} of ${data.summary.interns}`} hint="Only confirmed stipends are used for stipend runs." tone={data.summary.internsConfirmed < data.summary.interns ? "warn" : "good"} />
            <StatCard label="Missing bank details" value={String(data.summary.withoutBankDetails)} hint="People with no account recorded for payments. Bank details are encrypted; only the last four digits are shown." tone={data.summary.withoutBankDetails ? "warn" : "good"} />
            <StatCard label="Internship ended, still marked active" value={String(data.summary.internsEndedButActive)} hint="HR still shows these interns as active although their end date has passed. They're left out of stipends until HR updates their dates or status." tone={data.summary.internsEndedButActive ? "warn" : "good"} />
          </div>

          <Panel title={`Employees (${data.employees.length})`} hint="Monthly pay is set with explicit components, from a start date. Changing pay later keeps the old figure in history.">
            {data.employees.length === 0 ? <p className="text-[13px] text-[#6b6b6b]">No active employees.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-[13px]">
                  <thead className="text-left text-[11.5px] text-[#6b6b6b]">
                    <tr><th className="pb-2 font-medium">Person</th><th className="pb-2 font-medium">Startup</th><th className="pb-2 font-medium">HR says</th><th className="pb-2 font-medium">Monthly pay</th><th className="pb-2 font-medium">Bank</th><th /></tr>
                  </thead>
                  <tbody>
                    {data.employees.map((e) => (
                      <tr key={e.id} className="border-t border-white/5 align-top">
                        <td className="py-3"><div className="text-[#e4e4e4]">{e.name}</div><div className="text-[11.5px] text-[#6b6b6b]">{e.code} · {e.designation}{e.department ? ` · ${e.department}` : ""}</div></td>
                        <td className="py-3 text-[#a1a1a1]">{e.startup.name}</td>
                        <td className="py-3 text-[#a1a1a1]">{e.hrCtc ?? "—"}</td>
                        <td className="py-3">
                          {e.compensation ? (
                            <span className="flex items-center gap-1.5 text-white"><CheckCircle2 className="h-3.5 w-3.5 text-[#c8f135]" />{inr(e.compensation.monthlyGrossPaise)}<span className="text-[11px] text-[#6b6b6b]">from {e.compensation.effectiveFrom.slice(0, 10)}</span></span>
                          ) : e.suggestion?.monthlyPaise != null ? (
                            <div><span className="text-amber-200">{inr(e.suggestion.monthlyPaise)}?</span><div className="max-w-[260px] text-[11px] text-[#6b6b6b]">{e.suggestion.explanation}</div></div>
                          ) : <span className="text-[11.5px] text-amber-300">{e.suggestion?.explanation ?? "Not set"}</span>}
                        </td>
                        <td className="py-3 text-[#a1a1a1]">{e.bank ? `•••• ${e.bank.accountLast4}` : <span className="text-[#6b6b6b]">None</span>}</td>
                        <td className="py-3 text-right whitespace-nowrap">
                          <Button kind={e.compensation ? "ghost" : "primary"} onClick={() => setEmp(e)}>{e.compensation ? "Change pay" : "Confirm pay"}</Button>
                          <Button kind="ghost" onClick={() => setBank({ kind: "employee", id: e.id, name: e.name, current: e.bank })}><Landmark className="h-3.5 w-3.5" /></Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title={`Interns (${data.interns.length})`} hint="Stipends are whole rupees a month. Enter 0 for an unpaid internship." className="mt-4">
            {data.interns.length === 0 ? <p className="text-[13px] text-[#6b6b6b]">No active interns.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-[13px]">
                  <thead className="text-left text-[11.5px] text-[#6b6b6b]">
                    <tr><th className="pb-2 font-medium">Person</th><th className="pb-2 font-medium">Startup</th><th className="pb-2 font-medium">Internship</th><th className="pb-2 font-medium">Monthly stipend</th><th className="pb-2 font-medium">Bank</th><th /></tr>
                  </thead>
                  <tbody>
                    {data.interns.map((i) => (
                      <tr key={i.id} className="border-t border-white/5 align-top">
                        <td className="py-3"><div className="text-[#e4e4e4]">{i.name}</div><div className="text-[11.5px] text-[#6b6b6b]">{i.code}{i.college ? ` · ${i.college}` : ""}</div></td>
                        <td className="py-3 text-[#a1a1a1]">{i.startup.name}</td>
                        <td className="py-3 text-[#a1a1a1]">
                          {i.startDate.slice(0, 10)} → {i.endDate.slice(0, 10)}
                          {i.warning && <div className="mt-0.5 flex max-w-[240px] gap-1 text-[11px] text-amber-300"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />Period ended — HR still shows active</div>}
                        </td>
                        <td className="py-3">
                          {i.stipendAmount != null ? (
                            <span className="flex items-center gap-1.5 text-white"><CheckCircle2 className="h-3.5 w-3.5 text-[#c8f135]" />{inr(i.stipendAmount * 100)}</span>
                          ) : i.suggestion?.monthlyRupees != null ? (
                            <div><span className="text-amber-200">{inr(i.suggestion.monthlyRupees * 100)}?</span><div className="text-[11px] text-[#6b6b6b]">{i.suggestion.explanation}</div></div>
                          ) : <span className="text-[11.5px] text-amber-300">{i.suggestion?.explanation ?? "Not set"}</span>}
                        </td>
                        <td className="py-3 text-[#a1a1a1]">{i.bank ? `•••• ${i.bank.accountLast4}` : <span className="text-[#6b6b6b]">None</span>}</td>
                        <td className="py-3 text-right whitespace-nowrap">
                          <Button kind={i.stipendAmount != null ? "ghost" : "primary"} onClick={() => setIntern(i)}>{i.stipendAmount != null ? "Change" : "Confirm"}</Button>
                          <Button kind="ghost" onClick={() => setBank({ kind: "intern", id: i.id, name: i.name, current: i.bank })}><Landmark className="h-3.5 w-3.5" /></Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}

      {emp && <PayForm emp={emp} onClose={() => setEmp(null)} onSaved={load} />}
      {intern && <StipendForm intern={intern} onClose={() => setIntern(null)} onSaved={load} />}
      {bank && <BankForm target={bank} onClose={() => setBank(null)} onSaved={load} />}
    </>
  );
}

/** Starting values for the pay form: the confirmed pay, else HR's suggestion, else empty. */
function initialPay(emp: PaySetup["employees"][number]) {
  const c = emp.compensation;
  const s = emp.suggestion;
  const rupees = (p: number | null | undefined) => (p == null ? "" : String(p / 100));
  const suggestedAnnual = s && "annualCtcPaise" in s ? s.annualCtcPaise : null;
  const joined = emp.joinedAt.slice(0, 10);
  return {
    fromHr: !c && s?.monthlyPaise != null,
    monthly: c ? rupees(c.monthlyGrossPaise) : rupees(s?.monthlyPaise),
    annual: c ? rupees(c.annualCtcPaise) : rupees(suggestedAnnual),
    // New pay starts today; first-time pay starts this month, or on the joining date if that's later.
    from: c ? today() : joined > today() ? joined : today().slice(0, 8) + "01",
  };
}

function PayForm({ emp, onClose, onSaved }: { emp: PaySetup["employees"][number]; onClose: () => void; onSaved: () => void }) {
  const s = emp.suggestion;
  const init = initialPay(emp);
  const fromHr = init.fromHr;
  const [monthly, setMonthly] = useState(init.monthly);
  const [annual, setAnnual] = useState(init.annual);
  const [from, setFrom] = useState(init.from);
  const [parts, setParts] = useState<Array<{ name: string; amount: string }>>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const partsTotal = parts.reduce((t, p) => t + (Number(p.amount) || 0), 0);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await financeApi.confirmPay(emp.id, {
        monthlyGross: monthly, annualCtc: annual || null, effectiveFrom: from,
        components: parts.length ? parts : undefined, basis: fromHr && Number(monthly) * 100 === s?.monthlyPaise ? "CONFIRMED_FROM_HR" : "ENTERED", note: note || undefined,
      });
      onSaved();
      onClose();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal title={`${emp.compensation ? "Change" : "Confirm"} pay — ${emp.name}`} onClose={onClose}>
      {fromHr && <div className="mb-4 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] p-3 text-[12.5px] text-amber-100">Suggested from HR: {s!.explanation}. Check it before confirming.</div>}
      <div className="grid gap-3">
        <Field label="Monthly gross pay (₹)" required hint="What this person earns in a month before deductions."><input className={inputCls} inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} /></Field>
        <Field label="Yearly CTC (₹), for reference" hint="Kept for reference only. Payroll uses the monthly figure."><input className={inputCls} inputMode="decimal" value={annual} onChange={(e) => setAnnual(e.target.value)} /></Field>
        <Field label="Pay starts from" required hint={emp.compensation ? "The current pay ends the day before. Its history is kept." : "Usually the first of the month, or the joining date."}><input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <div>
          <div className="mb-1.5 flex items-center justify-between text-[12px] text-[#a1a1a1]">Pay components (optional)<Button kind="ghost" onClick={() => setParts([...parts, { name: "", amount: "" }])}><Plus className="h-3.5 w-3.5" />Add</Button></div>
          {parts.map((p, i) => (
            <div key={i} className="mb-2 flex gap-2">
              <input className={inputCls} placeholder="e.g. Basic, HRA" value={p.name} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input className={`${inputCls} w-36 text-right`} inputMode="decimal" placeholder="₹" value={p.amount} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              <Button kind="ghost" aria-label="Remove" onClick={() => setParts(parts.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          ))}
          {parts.length > 0 && <p className={`text-[11.5px] ${Math.abs(partsTotal - Number(monthly)) < 0.005 ? "text-[#6b6b6b]" : "text-amber-300"}`}>Components add up to ₹{partsTotal.toLocaleString("en-IN")} — must equal the monthly pay.</p>}
        </div>
        <Field label="Note"><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Confirmed with founder on 16 Nov" /></Field>
      </div>
      <div className="mt-3"><ErrorNote message={error} /></div>
      <div className="mt-4 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button kind="primary" disabled={busy || !monthly || !from} onClick={save}>{busy ? "Saving…" : "Confirm pay"}</Button>
      </div>
    </Modal>
  );
}

function StipendForm({ intern, onClose, onSaved }: { intern: PaySetup["interns"][number]; onClose: () => void; onSaved: () => void }) {
  const [monthly, setMonthly] = useState(intern.stipendAmount != null ? String(intern.stipendAmount) : intern.suggestion?.monthlyRupees != null ? String(intern.suggestion.monthlyRupees) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Monthly stipend — ${intern.name}`} onClose={onClose}>
      {intern.suggestion && <p className="mb-3 text-[12.5px] text-[#8b8b8b]">{intern.suggestion.explanation}.</p>}
      <Field label="Monthly stipend (₹, whole rupees)" required hint="Enter 0 for an unpaid internship."><input className={inputCls} inputMode="numeric" value={monthly} onChange={(e) => setMonthly(e.target.value)} /></Field>
      <div className="mt-3"><ErrorNote message={error} /></div>
      <div className="mt-4 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button kind="primary" disabled={busy || monthly === ""} onClick={async () => {
          setBusy(true); setError(null);
          try { await financeApi.confirmStipend(intern.id, monthly); onSaved(); onClose(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
        }}>{busy ? "Saving…" : "Confirm stipend"}</Button>
      </div>
    </Modal>
  );
}

function BankForm({ target, onClose, onSaved }: { target: { kind: "employee" | "intern"; id: string; name: string; current: Bank | null }; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ accountHolder: target.current?.accountHolder ?? target.name, accountNumber: "", ifsc: "", bankName: "", upiId: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={`Bank details — ${target.name}`} onClose={onClose}>
      <p className="mb-4 text-[12.5px] text-[#8b8b8b]">
        Stored encrypted. Only the last four digits are ever shown again. Never enter passwords, PINs or card numbers.
        {target.current && <> Current: •••• {target.current.accountLast4} ({target.current.ifsc}). Saving replaces it; the old one stays in history.</>}
      </p>
      <div className="grid gap-3">
        <Field label="Account holder" required><input className={inputCls} value={f.accountHolder} onChange={set("accountHolder")} /></Field>
        <Field label="Account number" required><input className={inputCls} inputMode="numeric" autoComplete="off" value={f.accountNumber} onChange={set("accountNumber")} /></Field>
        <Field label="IFSC" required hint="11 characters, like SBIN0001234."><input className={`${inputCls} uppercase`} maxLength={11} value={f.ifsc} onChange={set("ifsc")} /></Field>
        <Field label="Bank name"><input className={inputCls} value={f.bankName} onChange={set("bankName")} /></Field>
        <Field label="UPI ID (optional)"><input className={inputCls} autoComplete="off" value={f.upiId} onChange={set("upiId")} placeholder="name@bank" /></Field>
      </div>
      <div className="mt-3"><ErrorNote message={error} /></div>
      <div className="mt-4 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button kind="primary" disabled={busy || !f.accountNumber || f.ifsc.length !== 11} onClick={async () => {
          setBusy(true); setError(null);
          try {
            await financeApi.saveBank({ ...(target.kind === "employee" ? { employeeId: target.id } : { internId: target.id }), accountHolder: f.accountHolder, accountNumber: f.accountNumber, ifsc: f.ifsc, bankName: f.bankName || undefined, upiId: f.upiId || undefined });
            onSaved(); onClose();
          } catch (e: any) { setError(e.message); } finally { setBusy(false); }
        }}>{busy ? "Saving…" : "Save bank details"}</Button>
      </div>
    </Modal>
  );
}
