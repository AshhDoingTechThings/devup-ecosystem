"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Bell, Briefcase, CheckCircle2, Download, FileText, ShieldCheck } from "lucide-react";
import ProtectedContent from "@/components/auth/ProtectedContent";
import OnboardingDocRow from "@/components/workspace/OnboardingDocRow";
import { StartupSwitcher, EmploymentDetails } from "@/components/workspace/StartupContext";
import { candidateApi } from "@/lib/api/workspace";
import { api } from "@/lib/api/client";
import { affiliationApi, EmploymentRecord } from "@/lib/api/affiliation";
import DocumentFileLink from "@/components/workspace/DocumentFileLink";

/**
 * The employee's own dashboard: their employment record at one startup, the
 * onboarding documents that startup asks for, the HR documents it issued, and
 * their notifications.
 *
 * Built from the same self-service endpoints as the intern dashboard. There is
 * no employee attendance or work log here because the platform has no
 * self-service version of either for employees yet — nothing unfinished is
 * shown as if it worked.
 */
export default function EmploymentPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#0a0a0a]" />}>
      <Employment />
    </Suspense>
  );
}

function Employment() {
  const requested = useSearchParams().get("startup")?.toUpperCase() ?? null;
  const [records, setRecords] = useState<EmploymentRecord[] | null>(null);
  const [checklists, setChecklists] = useState<any[]>([]);
  const [issued, setIssued] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [e, o, d, n] = await Promise.all([
        affiliationApi.employment(),
        candidateApi.myOnboarding().catch(() => []),
        candidateApi.myDocuments().catch(() => []),
        api.get<{ items: any[] }>("/api/profile/notifications").catch(() => ({ items: [] })),
      ]);
      setRecords(e.filter((r) => r.kind === "EMPLOYEE"));
      setChecklists(o ?? []);
      setIssued(d ?? []);
      setNotifications(n.items ?? []);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Could not load your employment details.");
      setRecords([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const upload = async (personId: string, docType: string, file: File) => {
    setUploading(personId + docType);
    setError(null);
    setNotice(null);
    try {
      await candidateApi.uploadMyDoc(personId, docType, file);
      setNotice("Uploaded — your HR team will review it shortly.");
      await load();
    } catch (e: any) {
      setError(e.message || "Upload failed. Use a PDF or image under 10 MB.");
    } finally {
      setUploading(null);
    }
  };

  const current = records?.find((r) => r.startup.code === requested) ?? records?.[0] ?? null;
  const checklist = current ? checklists.find((l) => l.person?.id === current.personId) : null;
  const docs = current ? issued.filter((d) => d.startup?.code === current.startup.code) : [];
  const news = notifications.slice(0, 6);

  return (
    <ProtectedContent blurRadius={12} message="Sign in to view your employment">
      <main className="min-h-screen bg-[#0a0a0a] pt-28 pb-24">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <Link href="/workspace?stay=1" className="mb-6 inline-block text-sm text-[#c8f135] hover:underline">&larr; My workspaces</Link>
          <h1 className="mb-1 text-3xl text-white" style={{ fontSize: 30, lineHeight: 1.2, fontFamily: "var(--font-syne), sans-serif", fontWeight: 800 }}>My Employment</h1>
          <p className="mb-7 text-sm text-[#a1a1a1]">Your role, your documents, and updates from your team.</p>

          {error && <div role="alert" className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
          {notice && <div role="status" className="mb-4 rounded-lg border border-[#c8f135]/20 bg-[#c8f135]/10 p-3 text-sm text-[#c8f135]">{notice}</div>}

          {!records ? (
            <div className="space-y-3" aria-busy="true">{[0, 1].map((i) => <div key={i} className="h-40 animate-pulse rounded-2xl border border-white/[0.06] bg-[#111111]" />)}</div>
          ) : !current ? (
            <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center">
              <Briefcase className="mx-auto mb-3 h-8 w-8 text-[#3d3d3d]" />
              <p className="text-sm text-[#8b8b8b]">No active employment yet. Once a startup approves you as an employee, it appears here.</p>
              <Link href="/workspace?stay=1" className="mt-4 inline-block text-sm text-[#c8f135] hover:underline">See my requests</Link>
            </div>
          ) : (
            <div className="space-y-6">
              <StartupSwitcher records={records} current={current.startup.code} basePath="/dashboard/employment" />
              <EmploymentDetails record={current} />

              {checklist && (
                <section className="rounded-2xl border border-white/[0.06] bg-[#111111] p-5 sm:p-6" aria-labelledby="onb">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h2 id="onb" className="text-[15px] font-semibold text-white" style={{ fontSize: 15, lineHeight: 1.2, fontFamily: "var(--font-syne), sans-serif" }}>Onboarding documents</h2>
                    {checklist.progress.complete ? (
                      <span className="inline-flex items-center gap-1.5 rounded bg-[#c8f135]/10 px-2.5 py-1 text-[11px] text-[#c8f135]">
                        <CheckCircle2 className="h-3 w-3" /> All verified
                      </span>
                    ) : (
                      <span className="text-[11px] tabular-nums text-[#facc15]">
                        {checklist.progress.requiredApproved}/{checklist.progress.requiredTotal} approved
                      </span>
                    )}
                  </div>
                  <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-white/5">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${checklist.progress.percent}%`, background: checklist.progress.complete ? "#c8f135" : "#facc15" }}
                    />
                  </div>
                  <div className="mb-3 flex gap-2 rounded-lg bg-white/[0.02] p-2.5">
                    <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#8fb6ff]" />
                    <p className="text-[11.5px] leading-relaxed text-[#8b8b8b]">
                      Stored privately. Only {current.startup.name}&apos;s HR team can open them, through links that expire in minutes.
                    </p>
                  </div>
                  <div className="divide-y divide-white/5">
                    {checklist.items.map((item: any) => (
                      <OnboardingDocRow
                        key={item.docType}
                        item={item}
                        personId={checklist.person.id}
                        uploading={uploading === checklist.person.id + item.docType}
                        onUpload={upload}
                      />
                    ))}
                  </div>
                </section>
              )}

              <section className="rounded-2xl border border-white/[0.06] bg-[#111111] p-5 sm:p-6" aria-labelledby="hrdocs">
                <h2 id="hrdocs" className="mb-3 text-[15px] font-semibold text-white" style={{ fontSize: 15, lineHeight: 1.2, fontFamily: "var(--font-syne), sans-serif" }}>HR documents</h2>
                {docs.length === 0 ? (
                  <p className="text-[13px] text-[#6b6b6b]">Letters {current.startup.name} issues to you (offer, appointment, experience) appear here.</p>
                ) : (
                  <ul className="divide-y divide-white/5">
                    {docs.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-3 py-3">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <FileText className="h-4 w-4 shrink-0 text-[#6b6b6b]" />
                          <span className="min-w-0">
                            <span className="block truncate text-[13px] text-[#e4e4e4]">{d.docType.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c: string) => c.toUpperCase())}</span>
                            <span className="block font-mono text-[11px] text-[#6b6b6b]">{d.documentNo}</span>
                          </span>
                        </span>
                        {d.pdfUrl && (
                          <DocumentFileLink docId={d.id} href={d.pdfUrl} scope="me" className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[12px] text-white hover:bg-white/5">
                            <Download className="h-3.5 w-3.5" /> PDF
                          </DocumentFileLink>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="rounded-2xl border border-white/[0.06] bg-[#111111] p-5 sm:p-6" aria-labelledby="news">
                <h2 id="news" className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-white" style={{ fontSize: 15, lineHeight: 1.2, fontFamily: "var(--font-syne), sans-serif" }}>
                  <Bell className="h-4 w-4 text-[#6b6b6b]" /> Notifications
                </h2>
                {news.length === 0 ? (
                  <p className="text-[13px] text-[#6b6b6b]">Nothing new.</p>
                ) : (
                  <ul className="space-y-3">
                    {news.map((n) => (
                      <li key={n.id} className="flex gap-3">
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.isRead ? "bg-white/10" : "bg-[#c8f135]"}`} aria-hidden="true" />
                        <span className="min-w-0">
                          <span className="block text-[13px] text-[#e4e4e4]">{n.title}</span>
                          <span className="block text-[12px] text-[#8b8b8b]">{n.message}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>
      </main>
    </ProtectedContent>
  );
}
