"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Briefcase, Check, GraduationCap, Search, ShieldCheck } from "lucide-react";
import ProtectedContent from "@/components/auth/ProtectedContent";
import StartupLogo from "@/components/StartupLogo";
import StatusBadge from "@/components/workspace/StatusBadge";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  affiliationApi, AffiliationKind, CATEGORY_LABEL, JoinableStartup, JoinRequestInput,
} from "@/lib/api/affiliation";

/**
 * "Which startup are you working with?" — three steps: startup, Intern or
 * Employee, then details. Submitting creates a request and nothing more;
 * access comes only from the startup's approval.
 *
 * ?startup=<id> preselects a startup (from "Request again").
 * ?request=<id> edits an open request (from "Update my request").
 */
export default function JoinStartupPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#0a0a0a]" />}>
      <JoinFlow />
    </Suspense>
  );
}

type Step = 1 | 2 | 3;

const BLOCKING = ["ACTIVE", "PENDING", "NEEDS_INFO", "INVITED"];

function JoinFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const editId = params.get("request");
  const { user, loading: authLoading } = useAuth();

  const [startups, setStartups] = useState<JoinableStartup[] | null>(null);
  const [emailVerified, setEmailVerified] = useState(true);
  const [step, setStep] = useState<Step>(1);
  const [query, setQuery] = useState("");
  const [startupId, setStartupId] = useState<string | null>(params.get("startup"));
  const [kind, setKind] = useState<AffiliationKind | null>(null);
  const [form, setForm] = useState<Omit<JoinRequestInput, "kind">>({ fullName: "" });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (authLoading || !user) return;
    Promise.all([affiliationApi.startups(), affiliationApi.mine()])
      .then(([list, mine]) => {
        setStartups(list);
        setEmailVerified(mine.emailVerified);
        setForm((f) => ({ ...f, fullName: f.fullName || user.name || "" }));

        if (editId) {
          const item = mine.items.find((i) => i.requestId === editId);
          if (!item || !["PENDING", "NEEDS_INFO"].includes(item.status)) {
            setError("That request can no longer be edited.");
            return;
          }
          const d: any = (item as any).details ?? {};
          setStartupId(item.startup.id);
          setKind(item.kind);
          setForm({
            fullName: d.fullName ?? user.name ?? "",
            phone: d.phone ?? "",
            department: item.department ?? "",
            designation: item.designation ?? "",
            college: d.college ?? "",
            joiningDate: d.joiningDate ? String(d.joiningDate).slice(0, 10) : "",
            endDate: d.endDate ? String(d.endDate).slice(0, 10) : "",
            note: d.note ?? "",
          });
          setStep(3);
        } else if (params.get("startup")) {
          setStep(2);
        }
      })
      .catch((e) => setError(e.message || "Could not load startups."));
  }, [authLoading, user, editId, params]);

  const selected = startups?.find((s) => s.id === startupId) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!startups) return [];
    if (!q) return startups;
    return startups.filter((s) =>
      [s.name, s.tagline, s.description, CATEGORY_LABEL[s.category ?? ""] ?? s.category, s.location]
        .some((v) => String(v ?? "").toLowerCase().includes(q))
    );
  }, [startups, query]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const validate = () => {
    const errs: Record<string, string> = {};
    if (!form.fullName || form.fullName.trim().length < 2) errs.fullName = "Enter your full name";
    if (form.phone && !/^[+\d][\d\s-]{6,19}$/.test(form.phone.trim())) errs.phone = "Enter a valid phone number";
    if (kind === "INTERN" && form.joiningDate && form.endDate && form.endDate <= form.joiningDate) {
      errs.endDate = "The end date must be after the start date";
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!startupId || !kind || !validate()) return;
    setSubmitting(true);
    setError(null);
    // Only send what applies; empty strings become "not given".
    const body: JoinRequestInput = { kind, fullName: form.fullName.trim() };
    for (const k of ["phone", "department", "designation", "joiningDate", "note"] as const) {
      const v = (form[k] ?? "").trim();
      if (v) body[k] = v;
    }
    if (kind === "INTERN") {
      if (form.college?.trim()) body.college = form.college.trim();
      if (form.endDate?.trim()) body.endDate = form.endDate.trim();
    }
    try {
      if (editId) await affiliationApi.update(editId, body);
      else await affiliationApi.submit(startupId, body);
      router.push("/workspace?submitted=1&stay=1");
    } catch (err: any) {
      setError(err.message || "Could not send your request.");
      setSubmitting(false);
    }
  };

  return (
    <ProtectedContent blurRadius={12} message="Sign in to join a startup">
      <main className="min-h-screen bg-[#0a0a0a] pt-28 pb-24">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <Link href="/workspace?stay=1" className="mb-6 inline-flex items-center gap-1.5 text-sm text-[#c8f135] hover:underline">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to workspaces
          </Link>

          <Stepper step={step} />

          {error && (
            <div role="alert" className="mb-5 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
              {error}
            </div>
          )}

          {!emailVerified && (
            <div className="mb-5 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-3 text-[13px] text-amber-100/80">
              Your email address is not verified yet, so a request cannot be sent. Use the verification link we emailed you, then come back.
            </div>
          )}

          {step > 1 && startups && !selected && (
            <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-[#8b8b8b]">
              That startup is not open for requests right now.{" "}
              <button type="button" onClick={() => { setStartupId(null); setStep(1); }} className="text-[#c8f135] hover:underline">
                Choose another
              </button>
            </div>
          )}

          {/* ── Step 1: startup ───────────────────────────────── */}
          {step === 1 && (
            <section aria-labelledby="step1">
              <h1 id="step1" className="mb-2 text-3xl text-white" style={{ fontSize: 30, lineHeight: 1.2, fontFamily: "var(--font-syne), sans-serif", fontWeight: 800 }}>
                Which startup are you working with?
              </h1>
              <p className="mb-6 text-sm text-[#a1a1a1]">Choosing one sends a request to its admins. It does not give you access by itself.</p>

              <label className="relative mb-5 block">
                <span className="sr-only">Search startups</span>
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6b6b6b]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name, category or city"
                  className="w-full rounded-xl border border-white/10 bg-[#111111] py-3 pl-10 pr-4 text-sm text-white placeholder:text-[#6b6b6b] focus:border-[#c8f135]/50 focus:outline-none"
                />
              </label>

              {!startups ? (
                <div className="grid gap-3 sm:grid-cols-2" aria-busy="true">
                  {[0, 1, 2, 3].map((i) => <div key={i} className="h-[132px] animate-pulse rounded-2xl border border-white/[0.06] bg-[#111111]" />)}
                </div>
              ) : filtered.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-[#8b8b8b]">
                  {startups.length === 0 ? "No startups are open for requests right now." : `No startup matches “${query}”.`}
                </div>
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2">
                  {filtered.map((s) => {
                    const blocked = s.affiliation && BLOCKING.includes(s.affiliation.status);
                    return (
                      <li key={s.id}>
                        <button
                          type="button"
                          disabled={Boolean(blocked)}
                          onClick={() => { setStartupId(s.id); setStep(2); }}
                          aria-pressed={startupId === s.id}
                          className={`flex h-full w-full flex-col gap-3 rounded-2xl border p-4 text-left transition ${
                            blocked
                              ? "cursor-not-allowed border-white/[0.05] bg-[#0f0f0f] opacity-60"
                              : startupId === s.id
                                ? "border-[#c8f135]/50 bg-[#c8f135]/[0.05]"
                                : "border-white/[0.07] bg-[#111111] hover:border-white/20"
                          }`}
                        >
                          <span className="flex items-center gap-3">
                            <StartupLogo src={s.logoUrl} name={s.name} className="h-10 w-10 shrink-0 border border-white/10 text-sm" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[15px] font-semibold text-white" style={{ fontFamily: "var(--font-syne), sans-serif" }}>
                                {s.name}
                              </span>
                              <span className="block truncate text-[12px] text-[#8b8b8b]">
                                {[CATEGORY_LABEL[s.category ?? ""] ?? s.category, s.location].filter(Boolean).join(" · ")}
                              </span>
                            </span>
                          </span>
                          {(s.tagline || s.description) && (
                            <span className="line-clamp-2 text-[12.5px] leading-relaxed text-[#a1a1a1]">{s.tagline || s.description}</span>
                          )}
                          {s.affiliation && (
                            <span className="flex items-center gap-2">
                              <StatusBadge status={s.affiliation.status} />
                              {blocked && <span className="text-[11.5px] text-[#6b6b6b]">See your workspaces</span>}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          {/* ── Step 2: intern or employee ────────────────────── */}
          {step === 2 && selected && (
            <section aria-labelledby="step2">
              <SelectedStartup s={selected} onChange={() => setStep(1)} />
              <h1 id="step2" className="mb-6 text-2xl text-white sm:text-3xl" style={{ fontSize: "clamp(24px, 4vw, 30px)", lineHeight: 1.2, fontFamily: "var(--font-syne), sans-serif", fontWeight: 800 }}>
                How do you work with {selected.name}?
              </h1>
              <div className="grid gap-3 sm:grid-cols-2">
                {([
                  { k: "INTERN", icon: GraduationCap, title: "Intern", text: "A fixed-term internship. You will see your internship dashboard, attendance and documents." },
                  { k: "EMPLOYEE", icon: Briefcase, title: "Employee", text: "A team member on staff. You will see your employment details and HR documents." },
                ] as const).map(({ k, icon: Icon, title, text }) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => { setKind(k); setStep(3); }}
                    aria-pressed={kind === k}
                    className={`rounded-2xl border p-5 text-left transition ${
                      kind === k ? "border-[#c8f135]/50 bg-[#c8f135]/[0.05]" : "border-white/[0.07] bg-[#111111] hover:border-white/20"
                    }`}
                  >
                    <Icon className="mb-3 h-6 w-6 text-[#c8f135]" />
                    <span className="block text-[16px] font-semibold text-white" style={{ fontFamily: "var(--font-syne), sans-serif" }}>{title}</span>
                    <span className="mt-1 block text-[13px] leading-relaxed text-[#a1a1a1]">{text}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* ── Step 3: details ───────────────────────────────── */}
          {step === 3 && selected && kind && (
            <section aria-labelledby="step3">
              <SelectedStartup s={selected} onChange={editId ? undefined : () => setStep(1)} kind={kind} onKind={editId ? undefined : () => setStep(2)} />
              <h1 id="step3" className="mb-2 text-2xl text-white sm:text-3xl" style={{ fontSize: "clamp(24px, 4vw, 30px)", lineHeight: 1.2, fontFamily: "var(--font-syne), sans-serif", fontWeight: 800 }}>
                {editId ? "Update your request" : "Your details"}
              </h1>
              <p className="mb-6 text-sm text-[#a1a1a1]">
                {selected.name}&apos;s admins see this when they review your request.
              </p>

              <form onSubmit={submit} noValidate className="space-y-5 rounded-2xl border border-white/[0.06] bg-[#111111] p-5 sm:p-6">
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="Full name" required error={fieldErrors.fullName}>
                    <input value={form.fullName} onChange={set("fullName")} autoComplete="name" className={inputCls} />
                  </Field>
                  <Field label="Email" hint="From your account. Startups see this verified address.">
                    <input value={user?.email ?? ""} readOnly aria-readonly="true" className={`${inputCls} cursor-not-allowed text-[#8b8b8b]`} />
                  </Field>
                  <Field label="Phone" error={fieldErrors.phone}>
                    <input value={form.phone ?? ""} onChange={set("phone")} inputMode="tel" autoComplete="tel" placeholder="+91 98765 43210" className={inputCls} />
                  </Field>
                  <Field label="Department">
                    <input value={form.department ?? ""} onChange={set("department")} placeholder="e.g. Engineering" className={inputCls} />
                  </Field>
                  <Field label={kind === "INTERN" ? "Internship role" : "Designation"}>
                    <input value={form.designation ?? ""} onChange={set("designation")} placeholder={kind === "INTERN" ? "e.g. Frontend Intern" : "e.g. Backend Engineer"} className={inputCls} />
                  </Field>
                  {kind === "INTERN" && (
                    <Field label="College">
                      <input value={form.college ?? ""} onChange={set("college")} placeholder="Your college or university" className={inputCls} />
                    </Field>
                  )}
                  <Field label={kind === "INTERN" ? "Start date" : "Joining date"}>
                    <input type="date" value={form.joiningDate ?? ""} onChange={set("joiningDate")} className={`${inputCls} [color-scheme:dark]`} />
                  </Field>
                  {kind === "INTERN" && (
                    <Field label="End date" error={fieldErrors.endDate}>
                      <input type="date" value={form.endDate ?? ""} onChange={set("endDate")} className={`${inputCls} [color-scheme:dark]`} />
                    </Field>
                  )}
                </div>
                <Field label="Anything the admins should know?">
                  <textarea value={form.note ?? ""} onChange={set("note")} rows={3} maxLength={1000} placeholder="e.g. who you report to, or your offer reference" className={`${inputCls} resize-y`} />
                </Field>

                <div className="flex gap-2.5 rounded-xl border border-white/10 bg-white/[0.02] p-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#8fb6ff]" />
                  <p className="text-[11.5px] leading-relaxed text-[#8b8b8b]">
                    Only {selected.name}&apos;s admins and DevUp platform admins can see this request. You get access once they approve it.
                  </p>
                </div>

                <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                  <Link href="/workspace?stay=1" className="rounded-xl border border-white/10 px-5 py-3 text-center text-sm text-[#a1a1a1] transition hover:bg-white/5">
                    Cancel
                  </Link>
                  <button
                    type="submit"
                    disabled={submitting || !emailVerified}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#c8f135] px-6 py-3 text-sm font-bold text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {submitting ? "Sending…" : editId ? "Resubmit request" : "Send request"}
                  </button>
                </div>
              </form>
            </section>
          )}
        </div>
      </main>
    </ProtectedContent>
  );
}

const inputCls =
  "w-full rounded-lg border border-white/10 bg-[#0a0a0a] px-3.5 py-2.5 text-sm text-white placeholder:text-[#555] focus:border-[#c8f135]/50 focus:outline-none";

function Field({ label, required, hint, error, children }: { label: string; required?: boolean; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] font-medium text-[#c4c4c4]">
        {label} {required && <span className="text-[#c8f135]" aria-hidden="true">*</span>}
      </span>
      {children}
      {error ? (
        <span role="alert" className="mt-1 block text-[12px] text-red-300">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[11.5px] text-[#6b6b6b]">{hint}</span>
      ) : null}
    </label>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps = ["Startup", "Type", "Details"];
  return (
    <ol className="mb-8 flex items-center gap-2" aria-label="Progress">
      {steps.map((label, i) => {
        const n = (i + 1) as Step;
        const done = n < step;
        const current = n === step;
        return (
          <li key={label} className="flex flex-1 items-center gap-2" aria-current={current ? "step" : undefined}>
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[12px] font-bold ${
                done ? "border-[#c8f135] bg-[#c8f135] text-black" : current ? "border-[#c8f135] text-[#c8f135]" : "border-white/15 text-[#6b6b6b]"
              }`}
            >
              {done ? <Check className="h-3.5 w-3.5" /> : n}
            </span>
            <span className={`hidden text-[12.5px] sm:inline ${current ? "text-white" : "text-[#6b6b6b]"}`}>{label}</span>
            {i < steps.length - 1 && <span className="h-px flex-1 bg-white/10" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}

function SelectedStartup({ s, onChange, kind, onKind }: { s: JoinableStartup; onChange?: () => void; kind?: AffiliationKind; onKind?: () => void }) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.06] bg-[#111111] p-3">
      <StartupLogo src={s.logoUrl} name={s.name} className="h-9 w-9 shrink-0 border border-white/10 text-sm" />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white">{s.name}</span>
      {kind && (
        <span className="rounded-full border border-white/10 px-2.5 py-0.5 text-[11.5px] text-[#c4c4c4]">
          {kind === "INTERN" ? "Intern" : "Employee"}
          {onKind && <button type="button" onClick={onKind} className="ml-2 text-[#c8f135] hover:underline">change</button>}
        </span>
      )}
      {onChange && (
        <button type="button" onClick={onChange} className="text-[12.5px] text-[#c8f135] hover:underline">
          Change startup
        </button>
      )}
    </div>
  );
}
