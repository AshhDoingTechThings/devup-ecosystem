/**
 * Give someone a finance role from the command line — for the first CFOs,
 * before there is a real super admin to do it in the admin portal.
 *
 * Same rules as the portal (modules/finance/roles.service.ts grantRole):
 * the account must already exist with a verified email, and the same role
 * can't be held twice. The grant is recorded in AuditLog as made by
 * "script:<operator>", and the person gets an in-app notification.
 *
 *   # dry run (default): shows what would happen, changes nothing
 *   npx ts-node scripts/grant-finance-role.ts --email someone@example.com --role ECOSYSTEM_CFO --operator "Asif"
 *   # do it
 *   npx ts-node scripts/grant-finance-role.ts --email someone@example.com --role ECOSYSTEM_CFO --operator "Asif" --apply
 *
 * Roles: ECOSYSTEM_CFO | FINANCE_VIEWER (add --startup <id or code> for one startup)
 *        | STARTUP_FINANCE_MANAGER (needs --startup).
 *
 * It writes to whatever DATABASE_URL points at (backend/.env is production).
 * The target host is printed before anything happens.
 */
import { FinanceRoleKind } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { grantRole } from "../src/modules/finance/roles.service";

const ROLES: FinanceRoleKind[] = ["ECOSYSTEM_CFO", "STARTUP_FINANCE_MANAGER", "FINANCE_VIEWER"];

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  const role = arg("role") as FinanceRoleKind | undefined;
  const operator = arg("operator")?.trim();
  const startupArg = arg("startup");
  const apply = process.argv.includes("--apply");
  if (!email || !role || !ROLES.includes(role) || !operator) {
    console.error("Usage: --email <address> --role <ECOSYSTEM_CFO|STARTUP_FINANCE_MANAGER|FINANCE_VIEWER> --operator <your name> [--startup <id|code>] [--apply]");
    process.exit(2);
  }

  const host = (() => { try { return new URL(process.env.DATABASE_URL ?? "").host; } catch { return "(unknown)"; } })();
  console.log(`Database: ${host}`);

  const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true, email: true, role: true, emailVerifiedAt: true, profile: { select: { name: true } } } });
  if (!user) {
    console.error(`No account uses ${email}. They need to sign up (or sign in with Google) with that address first.`);
    process.exit(1);
  }
  console.log(`Account: ${user.profile?.name ?? "(no name)"} <${user.email}> · platform role ${user.role} · email ${user.emailVerifiedAt ? "verified" : "NOT verified"}`);
  if (!user.emailVerifiedAt) {
    console.error("Refusing: the email isn't verified. Ask them to verify it (or sign in with Google), then run this again.");
    process.exit(1);
  }

  let startupId: string | null = null;
  if (startupArg) {
    const s = await prisma.startup.findFirst({ where: { OR: [{ id: startupArg }, { code: startupArg.toUpperCase() }] }, select: { id: true, name: true } });
    if (!s) { console.error(`No startup "${startupArg}"`); process.exit(1); }
    startupId = s.id;
    console.log(`Startup: ${s.name}`);
  }

  const existing = await prisma.financeRole.findMany({ where: { userId: user.id, revokedAt: null }, select: { role: true, startupId: true } });
  if (existing.length) console.log(`Already holds: ${existing.map((r) => `${r.role}${r.startupId ? `(${r.startupId})` : ""}`).join(", ")}`);

  if (!apply) {
    console.log(`Dry run: would grant ${role}${startupId ? " for that startup" : ""}. Add --apply to do it.`);
    return;
  }
  const row = await grantRole({ actorId: `script:${operator}`, userId: user.id, role, startupId, note: `Granted with scripts/grant-finance-role.ts by ${operator}` });
  console.log(`Granted ${row.role} (role id ${row.id}). They can open /finance after signing in.`);
}

main()
  .catch((e) => { console.error(e.message ?? e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
