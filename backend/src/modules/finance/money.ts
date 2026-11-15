import { AppError } from "../../middleware/errorHandler";

/**
 * Money is whole paise in integers, everywhere in finance. Rupees as floats
 * produce totals that are off by a paisa and never reconcile.
 */

/** The most a single finance entry may be: ₹1 crore. Larger is almost certainly a typo (a missing decimal point). */
export const MAX_ENTRY_PAISE = 1_000_000_000;

/** "1,250.50" or 1250.5 (rupees) → 125050 paise. Refuses anything ambiguous. */
export function rupeesToPaise(input: unknown, { allowNegative = false, allowZero = false } = {}): number {
  const raw = typeof input === "number" ? String(input) : String(input ?? "").replace(/[,\s₹]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) throw new AppError(400, "Enter an amount in rupees, like 1250 or 1250.50", "INVALID_AMOUNT");
  const [whole, frac = ""] = raw.replace("-", "").split(".");
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  const signed = raw.startsWith("-") ? -paise : paise;
  if (!Number.isSafeInteger(signed)) throw new AppError(400, "That amount is too large", "INVALID_AMOUNT");
  if (signed < 0 && !allowNegative) throw new AppError(400, "The amount cannot be negative", "INVALID_AMOUNT");
  if (signed === 0 && !allowZero) throw new AppError(400, "The amount must be more than zero", "INVALID_AMOUNT");
  if (Math.abs(signed) > MAX_ENTRY_PAISE) throw new AppError(400, "That amount is over ₹1 crore — check for a missing decimal point", "AMOUNT_TOO_LARGE");
  return signed;
}

export const paiseToRupees = (paise: number) => paise / 100;

export function formatINR(paise: number) {
  const r = paise / 100;
  return `₹${r.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/**
 * Split `total` paise in proportion to `weights`, so the parts always add up
 * to exactly `total` (largest-remainder method). Ties go to the earlier entry,
 * so the same input always gives the same split.
 */
export function splitByWeights(total: number, weights: number[]): number[] {
  if (!weights.length) return [];
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) throw new AppError(400, "Shares cannot be negative", "INVALID_ALLOCATION");
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new AppError(400, "At least one share must be more than zero", "INVALID_ALLOCATION");
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const exact = weights.map((w) => (abs * w) / sum);
  const parts = exact.map(Math.floor);
  let left = abs - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, rem: x - Math.floor(x) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k].i] += 1;
  return parts.map((p) => p * sign);
}

/* Periods */

export type PeriodKind = "day" | "week" | "month" | "quarter" | "year" | "custom";

/** Midnight UTC of a date-only value. Finance dates are calendar dates, stored as @db.Date. */
export const dateOnly = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Parse YYYY-MM-DD strictly. */
export function parseDate(v: unknown, label = "date"): Date {
  const s = String(v ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new AppError(400, `Enter the ${label} as YYYY-MM-DD`, "INVALID_DATE");
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new AppError(400, `That ${label} does not exist`, "INVALID_DATE");
  return d;
}

/**
 * The [from, to] calendar range (both inclusive) for a period containing
 * `anchor`. Weeks start on Monday; quarters and years follow the Indian
 * financial year (April–March), which is how DevUp's books are kept.
 */
export function periodRange(kind: PeriodKind, anchor: Date, custom?: { from?: unknown; to?: unknown }): { from: Date; to: Date } {
  const a = dateOnly(anchor);
  const y = a.getUTCFullYear();
  const m = a.getUTCMonth();
  const utc = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd));
  switch (kind) {
    case "day":
      return { from: a, to: a };
    case "week": {
      const dow = (a.getUTCDay() + 6) % 7; // Monday = 0
      const from = utc(y, m, a.getUTCDate() - dow);
      return { from, to: utc(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 6) };
    }
    case "month":
      return { from: utc(y, m, 1), to: utc(y, m + 1, 0) };
    case "quarter": {
      // FY quarters: Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar.
      const fyMonth = (m + 9) % 12; // April = 0
      const qStart = m - (fyMonth % 3);
      return { from: utc(y, qStart, 1), to: utc(y, qStart + 3, 0) };
    }
    case "year": {
      const startYear = m >= 3 ? y : y - 1;
      return { from: utc(startYear, 3, 1), to: utc(startYear + 1, 2, 31) };
    }
    case "custom": {
      const from = parseDate(custom?.from, "start date");
      const to = parseDate(custom?.to, "end date");
      if (to < from) throw new AppError(400, "The end date is before the start date", "INVALID_PERIOD");
      if (to.getTime() - from.getTime() > 5 * 366 * 86400_000) throw new AppError(400, "Choose a range of five years or less", "INVALID_PERIOD");
      return { from, to };
    }
    default:
      throw new AppError(400, "Unknown period", "INVALID_PERIOD");
  }
}
