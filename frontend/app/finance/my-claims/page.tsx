"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Paperclip, Plus } from "lucide-react";
import { Category, financeApi, inr, today } from "@/lib/api/finance";
import { Button, Empty, ErrorNote, Field, Modal, PageHeader, StatusPill, inputCls, useFinance } from "@/components/finance/ui";

type Claim = Awaited<ReturnType<typeof financeApi.myClaims>>[number];

/** Money a team member spent for their startup and wants back. Only their own claims are shown. */
export default function MyClaimsPage() {
  const { me } = useFinance();
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => financeApi.myClaims().then(setClaims).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  if (!me.claimStartups.length) return <Empty title="Claims are for people working at a startup">You don't have an active employee, intern or team role at any startup.</Empty>;

  return (
    <>
      <PageHeader title="My expense claims" sub="Spent your own money on something for your startup? Claim it here with the receipt. DevUp's CFO reviews every claim.">
        <Button kind="primary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" />New claim</Button>
      </PageHeader>
      <ErrorNote message={error} />
      {!claims ? <div className="h-32 animate-pulse rounded-xl bg-white/[0.03]" /> : claims.length === 0 ? (
        <Empty title="No claims yet">Your claims and their status will appear here.</Empty>
      ) : (
        <ul className="space-y-2">
          {claims.map((c) => (
            <li key={c.id} className="rounded-xl border border-white/[0.07] bg-[#0f0f0f] p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] text-[#e4e4e4]">{c.title}</div>
                  <div className="text-[11.5px] text-[#6b6b6b]">{c.number} · {c.startup.name} · {c.category.name} · {new Date(c.incurredOn).toLocaleDateString("en-IN", { timeZone: "UTC" })}</div>
                </div>
                <StatusPill status={c.status} />
                <span className="w-28 text-right text-[15px] font-semibold tabular-nums text-white">{inr(c.amountPaise)}</span>
              </div>
              {c.reviewNote && ["NEEDS_INFO", "REJECTED"].includes(c.status) && (
                <div className="mt-3 rounded-lg border border-orange-400/20 bg-orange-400/[0.06] p-3 text-[12.5px] text-orange-100">From finance: {c.reviewNote}</div>
              )}
              {c.status === "PAID" && <div className="mt-2 text-[12px] text-[#8b8b8b]">Paid {c.paidAt ? new Date(c.paidAt).toLocaleDateString("en-IN") : ""}{c.paymentRef ? ` · reference ${c.paymentRef}` : ""}</div>}
              {["DRAFT", "SUBMITTED", "NEEDS_INFO", "REJECTED"].includes(c.status) && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[12.5px] text-[#cfcfcf] hover:bg-white/5">
                    <Paperclip className="h-3.5 w-3.5" />{busy === `f${c.id}` ? "Uploading…" : "Attach receipt"}
                    <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="hidden" onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) run(`f${c.id}`, () => financeApi.upload(c.id, f, "RECEIPT", true));
                    }} />
                  </label>
                  {["DRAFT", "NEEDS_INFO", "REJECTED"].includes(c.status) && (
                    <Button disabled={busy === c.id} onClick={() => run(c.id, () => financeApi.resubmitClaim(c.id))}>{c.status === "DRAFT" ? "Send for approval" : "Send again"}</Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && <ClaimForm onClose={() => setAdding(false)} onSaved={load} />}
    </>
  );
}

function ClaimForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { me } = useFinance();
  const [categories, setCategories] = useState<Category[]>([]);
  const [f, setF] = useState({ scope: me.claimStartups[0]?.id ?? "", title: "", categoryId: "", amount: "", incurredOn: today(), businessPurpose: "", payee: "" });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { financeApi.categories().then(setCategories).catch(() => {}); }, []);
  const groups = useMemo(() => {
    const m = new Map<string, Category[]>();
    for (const c of categories) if (c.group !== "People") m.set(c.group, [...(m.get(c.group) ?? []), c]);
    return [...m.entries()];
  }, [categories]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const c = await financeApi.submitClaim({ ...f, payee: f.payee || null });
      if (file) await financeApi.upload(c.id, file, "RECEIPT", true).catch((e) => { throw new Error(`Claim ${c.number} was sent, but the receipt didn't upload: ${e.message}. Attach it from the list.`); });
      onSaved(); onClose();
    } catch (e: any) { setError(e.message); onSaved(); } finally { setBusy(false); }
  };

  return (
    <Modal title="Claim an expense" onClose={onClose}>
      <div className="grid gap-3">
        {me.claimStartups.length > 1 && (
          <Field label="For which startup?" required>
            <select className={inputCls} value={f.scope} onChange={set("scope")}>{me.claimStartups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </Field>
        )}
        <Field label="What did you pay for?" required><input className={inputCls} value={f.title} onChange={set("title")} placeholder="e.g. Cab to client meeting" /></Field>
        <Field label="Category" required>
          <select className={inputCls} value={f.categoryId} onChange={set("categoryId")}>
            <option value="">Choose…</option>
            {groups.map(([g, cs]) => <optgroup key={g} label={g}>{cs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>)}
          </select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount (₹)" required><input className={inputCls} inputMode="decimal" value={f.amount} onChange={set("amount")} /></Field>
          <Field label="Date" required><input type="date" className={inputCls} max={today()} value={f.incurredOn} onChange={set("incurredOn")} /></Field>
        </div>
        <Field label="Why was it needed?" required hint="A sentence is enough — what it was for and who it helped."><textarea className={`${inputCls} min-h-[70px]`} value={f.businessPurpose} onChange={set("businessPurpose")} /></Field>
        <Field label="Paid to"><input className={inputCls} value={f.payee} onChange={set("payee")} placeholder="Shop, cab company…" /></Field>
        <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-white/15 px-3 py-3 text-[13px] text-[#a1a1a1] hover:border-white/30">
          <Paperclip className="h-4 w-4" />{file ? file.name : "Attach the receipt (photo or PDF)"}
          <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      <div className="mt-3"><ErrorNote message={error} /></div>
      <div className="mt-4 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button kind="primary" disabled={busy || !f.title.trim() || !f.categoryId || !f.amount || f.businessPurpose.trim().length < 3} onClick={save}>{busy ? "Sending…" : "Send claim"}</Button>
      </div>
    </Modal>
  );
}
