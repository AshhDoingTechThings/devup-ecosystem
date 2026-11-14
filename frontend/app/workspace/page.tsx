"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Building2, Clock, Info, Plus, ShieldAlert, XCircle, LayoutGrid, MailWarning } from "lucide-react";
import ProtectedContent from "@/components/auth/ProtectedContent";
import StartupLogo from "@/components/StartupLogo";
import StatusBadge from "@/components/workspace/StatusBadge";
import { useAuth } from "@/lib/auth/AuthProvider";
import { affiliationApi, AffiliationItem, MyAffiliations, ROLE_LABEL } from "@/lib/api/affiliation";

/**
 * "Select your workspace" — where everyone lands after signing in.
 *
 * Lists each startup this person is connected to with its real status from
 * the server. Only an ACTIVE membership has an Open button, and even that
 * button just navigates: the destination checks access again on the server.
 * People with no startup connections are sent straight on to their dashboard.
 */
export default function WorkspacePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#0a0a0a]" />}>
      <WorkspaceSelector />
    </Suspense>
  );
}

function WorkspaceSelector() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const [data, setData] = useState<MyAffiliations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(params.get("submitted") ? "Request sent. The startup's admins have been notified." : null);

  const load = useCallback(async () => {
    try {
      const res = await affiliationApi.mine();
      setData(res);
      setError(null);
      // Nothing to choose between: carry on to the normal dashboard.
      if (res.items.length === 0 && !res.isPlatformAdmin && !params.get("stay")) {
        router.replace("/dashboard");
      }
    } catch (e: any) {
      setError(e.message || "Could not load your workspaces.");
    }
  }, [params, router]);

  useEffect(() => {
    if (!authLoading && user) load();
  }, [authLoading, user, load]);

  const withdraw = async (item: AffiliationItem) => {
    if (!item.requestId) return;
    if (!window.confirm(`Withdraw your request to join ${item.startup.name}?`)) return;
    setBusy(item.requestId);
    try {
      await affiliationApi.cancel(item.requestId);
      setNotice("Request withdrawn.");
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const active = data?.items.filter((i) => i.status === "ACTIVE") ?? [];
  const waiting = data?.items.filter((i) => i.status !== "ACTIVE") ?? [];

  return (
    <ProtectedContent blurRadius={12} message="Sign in to choose your workspace">
      <main className="min-h-screen bg-[#0a0a0a] pt-28 pb-24">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6b6b6b]">Workspaces</p>
          <h1 className="mb-2 text-3xl text-white sm:text-4xl" style={{ fontSize: "clamp(30px, 4vw, 36px)", lineHeight: 1.2, fontFamily: "var(--font-syne), sans-serif", fontWeight: 800 }}>
            Select your workspace
          </h1>
          <p className="mb-8 text-sm text-[#a1a1a1]">
            The startups you work with, and where each request stands.
          </p>

          {error && <Banner tone="error">{error}</Banner>}
          {notice && <Banner tone="ok">{notice}</Banner>}

          {data && !data.emailVerified && (
            <div className="mb-6 flex gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-4">
              <MailWarning className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              <p className="text-[13px] leading-relaxed text-amber-100/80">
                Verify your email address before asking to join a startup. Startups only approve people whose address is confirmed.
              </p>
            </div>
          )}

          {!data && !error ? (
            <div className="space-y-3" aria-busy="true">
              {[0, 1].map((i) => (
                <div key={i} className="h-[84px] animate-pulse rounded-2xl border border-white/[0.06] bg-[#111111]" />
              ))}
            </div>
          ) : data ? (
            <div className="space-y-8">
              {data.isPlatformAdmin && (
                <Link
                  href="/admin/startups"
                  className="group flex items-center gap-4 rounded-2xl border border-[#c8f135]/20 bg-[#c8f135]/[0.04] p-5 transition hover:border-[#c8f135]/40"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#c8f135]/10">
                    <LayoutGrid className="h-5 w-5 text-[#c8f135]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-semibold text-white" style={{ fontFamily: "var(--font-syne), sans-serif" }}>
                      Startup management
                    </span>
                    <span className="block text-[12.5px] text-[#a1a1a1]">Every startup, its people and its pending requests.</span>
                  </span>
                  <ArrowRight className="h-4 w-4 text-[#c8f135] transition group-hover:translate-x-0.5" />
                </Link>
              )}

              {active.length > 0 && (
                <section>
                  <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-[#6b6b6b]" style={{ fontSize: 13, lineHeight: 1.4, fontFamily: "var(--font-sans), sans-serif", letterSpacing: "0.08em" }}>Your startups</h2>
                  <ul className="space-y-3">
                    {active.map((item) => (
                      <li key={item.startup.id}>
                        <ActiveRow item={item} />
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {waiting.length > 0 && (
                <section>
                  <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-[#6b6b6b]" style={{ fontSize: 13, lineHeight: 1.4, fontFamily: "var(--font-sans), sans-serif", letterSpacing: "0.08em" }}>Requests</h2>
                  <ul className="space-y-3">
                    {waiting.map((item) => (
                      <li key={item.startup.id}>
                        <StatusCard item={item} busy={busy === item.requestId} onWithdraw={() => withdraw(item)} />
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {data.items.length === 0 && (
                <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center">
                  <Building2 className="mx-auto mb-3 h-8 w-8 text-[#3d3d3d]" />
                  <p className="text-sm text-[#8b8b8b]">You are not connected to any startup yet.</p>
                </div>
              )}

              <div className="flex flex-col gap-3 border-t border-white/[0.06] pt-6 sm:flex-row sm:items-center sm:justify-between">
                <Link
                  href="/workspace/join"
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#c8f135] px-5 py-3 text-sm font-bold text-black transition hover:brightness-110"
                >
                  <Plus className="h-4 w-4" />
                  Join a startup
                </Link>
                <Link href="/dashboard" className="text-center text-[13px] text-[#8b8b8b] transition hover:text-white">
                  Continue to my dashboard →
                </Link>
              </div>
            </div>
          ) : null}
        </div>
      </main>
    </ProtectedContent>
  );
}

function ActiveRow({ item }: { item: AffiliationItem }) {
  const role = ROLE_LABEL[item.role ?? ""] ?? item.role ?? "Member";
  const body = (
    <>
      <StartupLogo src={item.startup.logoUrl} name={item.startup.name} className="h-11 w-11 shrink-0 border border-white/10 text-sm" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold text-white" style={{ fontFamily: "var(--font-syne), sans-serif" }}>
          {item.startup.name}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-[#a1a1a1]">{role}</span>
          <StatusBadge status="ACTIVE" />
        </div>
      </div>
    </>
  );

  if (!item.canEnter || !item.destination) {
    return (
      <div className="flex items-center gap-4 rounded-2xl border border-white/[0.06] bg-[#111111] p-4 opacity-70">
        {body}
        <span className="text-[12px] text-[#6b6b6b]">Startup unavailable</span>
      </div>
    );
  }

  return (
    <Link
      href={item.destination}
      className="group flex items-center gap-4 rounded-2xl border border-white/[0.06] bg-[#111111] p-4 transition hover:border-[#c8f135]/30 hover:bg-[#141414]"
    >
      {body}
      <span className="hidden items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[13px] font-semibold text-white transition group-hover:border-[#c8f135]/40 group-hover:text-[#c8f135] sm:inline-flex">
        Open <ArrowRight className="h-3.5 w-3.5" />
      </span>
      <ArrowRight className="h-4 w-4 text-[#6b6b6b] sm:hidden" />
    </Link>
  );
}

function StatusCard({ item, busy, onWithdraw }: { item: AffiliationItem; busy: boolean; onWithdraw: () => void }) {
  const kind = item.kind === "INTERN" ? "Intern" : item.kind === "EMPLOYEE" ? "Employee" : ROLE_LABEL[item.role ?? ""] ?? "";
  const copy: Record<string, { icon: any; text: string }> = {
    PENDING: { icon: Clock, text: `Waiting for ${item.startup.name} to review your request. You will be notified when they decide.` },
    NEEDS_INFO: { icon: Info, text: `${item.startup.name} needs more information before they can approve you.` },
    REJECTED: { icon: XCircle, text: `${item.startup.name} did not approve this request.` },
    DEACTIVATED: { icon: ShieldAlert, text: `Your access to ${item.startup.name} was deactivated by an administrator. Contact them if this is a mistake.` },
    INVITED: { icon: Info, text: `${item.startup.name} has invited you. Accept the invitation from your email to get access.` },
  };
  const c = copy[item.status] ?? { icon: Info, text: "" };
  const Icon = c.icon;

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#111111] p-4 sm:p-5">
      <div className="flex items-start gap-3 sm:gap-4">
        <StartupLogo src={item.startup.logoUrl} name={item.startup.name} className="h-9 w-9 shrink-0 border border-white/10 text-sm sm:h-11 sm:w-11" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[15px] font-semibold text-white" style={{ fontFamily: "var(--font-syne), sans-serif" }}>
              {item.startup.name}
            </span>
            {kind && <span className="text-[12.5px] text-[#8b8b8b]">· {kind}</span>}
            <StatusBadge status={item.status} />
          </div>
          <p className="mt-2 flex gap-2 text-[13px] leading-relaxed text-[#a1a1a1]">
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[#6b6b6b]" aria-hidden="true" />
            {c.text}
          </p>

          {item.reviewNote && (item.status === "NEEDS_INFO" || item.status === "REJECTED") && (
            <blockquote
              className={`mt-3 rounded-lg border-l-2 px-3 py-2 text-[13px] leading-relaxed ${
                item.status === "NEEDS_INFO" ? "border-sky-400/60 bg-sky-500/[0.06] text-sky-100/90" : "border-red-400/50 bg-red-500/[0.05] text-red-100/80"
              }`}
            >
              <span className="mb-0.5 block text-[10.5px] font-semibold uppercase tracking-wider opacity-70">
                {item.status === "NEEDS_INFO" ? "They asked" : "Reason given"}
              </span>
              {item.reviewNote}
            </blockquote>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {item.status === "NEEDS_INFO" && item.requestId && (
              <Link
                href={`/workspace/join?request=${item.requestId}`}
                className="rounded-lg bg-[#c8f135] px-4 py-2 text-[13px] font-bold text-black transition hover:brightness-110"
              >
                Update my request
              </Link>
            )}
            {(item.status === "REJECTED" || item.status === "DEACTIVATED") && (
              <Link
                href={`/workspace/join?startup=${item.startup.id}`}
                className="rounded-lg border border-white/10 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-white/5"
              >
                Request again
              </Link>
            )}
            {(item.status === "PENDING" || item.status === "NEEDS_INFO") && item.requestId && (
              <button
                type="button"
                onClick={onWithdraw}
                disabled={busy}
                className="rounded-lg border border-white/10 px-4 py-2 text-[13px] text-[#a1a1a1] transition hover:bg-white/5 hover:text-white disabled:opacity-50"
              >
                {busy ? "Withdrawing…" : "Withdraw request"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Banner({ tone, children }: { tone: "error" | "ok"; children: React.ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`mb-5 rounded-lg border p-3 text-sm ${
        tone === "error" ? "border-red-500/20 bg-red-500/10 text-red-300" : "border-[#c8f135]/20 bg-[#c8f135]/10 text-[#c8f135]"
      }`}
    >
      {children}
    </div>
  );
}
