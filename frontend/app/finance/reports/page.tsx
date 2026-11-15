"use client";

import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Category, financeApi, inr, ReportKind, ReportPreview } from "@/lib/api/finance";
import { Button, ErrorNote, Field, PageHeader, Panel, PeriodPicker, inputCls, useFinance } from "@/components/finance/ui";

/**
 * Reports: preview on screen, then export as CSV, Excel or PDF. Each comes
 * with a short note on what it includes and what it leaves out. Every export
 * is recorded. The payroll report is the CFO's only.
 */

const KINDS: Array<{ kind: ReportKind; label: string; about: string; cfoOnly?: boolean }> = [
  { kind: "summary", label: "Summary", about: "Money in, money out, what's still to pay and what it was spent on." },
  { kind: "startups", label: "Startups at a glance", about: "Each startup's spending, share of shared costs, money in and what it owes DevUp." },
  { kind: "expenses", label: "Expenses", about: "Every expense in the period, with filters for category and status." },
  { kind: "income", label: "Money received", about: "What arrived from outside DevUp, by source." },
  { kind: "budgets", label: "Budget use", about: "Each budget line: budget, spent, committed and what's left." },
  { kind: "payroll", label: "Payroll", about: "Salaries and stipends by month and person.", cfoOnly: true },
  { kind: "subscriptions", label: "Subscriptions", about: "What each subscription costs a month, and seats used." },
  { kind: "receivables", label: "Money expected from startups", about: "DevUp's bills to startups and what's still owed." },
];

export default function ReportsPage() {
  const { me, scope, scopeName, period, custom } = useFinance();
  const [kind, setKind] = useState<ReportKind>("summary");
  const [categoryId, setCategoryId] = useState("");
  const [status, setStatus] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [data, setData] = useState<ReportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const kinds = KINDS.filter((k) => !k.cfoOnly || me.isCfo);

  const params = useMemo(() => {
    const p: Record<string, string | undefined> = { scope, period: period === "custom" && !(custom.from && custom.to) ? "month" : period };
    if (p.period === "custom") { p.from = custom.from; p.to = custom.to; }
    if (kind === "expenses") { p.categoryId = categoryId || undefined; p.status = status || undefined; }
    return p;
  }, [scope, period, custom, kind, categoryId, status]);

  useEffect(() => { financeApi.categories().then(setCategories).catch(() => {}); }, []);
  useEffect(() => {
    setData(null);
    financeApi.report(kind, params).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  }, [kind, params]);

  const download = async (format: "csv" | "xlsx" | "pdf") => {
    setBusy(format); setError(null);
    try { await financeApi.exportReport(kind, format, params); } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  return (
    <>
      <PageHeader title="Reports" sub={`For ${scopeName}. Every export is recorded.`}>
        <Button disabled={!!busy} onClick={() => download("xlsx")}><Download className="h-4 w-4" />Excel</Button>
        <Button disabled={!!busy} onClick={() => download("csv")}><Download className="h-4 w-4" />CSV</Button>
        <Button disabled={!!busy} onClick={() => download("pdf")}><Download className="h-4 w-4" />PDF</Button>
      </PageHeader>
      <PeriodPicker />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {kinds.map((k) => (
          <button key={k.kind} onClick={() => setKind(k.kind)} className={`rounded-xl border p-3 text-left transition ${kind === k.kind ? "border-[#c8f135]/40 bg-[#c8f135]/[0.06]" : "border-white/[0.07] bg-[#0f0f0f] hover:border-white/15"}`}>
            <div className="text-[13px] font-semibold text-white">{k.label}</div>
            <div className="mt-0.5 text-[11.5px] text-[#8b8b8b]">{k.about}</div>
          </button>
        ))}
      </div>
      {kind === "expenses" && (
        <div className="mb-4 grid gap-2 sm:grid-cols-2 md:w-2/3">
          <Field label="Category"><select className={inputCls} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">All</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Status"><select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Live (submitted, approved, paid)</option>{["DRAFT", "SUBMITTED", "NEEDS_INFO", "APPROVED", "REJECTED", "PAID", "VOID"].map((s) => <option key={s} value={s}>{s.replace("_", " ").toLowerCase()}</option>)}</select></Field>
        </div>
      )}
      <ErrorNote message={error} />
      {!data ? <div className="h-40 animate-pulse rounded-xl bg-white/[0.03]" /> : <Preview data={data} />}
    </>
  );
}

function Preview({ data }: { data: ReportPreview }) {
  const show = (type: string | undefined, v: unknown) => (type === "money" && typeof v === "number" ? inr(Math.round(v * 100)) : v == null ? "" : String(v));
  return (
    <Panel title={`${data.title} · ${data.from} to ${data.to}`}>
      <ul className="mb-3 space-y-1 text-[12px] text-[#8b8b8b]">{data.notes.map((n, i) => <li key={i}>• {n}</li>)}</ul>
      {data.rows.length === 0 ? <p className="text-[13px] text-[#6b6b6b]">Nothing to show for this period.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[12.5px]">
            <thead className="text-left text-[11px] text-[#6b6b6b]"><tr>{data.columns.map((c) => <th key={c.key} className={`pb-2 pr-3 font-medium ${c.type === "money" || c.type === "number" ? "text-right" : ""}`}>{c.label}</th>)}</tr></thead>
            <tbody>
              {data.rows.map((r, i) => <tr key={i} className="border-t border-white/5">{data.columns.map((c) => <td key={c.key} className={`py-1.5 pr-3 ${c.type === "money" || c.type === "number" ? "text-right tabular-nums text-white" : "text-[#cfcfcf]"}`}>{show(c.type, r[c.key])}</td>)}</tr>)}
              {data.totals && <tr className="border-t-2 border-white/20 font-semibold">{data.columns.map((c) => <td key={c.key} className={`py-2 pr-3 ${c.type === "money" ? "text-right tabular-nums" : ""} text-white`}>{show(c.type, data.totals![c.key])}</td>)}</tr>}
            </tbody>
          </table>
          {data.totalRows > data.rows.length && <p className="mt-2 text-[11.5px] text-[#6b6b6b]">Showing the first {data.rows.length} of {data.totalRows} rows — the export has them all.</p>}
        </div>
      )}
    </Panel>
  );
}
