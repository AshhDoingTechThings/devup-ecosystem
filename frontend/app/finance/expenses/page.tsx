"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Search, Paperclip, ExternalLink, Split, History, Loader2 } from "lucide-react";
import { Category, Expense, ExpenseDetail, ExpenseKind, ExpenseStatus, financeApi, inr, METHOD_LABEL, PaymentMethod, today } from "@/lib/api/finance";
import { Button, Empty, ErrorNote, Field, Modal, PageHeader, StatusPill, h3Style, inputCls, useFinance } from "@/components/finance/ui";
import ExpenseForm from "@/components/finance/ExpenseForm";

const TABS: Array<{ value: ExpenseStatus | ""; label: string }> = [
  { value: "", label: "All" },
  { value: "SUBMITTED", label: "Waiting for approval" },
  { value: "NEEDS_INFO", label: "More info needed" },
  { value: "APPROVED", label: "To pay" },
  { value: "PAID", label: "Paid" },
  { value: "DRAFT", label: "Drafts" },
  { value: "REJECTED", label: "Rejected" },
];

const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");

export default function ExpensesPage() {
  const { me, scope, scopeName } = useFinance();
  const [kind, setKind] = useState<ExpenseKind | "">("");
  const [status, setStatus] = useState<ExpenseStatus | "">("");
  const [categoryId, setCategoryId] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [categories, setCategories] = useState<Category[]>([]);
  const [data, setData] = useState<Awaited<ReturnType<typeof financeApi.expenses>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    financeApi.categories().then(setCategories).catch(() => {});
    // Links from the dashboard: /finance/expenses?open=<id>
    const id = new URLSearchParams(window.location.search).get("open");
    if (id) setOpenId(id);
  }, []);

  const load = useCallback(async () => {
    try {
      setData(await financeApi.expenses({ scope, status: status || undefined, kind: kind || undefined, categoryId: categoryId || undefined, q: q.trim() || undefined, from: from || undefined, to: to || undefined, page }));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [scope, status, kind, categoryId, q, from, to, page]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);
  useEffect(() => setPage(1), [scope, status, kind, categoryId, q, from, to]);

  const totalShown = data ? Object.values(data.totals).reduce((s, t) => s + t.amountPaise, 0) : 0;

  return (
    <>
      <PageHeader title="Expenses & claims" sub={`Everything spent for ${scopeName}. Bills are paid to vendors; claims are team members asking to be paid back.`}>
        {me.canManageAnything && <Button kind="primary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" />Add expense</Button>}
      </PageHeader>

      <div className="mb-3 flex flex-wrap gap-1 rounded-lg border border-white/[0.08] p-1 w-fit">
        {([["", "Everything"], ["VENDOR_BILL", "Bills"], ["REIMBURSEMENT", "Team claims"], ["ADJUSTMENT", "Corrections"]] as const).map(([v, l]) => (
          <button key={v} onClick={() => setKind(v)} className={`rounded-md px-3 py-1.5 text-[12.5px] ${kind === v ? "bg-white/10 text-white" : "text-[#8b8b8b] hover:text-white"}`}>{l}</button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button key={t.value} onClick={() => setStatus(t.value)} className={`rounded-full border px-3 py-1 text-[12px] transition ${status === t.value ? "border-[#c8f135]/40 bg-[#c8f135]/10 text-[#c8f135]" : "border-white/[0.08] text-[#8b8b8b] hover:text-white"}`}>
            {t.label}
            {t.value && data?.totals[t.value] ? <span className="ml-1.5 text-[#6b6b6b]">{data.totals[t.value].count}</span> : null}
          </button>
        ))}
      </div>

      <div className="mb-4 grid gap-2 md:grid-cols-[1fr_200px_150px_150px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-[#5d5d5d]" />
          <input className={`${inputCls} pl-9`} placeholder="Search title, number or vendor" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className={inputCls} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input type="date" aria-label="From date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" aria-label="To date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      <ErrorNote message={error} />

      {!data ? (
        <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-white/[0.03]" />)}</div>
      ) : data.rows.length === 0 ? (
        <Empty title="Nothing here">{me.canManageAnything ? "No expenses match. Add one with the button above." : "No expenses match these filters."}</Empty>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-white/[0.07]">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead className="bg-white/[0.02] text-left text-[11.5px] text-[#6b6b6b]">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Expense</th>
                  <th className="px-4 py-2.5 font-medium">Whose cost</th>
                  <th className="px-4 py-2.5 font-medium">Date</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((e) => (
                  <tr key={e.id} onClick={() => setOpenId(e.id)} className="cursor-pointer border-t border-white/5 hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <div className="text-[#e4e4e4]">{e.title}</div>
                      <div className="text-[11.5px] text-[#6b6b6b]">{e.number} · {e.category.name}{e.vendor ? ` · ${e.vendor.name}` : e.payee ? ` · ${e.payee}` : ""}{e.kind === "REIMBURSEMENT" ? " · Team claim" : ""}</div>
                    </td>
                    <td className="px-4 py-3 text-[#a1a1a1]">
                      {e.startup?.name ?? "Central DevUp"}
                      {e.allocations.length > 0 && <div className="text-[11px] text-[#6b6b6b]">Shared with {e.allocations.filter((a) => a.startupId).length} startup(s)</div>}
                    </td>
                    <td className="px-4 py-3 text-[#a1a1a1]">
                      {fmtDate(e.incurredOn)}
                      {e.dueOn && e.status === "APPROVED" && <div className={`text-[11px] ${e.isOverdue ? "text-amber-300" : "text-[#6b6b6b]"}`}>{e.isOverdue ? "Overdue · " : "Due "}{fmtDate(e.dueOn)}</div>}
                    </td>
                    <td className="px-4 py-3"><StatusPill status={e.status} /></td>
                    <td className={`px-4 py-3 text-right tabular-nums ${e.amountPaise < 0 ? "text-[#c8f135]" : "text-white"}`}>{inr(e.amountPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[12px] text-[#6b6b6b]">
            <span>{data.total} expense{data.total === 1 ? "" : "s"} · {inr(totalShown)} in total across all statuses shown</span>
            {data.total > data.pageSize && (
              <div className="flex gap-2">
                <Button kind="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button kind="ghost" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            )}
          </div>
        </>
      )}

      {adding && <ExpenseForm onClose={() => setAdding(false)} onSaved={load} />}
      {openId && <ExpenseDrawer id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </>
  );
}

/* One expense: details, files, history, and the actions this person may take */

type DialogKind = null | "reject" | "info" | "void" | "pay" | "correct" | "split";
type Act = (fn: () => Promise<unknown>) => Promise<void>;

function ExpenseDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { me } = useFinance();
  const [e, setE] = useState<ExpenseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);

  const load = useCallback(() => financeApi.expense(id).then(setE).catch((x) => setError(x.message)), [id]);
  useEffect(() => { load(); }, [load]);

  const act: Act = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
      setDialog(null);
    } catch (x: any) {
      setError(x.message);
    } finally {
      setBusy(false);
    }
  };

  if (!e) {
    return (
      <Modal title="Expense" onClose={onClose} wide>
        <div className="flex justify-center py-10 text-[#6b6b6b]">{error ? <ErrorNote message={error} /> : <Loader2 className="h-5 w-5 animate-spin" />}</div>
      </Modal>
    );
  }

  const canManage = me.isCfo || (!!e.startupId && me.roles.some((r) => r.role === "STARTUP_FINANCE_MANAGER" && r.startupId === e.startupId));
  return (
    <Modal title={e.title} onClose={onClose} wide>
      <div className="space-y-5">
        <ExpenseFacts e={e} />
        <ExpenseFiles e={e} canAttach={canManage && e.status !== "VOID" && (e.status !== "PAID" || me.isCfo)} act={act} onError={setError} />
        <ExpenseHistory e={e} />
        <ErrorNote message={error} />
        <ExpenseActions e={e} canManage={canManage} canApprove={me.canApprove} busy={busy} act={act} open={setDialog} onDeleted={onClose} />
      </div>
      <ExpenseDialogs e={e} dialog={dialog} busy={busy} act={act} close={() => setDialog(null)} />
    </Modal>
  );
}

const KIND_LABEL: Record<ExpenseKind, string> = { VENDOR_BILL: "Bill", REIMBURSEMENT: "Team member's claim", ADJUSTMENT: "Correction" };

function ExpenseFacts({ e }: { e: ExpenseDetail }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill status={e.status} />
        <span className="text-[12px] text-[#6b6b6b]">{e.number}</span>
        <span className={`ml-auto text-2xl font-bold tabular-nums ${e.amountPaise < 0 ? "text-[#c8f135]" : "text-white"}`}>{inr(e.amountPaise)}</span>
      </div>
      {e.reviewNote && <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-[13px] text-[#cfcfcf]"><span className="text-[#8b8b8b]">Note from review: </span>{e.reviewNote}</div>}
      {e.splitCleared && <div className="rounded-lg border border-amber-400/20 bg-amber-400/[0.06] p-3 text-[13px] text-amber-200">The amount or owner changed, so the split between startups was cleared. Split it again if needed.</div>}
      <dl className="grid gap-x-6 gap-y-3 text-[13px] md:grid-cols-2">
        <Row k="Whose cost" v={e.startup?.name ?? "Central DevUp operations"} />
        <Row k="Category" v={`${e.category.name} (${e.category.group})`} />
        <Row k="Paid to" v={e.vendor?.name ?? e.payee ?? "—"} />
        <Row k="Type" v={KIND_LABEL[e.kind]} />
        <Row k="Date of expense" v={fmtDate(e.incurredOn)} />
        <Row k="Due" v={fmtDate(e.dueOn)} />
        <Row k="Payment method" v={e.paymentMethod ? METHOD_LABEL[e.paymentMethod] : "—"} />
        {e.status === "PAID" && <Row k="Paid on · reference" v={`${fmtDate(e.paidAt)} · ${e.paymentRef ?? "no reference"}`} />}
        {e.currency !== "INR" && <Row k="Original amount" v={`${e.currency} ${(e.originalAmount ?? 0) / 100}`} />}
        {e.businessPurpose && <Row k="Business purpose" v={e.businessPurpose} wide />}
        {e.description && <Row k="Details" v={e.description} wide />}
      </dl>
      {e.allocations.length > 0 && (
        <div>
          <h3 className="mb-2 text-[#a1a1a1]" style={h3Style}>How this cost is shared</h3>
          <ul className="space-y-1 text-[13px]">
            {e.allocations.map((a) => (
              <li key={a.id} className="flex justify-between"><span className="text-[#cfcfcf]">{a.startup?.name ?? "Kept by central DevUp"}</span><span className="tabular-nums text-white">{inr(a.amountPaise)}</span></li>
            ))}
          </ul>
        </div>
      )}
      {e.corrections.length > 0 && (
        <div>
          <h3 className="mb-2 text-[#a1a1a1]" style={h3Style}>Corrections</h3>
          <ul className="space-y-1 text-[13px]">
            {e.corrections.map((c) => <li key={c.id} className="flex justify-between gap-3"><span className="text-[#cfcfcf]">{c.number} — {c.notes}</span><span className="tabular-nums">{inr(c.amountPaise)}</span></li>)}
          </ul>
          <p className="mt-1 text-[11.5px] text-[#6b6b6b]">Net after corrections: {inr(e.amountPaise + e.corrections.reduce((s, c) => s + c.amountPaise, 0))}</p>
        </div>
      )}
    </>
  );
}

function ExpenseFiles({ e, canAttach, act, onError }: { e: ExpenseDetail; canAttach: boolean; act: Act; onError: (m: string) => void }) {
  const openFile = async (attId: string) => {
    try {
      const { url } = await financeApi.fileLink(attId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (x: any) {
      onError(x.message);
    }
  };
  return (
    <div>
      <h3 className="mb-2 text-[#a1a1a1]" style={h3Style}>Receipts and proofs</h3>
      {e.attachments.length ? (
        <ul className="space-y-1.5">
          {e.attachments.map((a) => (
            <li key={a.id}>
              <button onClick={() => openFile(a.id)} className="inline-flex items-center gap-2 text-[13px] text-[#c8f135] hover:underline">
                <Paperclip className="h-3.5 w-3.5" />{a.fileName ?? a.kind.toLowerCase()}<ExternalLink className="h-3 w-3" />
              </button>
              <span className="ml-2 text-[11px] text-[#6b6b6b]">{a.kind.replace("_", " ").toLowerCase()} · {Math.round(a.sizeBytes / 1024)} KB</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-[12.5px] text-[#6b6b6b]">No files attached.</p>}
      {canAttach && (
        <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-[12.5px] text-[#a1a1a1] hover:text-white">
          <Paperclip className="h-3.5 w-3.5" />Attach a file
          <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="hidden" onChange={(ev) => {
            const f = ev.target.files?.[0];
            if (f) act(() => financeApi.upload(e.id, f, e.status === "PAID" ? "PAYMENT_PROOF" : "RECEIPT"));
          }} />
        </label>
      )}
    </div>
  );
}

const historyLabel = (action: string) => action.replace("finance.expense.", "").replace("finance.claim.", "claim ").replace(/_/g, " ");

function ExpenseHistory({ e }: { e: ExpenseDetail }) {
  return (
    <details className="rounded-lg border border-white/[0.07] p-3">
      <summary className="flex cursor-pointer items-center gap-2 text-[12.5px] text-[#a1a1a1]"><History className="h-3.5 w-3.5" />History ({e.history.length})</summary>
      <ol className="mt-3 space-y-2 text-[12px]">
        {e.history.map((h, i) => (
          <li key={i} className="text-[#a1a1a1]">
            <span className="text-[#6b6b6b]">{new Date(h.at).toLocaleString("en-IN")}</span> — {historyLabel(h.action)}
            {h.details?.changes && <span className="text-[#6b6b6b]"> ({Object.keys(h.details.changes).join(", ")})</span>}
            {h.details?.reason && <span className="text-[#6b6b6b]"> — {h.details.reason}</span>}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Which buttons to show. The server enforces the same rules; these only hide doors it would refuse. */
function availableActions(e: ExpenseDetail, canManage: boolean, canApprove: boolean) {
  const s = e.status;
  const central = !e.startupId && e.kind !== "ADJUSTMENT";
  return {
    deleteDraft: canManage && s === "DRAFT",
    submit: canManage && ["DRAFT", "NEEDS_INFO", "REJECTED"].includes(s),
    info: canApprove && s === "SUBMITTED",
    reject: canApprove && ["SUBMITTED", "NEEDS_INFO", "APPROVED"].includes(s),
    void: canApprove && !["PAID", "VOID"].includes(s),
    split: canApprove && central && !["VOID", "REJECTED"].includes(s),
    approve: canApprove && ["DRAFT", "SUBMITTED", "NEEDS_INFO"].includes(s),
    pay: canApprove && s === "APPROVED",
    correct: canApprove && s === "PAID" && e.kind !== "ADJUSTMENT",
  };
}

function ExpenseActions({ e, canManage, canApprove, busy, act, open, onDeleted }: { e: ExpenseDetail; canManage: boolean; canApprove: boolean; busy: boolean; act: Act; open: (d: DialogKind) => void; onDeleted: () => void }) {
  const can = availableActions(e, canManage, canApprove);
  return (
    <>
      <div className="flex flex-wrap justify-end gap-2 border-t border-white/5 pt-4">
        {can.deleteDraft && <Button kind="ghost" disabled={busy} onClick={() => act(() => financeApi.deleteDraft(e.id).then(onDeleted))}>Delete draft</Button>}
        {can.submit && <Button disabled={busy} onClick={() => act(() => financeApi.submit(e.id))}>Send for approval</Button>}
        {can.info && <Button disabled={busy} onClick={() => open("info")}>Ask for more info</Button>}
        {can.reject && <Button kind="danger" disabled={busy} onClick={() => open("reject")}>Reject</Button>}
        {can.void && <Button kind="ghost" disabled={busy} onClick={() => open("void")}>Cancel expense</Button>}
        {can.split && <Button disabled={busy} onClick={() => open("split")}><Split className="h-3.5 w-3.5" />Share between startups</Button>}
        {can.approve && <Button kind="primary" disabled={busy} onClick={() => act(() => financeApi.approve(e.id))}>Approve</Button>}
        {can.pay && <Button kind="primary" disabled={busy} onClick={() => open("pay")}>Mark as paid</Button>}
        {can.correct && <Button disabled={busy} onClick={() => open("correct")}>Add a correction</Button>}
      </div>
      {e.status === "PAID" && <p className="text-right text-[11.5px] text-[#6b6b6b]">A paid expense can&apos;t be edited or deleted. Mistakes are fixed with a correction, so the history stays intact.</p>}
    </>
  );
}

function ExpenseDialogs({ e, dialog, busy, act, close }: { e: ExpenseDetail; dialog: DialogKind; busy: boolean; act: Act; close: () => void }) {
  switch (dialog) {
    case "reject":
      return <TextDialog title="Reject this expense" label="Why? The person who added it will see this." cta="Reject" danger busy={busy} onClose={close} onSubmit={(t) => act(() => financeApi.reject(e.id, t))} />;
    case "info":
      return <TextDialog title="Ask for more information" label="What do you need?" cta="Send back" busy={busy} onClose={close} onSubmit={(t) => act(() => financeApi.requestInfo(e.id, t))} />;
    case "void":
      return <TextDialog title="Cancel this expense" label="Why is it being cancelled? It stays on record as cancelled." cta="Cancel expense" danger busy={busy} onClose={close} onSubmit={(t) => act(() => financeApi.voidIt(e.id, t))} />;
    case "pay":
      return <PayDialog e={e} busy={busy} onClose={close} onSubmit={(b) => act(() => financeApi.pay(e.id, b))} />;
    case "correct":
      return <CorrectDialog busy={busy} onClose={close} onSubmit={(b) => act(() => financeApi.correct(e.id, b))} />;
    case "split":
      return <SplitDialog e={e} busy={busy} onClose={close} onSubmit={(b) => act(() => financeApi.split(e.id, b))} />;
    default:
      return null;
  }
}

function Row({ k, v, wide }: { k: string; v: string; wide?: boolean }) {
  return (
    <div className={wide ? "md:col-span-2" : ""}>
      <dt className="text-[11.5px] text-[#6b6b6b]">{k}</dt>
      <dd className="mt-0.5 whitespace-pre-wrap text-[#e4e4e4]">{v}</dd>
    </div>
  );
}

function TextDialog({ title, label, cta, danger, busy, onClose, onSubmit }: { title: string; label: string; cta: string; danger?: boolean; busy: boolean; onClose: () => void; onSubmit: (t: string) => void }) {
  const [t, setT] = useState("");
  return (
    <Modal title={title} onClose={onClose}>
      <Field label={label} required><textarea className={`${inputCls} min-h-[90px]`} value={t} onChange={(e) => setT(e.target.value)} maxLength={1000} /></Field>
      <div className="mt-4 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>Back</Button>
        <Button kind={danger ? "danger" : "primary"} disabled={busy || t.trim().length < 3} onClick={() => onSubmit(t.trim())}>{cta}</Button>
      </div>
    </Modal>
  );
}

function PayDialog({ e, busy, onClose, onSubmit }: { e: Expense; busy: boolean; onClose: () => void; onSubmit: (b: { paidOn: string; paymentMethod?: PaymentMethod; paymentRef?: string }) => void }) {
  const [paidOn, setPaidOn] = useState(today());
  const [method, setMethod] = useState<PaymentMethod | "">(e.paymentMethod ?? "");
  const [ref, setRef] = useState("");
  return (
    <Modal title={`Mark ${inr(e.amountPaise)} as paid`} onClose={onClose}>
      <p className="mb-4 text-[12.5px] text-[#8b8b8b]">This records a payment you've already made in the bank, by UPI or in cash. It doesn't send any money.</p>
      <div className="grid gap-3">
        <Field label="Paid on" required><input type="date" className={inputCls} value={paidOn} max={today()} onChange={(ev) => setPaidOn(ev.target.value)} /></Field>
        <Field label="How"><select className={inputCls} value={method} onChange={(ev) => setMethod(ev.target.value as PaymentMethod)}><option value="">—</option>{(Object.keys(METHOD_LABEL) as PaymentMethod[]).map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select></Field>
        <Field label="Payment reference" hint="UTR, UPI reference or cheque number. Strongly recommended — it's how the payment is traced later."><input className={inputCls} value={ref} onChange={(ev) => setRef(ev.target.value)} /></Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>Back</Button>
        <Button kind="primary" disabled={busy} onClick={() => onSubmit({ paidOn, paymentMethod: method || undefined, paymentRef: ref.trim() || undefined })}>Mark as paid</Button>
      </div>
    </Modal>
  );
}

function CorrectDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (b: { amount: string; reason: string }) => void }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  return (
    <Modal title="Add a correction" onClose={onClose}>
      <p className="mb-4 text-[12.5px] text-[#8b8b8b]">The paid expense stays as it is. A correction records the difference: a negative amount for a refund or overcharge, a positive one for an extra payment.</p>
      <div className="grid gap-3">
        <Field label="Difference (₹)" required hint="For example -500 for a ₹500 refund."><input className={inputCls} inputMode="decimal" value={amount} onChange={(ev) => setAmount(ev.target.value)} placeholder="-500" /></Field>
        <Field label="What happened?" required><textarea className={`${inputCls} min-h-[80px]`} value={reason} onChange={(ev) => setReason(ev.target.value)} /></Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>Back</Button>
        <Button kind="primary" disabled={busy || !amount || reason.trim().length < 3} onClick={() => onSubmit({ amount, reason: reason.trim() })}>Add correction</Button>
      </div>
    </Modal>
  );
}

function SplitDialog({ e, busy, onClose, onSubmit }: { e: ExpenseDetail; busy: boolean; onClose: () => void; onSubmit: (b: { method: string; shares: Array<{ scope: string; percent?: string; amount?: string; units?: string }> }) => void }) {
  const { me } = useFinance();
  const [method, setMethod] = useState<"PERCENT" | "FIXED" | "HEADCOUNT" | "USAGE">("PERCENT");
  const [rows, setRows] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<Set<string>>(new Set(e.allocations.map((a) => a.startupId ?? "central")));
  const targets = [{ id: "central", name: "Kept by central DevUp" }, ...me.startups.map((s) => ({ id: s.id, name: s.name }))];
  const total = Object.entries(rows).filter(([k]) => chosen.has(k)).reduce((s, [, v]) => s + (Number(v) || 0), 0);
  const ok = chosen.size > 0 && (method === "PERCENT" ? Math.abs(total - 100) < 0.001 : method === "FIXED" ? Math.round(total * 100) === e.amountPaise : true);
  const unit = { PERCENT: "%", FIXED: "₹", HEADCOUNT: "", USAGE: "units" }[method];
  return (
    <Modal title={`Share ${inr(e.amountPaise)} between startups`} onClose={onClose} wide>
      <p className="mb-4 text-[12.5px] text-[#8b8b8b]">Charging part of a central cost to startups doesn't change what DevUp spent: the total still counts this bill once. Each startup's page shows its share separately.</p>
      <Field label="How to split">
        <select className={inputCls} value={method} onChange={(ev) => setMethod(ev.target.value as any)}>
          <option value="PERCENT">By percentage</option>
          <option value="FIXED">Fixed amounts</option>
          <option value="HEADCOUNT">By number of people working there now</option>
          <option value="USAGE">By usage (e.g. seats, hours, desks)</option>
        </select>
      </Field>
      <ul className="mt-4 space-y-2">
        {targets.map((t) => (
          <li key={t.id} className="flex items-center gap-3">
            <label className="flex flex-1 items-center gap-2 text-[13px] text-[#cfcfcf]">
              <input type="checkbox" checked={chosen.has(t.id)} onChange={(ev) => { const n = new Set(chosen); ev.target.checked ? n.add(t.id) : n.delete(t.id); setChosen(n); }} />
              {t.name}
            </label>
            {method !== "HEADCOUNT" && chosen.has(t.id) && (
              <div className="flex items-center gap-1.5">
                <input className={`${inputCls} w-28 text-right`} inputMode="decimal" value={rows[t.id] ?? ""} onChange={(ev) => setRows({ ...rows, [t.id]: ev.target.value })} />
                <span className="w-10 text-[12px] text-[#6b6b6b]">{unit}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
      {method === "PERCENT" && <p className={`mt-3 text-[12px] ${ok ? "text-[#6b6b6b]" : "text-amber-300"}`}>Total: {total}% (must be 100%)</p>}
      {method === "FIXED" && <p className={`mt-3 text-[12px] ${ok ? "text-[#6b6b6b]" : "text-amber-300"}`}>Total: ₹{total.toLocaleString("en-IN")} of {inr(e.amountPaise)}</p>}
      {method === "HEADCOUNT" && <p className="mt-3 text-[12px] text-[#6b6b6b]">Uses today's count of active employees and current interns at each startup chosen.</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {e.allocations.length > 0 && <Button kind="ghost" disabled={busy} onClick={() => onSubmit({ method: "PERCENT", shares: [] })}>Remove the split</Button>}
        <Button kind="ghost" onClick={onClose}>Back</Button>
        <Button kind="primary" disabled={busy || !ok} onClick={() => onSubmit({
          method,
          shares: [...chosen].map((s) => ({ scope: s, ...(method === "PERCENT" ? { percent: rows[s] } : method === "FIXED" ? { amount: rows[s] } : method === "USAGE" ? { units: rows[s] } : {}) })),
        })}>Save split</Button>
      </div>
    </Modal>
  );
}
