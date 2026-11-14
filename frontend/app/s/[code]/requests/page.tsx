"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, Clock, GraduationCap, History, Mail, ShieldOff, UserCheck, X, XCircle, Info, Search } from "lucide-react";
import StatusBadge from "@/components/workspace/StatusBadge";
import { joinRequestAdminApi } from "@/lib/api/affiliation";

/**
 * Employee & intern requests for one startup.
 *
 * Every list comes from this startup's own endpoints (/api/w/:code/…), which
 * the server scopes to the startup and to HR-or-above. A platform admin opens
 * this same screen for any startup from Startup management.
 */

type Tab = "pending" | "approved" | "employees" | "interns" | "rejected" | "deactivated";

const TABS: Array<{ key: Tab; label: string; icon: any }> = [
  { key: "pending", label: "Pending", icon: Clock },
  { key: "approved", label: "Approved", icon: CheckCircle2 },
  { key: "employees", label: "Active employees", icon: UserCheck },
  { key: "interns", label: "Active interns", icon: GraduationCap },
  { key: "rejected", label: "Rejected", icon: XCircle },
  { key: "deactivated", label: "Deactivated", icon: ShieldOff },
];

const fmt = (d?: string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");

export default function JoinRequestsPage() {
  const { code } = useParams<{ code: string }>();
  const [tab, setTab] = useState<Tab>("pending");
  const [requests, setRequests] = useState<any[] | null>(null);
  const [summary, setSummary] = useState<any>(null);
  const [people, setPeople] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<"ok" | "warn">("ok");
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([joinRequestAdminApi.list(code, "ALL"), joinRequestAdminApi.affiliates(code)]);
      setRequests(r.items);
      setSummary(r.summary);
      setPeople(p);
      setError(null);
    } catch (e: any) {
      if (e.status === 403) setForbidden(true);
      else setError(e.message || "Could not load requests.");
    }
  }, [code]);

  useEffect(() => { load(); }, [load]);

  const personAction = async (person: any, action: "deactivate" | "reactivate") => {
    if (action === "deactivate") {
      const reason = window.prompt(`Deactivate ${person.fullName}? They lose access straight away. Add a reason (optional):`, "");
      if (reason === null) return;
      try {
        await joinRequestAdminApi.deactivate(code, person.id, reason || undefined);
        setNoticeTone("ok"); setNotice(`${person.fullName} was deactivated.`);
      } catch (e: any) {
        setError(e.message);
      }
    } else {
      if (!window.confirm(`Reactivate ${person.fullName}? Their access returns immediately.`)) return;
      try {
        await joinRequestAdminApi.reactivate(code, person.id);
        setNoticeTone("ok"); setNotice(`${person.fullName} was reactivated.`);
      } catch (e: any) {
        setError(e.message);
      }
    }
    load();
  };

  const q = query.trim().toLowerCase();
  const match = (x: any) => !q || [x.fullName, x.email, x.designation, x.department, x.code].some((v) => String(v ?? "").toLowerCase().includes(q));

  const rows = useMemo(() => {
    if (!requests || !people) return [];
    if (tab === "pending") return requests.filter((r) => r.status === "PENDING" || r.status === "NEEDS_INFO").filter(match);
    if (tab === "rejected") return requests.filter((r) => r.status === "REJECTED").filter(match);
    if (tab === "approved") return requests.filter((r) => r.status === "APPROVED").filter(match);
    if (tab === "deactivated") return people.filter((p) => p.access === "DEACTIVATED").filter(match);
    const kind = tab === "employees" ? "EMPLOYEE" : "INTERN";
    return people.filter((p) => p.kind === kind && p.access !== "DEACTIVATED" && ["ACTIVE", "NOTICE"].includes(p.status)).filter(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, requests, people, q]);

  const counts: Record<Tab, number | undefined> = summary
    ? {
        pending: summary.pending + summary.needsInfo,
        employees: summary.activeEmployees,
        interns: summary.activeInterns,
        approved: summary.approved,
        rejected: summary.rejected,
        deactivated: summary.deactivated,
      }
    : ({} as any);

  if (forbidden) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
        <ShieldOff className="mb-4 h-10 w-10 text-[#3d3d3d]" />
        <h1 className="mb-2 text-xl font-semibold text-white" style={{ fontSize: 20, lineHeight: 1.2, fontFamily: "var(--font-syne), sans-serif" }}>HR and admins only</h1>
        <p className="text-sm text-[#6b6b6b]">Ask a founder or admin of this startup if you need to review team requests.</p>
      </div>
    );
  }

  const isRequestTab = tab === "pending" || tab === "rejected" || tab === "approved";

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 md:py-10">
      <h1 className="text-2xl text-white sm:text-3xl" style={{ fontSize: "clamp(24px, 4vw, 30px)", lineHeight: 1.2, fontFamily: "var(--font-syne), sans-serif", fontWeight: 800 }}>
        Employee &amp; Intern Requests
      </h1>
      <p className="mb-6 mt-1 text-sm text-[#8b8b8b]">People asking to join this startup, and everyone already on the team.</p>

      {error && <div role="alert" className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
      {notice && (
        <div
          role="status"
          className={`mb-4 rounded-lg border p-3 text-sm ${
            noticeTone === "warn" ? "border-amber-500/30 bg-amber-500/10 text-amber-200" : "border-[#c8f135]/20 bg-[#c8f135]/10 text-[#c8f135]"
          }`}
        >
          {notice}
        </div>
      )}

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div role="tablist" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition ${
                tab === key ? "bg-[#c8f135]/10 text-[#c8f135]" : "text-[#8b8b8b] hover:bg-white/5 hover:text-white"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
              {counts[key] !== undefined && (
                <span className={`rounded-full px-1.5 text-[11px] ${tab === key ? "bg-[#c8f135]/20" : "bg-white/10"}`}>{counts[key]}</span>
              )}
            </button>
          ))}
        </div>
        <label className="relative block lg:w-64">
          <span className="sr-only">Search</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6b6b6b]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email, role"
            className="w-full rounded-lg border border-white/10 bg-[#111111] py-2 pl-9 pr-3 text-sm text-white placeholder:text-[#6b6b6b] focus:border-[#c8f135]/50 focus:outline-none"
          />
        </label>
      </div>

      <div className="overflow-hidden rounded-2xl border border-white/[0.06] bg-[#111111]">
        {!requests || !people ? (
          <div className="space-y-2 p-4" aria-busy="true">
            {[0, 1, 2].map((i) => <div key={i} className="h-12 animate-pulse rounded-lg bg-white/[0.03]" />)}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center text-sm text-[#6b6b6b]">
            {q ? "Nothing matches your search." : tab === "pending" ? "No requests waiting. New ones appear here and in your notifications." : "Nobody here yet."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-white/[0.06] text-[11px] uppercase tracking-wider text-[#6b6b6b]">
                <tr>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">{isRequestTab ? "Requested role" : "Role"}</th>
                  <th className="px-4 py-3 font-medium">{isRequestTab ? "Submitted" : "Since"}</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <div className="font-medium text-white">{r.fullName}</div>
                      <div className="flex items-center gap-1.5 text-[12px] text-[#8b8b8b]">
                        {r.email}
                        {isRequestTab && r.emailVerified && <CheckCircle2 className="h-3 w-3 text-[#c8f135]" aria-label="Verified email" />}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[#c4c4c4]">{r.kind === "INTERN" ? "Intern" : "Employee"}</td>
                    <td className="px-4 py-3 text-[#c4c4c4]">
                      {r.designation || "—"}
                      {r.department && <span className="block text-[12px] text-[#6b6b6b]">{r.department}</span>}
                      {!isRequestTab && r.code && <span className="block font-mono text-[11px] text-[#6b6b6b]">{r.code}</span>}
                    </td>
                    <td className="px-4 py-3 text-[#a1a1a1]">{fmt(isRequestTab ? r.submittedAt : tab === "deactivated" ? r.deactivatedAt : r.startDate)}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={isRequestTab ? r.status : r.access === "DEACTIVATED" ? "DEACTIVATED" : r.access === "NO_ACCOUNT" ? "NO_ACCOUNT" : "ACTIVE"} />
                      {tab === "approved" && r.offerStatus && <LetterBadge status={r.offerStatus} className="mt-1" />}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {isRequestTab ? (
                        <button onClick={() => setOpenId(r.id)} className="rounded-lg border border-white/10 px-3 py-1.5 text-[12.5px] font-semibold text-white transition hover:border-[#c8f135]/40 hover:text-[#c8f135]">
                          {tab === "pending" ? "Review" : "View"}
                        </button>
                      ) : tab === "deactivated" ? (
                        <button onClick={() => personAction(r, "reactivate")} className="rounded-lg border border-white/10 px-3 py-1.5 text-[12.5px] text-white transition hover:bg-white/5">
                          Reactivate
                        </button>
                      ) : (
                        <button onClick={() => personAction(r, "deactivate")} className="rounded-lg border border-red-500/20 px-3 py-1.5 text-[12.5px] text-red-300 transition hover:bg-red-500/10">
                          Deactivate
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="mt-3 text-[11.5px] text-[#6b6b6b]">HR can review requests. Deactivating and reactivating needs an admin or founder.</p>

      {openId && (
        <ReviewDrawer
          code={code}
          id={openId}
          onClose={() => setOpenId(null)}
          onDone={(msg, tone = "ok") => { setOpenId(null); setNoticeTone(tone); setNotice(msg); load(); }}
        />
      )}
    </div>
  );
}

function ReviewDrawer({ code, id, onClose, onDone }: { code: string; id: string; onClose: () => void; onDone: (msg: string, tone?: "ok" | "warn") => void }) {
  const [r, setR] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<null | "approve" | "reject" | "info">(null);
  const [text, setText] = useState("");
  const [approve, setApprove] = useState({ designation: "", department: "", joiningDate: "", endDate: "", supervisorUserId: "", stipend: "", ctc: "", workMode: "OFFICE", location: "" });
  const [sendLetter, setSendLetter] = useState(true);
  const [letterBusy, setLetterBusy] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    joinRequestAdminApi.get(code, id).then((d) => {
      setR(d);
      setApprove({
        designation: d.designation ?? "",
        department: d.department ?? "",
        joiningDate: d.joiningDate ? d.joiningDate.slice(0, 10) : "",
        endDate: d.endDate ? d.endDate.slice(0, 10) : "",
        supervisorUserId: "",
        stipend: "",
        ctc: "",
        workMode: "OFFICE",
        location: "",
      });
      // Interns get their offer letter by default; employees only if asked (as with a direct hire).
      setSendLetter(d.kind === "INTERN");
    }).catch((e) => setError(e.message));
  }, [code, id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const open = r && (r.status === "PENDING" || r.status === "NEEDS_INFO");

  const act = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "approve") {
        const body: Record<string, string | boolean> = { issueOfferLetter: sendLetter };
        const internOnly = ["endDate", "stipend"];
        const employeeOnly = ["ctc"];
        const letterOnly = ["workMode", "location", "stipend", "ctc"];
        for (const [k, v] of Object.entries(approve)) {
          if (!v) continue;
          if (internOnly.includes(k) && r.kind !== "INTERN") continue;
          if (employeeOnly.includes(k) && r.kind === "INTERN") continue;
          if (letterOnly.includes(k) && !sendLetter && k !== "stipend" && k !== "ctc") continue;
          body[k] = v;
        }
        const res = await joinRequestAdminApi.approve(code, id, body);
        if (res.alreadyApproved) onDone("This request was already approved.");
        else if (!res.offer) onDone(`${r.fullName} is now active (${res.code}).`);
        else if (res.offer.status === "SENT") onDone(`${r.fullName} is now active (${res.code}). Offer letter ${res.offer.documentNo} was emailed.`);
        else onDone(`${r.fullName} is now active (${res.code}), but the offer letter was not sent: ${res.offer.message} Open the Approved tab to retry.`, "warn");
      } else if (mode === "reject") {
        await joinRequestAdminApi.reject(code, id, text);
        onDone(`Request from ${r.fullName} was rejected.`);
      } else if (mode === "info") {
        await joinRequestAdminApi.requestInfo(code, id, text);
        onDone(`Asked ${r.fullName} for more information.`);
      }
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  const actionLabel = { approve: "Approve and activate", reject: "Reject request", info: "Send question" } as const;

  return (
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-labelledby="review-title">
      <button className="absolute inset-0 bg-black/60" aria-label="Close" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-lg flex-col border-l border-white/10 bg-[#0d0d0d] shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-white/[0.06] p-5">
          <div className="min-w-0">
            <h2 id="review-title" className="truncate text-lg font-semibold text-white" style={{ fontSize: 18, lineHeight: 1.2, fontFamily: "var(--font-syne), sans-serif" }}>
              {r?.fullName ?? "Request"}
            </h2>
            {r && (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="text-[12.5px] text-[#a1a1a1]">{r.kind === "INTERN" ? "Intern" : "Employee"} request</span>
                <StatusBadge status={r.status} />
              </div>
            )}
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-[#8b8b8b] hover:bg-white/5 hover:text-white" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          {error && <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
          {!r ? (
            <div className="space-y-2" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="h-8 animate-pulse rounded bg-white/[0.03]" />)}</div>
          ) : (
            <>
              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#6b6b6b]" style={{ fontSize: 11, lineHeight: 1.4, fontFamily: "var(--font-sans), sans-serif", letterSpacing: "0.08em" }}>Account</h3>
                <div className="flex items-center gap-2 text-sm text-white">
                  <Mail className="h-4 w-4 text-[#6b6b6b]" />
                  {r.user.email}
                  {r.user.emailVerified ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#c8f135]/10 px-2 py-0.5 text-[11px] font-semibold text-[#c8f135]">
                      <CheckCircle2 className="h-3 w-3" /> Verified
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-300">Not verified</span>
                  )}
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#6b6b6b]" style={{ fontSize: 11, lineHeight: 1.4, fontFamily: "var(--font-sans), sans-serif", letterSpacing: "0.08em" }}>What they submitted</h3>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <Item k="Designation" v={r.designation} />
                  <Item k="Department" v={r.department} />
                  <Item k="Phone" v={r.phone} />
                  {r.kind === "INTERN" && <Item k="College" v={r.college} />}
                  <Item k={r.kind === "INTERN" ? "Start date" : "Joining date"} v={r.joiningDate && fmt(r.joiningDate)} />
                  {r.kind === "INTERN" && <Item k="End date" v={r.endDate && fmt(r.endDate)} />}
                  <Item k="Submitted" v={fmt(r.submittedAt)} />
                </dl>
                {r.note && <p className="mt-3 rounded-lg bg-white/[0.03] p-3 text-[13px] leading-relaxed text-[#c4c4c4]">{r.note}</p>}
              </section>

              {r.user.profile && (
                <section>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#6b6b6b]" style={{ fontSize: 11, lineHeight: 1.4, fontFamily: "var(--font-sans), sans-serif", letterSpacing: "0.08em" }}>DevUp profile</h3>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                    <Item k="Name" v={r.user.profile.name} />
                    <Item k="College" v={r.user.profile.college} />
                    <Item k="Degree" v={[r.user.profile.degree, r.user.profile.branch].filter(Boolean).join(", ")} />
                    <Item k="Graduation" v={r.user.profile.graduationYear} />
                    <Item k="City" v={r.user.profile.city} />
                  </dl>
                </section>
              )}

              {r.person && (
                <section className="rounded-lg border border-[#c8f135]/20 bg-[#c8f135]/[0.04] p-3 text-[13px] text-[#c4c4c4]">
                  Linked {r.person.kind === "INTERN" ? "intern" : "employee"} record <span className="font-mono text-white">{r.person.code}</span> · {r.person.status.toLowerCase()}
                </section>
              )}

              {r.status === "APPROVED" && (
                <section className="rounded-lg border border-white/10 bg-white/[0.02] p-3 text-[13px] text-[#c4c4c4]" aria-label="Offer letter">
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[10.5px] font-semibold uppercase tracking-wider text-[#6b6b6b]">Offer letter</span>
                    {r.offer?.status ? <LetterBadge status={r.offer.status} /> : <span className="text-[11.5px] text-[#6b6b6b]">Not issued</span>}
                  </div>
                  {r.offer?.documentNo && <div className="font-mono text-white">{r.offer.documentNo}</div>}
                  {r.offer?.status === "SENT" && r.offer.sentAt && (
                    <div className="text-[12px] text-[#8b8b8b]">Emailed {new Date(r.offer.sentAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</div>
                  )}
                  {r.offer?.status === "FAILED" && (
                    <p className="mt-1 text-[12.5px] text-amber-200/90">{r.offer.message} <span className="text-[#6b6b6b]">({r.offer.attempts} attempt{r.offer.attempts === 1 ? "" : "s"})</span></p>
                  )}
                  {(r.offer?.status === "FAILED" || !r.offer?.status) && (
                    <button
                      onClick={async () => {
                        if (!window.confirm(r.offer?.documentNo ? `Re-send ${r.offer.documentNo} to ${r.fullName}?` : `Issue and email an offer letter to ${r.fullName}?`)) return;
                        setLetterBusy(true);
                        setError(null);
                        try {
                          await joinRequestAdminApi.retryOffer(code, id);
                        } catch (e: any) {
                          setError(e.message);
                        }
                        try { setR(await joinRequestAdminApi.get(code, id)); } catch { /* keep what we have */ }
                        setLetterBusy(false);
                      }}
                      disabled={letterBusy}
                      className="mt-2 rounded-lg border border-white/15 px-3 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-white/5 disabled:opacity-50"
                    >
                      {letterBusy ? "Sending…" : r.offer?.documentNo ? "Retry sending" : "Issue offer letter"}
                    </button>
                  )}
                </section>
              )}

              {r.reviewNote && (
                <section className="rounded-lg border border-white/10 bg-white/[0.02] p-3 text-[13px] text-[#c4c4c4]">
                  <span className="mb-0.5 block text-[10.5px] font-semibold uppercase tracking-wider text-[#6b6b6b]">
                    {r.status === "NEEDS_INFO" ? "Question sent" : "Reason"}
                  </span>
                  {r.reviewNote}
                </section>
              )}

              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#6b6b6b]" style={{ fontSize: 11, lineHeight: 1.4, fontFamily: "var(--font-sans), sans-serif", letterSpacing: "0.08em" }}>
                  <History className="h-3.5 w-3.5" /> History
                </h3>
                <ol className="space-y-2 border-l border-white/10 pl-4">
                  {r.history.map((h: any, i: number) => (
                    <li key={i} className="text-[12.5px]">
                      <span className="text-white">{HISTORY_LABEL[h.action] ?? h.action}</span>
                      <span className="text-[#6b6b6b]"> · {new Date(h.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}{h.by ? ` · ${h.by}` : ""}</span>
                      {h.note && <span className="block text-[#8b8b8b]">“{h.note}”</span>}
                    </li>
                  ))}
                </ol>
              </section>

              {open && mode === "approve" && (
                <section className="space-y-3 rounded-xl border border-white/10 p-4">
                  <h3 className="text-sm font-semibold text-white" style={{ fontSize: 14, lineHeight: 1.3, fontFamily: "var(--font-sans), sans-serif" }}>Confirm the details on their record</h3>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Input label="Designation" value={approve.designation} onChange={(v) => setApprove({ ...approve, designation: v })} />
                    <Input label="Department" value={approve.department} onChange={(v) => setApprove({ ...approve, department: v })} />
                    <Input type="date" label={r.kind === "INTERN" ? "Start date" : "Joining date"} value={approve.joiningDate} onChange={(v) => setApprove({ ...approve, joiningDate: v })} />
                    {r.kind === "INTERN" && <Input type="date" label="End date" value={approve.endDate} onChange={(v) => setApprove({ ...approve, endDate: v })} />}
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-[12px] text-[#a1a1a1]">{r.kind === "INTERN" ? "Mentor" : "Manager"} (optional)</span>
                    <select
                      value={approve.supervisorUserId}
                      onChange={(e) => setApprove({ ...approve, supervisorUserId: e.target.value })}
                      className="w-full rounded-lg border border-white/10 bg-[#0a0a0a] px-3 py-2 text-sm text-white focus:border-[#c8f135]/50 focus:outline-none"
                    >
                      <option value="">Not assigned</option>
                      {r.supervisors.map((s: any) => (
                        <option key={s.userId} value={s.userId}>{s.name} · {s.role.toLowerCase()}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-start gap-2.5 rounded-lg border border-white/10 bg-white/[0.02] p-3">
                    <input type="checkbox" checked={sendLetter} onChange={(e) => setSendLetter(e.target.checked)} className="mt-0.5 accent-[#c8f135]" />
                    <span className="text-[12.5px] text-[#c4c4c4]">
                      Email the {r.kind === "INTERN" ? "internship " : ""}offer letter now
                      <span className="block text-[11.5px] text-[#6b6b6b]">Generated from your startup&apos;s letterhead and sent to {r.user.email} with the PDF attached.</span>
                    </span>
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {r.kind === "INTERN" ? (
                      <Input label="Stipend (as printed)" value={approve.stipend} onChange={(v) => setApprove({ ...approve, stipend: v })} />
                    ) : (
                      <Input label="CTC (as printed)" value={approve.ctc} onChange={(v) => setApprove({ ...approve, ctc: v })} />
                    )}
                    {sendLetter && (
                      <>
                        <label className="block">
                          <span className="mb-1 block text-[12px] text-[#a1a1a1]">Work mode</span>
                          <select
                            value={approve.workMode}
                            onChange={(e) => setApprove({ ...approve, workMode: e.target.value })}
                            className="w-full rounded-lg border border-white/10 bg-[#0a0a0a] px-3 py-2 text-sm text-white focus:border-[#c8f135]/50 focus:outline-none"
                          >
                            <option value="OFFICE">Office</option>
                            <option value="HYBRID">Hybrid</option>
                            <option value="REMOTE">Remote</option>
                          </select>
                        </label>
                        <Input label="Location" value={approve.location} onChange={(v) => setApprove({ ...approve, location: v })} />
                      </>
                    )}
                  </div>
                  <p className="text-[11.5px] text-[#6b6b6b]">Approving creates their {r.kind === "INTERN" ? "intern" : "employee"} record and opens their dashboard. Their DevUp account role does not change. If the letter cannot be sent, the approval still stands and you can retry from here.</p>
                </section>
              )}

              {open && (mode === "reject" || mode === "info") && (
                <label className="block">
                  <span className="mb-1 block text-[12.5px] text-[#c4c4c4]">
                    {mode === "reject" ? "Reason (shown to them)" : "What do you need from them?"}
                  </span>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={3}
                    maxLength={1000}
                    className="w-full rounded-lg border border-white/10 bg-[#0a0a0a] px-3 py-2 text-sm text-white focus:border-[#c8f135]/50 focus:outline-none"
                  />
                </label>
              )}
            </>
          )}
        </div>

        {open && (
          <footer className="border-t border-white/[0.06] p-4">
            {mode ? (
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button onClick={() => { setMode(null); setText(""); }} className="rounded-lg border border-white/10 px-4 py-2.5 text-sm text-[#a1a1a1] hover:bg-white/5">
                  Back
                </button>
                <button
                  onClick={act}
                  disabled={busy || (mode !== "approve" && text.trim().length < 3)}
                  className={`rounded-lg px-4 py-2.5 text-sm font-bold transition disabled:opacity-50 ${
                    mode === "reject" ? "bg-red-500/90 text-white hover:bg-red-500" : "bg-[#c8f135] text-black hover:brightness-110"
                  }`}
                >
                  {busy ? "Working…" : actionLabel[mode]}
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                <button onClick={() => setMode("approve")} className="rounded-lg bg-[#c8f135] px-3 py-2.5 text-sm font-bold text-black hover:brightness-110">Approve</button>
                <button onClick={() => setMode("info")} className="flex items-center justify-center gap-1.5 rounded-lg border border-white/10 px-3 py-2.5 text-sm text-white hover:bg-white/5">
                  <Info className="h-4 w-4" /> Ask
                </button>
                <button onClick={() => setMode("reject")} className="rounded-lg border border-red-500/25 px-3 py-2.5 text-sm text-red-300 hover:bg-red-500/10">Reject</button>
              </div>
            )}
          </footer>
        )}
      </aside>
    </div>
  );
}

const HISTORY_LABEL: Record<string, string> = {
  "affiliation.requested": "Request submitted",
  "affiliation.resubmitted": "Request submitted again",
  "affiliation.updated": "Request updated",
  "affiliation.info_requested": "More information requested",
  "affiliation.approved": "Approved and activated",
  "affiliation.rejected": "Rejected",
  "affiliation.cancelled": "Withdrawn by requester",
  "affiliation.offer_sent": "Offer letter emailed",
  "affiliation.offer_failed": "Offer letter not sent",
};

function Item({ k, v }: { k: string; v?: string | number | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-[#6b6b6b]">{k}</dt>
      <dd className="truncate text-[#e4e4e4]">{v || "—"}</dd>
    </div>
  );
}

function Input({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] text-[#a1a1a1]">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/10 bg-[#0a0a0a] px-3 py-2 text-sm text-white [color-scheme:dark] focus:border-[#c8f135]/50 focus:outline-none"
      />
    </label>
  );
}

function LetterBadge({ status, className = "" }: { status: string; className?: string }) {
  const tone =
    status === "SENT" ? { t: "Letter sent", c: "bg-[#c8f135]/10 text-[#c8f135] border-[#c8f135]/25" }
    : status === "FAILED" ? { t: "Letter failed", c: "bg-red-500/10 text-red-300 border-red-500/25" }
    : { t: "Sending letter", c: "bg-amber-500/10 text-amber-300 border-amber-500/25" };
  return <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[10.5px] font-semibold ${tone.c} ${className}`}>{tone.t}</span>;
}
