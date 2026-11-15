"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { financeApi, inr } from "@/lib/api/finance";

/**
 * A startup's view of a bill from DevUp, reached from the link in the bill or
 * a reminder email. No sign-in; the unguessable link is the key. Read-only,
 * and shows nothing internal (no notes, emails or reminder history).
 */

const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "—");
const STATUS: Record<string, string> = { ISSUED: "Awaiting payment", PART_PAID: "Partly paid", PAID: "Paid", CANCELLED: "Cancelled" };

export default function BillPage() {
  const { token } = useParams<{ token: string }>();
  const [bill, setBill] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (token) financeApi.publicBill(token).then(setBill).catch(() => setError("This bill link isn't valid. Ask DevUp for a new one.")); }, [token]);

  return (
    <div className="min-h-screen bg-[#0a0a0a] px-4 py-10">
      <div className="mx-auto max-w-2xl rounded-2xl border border-white/[0.08] bg-[#0f0f0f] p-6 md:p-8">
        <div className="text-[12px] uppercase tracking-wider text-[#6b6b6b]">DevUp Ecosystem · Finance</div>
        {error ? <p className="mt-6 text-[14px] text-red-300">{error}</p> : !bill ? <div className="mt-6 h-40 animate-pulse rounded-xl bg-white/[0.03]" /> : (
          <>
            <h1 className="mt-2 text-white" style={{ fontFamily: "var(--font-syne), sans-serif", fontSize: 24, fontWeight: 800, lineHeight: 1.2 }}>{bill.title}</h1>
            <p className="mt-1 text-[13px] text-[#8b8b8b]">Bill {bill.number} to {bill.recipient} · {STATUS[bill.status] ?? bill.status}{bill.isOverdue ? " · overdue" : ""}</p>
            <dl className="mt-5 grid grid-cols-2 gap-3 text-[13px]">
              <div><dt className="text-[#6b6b6b]">Issued</dt><dd className="text-[#e4e4e4]">{fmt(bill.issueDate)}</dd></div>
              <div><dt className="text-[#6b6b6b]">Due</dt><dd className={bill.isOverdue ? "text-amber-300" : "text-[#e4e4e4]"}>{fmt(bill.dueDate)}</dd></div>
              {bill.periodStart && <div className="col-span-2"><dt className="text-[#6b6b6b]">Covering</dt><dd className="text-[#e4e4e4]">{fmt(bill.periodStart)} – {fmt(bill.periodEnd)}</dd></div>}
            </dl>
            <ul className="mt-6 divide-y divide-white/5 text-[14px]">
              {bill.lines.map((l: any, i: number) => <li key={i} className="flex justify-between gap-4 py-2.5"><span className="text-[#cfcfcf]">{l.label}</span><span className="tabular-nums text-white">{inr(l.amountPaise)}</span></li>)}
            </ul>
            <div className="mt-3 space-y-1 border-t border-white/10 pt-3 text-[14px]">
              <div className="flex justify-between"><span className="text-[#a1a1a1]">Total</span><span className="tabular-nums text-white">{inr(bill.amountPaise)}</span></div>
              <div className="flex justify-between"><span className="text-[#a1a1a1]">Paid</span><span className="tabular-nums text-[#c8f135]">{inr(bill.receivedPaise)}</span></div>
              <div className="flex justify-between text-[16px] font-semibold"><span className="text-white">Still owed</span><span className="tabular-nums text-white">{inr(bill.outstandingPaise)}</span></div>
            </div>
            {bill.payments.length > 0 && (
              <ul className="mt-4 space-y-1 text-[12.5px] text-[#8b8b8b]">{bill.payments.map((p: any, i: number) => <li key={i}>Received {fmt(p.receivedOn)}{p.reference ? ` · ref ${p.reference}` : ""} — {inr(p.amountPaise)}</li>)}</ul>
            )}
            <p className="mt-6 text-[12px] text-[#6b6b6b]">Questions about this bill, or already paid? Reply to DevUp&apos;s email with the payment reference.</p>
          </>
        )}
      </div>
    </div>
  );
}
