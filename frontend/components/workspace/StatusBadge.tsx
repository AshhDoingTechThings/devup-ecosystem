import { STATUS_BADGE } from "@/lib/api/affiliation";

/** One look for every membership / request status across the app. */
export default function StatusBadge({ status, className = "" }: { status: string; className?: string }) {
  const tone = STATUS_BADGE[status] ?? { label: status.replace(/_/g, " ").toLowerCase(), className: "bg-white/5 text-[#a1a1a1] border-white/10" };
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${tone.className} ${className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" aria-hidden="true" />
      {tone.label}
    </span>
  );
}
