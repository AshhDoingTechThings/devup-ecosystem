"use client";

import Link from "next/link";
import { CalendarDays, IdCard, Network, UserRound } from "lucide-react";
import StartupLogo from "@/components/StartupLogo";
import StatusBadge from "@/components/workspace/StatusBadge";
import { EmploymentRecord, CATEGORY_LABEL } from "@/lib/api/affiliation";

/**
 * The startup a self-service dashboard is showing. The choice lives in the
 * URL (?startup=CODE) so switching reloads that startup's data; it is only a
 * filter over records the server already scoped to this person.
 */
export function StartupSwitcher({ records, current, basePath }: { records: EmploymentRecord[]; current: string | null; basePath: string }) {
  if (records.length < 2) return null;
  return (
    <nav aria-label="Switch startup" className="-mx-1 mb-6 flex gap-2 overflow-x-auto px-1 pb-1">
      {records.map((r) => {
        const active = r.startup.code === current;
        return (
          <Link
            key={r.personId}
            href={`${basePath}?startup=${r.startup.code}`}
            aria-current={active ? "page" : undefined}
            className={`flex shrink-0 items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3.5 text-[13px] transition ${
              active ? "border-[#c8f135]/40 bg-[#c8f135]/10 text-[#c8f135]" : "border-white/10 text-[#a1a1a1] hover:bg-white/5 hover:text-white"
            }`}
          >
            <StartupLogo src={r.startup.logoUrl} name={r.startup.name} className="h-6 w-6 border border-white/10 text-[10px]" rounded="rounded-full" />
            {r.startup.name}
          </Link>
        );
      })}
    </nav>
  );
}

const fmt = (d?: string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : null);

function months(start: string, end: string) {
  const m = Math.round((new Date(end).getTime() - new Date(start).getTime()) / (30.44 * 864e5));
  return m <= 1 ? "1 month" : `${m} months`;
}

/** Who, where, what role, since when — the facts of one employment record. */
export function EmploymentDetails({ record }: { record: EmploymentRecord }) {
  const isIntern = record.kind === "INTERN";
  return (
    <section className="rounded-2xl border border-white/[0.06] bg-[#111111] p-5 sm:p-6" aria-labelledby={`emp-${record.personId}`}>
      <div className="mb-5 flex items-start gap-4">
        <StartupLogo src={record.startup.logoUrl} name={record.startup.name} className="h-12 w-12 shrink-0 border border-white/10" />
        <div className="min-w-0 flex-1">
          <h2 id={`emp-${record.personId}`} className="truncate text-lg font-semibold text-white" style={{ fontSize: 18, lineHeight: 1.2, fontFamily: "var(--font-syne), sans-serif" }}>
            {record.startup.name}
          </h2>
          <p className="truncate text-[12.5px] text-[#8b8b8b]">
            {[record.startup.tagline, CATEGORY_LABEL[record.startup.domain ?? ""]].filter(Boolean).join(" · ")}
          </p>
        </div>
        <StatusBadge status={record.status === "NOTICE" ? "NOTICE" : "ACTIVE"} />
      </div>

      <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
        <Fact icon={IdCard} label={isIntern ? "Intern ID" : "Employee ID"} value={<span className="font-mono">{record.code}</span>} />
        <Fact icon={UserRound} label={isIntern ? "Internship role" : "Designation"} value={record.designation} />
        <Fact icon={Network} label="Department" value={record.department} />
        <Fact icon={UserRound} label={isIntern ? "Mentor" : "Manager"} value={record.supervisor ?? "Not assigned yet"} muted={!record.supervisor} />
        {isIntern ? (
          <Fact
            icon={CalendarDays}
            label="Duration"
            value={record.endDate ? `${fmt(record.startDate)} – ${fmt(record.endDate)} (${months(record.startDate, record.endDate)})` : fmt(record.startDate)}
          />
        ) : (
          <Fact icon={CalendarDays} label="Joined" value={fmt(record.startDate)} />
        )}
        {isIntern && record.college && <Fact icon={UserRound} label="College" value={record.college} />}
      </dl>
    </section>
  );
}

function Fact({ icon: Icon, label, value, muted }: { icon: any; label: string; value?: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex min-w-0 gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[#6b6b6b]" aria-hidden="true" />
      <div className="min-w-0">
        <dt className="text-[11.5px] text-[#6b6b6b]">{label}</dt>
        <dd className={`truncate ${muted ? "text-[#6b6b6b]" : "text-[#e4e4e4]"}`}>{value || "—"}</dd>
      </div>
    </div>
  );
}
