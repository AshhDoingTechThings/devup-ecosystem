"use client";

import { useEffect, useMemo, useState } from "react";
import { Paperclip } from "lucide-react";
import { Category, FinanceMe, financeApi, METHOD_LABEL, PaymentMethod, Vendor, today } from "@/lib/api/finance";
import { Button, ErrorNote, Field, Modal, inputCls, useFinance } from "./ui";

/**
 * Add an expense. Used by the dashboard's quick actions and the expenses page.
 * The server decides everything that matters (who may add where, approval);
 * this form only offers the choices that will be accepted.
 */
export default function ExpenseForm({ onClose, onSaved, presetCategory, presetTitle }: { onClose: () => void; onSaved: () => void; presetCategory?: string; presetTitle?: string }) {
  const { me, scope } = useFinance();
  const manageable = useMemo(() => manageableScopes(me), [me]);

  const [categories, setCategories] = useState<Category[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [f, setF] = useState<FormState>(() => initialForm(scope, manageable, presetTitle));
  const [newVendor, setNewVendor] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paidMode, setPaidMode] = useState(false);

  useEffect(() => {
    financeApi.categories().then((c) => {
      setCategories(c);
      if (presetCategory) {
        const hit = c.find((x) => x.key === presetCategory);
        if (hit) setF((p) => ({ ...p, categoryId: hit.id }));
      }
    }).catch((e) => setError(e.message));
    financeApi.vendors().then(setVendors).catch(() => {});
  }, [presetCategory]);

  const groups = useMemo(() => {
    const m = new Map<string, Category[]>();
    for (const c of categories) m.set(c.group, [...(m.get(c.group) ?? []), c]);
    return [...m.entries()];
  }, [categories]);

  const set: Setter = (k) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  const save = async (action: "draft" | "submit" | "paid") => {
    setBusy(true);
    setError(null);
    try {
      const { created, uploadError } = await saveExpense(f, newVendor, file, action);
      onSaved();
      // The expense is saved even if the file failed; say so plainly rather than losing it.
      if (uploadError) setError(`Saved as ${created.number}, but the file didn't upload: ${uploadError}. Open the expense to try again.`);
      else onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!manageable.length) {
    return (
      <Modal title="Add an expense" onClose={onClose}>
        <p className="text-sm text-[#8b8b8b]">Your finance access is read-only, so you can't add expenses.</p>
      </Modal>
    );
  }

  const ready = isReady(f);

  return (
    <Modal title="Add an expense" onClose={onClose} wide>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Whose cost is it?" required hint="Central DevUp is shared office and operations spending. Choose a startup if only that startup should carry it.">
          <select className={inputCls} value={f.scope} onChange={set("scope")}>
            {manageable.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="What was it?" required>
          <input className={inputCls} value={f.title} onChange={set("title")} placeholder="e.g. October office rent" maxLength={200} />
        </Field>
        <Field label="Category" required hint="What the money was spent on. Used for the charts and budgets.">
          <select className={inputCls} value={f.categoryId} onChange={set("categoryId")}>
            <option value="">Choose…</option>
            {groups.map(([g, cs]) => (
              <optgroup key={g} label={g}>
                {cs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="Amount (₹)" required hint="In rupees, like 1250 or 1250.50. For a foreign bill, enter its value in rupees.">
          <input className={inputCls} inputMode="decimal" value={f.amount} onChange={set("amount")} placeholder="0.00" />
        </Field>
        <Field label="Date of the expense" required>
          <input type="date" className={inputCls} value={f.incurredOn} max={today()} onChange={set("incurredOn")} />
        </Field>
        <Field label="Due date" hint="When the bill must be paid. Leave empty if it's already paid or has no deadline.">
          <input type="date" className={inputCls} value={f.dueOn} onChange={set("dueOn")} />
        </Field>
        <Field label="Paid to (vendor)">
          <VendorField vendors={vendors} vendorId={f.vendorId} newVendor={newVendor} setVendorId={(v) => setF((p) => ({ ...p, vendorId: v }))} setNewVendor={setNewVendor} />
        </Field>
        {!f.vendorId && newVendor === null && (
          <Field label="Or paid to (name)" hint="A person or shop with no vendor record.">
            <input className={inputCls} value={f.payee} onChange={set("payee")} placeholder="e.g. Ravi (housekeeping)" />
          </Field>
        )}
        <Field label="How it's paid">
          <select className={inputCls} value={f.paymentMethod} onChange={set("paymentMethod")}>
            <option value="">Not decided</option>
            {(Object.keys(METHOD_LABEL) as PaymentMethod[]).map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
          </select>
        </Field>
        <Field label="Business purpose" hint="Why DevUp needed this. Helps whoever approves it.">
          <input className={inputCls} value={f.businessPurpose} onChange={set("businessPurpose")} maxLength={1000} />
        </Field>
        <div className="md:col-span-2">
          <Field label="Details / notes">
            <textarea className={`${inputCls} min-h-[70px]`} value={f.description} onChange={set("description")} maxLength={2000} />
          </Field>
        </div>
        <div className="md:col-span-2">
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-white/15 px-3 py-3 text-[13px] text-[#a1a1a1] hover:border-white/30">
            <Paperclip className="h-4 w-4" />
            {file ? `${file.name} (${Math.round(file.size / 1024)} KB)` : "Attach the receipt or bill (photo or PDF, up to 8 MB)"}
            <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        </div>

        {me.isCfo && <PaidSection paidMode={paidMode} setPaidMode={setPaidMode} paidOn={f.paidOn} paymentRef={f.paymentRef} set={set} />}
      </div>

      <div className="mt-4"><ErrorNote message={error} /></div>
      <FormButtons paidMode={paidMode} busy={busy} ready={ready} isCfo={me.isCfo} onCancel={onClose} save={save} />
    </Modal>
  );
}

/** Where this person may add expenses: the CFO anywhere, a finance manager only their startups. */
function manageableScopes(me: FinanceMe) {
  const out: Array<{ value: string; label: string }> = [];
  if (me.isCfo) out.push({ value: "central", label: "Central DevUp operations" });
  const mgr = new Set(me.roles.filter((r) => r.role === "STARTUP_FINANCE_MANAGER").map((r) => r.startupId));
  for (const s of me.startups) if (me.isCfo || mgr.has(s.id)) out.push({ value: s.id, label: s.name });
  return out;
}

type FormState = {
  scope: string; title: string; categoryId: string; amount: string; incurredOn: string; dueOn: string; vendorId: string; payee: string;
  paymentMethod: PaymentMethod | ""; description: string; businessPurpose: string; notes: string; paidOn: string; paymentRef: string;
};

/** Create the expense (and a new vendor first, if one was typed), then upload the file. */
async function saveExpense(f: FormState, newVendor: string | null, file: File | null, action: "draft" | "submit" | "paid") {
  let vendorId = f.vendorId || null;
  if (newVendor?.trim()) vendorId = (await financeApi.createVendor({ name: newVendor.trim() })).id;
  const created = await financeApi.createExpense({
    scope: f.scope, title: f.title, categoryId: f.categoryId, amount: f.amount, incurredOn: f.incurredOn,
    dueOn: f.dueOn || null, vendorId, payee: f.payee || null, paymentMethod: f.paymentMethod || null,
    description: f.description || null, businessPurpose: f.businessPurpose || null, notes: f.notes || null,
    action, ...(action === "paid" ? { paidOn: f.paidOn, paymentRef: f.paymentRef || null } : {}),
  });
  if (!file) return { created, uploadError: null as string | null };
  try {
    await financeApi.upload(created.id, file, action === "paid" ? "PAYMENT_PROOF" : "RECEIPT");
    return { created, uploadError: null as string | null };
  } catch (e: any) {
    return { created, uploadError: e.message as string };
  }
}

function VendorField({ vendors, vendorId, newVendor, setVendorId, setNewVendor }: { vendors: Vendor[]; vendorId: string; newVendor: string | null; setVendorId: (v: string) => void; setNewVendor: (v: string | null) => void }) {
  if (newVendor !== null) {
    return (
      <div className="flex gap-2">
        <input className={inputCls} autoFocus value={newVendor} onChange={(e) => setNewVendor(e.target.value)} placeholder="New vendor name" />
        <Button type="button" kind="ghost" onClick={() => setNewVendor(null)}>Cancel</Button>
      </div>
    );
  }
  return (
    <select className={inputCls} value={vendorId} onChange={(e) => (e.target.value === "__new" ? setNewVendor("") : setVendorId(e.target.value))}>
      <option value="">No vendor / someone else</option>
      {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
      <option value="__new">+ Add a new vendor…</option>
    </select>
  );
}

function initialForm(scope: string, manageable: Array<{ value: string }>, presetTitle?: string): FormState {
  const own = scope !== "all" && manageable.some((m) => m.value === scope);
  return {
    scope: own ? scope : manageable[0]?.value ?? "", title: presetTitle ?? "", categoryId: "", amount: "", incurredOn: today(), dueOn: "",
    vendorId: "", payee: "", paymentMethod: "", description: "", businessPurpose: "", notes: "", paidOn: today(), paymentRef: "",
  };
}

const isReady = (f: FormState) => Boolean(f.scope && f.title.trim().length >= 2 && f.categoryId && f.amount && f.incurredOn);

type Setter = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void;

/** CFO only: record a bill that has already been paid, in one step. */
function PaidSection({ paidMode, setPaidMode, paidOn, paymentRef, set }: { paidMode: boolean; setPaidMode: (v: boolean) => void; paidOn: string; paymentRef: string; set: Setter }) {
  return (
    <div className="md:col-span-2 rounded-lg border border-white/[0.07] bg-white/[0.02] p-3">
      <label className="flex items-center gap-2 text-[13px] text-[#cfcfcf]">
        <input type="checkbox" checked={paidMode} onChange={(e) => setPaidMode(e.target.checked)} />
        This bill is already paid — record it as paid
      </label>
      {paidMode && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Field label="Paid on"><input type="date" className={inputCls} value={paidOn} onChange={set("paidOn")} /></Field>
          <Field label="Payment reference" hint="UTR, UPI reference or cheque number, so the payment can be traced.">
            <input className={inputCls} value={paymentRef} onChange={set("paymentRef")} />
          </Field>
        </div>
      )}
    </div>
  );
}

function FormButtons({ paidMode, busy, ready, isCfo, onCancel, save }: { paidMode: boolean; busy: boolean; ready: boolean; isCfo: boolean; onCancel: () => void; save: (a: "draft" | "submit" | "paid") => void }) {
  const disabled = busy || !ready;
  return (
    <div className="mt-5 flex flex-wrap justify-end gap-2">
      <Button kind="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      {paidMode ? (
        <Button kind="primary" onClick={() => save("paid")} disabled={disabled}>{busy ? "Saving…" : "Record as paid"}</Button>
      ) : (
        <>
          <Button onClick={() => save("draft")} disabled={disabled}>Save as draft</Button>
          <Button kind="primary" onClick={() => save("submit")} disabled={disabled}>{busy ? "Saving…" : isCfo ? "Save for approval" : "Send for approval"}</Button>
        </>
      )}
    </div>
  );
}
