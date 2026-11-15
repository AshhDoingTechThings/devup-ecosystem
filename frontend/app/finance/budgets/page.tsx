"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Budget, BudgetPeriod, BudgetScope, financeApi, inr, MoneyFigures, today } from "@/lib/api/finance";
import { Button, Empty, ErrorNote, Field, Modal, PageHeader, Tip, inputCls, useFinance } from "@/components/finance/ui";

/**
 * Budgets: money set aside for DevUp, central operations or a startup, for a
 * period. Available = allocated − spent − committed. Only the CFO sets them.
 */

const PERIOD_LABEL: Record<BudgetPeriod, string> = { WEEKLY: "Week", MONTHLY: "Month", QUARTERLY: "Quarter", YEARLY: "Financial year", CUSTOM: "Custom dates" };
const fmt = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export default function BudgetsPage() {
  const { me, scope, scopeName } = useFinance();
  const [rows, setRows] = useState<Budget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => financeApi.budgets(scope).then((r) => { setRows(r); setError(null); }).catch((e) => setError(e.message)), [scope]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <PageHeader title="Budgets" sub={`Money set aside for ${scopeName}, and how much of it is left. Spent is what's been paid; committed is approved but not paid yet.`}>
        {me.isCfo && <Button kind="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />Create budget</Button>}
      </PageHeader>
      <ErrorNote message={error} />
      {!rows ? <div className="h-40 animate-pulse rounded-xl bg-white/[0.03]" /> : rows.length === 0 ? (
        <Empty title="No budgets for this view yet">{me.isCfo ? "Create one for this month or the financial year — for all of DevUp, central operations, or a single startup." : "The CFO hasn't set a budget for this view."}</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rows.map((b) => <BudgetCard key={b.id} b={b} onOpen={() => setOpen(b.id)} />)}
        </div>
      )}
      {creating && <BudgetForm onClose={() => setCreating(false)} onSaved={load} />}
      {open && <BudgetDetail id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}

function Meter({ m }: { m: MoneyFigures }) {
  const total = Math.max(m.allocatedPaise, m.spentPaise + m.committedPaise, 1);
  return (
    <div className="h-2.5 overflow-hidden rounded-full bg-white/[0.05]" role="img" aria-label={`${m.usedPercent}% used`}>
      <div className="flex h-full">
        <div className={m.over ? "bg-red-400/80" : "bg-[#c8f135]/80"} style={{ width: `${(m.spentPaise / total) * 100}%` }} />
        <div className={m.over ? "bg-red-400/40" : "bg-sky-400/50"} style={{ width: `${(m.committedPaise / total) * 100}%` }} />
      </div>
    </div>
  );
}

function Figures({ m }: { m: MoneyFigures }) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">
      <div><dt className="text-[#6b6b6b]">Budget</dt><dd className="tabular-nums text-white">{inr(m.allocatedPaise, { compact: true })}</dd></div>
      <div><dt className="text-[#6b6b6b]">Spent</dt><dd className="tabular-nums text-[#c8f135]">{inr(m.spentPaise, { compact: true })}</dd></div>
      <div><dt className="text-[#6b6b6b]">Committed</dt><dd className="tabular-nums text-sky-300">{inr(m.committedPaise, { compact: true })}</dd></div>
      <div><dt className="text-[#6b6b6b]">{m.over ? "Over budget by" : "Left"}</dt><dd className={`tabular-nums ${m.over ? "text-red-300" : "text-white"}`}>{inr(Math.abs(m.availablePaise), { compact: true })}</dd></div>
    </dl>
  );
}

function BudgetCard({ b, onOpen }: { b: Budget; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="rounded-xl border border-white/[0.07] bg-[#0f0f0f] p-4 text-left transition hover:border-white/15">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-white">{b.name}</div>
          <div className="text-[11.5px] text-[#6b6b6b]">{b.startup?.name ?? (b.scope === "CENTRAL" ? "Central DevUp" : "All of DevUp")} · {PERIOD_LABEL[b.period]} · {fmt(b.periodStart)} – {fmt(b.periodEnd)}</div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${b.totals.over ? "bg-red-400/10 text-red-300" : "bg-white/5 text-[#a1a1a1]"}`}>{b.totals.usedPercent}% used</span>
      </div>
      <div className="mt-3"><Meter m={b.totals} /></div>
      <Figures m={b.totals} />
    </button>
  );
}

function BudgetDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { me } = useFinance();
  const [b, setB] = useState<Budget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revising, setRevising] = useState(false);
  const load = useCallback(() => financeApi.budget(id).then(setB).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  if (!b) return <Modal title="Budget" onClose={onClose}><ErrorNote message={error} /></Modal>;
  return (
    <Modal title={b.name} onClose={onClose} wide>
      <p className="text-[12.5px] text-[#8b8b8b]">{b.startup?.name ?? (b.scope === "CENTRAL" ? "Central DevUp operations" : "All of DevUp")} · {fmt(b.periodStart)} – {fmt(b.periodEnd)} · revision {b.version}</p>
      <div className="mt-4"><Meter m={b.totals} /></div>
      <Figures m={b.totals} />
      <div className="mt-5 space-y-3">
        {b.lines.map((l) => (
          <div key={l.id} className="rounded-lg border border-white/[0.06] p-3">
            <div className="flex justify-between text-[13px]"><span className="text-[#e4e4e4]">{l.categoryGroup ?? "All spending"}</span><span className="text-[#8b8b8b]">{l.usedPercent}% used</span></div>
            <div className="mt-2"><Meter m={l} /></div>
            <Figures m={l} />
          </div>
        ))}
      </div>
      {b.sharedCostSharePaise != null && b.sharedCostSharePaise > 0 && (
        <p className="mt-3 flex items-center gap-1.5 text-[12px] text-[#8b8b8b]">Includes {inr(b.sharedCostSharePaise)} as this startup&apos;s share of shared DevUp costs.<Tip text="Central bills split to this startup count against its budget. DevUp's overall total still counts each bill once." /></p>
      )}
      {b.unbudgeted.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/[0.05] p-3 text-[12.5px] text-amber-100">
          Spending with no budget line: {b.unbudgeted.map((u) => `${u.group} ${inr(u.spentPaise + u.committedPaise)}`).join(" · ")}
        </div>
      )}
      {b.history && b.history.length > 1 && (
        <details className="mt-4 text-[12px] text-[#a1a1a1]">
          <summary className="cursor-pointer">Changes ({b.history.length})</summary>
          <ul className="mt-2 space-y-1">{b.history.map((h, i) => <li key={i}>{new Date(h.at).toLocaleString("en-IN")} — {h.action.replace("finance.budget.", "")}{h.details?.reason ? `: ${h.details.reason}` : ""}</li>)}</ul>
        </details>
      )}
      <ErrorNote message={error} />
      {me.isCfo && !b.archivedAt && (
        <div className="mt-5 flex justify-end gap-2">
          <Button kind="ghost" onClick={() => financeApi.archiveBudget(b.id).then(() => { onChanged(); onClose(); }).catch((e) => setError(e.message))}>Archive</Button>
          <Button kind="primary" onClick={() => setRevising(true)}>Change amounts</Button>
        </div>
      )}
      {revising && <ReviseForm b={b} onClose={() => setRevising(false)} onSaved={() => { load(); onChanged(); }} />}
    </Modal>
  );
}

type LineRow = { categoryGroup: string; amount: string };

function LinesEditor({ perGroup, setPerGroup, total, setTotal, lines, setLines, groups }: { perGroup: boolean; setPerGroup: (v: boolean) => void; total: string; setTotal: (v: string) => void; lines: LineRow[]; setLines: (l: LineRow[]) => void; groups: string[] }) {
  return (
    <div className="space-y-2">
      <div className="flex gap-1 rounded-lg border border-white/[0.08] p-1 w-fit text-[12.5px]">
        <button type="button" onClick={() => setPerGroup(false)} className={`rounded-md px-3 py-1 ${!perGroup ? "bg-white/10 text-white" : "text-[#8b8b8b]"}`}>One amount for everything</button>
        <button type="button" onClick={() => setPerGroup(true)} className={`rounded-md px-3 py-1 ${perGroup ? "bg-white/10 text-white" : "text-[#8b8b8b]"}`}>Amount per spending group</button>
      </div>
      {!perGroup ? (
        <Field label="Budget (₹)" required><input className={inputCls} inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} /></Field>
      ) : (
        <>
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              <select className={inputCls} value={l.categoryGroup} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, categoryGroup: e.target.value } : x)))}>
                <option value="">Choose a group…</option>
                {groups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
              <input className={`${inputCls} w-40 text-right`} inputMode="decimal" placeholder="₹" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              <Button kind="ghost" aria-label="Remove" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          ))}
          <Button kind="ghost" onClick={() => setLines([...lines, { categoryGroup: "", amount: "" }])}><Plus className="h-3.5 w-3.5" />Add a group</Button>
        </>
      )}
    </div>
  );
}

function useGroups() {
  const [groups, setGroups] = useState<string[]>([]);
  useEffect(() => { financeApi.budgetGroups().then(setGroups).catch(() => {}); }, []);
  return groups;
}

const linesFrom = (perGroup: boolean, total: string, lines: LineRow[]) =>
  perGroup ? lines.filter((l) => l.categoryGroup && l.amount).map((l) => ({ categoryGroup: l.categoryGroup, amount: l.amount })) : [{ amount: total }];

function BudgetForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { me, scope } = useFinance();
  const groups = useGroups();
  const defaultScope: BudgetScope = scope === "central" ? "CENTRAL" : scope !== "all" ? "STARTUP" : "ECOSYSTEM";
  const [f, setF] = useState({ name: "", scope: defaultScope, startupId: scope !== "all" && scope !== "central" ? scope : "", period: "MONTHLY" as BudgetPeriod, anchor: today(), from: "", to: "", notes: "" });
  const [perGroup, setPerGroup] = useState(false);
  const [total, setTotal] = useState("");
  const [lines, setLines] = useState<LineRow[]>([{ categoryGroup: "", amount: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true); setError(null);
    try {
      await financeApi.createBudget({ ...f, startupId: f.scope === "STARTUP" ? f.startupId : null, lines: linesFrom(perGroup, total, lines), notes: f.notes || null });
      onSaved(); onClose();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Create a budget" onClose={onClose} wide>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name" required><input className={inputCls} value={f.name} onChange={set("name")} placeholder="e.g. November 2026 — office" /></Field>
        <Field label="For" required hint="All of DevUp counts each cost once. A startup's budget includes its share of shared DevUp costs.">
          <select className={inputCls} value={f.scope} onChange={set("scope")}>
            <option value="ECOSYSTEM">All of DevUp</option>
            <option value="CENTRAL">Central DevUp operations</option>
            <option value="STARTUP">One startup</option>
          </select>
        </Field>
        {f.scope === "STARTUP" && (
          <Field label="Startup" required>
            <select className={inputCls} value={f.startupId} onChange={set("startupId")}><option value="">Choose…</option>{me.startups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </Field>
        )}
        <Field label="Period" required>
          <select className={inputCls} value={f.period} onChange={set("period")}>{(Object.keys(PERIOD_LABEL) as BudgetPeriod[]).map((p) => <option key={p} value={p}>{PERIOD_LABEL[p]}</option>)}</select>
        </Field>
        {f.period === "CUSTOM" ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label="From" required><input type="date" className={inputCls} value={f.from} onChange={set("from")} /></Field>
            <Field label="To" required><input type="date" className={inputCls} value={f.to} onChange={set("to")} /></Field>
          </div>
        ) : (
          <Field label="Any date in the period" hint="Quarters and years follow the financial year (April–March)."><input type="date" className={inputCls} value={f.anchor} onChange={set("anchor")} /></Field>
        )}
      </div>
      <div className="mt-4"><LinesEditor perGroup={perGroup} setPerGroup={setPerGroup} total={total} setTotal={setTotal} lines={lines} setLines={setLines} groups={groups} /></div>
      <div className="mt-3"><ErrorNote message={error} /></div>
      <div className="mt-4 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button kind="primary" disabled={busy || f.name.trim().length < 2} onClick={save}>{busy ? "Saving…" : "Create budget"}</Button>
      </div>
    </Modal>
  );
}

function ReviseForm({ b, onClose, onSaved }: { b: Budget; onClose: () => void; onSaved: () => void }) {
  const groups = useGroups();
  const everything = b.lines.length === 1 && !b.lines[0].categoryGroup;
  const [perGroup, setPerGroup] = useState(!everything);
  const [total, setTotal] = useState(everything ? String(b.lines[0].allocatedPaise / 100) : "");
  const [lines, setLines] = useState<LineRow[]>(everything ? [{ categoryGroup: "", amount: "" }] : b.lines.map((l) => ({ categoryGroup: l.categoryGroup ?? "", amount: String(l.allocatedPaise / 100) })));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Change the budget" onClose={onClose}>
      <LinesEditor perGroup={perGroup} setPerGroup={setPerGroup} total={total} setTotal={setTotal} lines={lines} setLines={setLines} groups={groups} />
      <div className="mt-3"><Field label="Why is it changing?" required hint="Kept with the before-and-after amounts."><input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>
      <div className="mt-3"><ErrorNote message={error} /></div>
      <div className="mt-4 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button kind="primary" disabled={busy || reason.trim().length < 3} onClick={async () => {
          setBusy(true); setError(null);
          try { await financeApi.reviseBudget(b.id, { lines: linesFrom(perGroup, total, lines), reason }); onSaved(); onClose(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
        }}>Save change</Button>
      </div>
    </Modal>
  );
}

