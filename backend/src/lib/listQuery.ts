import { AppError } from "../middleware/errorHandler";

/**
 * Query-string parsing for list endpoints.
 *
 * Handlers used to pass `page`, `limit` and filters straight to Prisma:
 * `?limit=abc` became NaN and a 500, `?page=0` a negative skip that surfaced as
 * "database unavailable", `?domain=anything` an invalid enum and a 500, and
 * `?limit=100000` returned the whole table. Bad input is now a 400, and the
 * page size is capped.
 */

const invalid = (name: string, hint: string) =>
  new AppError(400, `Invalid ${name}: ${hint}`, "INVALID_QUERY");

/** A query value that arrived once. `?a=1&a=2` reaches handlers as an array. */
function single(value: unknown, name: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw invalid(name, "give it once");
  return value;
}

function positiveInt(value: unknown, name: string, fallback: number): number {
  const raw = single(value, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw invalid(name, "use a whole number from 1");
  return Number(raw);
}

/** Largest page any client asks for today (admin and sitemap use 100). */
export const MAX_PAGE_SIZE = 100;

export function pageParams(
  query: Record<string, unknown>,
  { defaultLimit = 10, maxLimit = MAX_PAGE_SIZE }: { defaultLimit?: number; maxLimit?: number } = {}
) {
  const page = positiveInt(query.page, "page", 1);
  const limit = Math.min(positiveInt(query.limit, "limit", defaultLimit), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
}

export function enumParam<T extends Record<string, string>>(value: unknown, allowed: T, name: string): T[keyof T] | undefined {
  const raw = single(value, name);
  if (raw === undefined) return undefined;
  if (!Object.values(allowed).includes(raw)) throw invalid(name, `use one of ${Object.values(allowed).join(", ")}`);
  return raw as T[keyof T];
}

export function textParam(value: unknown, name: string, max = 100): string | undefined {
  const raw = single(value, name);
  if (raw === undefined) return undefined;
  if (raw.length > max) throw invalid(name, `keep it under ${max} characters`);
  return raw;
}
