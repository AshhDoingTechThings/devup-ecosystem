import { timingSafeEqual } from "crypto";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { AppError } from "../../middleware/errorHandler";
import { audit } from "../shared/audit.service";
import { notify } from "../shared/notification.service";
import { esc, renderEmail, details } from "../../lib/email/layout";
import { dateOnly } from "./money";
import { generateDue } from "./recurring.service";
import { automaticReminders } from "./invoices.service";

/**
 * The daily finance job, called by a scheduler (Render cron) with the
 * FINANCE_CRON_SECRET header. It:
 *   1. creates the expenses for recurring bills that have come due;
 *   2. tells the CFO, once a day, which bills are due soon or overdue and
 *      which subscriptions renew this week — in-app and one digest email;
 *   3. reminds startups about overdue DevUp bills, within each bill's limits.
 * Running it twice in a day creates nothing twice and sends no second digest.
 */

export function checkCronSecret(given: string | undefined) {
  const secret = env.FINANCE_CRON_SECRET;
  if (!secret) throw new AppError(503, "The finance daily job is not configured (FINANCE_CRON_SECRET)", "CRON_DISABLED");
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(401, "Not authorized", "UNAUTHORIZED");
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function runDaily(now = new Date()) {
  const today = dateOnly(now);
  const generated = await generateDue({ today });
  const digest = await sendDigests(today);
  // Overdue startup bills: at most one automatic reminder per bill every 7 days, up to its limit.
  const reminders = await automaticReminders(now);
  return { date: day(today), billsCreated: generated.created.length, digestsSent: digest.sent, remindersSent: reminders };
}

async function sendDigests(today: Date) {
  const weekAhead = new Date(today.getTime() + 7 * 86400_000);
  const [due, renewals, cfos] = await Promise.all([
    prisma.expense.findMany({
      where: { deletedAt: null, status: { in: ["APPROVED", "SUBMITTED"] }, dueOn: { lte: weekAhead } },
      select: { id: true, number: true, title: true, amountPaise: true, dueOn: true, status: true, startup: { select: { name: true } } },
      orderBy: { dueOn: "asc" },
      take: 50,
    }),
    prisma.subscription.findMany({ where: { status: "ACTIVE", renewalOn: { gte: today, lte: weekAhead } }, select: { name: true, plan: true, renewalOn: true, costPaise: true }, orderBy: { renewalOn: "asc" } }),
    prisma.financeRole.findMany({ where: { role: "ECOSYSTEM_CFO", revokedAt: null }, select: { userId: true } }),
  ]);
  if (!due.length && !renewals.length) return { sent: 0 };

  let sent = 0;
  for (const { userId } of cfos) {
    // One digest per CFO per day, however often the job runs.
    const already = await prisma.auditLog.findFirst({ where: { entity: "FinanceDigest", entityId: `${userId}:${day(today)}` } });
    if (already) continue;
    const overdue = due.filter((d) => d.dueOn! < today);
    const title = overdue.length ? `${overdue.length} bill(s) overdue · ${due.length} due this week` : `${due.length} bill(s) due this week`;
    const rows: Array<[string, string]> = [
      ...due.slice(0, 15).map((d): [string, string] => [`${d.dueOn!.toISOString().slice(0, 10)}${d.dueOn! < today ? " (overdue)" : ""}`, `${d.title} — ₹${(d.amountPaise / 100).toLocaleString("en-IN")} · ${d.startup?.name ?? "Central DevUp"}`]),
      ...renewals.map((r): [string, string] => [`Renews ${r.renewalOn!.toISOString().slice(0, 10)}`, `${r.name}${r.plan ? ` (${r.plan})` : ""} — ₹${(r.costPaise / 100).toLocaleString("en-IN")}`]),
    ];
    const html = renderEmail({
      preheader: title,
      heading: "Finance: what's due",
      body: `<p style="margin:0 0 14px;">${esc(title)}${renewals.length ? `, and ${renewals.length} subscription renewal(s) this week` : ""}.</p>${details(rows)}`,
      cta: { label: "Open DevUp Finance", url: `${env.FRONTEND_URL ?? "https://www.devupecosystem.com"}/finance/expenses` },
    });
    await notify({ userId, event: "FINANCE_BILLS_DUE", title, message: "Bills due soon and subscription renewals are waiting in DevUp Finance.", link: "/finance/expenses", html });
    await audit({ action: "finance.digest.sent", entity: "FinanceDigest", entityId: `${userId}:${day(today)}`, metadata: { bills: due.length, renewals: renewals.length } });
    sent++;
  }
  return { sent };
}
