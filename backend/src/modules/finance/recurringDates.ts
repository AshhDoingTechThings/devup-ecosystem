import { RecurringFrequency } from "@prisma/client";
import { dateOnly } from "./money";

/**
 * When a recurring bill falls due — pure date arithmetic, no database, so it
 * can be tested on its own. All dates are calendar dates at midnight UTC.
 */

export const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const MONTH_STEP: Record<Exclude<RecurringFrequency, "WEEKLY">, number> = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Due dates of a bill between two dates (inclusive), in order. */
export function dueDates(bill: { frequency: RecurringFrequency; dueDay: number; startsOn: Date; endsOn: Date | null }, from: Date, until: Date): Date[] {
  const start = dateOnly(bill.startsOn);
  const end = bill.endsOn && dateOnly(bill.endsOn) < until ? dateOnly(bill.endsOn) : until;
  const lower = from > start ? from : start;
  const out: Date[] = [];
  if (bill.frequency === "WEEKLY") {
    const isoDay = (d: Date) => ((d.getUTCDay() + 6) % 7) + 1;
    let d = utc(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + ((bill.dueDay - isoDay(start) + 7) % 7));
    for (; d <= end; d = utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 7)) if (d >= lower) out.push(d);
    return out;
  }
  const step = MONTH_STEP[bill.frequency];
  for (let i = 0; i < 1200; i += step) {
    const d = utc(start.getUTCFullYear(), start.getUTCMonth() + i, bill.dueDay);
    if (d > end) break;
    if (d >= lower && d >= start) out.push(d);
  }
  return out;
}

