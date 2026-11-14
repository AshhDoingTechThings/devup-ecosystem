"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Building2, Clock, GraduationCap, Search, ShieldOff, UserCheck, Users } from "lucide-react";
import ProtectedContent from "@/components/auth/ProtectedContent";
import StartupLogo from "@/components/StartupLogo";
import { platformAffiliationApi } from "@/lib/api/affiliation";

/**
 * Startup management — every startup on DevUp with its real head-counts.
 *
 * Platform admins only: the API refuses anyone else (startup founders and
 * admins included). Opening a startup goes to that startup's own requests
 * screen, which a platform admin may enter for any startup.
 */
export default function StartupManagementPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyPending, setOnlyPending] = useState(false);

  useEffect(() => {
    platformAffiliationApi
      .overview()
      .then(setData)
      .catch((e) => (e.status === 403 ? setForbidden(true) : setError(e.message || "Could not load startups.")));
  }, []);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.items ?? [])
      .filter((s: any) => !q || [s.name, s.code].some((v) => String(v ?? "").toLowerCase().includes(q)))
      .filter((s: any) => !onlyPending || s.pending > 0)
      .sort((a: any, b: any) => b.pending - a.pending || a.name.localeCompare(b.name));
  }, [data, query, onlyPending]);

  return (
    <ProtectedContent blurRadius={12} message="Sign in as a platform admin">
      <main className="min-h-screen bg-[#0a0a0a] pt-28 pb-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6b6b6b]">Platform admin</p>
          <h1 className="text-3xl text-white" style={{ fontSize: 30, lineHeight: 1.2, fontFamily: "var(--font-syne), sans-serif", fontWeight: 800 }}>
            Startup management
          </h1>
          <p className="mb-8 mt-1 text-sm text-[#8b8b8b]">Employees, interns and pending requests across every startup.</p>

          {forbidden ? (
            <div className="flex flex-col items-center rounded-2xl border border-white/[0.06] bg-[#111111] p-12 text-center">
              <ShieldOff className="mb-3 h-9 w-9 text-[#3d3d3d]" />
              <p className="text-white">Platform admins only</p>
              <p className="mt-1 text-sm text-[#6b6b6b]">Startup admins manage their own team from their workspace.</p>
              <Link href="/workspace" className="mt-5 text-sm text-[#c8f135] hover:underline">Go to my workspaces</Link>
            </div>
          ) : error ? (
            <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>
          ) : (
            <>
              <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat icon={UserCheck} label="Active employees" value={data?.totals.employees} />
                <Stat icon={GraduationCap} label="Active interns" value={data?.totals.interns} />
                <Stat icon={Clock} label="Pending requests" value={data?.totals.pending} accent />
                <Stat icon={Users} label="Active memberships" value={data?.totals.activeMembers} />
              </div>

              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <label className="relative block sm:w-72">
                  <span className="sr-only">Search startups</span>
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6b6b6b]" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search startups"
                    className="w-full rounded-lg border border-white/10 bg-[#111111] py-2 pl-9 pr-3 text-sm text-white placeholder:text-[#6b6b6b] focus:border-[#c8f135]/50 focus:outline-none"
                  />
                </label>
                <label className="flex items-center gap-2 text-[13px] text-[#a1a1a1]">
                  <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} className="accent-[#c8f135]" />
                  Only startups with pending requests
                </label>
              </div>

              <div className="overflow-hidden rounded-2xl border border-white/[0.06] bg-[#111111]">
                {!data ? (
                  <div className="space-y-2 p-4" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-lg bg-white/[0.03]" />)}</div>
                ) : rows.length === 0 ? (
                  <div className="p-12 text-center text-sm text-[#6b6b6b]">
                    <Building2 className="mx-auto mb-2 h-7 w-7 text-[#3d3d3d]" />
                    No startups match.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[680px] text-left text-sm">
                      <thead className="border-b border-white/[0.06] text-[11px] uppercase tracking-wider text-[#6b6b6b]">
                        <tr>
                          <th className="px-4 py-3 font-medium">Startup</th>
                          <th className="px-4 py-3 text-right font-medium">Employees</th>
                          <th className="px-4 py-3 text-right font-medium">Interns</th>
                          <th className="px-4 py-3 text-right font-medium">Pending</th>
                          <th className="px-4 py-3 text-right font-medium">Active</th>
                          <th className="px-4 py-3 text-right font-medium"><span className="sr-only">Open</span></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.04]">
                        {rows.map((s: any) => (
                          <tr key={s.id} className="hover:bg-white/[0.02]">
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-3">
                                <StartupLogo src={s.logoUrl} name={s.name} className="h-8 w-8 shrink-0 border border-white/10 text-xs" />
                                <div className="min-w-0">
                                  <div className="truncate font-medium text-white">{s.name}</div>
                                  <div className="text-[11.5px] text-[#6b6b6b]">
                                    {s.code ?? "no workspace code"}
                                    {!s.isActive && " · inactive"}
                                    {s.deactivated > 0 && ` · ${s.deactivated} deactivated`}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums text-[#e4e4e4]">{s.employees}</td>
                            <td className="px-4 py-3 text-right tabular-nums text-[#e4e4e4]">{s.interns}</td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              <span className={s.pending > 0 ? "font-semibold text-amber-300" : "text-[#6b6b6b]"}>{s.pending}</span>
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums text-[#e4e4e4]">{s.activeMembers}</td>
                            <td className="px-4 py-3 text-right">
                              {s.code ? (
                                <Link
                                  href={`/s/${s.code}/requests`}
                                  className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-[12.5px] font-semibold text-white transition hover:border-[#c8f135]/40 hover:text-[#c8f135]"
                                >
                                  Manage <ArrowRight className="h-3.5 w-3.5" />
                                </Link>
                              ) : (
                                <span className="text-[11.5px] text-[#6b6b6b]">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <p className="mt-3 text-[11.5px] text-[#6b6b6b]">“Active” counts every active membership, staff included. Employees and interns count current HR records.</p>
            </>
          )}
        </div>
      </main>
    </ProtectedContent>
  );
}

function Stat({ icon: Icon, label, value, accent }: { icon: any; label: string; value?: number; accent?: boolean }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#111111] p-4">
      <Icon className={`mb-2 h-4 w-4 ${accent ? "text-amber-300" : "text-[#6b6b6b]"}`} />
      <div className="text-2xl font-bold tabular-nums text-white" style={{ fontFamily: "var(--font-syne), sans-serif" }}>
        {value ?? "—"}
      </div>
      <div className="text-[12px] text-[#8b8b8b]">{label}</div>
    </div>
  );
}
