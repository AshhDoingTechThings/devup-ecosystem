import { splitByWeights } from "./money";

/**
 * Pay arithmetic — pure functions, no database, so every rule is tested on
 * its own. Money in paise; dates are calendar dates at midnight UTC.
 */

export type Component = { name: string; amountPaise: number };
export type CompensationSegment = { id: string; effectiveFrom: Date; effectiveTo: Date | null; monthlyGrossPaise: number; components: Component[] };
export type Adjustment = { kind: "INCENTIVE" | "BONUS" | "DEDUCTION" | "REIMBURSEMENT" | "SETTLEMENT"; label: string; amountPaise: number };

const DAY = 86400_000;
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

/** The calendar month containing year/month (1–12): first day, last day, number of days. */
export function monthPeriod(year: number, month: number) {
  const start = utc(year, month - 1, 1);
  const end = utc(year, month, 0);
  return { start, end, days: end.getUTCDate() };
}

/** Days in [aStart, aEnd] ∩ [bStart, bEnd], both inclusive. 0 when they don't overlap. */
export function overlapDays(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  const s = Math.max(aStart.getTime(), bStart.getTime());
  const e = Math.min(aEnd.getTime(), bEnd.getTime());
  return e < s ? 0 : Math.round((e - s) / DAY) + 1;
}

const latest = (a: Date, b: Date) => (a > b ? a : b);
const earliest = (a: Date, b: Date) => (a < b ? a : b);

/**
 * One month's salary from confirmed pay, prorated by calendar days:
 *   monthly pay × days worked ÷ days in the month,
 * for each pay rate in force during the month (a raise mid-month counts each
 * rate for its own days), within the employee's dates (joined, exited).
 * Components are scaled the same way and always add up to the total.
 */
export function salaryForMonth(args: {
  periodStart: Date;
  periodEnd: Date;
  joinedAt: Date;
  exitedAt: Date | null;
  segments: CompensationSegment[];
}) {
  const days = overlapDays(args.periodStart, args.periodEnd, args.periodStart, args.periodEnd);
  const from = latest(args.periodStart, args.joinedAt);
  const to = args.exitedAt ? earliest(args.periodEnd, args.exitedAt) : args.periodEnd;
  const byName = new Map<string, number>();
  let base = 0;
  let worked = 0;
  for (const seg of args.segments) {
    const d = overlapDays(from, to, seg.effectiveFrom, seg.effectiveTo ?? args.periodEnd);
    if (!d) continue;
    const amount = Math.round((seg.monthlyGrossPaise * d) / days);
    const parts = seg.components.length ? seg.components : [{ name: "Gross salary", amountPaise: seg.monthlyGrossPaise }];
    const scaled = splitByWeights(amount, parts.map((p) => p.amountPaise));
    parts.forEach((p, i) => byName.set(p.name, (byName.get(p.name) ?? 0) + scaled[i]));
    base += amount;
    worked += d;
  }
  return {
    basePaise: base,
    workedDays: worked,
    periodDays: days,
    components: [...byName.entries()].map(([name, amountPaise]) => ({ name, amountPaise })),
    isFinalSettlement: !!args.exitedAt && args.exitedAt >= args.periodStart && args.exitedAt <= args.periodEnd,
  };
}

/** A fixed monthly stipend (whole rupees) for the days of the internship inside the month. */
export function stipendForMonth(args: { periodStart: Date; periodEnd: Date; startDate: Date; endDate: Date; monthlyRupees: number }) {
  const days = overlapDays(args.periodStart, args.periodEnd, args.periodStart, args.periodEnd);
  const active = overlapDays(args.periodStart, args.periodEnd, args.startDate, args.endDate);
  return { activeDays: active, periodDays: days, grossRupees: Math.round((args.monthlyRupees * active) / days) };
}

/** Net pay: base plus incentives, bonuses, reimbursements and settlement lines, minus deductions. Never below zero. */
export function netPay(basePaise: number, adjustments: Adjustment[]) {
  const net = adjustments.reduce((s, a) => s + (a.kind === "DEDUCTION" ? -Math.abs(a.amountPaise) : Math.abs(a.amountPaise)), basePaise);
  return net;
}
