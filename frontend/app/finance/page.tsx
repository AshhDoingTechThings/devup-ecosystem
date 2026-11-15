"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Building, Users2, Coffee, Receipt, Wallet, CheckCircle2, AlertTriangle } from "lucide-react";
import { financeApi, inr, Overview } from "@/lib/api/finance";
import { Bars, Button, Empty, ErrorNote, MonthColumns, PageHeader, Panel, PeriodPicker, StatCard, StatusPill, Tip, useFinance } from "@/components/finance/ui";
import ExpenseForm from "@/components/finance/ExpenseForm";

const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export default function FinanceOverviewPage() {
  const { me, scope, scopeName, period, custom } = useFinance();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<null | { category?: string; title?: string }>(null);

  const load = useCallback(async () => {
    if (period === "custom" && (!custom.from || !custom.to)) return;
    try {
      setData(await financeApi.overview({ scope, period, ...(period === "custom" ? custom : {}) }));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [scope, period, custom]);

  useEffect(() => { load(); }, [load]);

  const canAdd = me.canManageAnything;
  const single = scope !== "all" && scope !== "central";

  return (
    <>
      <PageHeader title={scopeName} sub="Where DevUp's money is going. Every figure comes from recorded expenses — nothing here is an estimate.">
        {canAdd && <Button kind="primary" onClick={() => setForm({})}><Plus className="h-4 w-4" />Add expense</Button>}
      </PageHeader>

      <PeriodPicker>
        {data && <span className="text-[12px] text-[#6b6b6b]">{fmtDate(data.period.from)} – {fmtDate(data.period.to)}</span>}
      </PeriodPicker>

      <ErrorNote message={error} />

      {canAdd && (
        <div className="mb-6 flex flex-wrap gap-2">
          <Quick icon={<Building className="h-4 w-4" />} label="Add office bill" onClick={() => setForm({ category: "office_rent" })} />
          <Quick icon={<Coffee className="h-4 w-4" />} label="Add meeting expense" onClick={() => setForm({ category: "meetings" })} />
          <Quick icon={<Receipt className="h-4 w-4" />} label="Add software subscription bill" onClick={() => setForm({ category: "software" })} />
          {me.canSeePay && <QuickLink icon={<Wallet className="h-4 w-4" />} label="Set salaries & stipends" href="/finance/pay" />}
          <QuickLink icon={<CheckCircle2 className="h-4 w-4" />} label="Review waiting expenses" href="/finance/expenses" />
          <QuickLink icon={<Receipt className="h-4 w-4" />} label="Set up a regular bill" href="/finance/bills" />
          <QuickLink icon={<CheckCircle2 className="h-4 w-4" />} label="Budgets" href="/finance/budgets" />
        </div>
      )}

      {!data ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-[104px] animate-pulse rounded-xl bg-white/[0.03]" />)}</div>
      ) : (
        <>
          <OverviewCards data={data} single={single} />
          <OverviewPanels data={data} single={single} canAdd={canAdd} />
        </>
      )}

      {form && <ExpenseForm presetCategory={form.category} presetTitle={form.title} onClose={() => setForm(null)} onSaved={load} />}
    </>
  );
}

function OverviewCards({ data, single }: { data: Overview; single: boolean }) {
  const c = data.cards;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Spent" value={inr(c.spentPaise, { compact: true })} sub={`${c.spentCount} paid expense${c.spentCount === 1 ? "" : "s"} in this period`} hint="Money actually paid out, for expenses dated in the selected period." tone="good" />
        {single && (
          <StatCard label="Share of shared DevUp costs" value={inr(c.sharedCostSharePaise ?? 0, { compact: true })} sub="Office, tools and other central costs charged to this startup" hint="Part of central DevUp costs (like rent) charged to this startup. Shown separately so it is never counted twice in DevUp's total." />
        )}
        <StatCard label="Bills still to pay" value={inr(c.billsToPayPaise, { compact: true })} sub={`${c.billsToPayCount} approved, not yet paid`} hint="Approved expenses that haven't been paid yet — as of today, whatever their date." tone={c.billsToPayCount ? "warn" : "default"} />
        <StatCard label="Overdue" value={inr(c.overduePaise, { compact: true })} sub={`${c.overdueCount} past their due date`} hint="Approved bills whose due date has passed and that are still unpaid." tone={c.overdueCount ? "warn" : "default"} />
        <StatCard label="Waiting for approval" value={inr(c.waitingApprovalPaise, { compact: true })} sub={`${c.waitingApprovalCount} to review`} hint="Expenses sent for approval, or sent back for more information. Only the CFO approves." />
        <StatCard label="Expense claims open" value={inr(c.claimsOpenPaise, { compact: true })} sub={`${c.claimsOpenCount} from team members`} hint="Money team members spent themselves and asked to be paid back, not yet paid." />
        {data.payroll && (
          <>
            {data.payroll.payDuePaise > 0 && <StatCard label="Payroll still to pay" value={inr(data.payroll.payDuePaise, { compact: true })} sub="Approved salaries and stipends not yet paid" hint="Pay in approved payroll runs that hasn't been confirmed as paid yet." tone="warn" />}
        <StatCard label="Monthly salaries" value={inr(data.payroll.monthlySalariesPaise, { compact: true })} sub={data.payroll.employeesWithoutConfirmedPay ? `${data.payroll.employeesWithoutConfirmedPay} of ${data.payroll.employees} employees' pay not confirmed yet` : `${data.payroll.employees} employees`} hint="What one normal month of salaries costs, from confirmed pay only. People whose pay isn't confirmed aren't included." tone={data.payroll.employeesWithoutConfirmedPay ? "warn" : "default"} />
            <StatCard label="Monthly stipends" value={inr(data.payroll.monthlyStipendsPaise, { compact: true })} sub={data.payroll.internsWithoutConfirmedStipend ? `${data.payroll.internsWithoutConfirmedStipend} of ${data.payroll.internsNow} interns not confirmed yet` : `${data.payroll.internsNow} current interns`} hint="What one normal month of stipends costs for interns working now, from confirmed amounts only." tone={data.payroll.internsWithoutConfirmedStipend ? "warn" : "default"} />
          </>
        )}
        <StatCard label="People working now" value={String(data.workforce.peopleNow)} sub={`across ${data.workforce.startups} startup${data.workforce.startups === 1 ? "" : "s"}`} hint="Active employees plus interns whose internship dates include today, from the HR records." />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <BudgetCard budget={data.budget} />
        <SmallFigure label="Money received" value={c.moneyReceivedPaise} empty="None recorded" href="/finance/revenue" hint="Money that arrived from outside DevUp in this period. Startups paying DevUp's bills is internal and not included." />
        <SmallFigure label="Money expected from startups" value={c.expectedFromStartupsPaise} empty="No open bills" href="/finance/invoices" hint="What startups still owe on bills DevUp has sent them." />
        <SmallFigure label="Monthly subscriptions" value={c.monthlySubscriptionsPaise} empty="None recorded" href="/finance/subscriptions" hint="What active software subscriptions cost in an average month. Yearly plans are divided by 12." />
        <NotYet label="Cash in bank" hint="Shown only once a bank balance is recorded with its date. DevUp has no bank connection, so it is never guessed." />
      </div>

    </>
  );
}

function OverviewPanels({ data, single, canAdd }: { data: Overview; single: boolean; canAdd: boolean }) {
  return (
    <>
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Panel title="Spending, last 12 months" hint="By the date of each expense. Solid: paid. Outlined: approved but not paid yet." className="lg:col-span-2">
          <MonthColumns months={data.trend} format={(v) => inr(v)} />
        </Panel>
        <Panel title="What it was spent on" hint="Paid expenses in the selected period, by category group.">
          {data.byCategoryGroup.length ? <Bars rows={data.byCategoryGroup.map((g) => ({ label: g.group, value: g.amountPaise }))} format={(v) => inr(v, { compact: true })} /> : <p className="text-[12.5px] text-[#6b6b6b]">Nothing paid in this period.</p>}
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Panel title={single ? "This startup" : "By startup"} hint="Own spending is what the startup paid itself. Share of shared costs is its part of central DevUp bills." className="lg:col-span-2">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-[13px]">
              <thead>
                <tr className="text-left text-[11.5px] text-[#6b6b6b]">
                  <th className="pb-2 font-medium">Startup</th>
                  <th className="pb-2 text-right font-medium">People now</th>
                  <th className="pb-2 text-right font-medium">Own spending</th>
                  <th className="pb-2 text-right font-medium">Share of shared costs</th>
                </tr>
              </thead>
              <tbody>
                {data.byStartup.map((s) => (
                  <tr key={s.id} className="border-t border-white/5">
                    <td className="py-2.5 text-[#e4e4e4]">{s.name}</td>
                    <td className="py-2.5 text-right tabular-nums text-[#a1a1a1]">{s.id === "central" ? "—" : s.peopleNow}</td>
                    <td className="py-2.5 text-right tabular-nums text-white">{inr(s.spentPaise)}</td>
                    <td className="py-2.5 text-right tabular-nums text-[#a1a1a1]">{s.id === "central" ? "—" : inr(s.sharedCostSharePaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.ecosystemTotalNote && <p className="mt-3 flex gap-1.5 text-[11.5px] text-[#6b6b6b]"><Users2 className="h-3.5 w-3.5 shrink-0" />{data.ecosystemTotalNote}</p>}
        </Panel>
        <Panel title="Due in the next 14 days" hint="Approved bills with a due date coming up.">
          {data.upcoming.length ? (
            <ul className="space-y-2.5">
              {data.upcoming.map((u) => (
                <li key={u.id} className="flex justify-between gap-3 text-[13px]">
                  <Link href={`/finance/expenses?open=${u.id}`} className="min-w-0">
                    <div className="truncate text-[#e4e4e4] hover:text-white">{u.title}</div>
                    <div className="text-[11.5px] text-[#6b6b6b]">{fmtDate(u.dueOn)} · {u.vendor?.name ?? u.payee ?? u.startup?.name ?? "Central"}</div>
                  </Link>
                  <span className="shrink-0 tabular-nums text-white">{inr(u.amountPaise)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-[12.5px] text-[#6b6b6b]">Nothing due in the next two weeks.</p>}
        </Panel>
      </div>

      <div className="mt-4">
        <Panel title="Latest activity" action={<Link href="/finance/expenses" className="text-[12px] text-[#8b8b8b] hover:text-white">All expenses →</Link>}>
          {data.recent.length ? (
            <ul className="divide-y divide-white/5">
              {data.recent.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-[13px]">
                  <Link href={`/finance/expenses?open=${r.id}`} className="min-w-0 flex-1">
                    <div className="truncate text-[#e4e4e4] hover:text-white">{r.title}</div>
                    <div className="text-[11.5px] text-[#6b6b6b]">{r.number} · {r.category.name} · {r.startup?.name ?? "Central DevUp"}</div>
                  </Link>
                  <StatusPill status={r.status} />
                  <span className="w-28 text-right tabular-nums text-white">{inr(r.amountPaise)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No expenses recorded yet">
              {canAdd ? "Start with this month's bills — rent, electricity, internet, subscriptions. Each one you add appears here and in the charts." : "Nothing has been recorded for this view yet."}
            </Empty>
          )}
        </Panel>
      </div>

      {data.payroll && (data.payroll.employeesWithoutConfirmedPay > 0 || data.payroll.internsWithoutConfirmedStipend > 0) && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-4 text-[13px] text-amber-200">
          <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" />Some pay figures come from HR and haven't been confirmed. Salaries and stipends can't be run until they are.</span>
          <Link href="/finance/pay" className="rounded-lg bg-amber-300/15 px-3 py-1.5 text-amber-100 hover:bg-amber-300/25">Confirm pay</Link>
        </div>
      )}
    </>
  );
}

function Quick({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button onClick={onClick} className="inline-flex items-center gap-2 rounded-lg border border-white/[0.08] bg-[#0f0f0f] px-3 py-2 text-[12.5px] text-[#cfcfcf] transition hover:border-white/20 hover:text-white">{icon}{label}</button>;
}

function QuickLink({ icon, label, href }: { icon: React.ReactNode; label: string; href: string }) {
  return <Link href={href} className="inline-flex items-center gap-2 rounded-lg border border-white/[0.08] bg-[#0f0f0f] px-3 py-2 text-[12.5px] text-[#cfcfcf] transition hover:border-white/20 hover:text-white">{icon}{label}</Link>;
}

function BudgetCard({ budget }: { budget: Overview["budget"] }) {
  if (!budget) {
    return <SmallFigure label="Budget" value={null} empty="No budget set" href="/finance/budgets" hint="Budgets running in this period for this view. The CFO creates them in Budgets." />;
  }
  return (
    <Link href="/finance/budgets" className="rounded-xl border border-white/[0.07] bg-[#0f0f0f] p-3.5 hover:border-white/15">
      <div className="flex items-center gap-1.5 text-[11.5px] text-[#8b8b8b]">Budget left<Tip text="Budget minus what's been paid and what's approved but not paid yet, for the budgets running in this period." /></div>
      <div className={`mt-1.5 text-[15px] font-semibold tabular-nums ${budget.over ? "text-red-300" : "text-white"}`}>{budget.over ? "Over by " : ""}{inr(Math.abs(budget.availablePaise), { compact: true })}</div>
      <div className="text-[11px] text-[#6b6b6b]">of {inr(budget.allocatedPaise, { compact: true })} · {budget.usedPercent}% used</div>
    </Link>
  );
}

function SmallFigure({ label, value, empty, href, hint }: { label: string; value: number | null; empty: string; href: string; hint: string }) {
  return (
    <Link href={href} className="rounded-xl border border-white/[0.07] bg-[#0f0f0f] p-3.5 hover:border-white/15">
      <div className="flex items-center gap-1.5 text-[11.5px] text-[#8b8b8b]">{label}<Tip text={hint} /></div>
      <div className={`mt-1.5 text-[15px] font-semibold tabular-nums ${value == null ? "text-[#4d4d4d]" : "text-white"}`}>{value == null ? empty : inr(value, { compact: true })}</div>
    </Link>
  );
}

function NotYet({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="rounded-xl border border-dashed border-white/[0.08] p-3.5">
      <div className="flex items-center gap-1.5 text-[11.5px] text-[#6b6b6b]">{label}<Tip text={hint} /></div>
      <div className="mt-1.5 text-[13px] text-[#4d4d4d]">Not tracked yet</div>
    </div>
  );
}
