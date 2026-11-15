"use client";

import { createContext, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { Info, X } from "lucide-react";
import type { ExpenseStatus, FinanceMe, Period, Scope } from "@/lib/api/finance";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/api/finance";

/* Shared state for every finance page: who is signed in, and what they're looking at. */

export interface FinanceState {
  me: FinanceMe;
  scope: Scope;
  setScope: (s: Scope) => void;
  period: Period;
  setPeriod: (p: Period) => void;
  custom: { from: string; to: string };
  setCustom: (c: { from: string; to: string }) => void;
  scopeName: string;
}

export const FinanceContext = createContext<FinanceState | null>(null);

export function useFinance() {
  const v = useContext(FinanceContext);
  if (!v) throw new Error("useFinance outside the finance portal");
  return v;
}

/* Building blocks, in the DevUp dark style */

export const heading = { fontFamily: "var(--font-syne), sans-serif" } as const;

/**
 * globals.css styles h1–h3 directly and outside Tailwind's layers, so it beats
 * utility classes like text-[13px]. Headings here set their size inline.
 */
export const h1Style = { ...heading, fontSize: "clamp(22px, 2.4vw, 28px)", fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.2 } as const;
export const h2Style = { fontFamily: "inherit", fontSize: 13, fontWeight: 600, letterSpacing: "normal", lineHeight: 1.4 } as const;
export const h3Style = { fontFamily: "inherit", fontSize: 12, fontWeight: 600, letterSpacing: "normal", lineHeight: 1.4 } as const;
export const modalTitleStyle = { ...heading, fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em", lineHeight: 1.3 } as const;

export function PageHeader({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-white" style={h1Style}>{title}</h1>
        {sub && <p className="text-[#8b8b8b] text-[13.5px] mt-1.5 max-w-2xl">{sub}</p>}
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </header>
  );
}

export function Panel({ title, hint, children, className = "", action }: { title?: string; hint?: string; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section className={`rounded-xl border border-white/[0.07] bg-[#0f0f0f] p-4 md:p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && (
            <h2 className="text-[#e4e4e4] flex items-center gap-1.5" style={h2Style}>
              {title}
              {hint && <Tip text={hint} />}
            </h2>
          )}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** A small (i) that explains a figure in plain words. Works on hover, focus and tap. */
export function Tip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={text}
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="text-[#5d5d5d] hover:text-[#a1a1a1] focus-visible:text-[#c8f135] outline-none"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {open && (
        <span role="tooltip" className="absolute left-1/2 top-5 z-50 w-60 -translate-x-1/2 rounded-lg border border-white/10 bg-[#1a1a1a] p-2.5 text-[11.5px] font-normal leading-relaxed text-[#cfcfcf] shadow-xl">
          {text}
        </span>
      )}
    </span>
  );
}

export function StatCard({ label, value, sub, hint, tone = "default", onClick }: { label: string; value: string; sub?: string; hint: string; tone?: "default" | "warn" | "good" | "muted"; onClick?: () => void }) {
  const color = tone === "warn" ? "text-amber-300" : tone === "good" ? "text-[#c8f135]" : tone === "muted" ? "text-[#5d5d5d]" : "text-white";
  const Comp = onClick ? "button" : "div";
  return (
    <Comp onClick={onClick} className={`text-left rounded-xl border border-white/[0.07] bg-[#0f0f0f] p-4 ${onClick ? "hover:border-white/15 transition" : ""}`}>
      <div className="flex items-center gap-1.5 text-[11.5px] text-[#8b8b8b]">
        {label}
        <Tip text={hint} />
      </div>
      <div className={`mt-2 text-[22px] font-bold tabular-nums tracking-tight ${color}`} style={heading}>{value}</div>
      {sub && <div className="mt-1 text-[11.5px] text-[#6b6b6b]">{sub}</div>}
    </Comp>
  );
}

export function StatusPill({ status }: { status: ExpenseStatus }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

export function Button({ children, kind = "secondary", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "secondary" | "danger" | "ghost" }) {
  const cls = {
    primary: "bg-[#c8f135] text-[#0a0a0a] hover:bg-[#d6f76a] font-semibold",
    secondary: "bg-white/5 border border-white/10 text-[#e4e4e4] hover:bg-white/10",
    danger: "bg-red-500/10 border border-red-500/20 text-red-300 hover:bg-red-500/20",
    ghost: "text-[#8b8b8b] hover:text-white hover:bg-white/5",
  }[kind];
  return (
    <button {...rest} className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] transition disabled:opacity-40 disabled:cursor-not-allowed ${cls} ${rest.className ?? ""}`}>
      {children}
    </button>
  );
}

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("input,select,textarea,button")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[100] flex items-end md:items-center justify-center bg-black/70 p-0 md:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`w-full ${wide ? "md:max-w-3xl" : "md:max-w-lg"} max-h-[92vh] overflow-y-auto rounded-t-2xl md:rounded-2xl border border-white/10 bg-[#111] p-5 md:p-6`}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-white" style={modalTitleStyle}>{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-[#8b8b8b] hover:bg-white/5 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, required }: { label: string; hint?: string; children: ReactNode; required?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-[12px] text-[#a1a1a1]">
        {label}{required && <span className="text-[#c8f135]">*</span>}
        {hint && <Tip text={hint} />}
      </span>
      {children}
    </label>
  );
}

export const inputCls = "w-full rounded-lg border border-white/10 bg-[#0a0a0a] px-3 py-2 text-[13.5px] text-white placeholder:text-[#4d4d4d] outline-none focus:border-[#c8f135]/50";

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">{message}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-white/10 px-6 py-10 text-center">
      <div className="text-[14px] font-semibold text-[#cfcfcf]">{title}</div>
      {children && <div className="mx-auto mt-1.5 max-w-md text-[12.5px] text-[#6b6b6b]">{children}</div>}
    </div>
  );
}

/** Horizontal bars — readable at a glance, no chart library needed. */
export function Bars({ rows, format }: { rows: Array<{ label: string; value: number; sub?: string }>; format: (v: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="mb-1 flex justify-between gap-3 text-[12.5px]">
            <span className="truncate text-[#cfcfcf]">{r.label}{r.sub && <span className="ml-1.5 text-[#6b6b6b]">{r.sub}</span>}</span>
            <span className="tabular-nums text-white">{format(r.value)}</span>
          </div>
          <div className="h-2 rounded-full bg-white/[0.04]">
            <div className="h-2 rounded-full bg-[#c8f135]/70" style={{ width: `${(Math.abs(r.value) / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Monthly columns: paid (solid) and approved-but-unpaid (outlined) stacked. */
export function MonthColumns({ months, format }: { months: Array<{ month: string; spentPaise: number; approvedUnpaidPaise: number }>; format: (v: number) => string }) {
  const max = Math.max(1, ...months.map((m) => m.spentPaise + m.approvedUnpaidPaise));
  const name = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString("en-IN", { month: "short", timeZone: "UTC" });
  return (
    <div>
      <div className="flex h-40 items-end gap-1.5" role="img" aria-label="Spending by month for the last 12 months">
        {months.map((m) => {
          const total = m.spentPaise + m.approvedUnpaidPaise;
          return (
            <div key={m.month} className="group relative flex h-full flex-1 flex-col justify-end" title={`${name(m.month)}: paid ${format(m.spentPaise)}, approved to pay ${format(m.approvedUnpaidPaise)}`}>
              <div className="w-full rounded-t border border-sky-400/40 border-b-0" style={{ height: `${(m.approvedUnpaidPaise / max) * 100}%` }} />
              <div className={`w-full ${m.approvedUnpaidPaise ? "" : "rounded-t"} bg-[#c8f135]/70`} style={{ height: `${(m.spentPaise / max) * 100}%` }} />
              {total === 0 && <div className="h-px w-full bg-white/10" />}
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {months.map((m) => <div key={m.month} className="flex-1 text-center text-[10px] text-[#5d5d5d]">{name(m.month)}</div>)}
      </div>
      <div className="mt-3 flex gap-4 text-[11px] text-[#8b8b8b]">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#c8f135]/70" />Paid</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm border border-sky-400/60" />Approved, still to pay</span>
      </div>
    </div>
  );
}
