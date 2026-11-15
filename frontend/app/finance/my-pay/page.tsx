"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { financeApi, inr, MyPay } from "@/lib/api/finance";
import { Button, Empty, ErrorNote, PageHeader, Panel } from "@/components/finance/ui";

/** Staff: your confirmed pay, payslips and stipend statements. Only your own. */
export default function MyPayPage() {
  const [data, setData] = useState<MyPay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { financeApi.myPay().then(setData).catch((e) => setError(e.message)); }, []);
  const month = (d: string) => new Date(d).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  const get = async (key: string, fn: () => Promise<void>) => { setBusy(key); setError(null); try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(null); } };

  return (
    <>
      <PageHeader title="My pay" sub="Your salary or stipend, as recorded by DevUp, and a statement for each month that's been approved." />
      <ErrorNote message={error} />
      {!data ? <div className="h-32 animate-pulse rounded-xl bg-white/[0.03]" /> : (
        <div className="space-y-4">
          {data.currentPay.length > 0 && (
            <Panel title="Your monthly pay">
              <ul className="space-y-1 text-[13px]">{data.currentPay.map((c, i) => <li key={i} className="flex justify-between"><span className="text-[#a1a1a1]">{c.startup} · since {new Date(c.since).toLocaleDateString("en-IN", { timeZone: "UTC" })}</span><span className="tabular-nums text-white">{inr(c.monthlyGrossPaise)}</span></li>)}</ul>
            </Panel>
          )}
          {data.salary.length === 0 && data.stipends.length === 0 ? (
            <Empty title="No statements yet">A statement appears here once a month's pay has been approved.</Empty>
          ) : (
            <Panel title="Statements">
              <ul className="divide-y divide-white/5 text-[13px]">
                {data.salary.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                    <span><span className="text-[#e4e4e4]">Salary — {month(s.period)}</span> <span className="text-[11.5px] text-[#6b6b6b]">{s.startup} · {s.status === "PAID" ? `paid ${s.paidOn ? new Date(s.paidOn).toLocaleDateString("en-IN", { timeZone: "UTC" }) : ""}` : "approved, not paid yet"}</span></span>
                    <span className="flex items-center gap-3"><span className="tabular-nums text-white">{inr(s.netPaise)}</span><Button kind="ghost" disabled={busy === s.id} onClick={() => get(s.id, () => financeApi.downloadPayslip(s.id))}><Download className="h-3.5 w-3.5" />Payslip</Button></span>
                  </li>
                ))}
                {data.stipends.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                    <span><span className="text-[#e4e4e4]">Stipend — {month(s.period)}</span> <span className="text-[11.5px] text-[#6b6b6b]">{s.startup} · {s.status === "PAID" ? "paid" : "approved, not paid yet"}</span></span>
                    <span className="flex items-center gap-3"><span className="tabular-nums text-white">{inr(s.netPaise)}</span><Button kind="ghost" disabled={busy === s.id} onClick={() => get(s.id, () => financeApi.downloadStipendStatement(s.id))}><Download className="h-3.5 w-3.5" />Statement</Button></span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      )}
    </>
  );
}
