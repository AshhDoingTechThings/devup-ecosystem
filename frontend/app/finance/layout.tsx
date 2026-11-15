"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, LayoutDashboard, Receipt, Wallet, HandCoins, Lock, Loader2, Building2, PiggyBank, CalendarClock, AppWindow, Users, Banknote, FileText } from "lucide-react";
import { financeApi, FinanceMe, Period, Scope } from "@/lib/api/finance";
import { FinanceContext, heading } from "@/components/finance/ui";
import "./finance.css";

/**
 * The DevUp finance portal. A self-contained app like the startup workspace:
 * its own sidebar, no marketing chrome (see LayoutClient).
 *
 * What appears here follows the server's answer to /api/finance/me. Someone
 * with no finance role but a job at a startup still gets "My expense claims".
 */

const NAV = [
  { href: "/finance", label: "Overview", icon: LayoutDashboard, need: "finance" as const },
  { href: "/finance/expenses", label: "Expenses & claims", icon: Receipt, need: "finance" as const },
  { href: "/finance/budgets", label: "Budgets", icon: PiggyBank, need: "finance" as const },
  { href: "/finance/bills", label: "Regular bills", icon: CalendarClock, need: "finance" as const },
  { href: "/finance/subscriptions", label: "Subscriptions", icon: AppWindow, need: "finance" as const },
  { href: "/finance/events", label: "Meetings & events", icon: Users, need: "finance" as const },
  { href: "/finance/pay", label: "Salaries & stipends", icon: Wallet, need: "pay" as const },
  { href: "/finance/payroll", label: "Payroll", icon: Banknote, need: "pay" as const },
  { href: "/finance/my-claims", label: "My expense claims", icon: HandCoins, need: "claims" as const },
  { href: "/finance/my-pay", label: "My pay", icon: FileText, need: "claims" as const },
];

/** The phone tab bar has room for five; the rest are on each page's links. */
const MOBILE_TABS = ["/finance", "/finance/expenses", "/finance/budgets", "/finance/pay", "/finance/my-claims"];

export default function FinanceLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [me, setMe] = useState<FinanceMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>("all");
  const [period, setPeriod] = useState<Period>("month");
  const [custom, setCustom] = useState({ from: "", to: "" });

  useEffect(() => {
    financeApi
      .me()
      .then((m) => {
        setMe(m);
        // Start where the person can see the most: everything, or their first startup.
        if (!m.viewAll && m.startups[0]) setScope(m.startups[0].id);
        try {
          const saved = localStorage.getItem("devup.finance.scope");
          if (saved && (saved === "all" || saved === "central" ? m.viewAll : m.startups.some((s) => s.id === saved))) setScope(saved);
        } catch { /* private mode: ignore */ }
      })
      .catch((e) => setError(e.message));
  }, []);

  const changeScope = (s: Scope) => {
    setScope(s);
    try { localStorage.setItem("devup.finance.scope", s); } catch { /* ignore */ }
  };

  const hasFinance = (me?.roles.length ?? 0) > 0;
  const nav = NAV.filter((n) => (n.need === "finance" ? hasFinance : n.need === "pay" ? me?.canSeePay : (me?.claimStartups.length ?? 0) > 0));
  const scopeName = useMemo(() => {
    if (scope === "all") return "All of DevUp";
    if (scope === "central") return "Central DevUp operations";
    return me?.startups.find((s) => s.id === scope)?.name ?? "Startup";
  }, [scope, me]);

  if (error) {
    return (
      <Shell>
        <Centered icon={<Lock className="h-10 w-10 text-[#3d3d3d]" />} title="Finance is unavailable">
          {error}
        </Centered>
      </Shell>
    );
  }
  if (!me) {
    return (
      <Shell>
        <div className="flex min-h-screen items-center justify-center text-[#6b6b6b]"><Loader2 className="h-5 w-5 animate-spin" /></div>
      </Shell>
    );
  }
  if (!hasFinance && me.claimStartups.length === 0 && !pathname.startsWith("/finance/my-pay")) {
    return (
      <Shell>
        <Centered icon={<Lock className="h-10 w-10 text-[#3d3d3d]" />} title="You don't have finance access">
          The finance portal is for DevUp's CFO and the people they work with. If you think you should have access, ask a DevUp super admin.
        </Centered>
      </Shell>
    );
  }

  // Everything except "My expense claims" needs a finance role.
  const financePage = pathname === "/finance" || (pathname.startsWith("/finance/") && !pathname.startsWith("/finance/my-"));
  if (financePage && !hasFinance) {
    return (
      <Shell>
        <Centered icon={<HandCoins className="h-10 w-10 text-[#3d3d3d]" />} title="Claim an expense">
          You can ask to be paid back for money you spent for your startup.
          <div className="mt-5"><Link href="/finance/my-claims" className="rounded-lg bg-[#c8f135] px-4 py-2 text-sm font-semibold text-[#0a0a0a]">Go to my claims</Link></div>
        </Centered>
      </Shell>
    );
  }

  const roleLabel = me.isCfo ? "CFO" : me.roles.some((r) => r.role === "STARTUP_FINANCE_MANAGER") ? "Finance manager" : hasFinance ? "Finance viewer" : "Team member";

  return (
    <FinanceContext.Provider value={{ me, scope, setScope: changeScope, period, setPeriod, custom, setCustom, scopeName }}>
      <Shell>
        <div className="flex min-h-screen">
          <aside className="hidden md:flex w-[256px] shrink-0 flex-col border-r border-white/5 bg-[#0d0d0d] sticky top-0 h-screen overflow-y-auto">
            <div className="border-b border-white/5 p-4">
              <div className="text-white text-[15px] font-bold" style={heading}>DevUp Finance</div>
              <div className="mt-0.5 text-[10.5px] uppercase tracking-wider text-[#6b6b6b]">{roleLabel}</div>
            </div>
            {hasFinance && (
              <div className="border-b border-white/5 p-3">
                <ScopePicker me={me} scope={scope} onChange={changeScope} />
              </div>
            )}
            <nav className="flex-1 space-y-1 px-3 py-4">
              {nav.map(({ href, label, icon: Icon }) => {
                const active = href === "/finance" ? pathname === "/finance" : pathname.startsWith(href);
                return (
                  <Link key={href} href={href} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13.5px] transition ${active ? "bg-[#c8f135]/10 text-[#c8f135]" : "text-[#8b8b8b] hover:bg-white/5 hover:text-[#e4e4e4]"}`}>
                    <Icon className="h-4 w-4 shrink-0" />
                    {label}
                  </Link>
                );
              })}
            </nav>
            <div className="border-t border-white/5 p-3">
              <Link href="/dashboard" className="flex items-center gap-2 rounded-lg px-3 py-2 text-[12.5px] text-[#8b8b8b] transition hover:bg-white/5 hover:text-[#e4e4e4]">
                <ArrowLeft className="h-3.5 w-3.5" /> Back to DevUp
              </Link>
            </div>
          </aside>

          {/* Mobile: the scope picker on top, tabs at the bottom. */}
          <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 flex border-t border-white/10 bg-[#0d0d0d] pb-[env(safe-area-inset-bottom)]">
            {nav.filter((n) => MOBILE_TABS.includes(n.href)).map(({ href, label, icon: Icon }) => {
              const active = href === "/finance" ? pathname === "/finance" : pathname.startsWith(href);
              return (
                <Link key={href} href={href} className={`flex flex-1 flex-col items-center gap-1 py-3 text-[9.5px] ${active ? "text-[#c8f135]" : "text-[#6b6b6b]"}`}>
                  <Icon className="h-4 w-4" />
                  {label.split(" ")[0]}
                </Link>
              );
            })}
          </div>

          <main className="min-w-0 flex-1 pb-24 md:pb-10">
            {hasFinance && (
              <div className="md:hidden border-b border-white/5 bg-[#0d0d0d] p-3">
                <ScopePicker me={me} scope={scope} onChange={changeScope} />
              </div>
            )}
            <div className="mx-auto max-w-[1240px] px-4 py-6 md:px-9 md:py-9">{children}</div>
          </main>
        </div>
      </Shell>
    </FinanceContext.Provider>
  );
}

function ScopePicker({ me, scope, onChange }: { me: FinanceMe; scope: Scope; onChange: (s: Scope) => void }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-[#6b6b6b]"><Building2 className="h-3 w-3" />Showing</span>
      <select
        value={scope}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/10 bg-[#141414] px-3 py-2 text-[13px] text-white outline-none focus:border-[#c8f135]/50"
      >
        {me.viewAll && <option value="all">All of DevUp</option>}
        {me.viewAll && <option value="central">Central DevUp operations</option>}
        {me.startups.map((s) => (
          <option key={s.id} value={s.id}>{s.name}{s.isActive ? "" : " (inactive)"}</option>
        ))}
      </select>
    </label>
  );
}

function Centered({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      {icon}
      <h1 className="mt-4 text-white" style={{ ...heading, fontSize: 20, fontWeight: 600 }}>{title}</h1>
      <div className="mt-2 max-w-md text-sm text-[#6b6b6b]">{children}</div>
      <Link href="/dashboard" className="mt-6 text-[12.5px] text-[#8b8b8b] hover:text-white">← Back to DevUp</Link>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="devup-finance min-h-screen bg-[#0a0a0a]">{children}</div>;
}
