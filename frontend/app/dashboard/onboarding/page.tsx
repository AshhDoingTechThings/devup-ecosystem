"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import ProtectedContent from "@/components/auth/ProtectedContent";
import { candidateApi } from "@/lib/api/workspace";
import OnboardingDocRow from "@/components/workspace/OnboardingDocRow";
import StartupLogo from "@/components/StartupLogo";

export default function MyOnboardingPage() {
  const [lists, setLists] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLists(await candidateApi.myOnboarding());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
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

  return (
    <ProtectedContent blurRadius={12} message="Login to view your onboarding">
      <div className="min-h-screen bg-[#0a0a0a] pt-28 pb-24">
        <div className="max-w-3xl mx-auto px-6">
          <Link href="/dashboard" className="text-[#c8f135] text-sm hover:underline mb-6 inline-block">
            &larr; Back to Dashboard
          </Link>

          <h1 className="text-3xl text-white mb-1" style={{ fontFamily: "var(--font-syne)", fontWeight: 800 }}>
            Your Onboarding
          </h1>
          <p className="text-[#a1a1a1] text-sm mb-6">
            Upload the documents your organisation needs. Photos of the originals are fine.
          </p>

          <div className="mb-6 flex gap-2.5 rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <ShieldCheck className="w-4 h-4 text-[#8fb6ff] shrink-0 mt-0.5" />
            <p className="text-[11.5px] leading-relaxed text-[#8b8b8b]">
              Your documents are visible only to the HR team of the organisation you joined.
              They are never shared with other startups or shown on your public profile.
            </p>
          </div>

          {error && <Banner tone="error">{error}</Banner>}
          {notice && <Banner tone="ok">{notice}</Banner>}

          {loading ? (
            <p className="text-[#6b6b6b] text-sm">Loading…</p>
          ) : lists.length === 0 ? (
            <div className="p-10 rounded-2xl border border-dashed border-white/[0.09] text-center">
              <p className="text-[#6b6b6b] text-sm">
                Nothing to upload. This page appears once you have joined a startup.
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {lists.map((l) => (
                <section key={l.person.id} className="rounded-2xl bg-[#111111] border border-white/[0.06] p-6">
                  <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                    <div className="flex items-center gap-3 min-w-0">
                      {l.startup?.logoUrl && (
                        <StartupLogo src={l.startup.logoUrl} name={l.startup.name} className="w-9 h-9 border border-white/10" />
                      )}
                      <div className="min-w-0">
                        <h2 className="text-white text-[15px] font-semibold truncate" style={{ fontFamily: "var(--font-syne)" }}>
                          {l.startup?.name}
                        </h2>
                        <p className="text-[11px] text-[#6b6b6b] tabular-nums">{l.person.code}</p>
                      </div>
                    </div>
                    {l.progress.complete ? (
                      <span className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded" style={{ background: "rgba(200,241,53,0.12)", color: "#c8f135" }}>
                        <CheckCircle2 className="w-3 h-3" /> All verified
                      </span>
                    ) : (
                      <span className="text-[11px] tabular-nums text-[#facc15]">
                        {l.progress.requiredApproved}/{l.progress.requiredTotal} approved
                      </span>
                    )}
                  </div>

                  <div className="h-1.5 rounded-full bg-white/5 overflow-hidden mb-5">
                    <div className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${l.progress.percent}%`, background: l.progress.complete ? "#c8f135" : "#facc15" }} />
                  </div>

                  <div className="divide-y divide-white/5">
                    {l.items.map((item: any) => (
                      <OnboardingDocRow
                        key={item.docType}
                        item={item}
                        personId={l.person.id}
                        uploading={uploading === l.person.id + item.docType}
                        onUpload={upload}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </ProtectedContent>
  );
}

function Banner({ tone, children }: { tone: "error" | "ok"; children: React.ReactNode }) {
  return (
    <div className="mb-4 p-3 rounded-lg border text-sm"
      style={tone === "error"
        ? { background: "rgba(248,113,113,0.08)", borderColor: "rgba(248,113,113,0.2)", color: "#fca5a5" }
        : { background: "rgba(200,241,53,0.06)", borderColor: "rgba(200,241,53,0.2)", color: "#c8f135" }}>
      {children}
    </div>
  );
}
