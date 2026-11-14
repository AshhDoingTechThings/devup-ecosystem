"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Building2 } from "lucide-react";
import { affiliationApi, MyAffiliations } from "@/lib/api/affiliation";

/**
 * "Join your startup workspace" — always on the dashboard.
 *
 * Rendered straight away, before (and regardless of) the membership request:
 * the button must never wait on the API, and sign-in never waits on this card.
 * When the user's workspaces arrive, a summary and a link to them are added.
 */
export default function AffiliationCard() {
  const [data, setData] = useState<MyAffiliations | null>(null);

  useEffect(() => {
    let cancelled = false;
    affiliationApi
      .mine()
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { /* the join button works without it */ });
    return () => { cancelled = true; };
  }, []);

  const active = data?.items.filter((i) => i.status === "ACTIVE").length ?? 0;
  const waiting = data?.items.filter((i) => i.status === "PENDING" || i.status === "NEEDS_INFO").length ?? 0;
  const hasAny = (data?.items.length ?? 0) > 0;

  const summary = hasAny
    ? [
        active ? `${active} active workspace${active === 1 ? "" : "s"}` : null,
        waiting ? `${waiting} request${waiting === 1 ? "" : "s"} waiting for approval` : null,
      ].filter(Boolean).join(" · ")
    : "Intern or work at a DevUp startup? Ask to join its workspace. Its admins approve you, then your dashboard opens.";

  return (
    <section
      aria-labelledby="join-workspace"
      className="mb-8 flex flex-col gap-4 rounded-2xl border border-[#c8f135]/20 bg-[#111111] p-5 sm:flex-row sm:items-center"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#c8f135]/10">
        <Building2 className="h-5 w-5 text-[#c8f135]" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id="join-workspace" className="text-white" style={{ fontFamily: "var(--font-syne), sans-serif", fontSize: 16, fontWeight: 700, lineHeight: 1.3 }}>
          Join your startup workspace
        </h2>
        <p className="mt-0.5 text-[13px] leading-relaxed text-[#a1a1a1]">{summary}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {hasAny && (
          <Link
            href="/workspace?stay=1"
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-white/5"
          >
            My workspaces
          </Link>
        )}
        <Link
          href="/workspace/join"
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#c8f135] px-4 py-2.5 text-[13px] font-bold text-black transition hover:brightness-110"
        >
          Join your startup workspace <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </section>
  );
}
