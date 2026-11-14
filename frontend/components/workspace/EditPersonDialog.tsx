"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, FileText, X } from "lucide-react";
import { workspaceApi } from "@/lib/api/workspace";
import { joinRequestAdminApi } from "@/lib/api/affiliation";

/**
 * Edit an employee's or intern's record: name, contact, role, dates, pay and
 * mentor/manager. Email stays fixed: it links the record to their DevUp
 * account and workspace seat. Saving sends only the fields that changed.
 *
 * If they have an offer letter and a detail printed on it changed, the server
 * issues a revised letter (new number, old one superseded). The dialog then
 * shows it and offers to email it — nothing is sent without that click.
 */
export default function EditPersonDialog({
  code,
  personId,
  onClose,
  onSaved,
}: {
  code: string;
  personId: string;
  onClose: () => void;
  onSaved: (person: any) => void;
}) {
  const [p, setP] = useState<any>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [initial, setInitial] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Saved record, kept while the letter step is shown. */
  const [result, setResult] = useState<any>(null);
  const [send, setSend] = useState<null | { status: "SENT" | "FAILED"; text: string }>(null);

  useEffect(() => {
    workspaceApi
      .person(code, personId)
      .then((d) => {
        setP(d);
        const f = toForm(d);
        setForm(f);
        setInitial(f);
      })
      .catch((e) => setError(e.message || "Could not load this record."));
  }, [code, personId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Once saved, closing always hands back the saved record so the page refreshes.
  const close = () => (result ? onSaved(result) : onClose());

  const isIntern = p?.kind === "INTERN";
  const set = (k: string) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const changed = Object.keys(form).filter((k) => form[k] !== initial[k]);

  const save = async () => {
    setError(null);
    if (!form.fullName.trim()) return setError("Name can't be empty.");
    if (!form.designation.trim()) return setError("Designation can't be empty.");
    if (isIntern && form.startDate && form.endDate && form.endDate <= form.startDate) {
      return setError("The end date must be after the start date.");
    }
    const body: Record<string, unknown> = {};
    for (const k of changed) {
      const v = form[k];
      if (k === "stipendAmount") body[k] = v.trim() === "" ? null : Math.round(Number(v));
      else if (k === "supervisorUserId") body[k] = v || null;
      else body[k] = v;
    }
    if (body.stipendAmount !== undefined && body.stipendAmount !== null && !Number.isFinite(body.stipendAmount as number)) {
      return setError("Monthly stipend must be a number.");
    }
    setBusy(true);
    try {
      const updated = await workspaceApi.updatePerson(code, personId, body);
      if (updated.letter) {
        setResult(updated);
        setBusy(false);
      } else onSaved(updated);
    } catch (e: any) {
      setError(e.status === 403 ? "Only HR, admins and founders can edit team records." : e.message || "Could not save.");
      setBusy(false);
    }
  };

  const letter = result?.letter;
  const sendLetter = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await joinRequestAdminApi.retryOffer(code, letter.requestId);
      if (r.status === "SENT") setResult({ ...result, letterSent: true });
      setSend(r.status === "SENT"
        ? { status: "SENT", text: `${r.documentNo} was emailed to ${result.email} with the PDF attached.` }
        : { status: "FAILED", text: r.message || "The letter could not be sent. Try again shortly." });
    } catch (e: any) {
      setSend({ status: "FAILED", text: e.message || "The letter could not be sent." });
    }
    setBusy(false);
  };

  if (result) {
    const canSend = letter.regenerated && send?.status !== "SENT";
    return (
      <div className="fixed inset-0 z-[130] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-labelledby="edit-person-title">
        <button className="absolute inset-0 bg-black/70" aria-label="Close" onClick={() => !busy && close()} />
        <div className="relative w-full max-w-xl rounded-t-2xl border border-white/10 bg-[#0d0d0d] shadow-2xl sm:rounded-2xl">
          <header className="flex items-start justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
            <h2 id="edit-person-title" className="text-white" style={{ fontSize: 18, lineHeight: 1.2, fontWeight: 700, fontFamily: "var(--font-syne), sans-serif" }}>
              Details saved
            </h2>
            <button onClick={close} disabled={busy} className="rounded-lg p-1.5 text-[#8b8b8b] hover:bg-white/5 hover:text-white" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </header>
          <div className="space-y-3 px-5 py-4 text-sm text-[#c4c4c4]">
            {letter.regenerated ? (
              <div className="rounded-lg border border-[#c8f135]/20 bg-[#c8f135]/[0.04] p-3">
                <div className="mb-1 flex items-center gap-2 text-white"><FileText className="h-4 w-4 text-[#c8f135]" /> Offer letter regenerated</div>
                <div className="font-mono text-white">{letter.documentNo}</div>
                <div className="mt-1 text-[12.5px] text-[#8b8b8b]">
                  Replaces <span className="font-mono">{letter.previousDocumentNo}</span>, which is now marked superseded. It has not been emailed yet.
                </div>
                {letter.message && <div className="mt-2 text-[12.5px] text-amber-200/90">{letter.message} Sending will try the file again.</div>}
              </div>
            ) : (
              <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[13px] text-amber-200">
                The offer letter was not regenerated. {letter.message}
              </div>
            )}
            {send && (
              <div role="status" className={`flex items-start gap-2 rounded-lg border p-3 text-[13px] ${send.status === "SENT" ? "border-[#c8f135]/20 bg-[#c8f135]/10 text-[#c8f135]" : "border-red-500/20 bg-red-500/10 text-red-300"}`}>
                {send.status === "SENT" && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />} {send.text}
              </div>
            )}
          </div>
          <footer className="flex flex-col-reverse gap-2 border-t border-white/[0.06] p-4 sm:flex-row sm:items-center sm:justify-end">
            <button onClick={close} disabled={busy} className="rounded-lg border border-white/10 px-4 py-2.5 text-sm text-[#a1a1a1] hover:bg-white/5">
              {send?.status === "SENT" || !letter.regenerated ? "Done" : "Send later"}
            </button>
            {canSend && (
              <button onClick={sendLetter} disabled={busy} className="rounded-lg bg-[#c8f135] px-4 py-2.5 text-sm font-bold text-black transition hover:brightness-110 disabled:opacity-50">
                {busy ? "Sending…" : send?.status === "FAILED" ? "Try again" : `Email it to ${result.email}`}
              </button>
            )}
          </footer>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[130] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-labelledby="edit-person-title">
      <button className="absolute inset-0 bg-black/70" aria-label="Close" onClick={() => !busy && onClose()} />
      <div className="relative flex max-h-[92vh] w-full max-w-xl flex-col rounded-t-2xl border border-white/10 bg-[#0d0d0d] shadow-2xl sm:rounded-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
          <div className="min-w-0">
            <h2 id="edit-person-title" className="truncate text-white" style={{ fontSize: 18, lineHeight: 1.2, fontWeight: 700, fontFamily: "var(--font-syne), sans-serif" }}>
              Edit {isIntern ? "intern" : p ? "employee" : ""} details
            </h2>
            {p && <p className="mt-0.5 truncate font-mono text-[#8b8b8b]" style={{ fontSize: 12, lineHeight: 1.4 }}>{p.code}</p>}
          </div>
          <button onClick={onClose} disabled={busy} className="rounded-lg p-1.5 text-[#8b8b8b] hover:bg-white/5 hover:text-white" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {error && <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
          {!p ? (
            !error && <div className="space-y-2" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded bg-white/[0.03]" />)}</div>
          ) : (
            <>
              <Group title="Person">
                <Field label="Full name" value={form.fullName} onChange={set("fullName")} required />
                <Field label="Phone" value={form.phone} onChange={set("phone")} type="tel" />
                <div className="sm:col-span-2">
                  <span className="mb-1 block text-[12px] text-[#a1a1a1]">Email</span>
                  <div className="truncate rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm text-[#8b8b8b]">{p.email}</div>
                  <span className="mt-1 block text-[11px] text-[#6b6b6b]">Fixed: it links this record to their DevUp account.</span>
                </div>
                {isIntern && <div className="sm:col-span-2"><Field label="College" value={form.college} onChange={set("college")} /></div>}
              </Group>

              <Group title="Role">
                <Field label="Designation" value={form.designation} onChange={set("designation")} required />
                <Field label="Department" value={form.department} onChange={set("department")} />
                {!isIntern && (
                  <Select label="Employment type" value={form.employmentType} onChange={set("employmentType")}
                    options={[["FULL_TIME", "Full-time"], ["PART_TIME", "Part-time"], ["CONTRACT", "Contract"], ["INTERNSHIP", "Internship"]]} />
                )}
                <Select
                  label={isIntern ? "Mentor" : "Manager"}
                  value={form.supervisorUserId}
                  onChange={set("supervisorUserId")}
                  options={[
                    ["", "Not assigned"],
                    ...(p.supervisors ?? []).map((s: any) => [s.userId, `${s.name} · ${String(s.role).toLowerCase()}`] as [string, string]),
                    // Keep a current mentor who is no longer an active member visible.
                    ...(initial.supervisorUserId && !(p.supervisors ?? []).some((s: any) => s.userId === initial.supervisorUserId)
                      ? [[initial.supervisorUserId, "Current (no longer active)"] as [string, string]]
                      : []),
                  ]}
                />
              </Group>

              <Group title={isIntern ? "Internship" : "Employment"}>
                {isIntern ? (
                  <>
                    <Field label="Start date" type="date" value={form.startDate} onChange={set("startDate")} />
                    <Field label="End date" type="date" value={form.endDate} onChange={set("endDate")} />
                    <Field label="Stipend (as printed)" value={form.stipend} onChange={set("stipend")} placeholder="Rs 10,000/month" />
                    <Field label="Monthly stipend (₹, for payouts)" value={form.stipendAmount} onChange={set("stipendAmount")} type="number" />
                  </>
                ) : (
                  <>
                    <Field label="Joining date" type="date" value={form.joinedAt} onChange={set("joinedAt")} />
                    <Field label="Annual CTC (as printed)" value={form.ctc} onChange={set("ctc")} />
                  </>
                )}
              </Group>
              {p.offerLetter && (
                <Group title="Offer letter">
                  <Select label="Work mode" value={form.workMode} onChange={set("workMode")} options={[["OFFICE", "Office"], ["HYBRID", "Hybrid"], ["REMOTE", "Remote"]]} />
                  <Field label="Work location" value={form.location} onChange={set("location")} />
                  <div className="sm:col-span-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-[#8b8b8b]" style={{ fontSize: 12, lineHeight: 1.5 }}>
                    Current letter <span className="font-mono text-[#c4c4c4]">{p.offerLetter.documentNo}</span>. Changing anything printed on it (name, role, dates, pay, {isIntern ? "mentor" : "manager"}, work mode or location) issues a revised letter with a new number. You choose when to email it.
                  </div>
                </Group>
              )}
              <p className="text-[#6b6b6b]" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
                Access is changed with Deactivate / Reactivate.
              </p>
            </>
          )}
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-white/[0.06] p-4 sm:flex-row sm:items-center sm:justify-end">
          <button onClick={onClose} disabled={busy} className="rounded-lg border border-white/10 px-4 py-2.5 text-sm text-[#a1a1a1] hover:bg-white/5">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!p || busy || changed.length === 0}
            className="rounded-lg bg-[#c8f135] px-4 py-2.5 text-sm font-bold text-black transition hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "Saving…" : changed.length ? `Save ${changed.length} change${changed.length === 1 ? "" : "s"}` : "No changes"}
          </button>
        </footer>
      </div>
    </div>
  );
}

const day = (d?: string | null) => (d ? String(d).slice(0, 10) : "");

function toForm(p: any): Record<string, string> {
  const base = {
    fullName: p.fullName ?? "",
    phone: p.phone ?? "",
    designation: p.designation ?? "",
    department: p.department ?? "",
    supervisorUserId: p.managerId ?? "",
  };
  const letter: Record<string, string> = p.offerLetter ? { workMode: p.offerLetter.workMode ?? "OFFICE", location: p.offerLetter.location ?? "" } : {};
  return p.kind === "INTERN"
    ? { ...letter, ...base, college: p.college ?? "", startDate: day(p.joinedAt), endDate: day(p.endDate), stipend: p.stipend ?? "", stipendAmount: p.stipendAmount == null ? "" : String(p.stipendAmount) }
    : { ...letter, ...base, employmentType: p.employmentType ?? "FULL_TIME", joinedAt: day(p.joinedAt), ctc: p.ctc ?? "" };
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={title}>
      <h3 className="mb-2 text-[11px] font-semibold uppercase text-[#6b6b6b]" style={{ fontSize: 11, lineHeight: 1.4, letterSpacing: "0.08em" }}>{title}</h3>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", required, placeholder }: { label: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean; placeholder?: string }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[12px] text-[#a1a1a1]">{label}{required && <span className="text-[#c8f135]"> *</span>}</span>
      <input
        type={type}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        min={type === "number" ? 0 : undefined}
        className="w-full rounded-lg border border-white/10 bg-[#0a0a0a] px-3 py-2 text-sm text-white placeholder:text-[#4a4a4a] [color-scheme:dark] focus:border-[#c8f135]/50 focus:outline-none"
      />
    </label>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[12px] text-[#a1a1a1]">{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/10 bg-[#0a0a0a] px-3 py-2 text-sm text-white focus:border-[#c8f135]/50 focus:outline-none"
      >
        {options.map(([v, t]) => <option key={v || "none"} value={v}>{t}</option>)}
      </select>
    </label>
  );
}
