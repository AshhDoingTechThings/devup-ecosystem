import { PayFrequency, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";
import { audit } from "../shared/audit.service";
import { seal, secretsAvailable } from "../../lib/secrets";
import { setStipendAmount } from "../hrms/finance/stipend.service";
import { FinanceAccess, assertApprove } from "./access";
import { dateOnly, parseDate, rupeesToPaise } from "./money";

/**
 * Pay setup: what each employee and intern is paid, and where to send it.
 *
 * The HR records already hold figures (Employee.ctc, Intern.stipend), but
 * they are free text with no unit. They are shown as SUGGESTIONS, worked out
 * from the database, and nothing is used for payroll until the CFO confirms
 * each one. CFO only — salaries and bank details are not visible to any other
 * finance role.
 */

export { suggestEmployeePay, suggestStipend } from "./paySuggest";
export type { PaySuggestion } from "./paySuggest";
import { suggestEmployeePay, suggestStipend } from "./paySuggest";

const bankSelect = { id: true, accountHolder: true, accountLast4: true, ifsc: true, bankName: true, upiCipher: true, createdAt: true } as const;
const presentBank = (b?: { id: string; accountHolder: string; accountLast4: string; ifsc: string; bankName: string | null; upiCipher: string | null; createdAt: Date } | null) =>
  b ? { id: b.id, accountHolder: b.accountHolder, accountLast4: b.accountLast4, ifsc: b.ifsc, bankName: b.bankName, hasUpi: Boolean(b.upiCipher), addedAt: b.createdAt } : null;

/** Everyone who may need paying, with what HR says, what is confirmed, and what is missing. */
export async function paySetup(access: FinanceAccess, startupId?: string | null) {
  assertApprove(access);
  const today = dateOnly(new Date());
  const where = startupId ? { startupId } : {};
  const [employees, interns] = await Promise.all([
    prisma.employee.findMany({
      where: { ...where, status: { in: ["ACTIVE", "NOTICE"] } },
      include: {
        startup: { select: { id: true, name: true, code: true } },
        compensation: { where: { effectiveTo: null }, orderBy: { effectiveFrom: "desc" }, take: 1 },
        bankAccounts: { where: { deactivatedAt: null }, select: bankSelect, take: 1, orderBy: { createdAt: "desc" } },
      },
      orderBy: [{ startup: { name: "asc" } }, { fullName: "asc" }],
    }),
    prisma.intern.findMany({
      where: { ...where, status: { in: ["ACTIVE", "NOTICE"] } },
      include: {
        startup: { select: { id: true, name: true, code: true } },
        bankAccounts: { where: { deactivatedAt: null }, select: bankSelect, take: 1, orderBy: { createdAt: "desc" } },
      },
      orderBy: [{ startup: { name: "asc" } }, { fullName: "asc" }],
    }),
  ]);

  const emp = employees.map((e) => {
    const current = e.compensation[0] ?? null;
    return {
      id: e.id, code: e.employeeCode, name: e.fullName, startup: e.startup, designation: e.designation, department: e.department,
      employmentType: e.employmentType, status: e.status, joinedAt: e.joinedAt, hasAccount: Boolean(e.userId),
      hrCtc: e.ctc,
      compensation: current && { id: current.id, monthlyGrossPaise: current.monthlyGrossPaise, annualCtcPaise: current.annualCtcPaise, components: current.components, frequency: current.frequency, effectiveFrom: current.effectiveFrom, basis: current.basis },
      suggestion: current ? null : suggestEmployeePay(e.ctc),
      bank: presentBank(e.bankAccounts[0]),
      payStatus: current ? "CONFIRMED" : "NEEDS_CONFIRMATION",
    };
  });

  const int = interns.map((i) => {
    const ended = i.endDate < today;
    const upcoming = i.startDate > today;
    const s = suggestStipend(i.stipendAmount, i.stipend);
    return {
      id: i.id, code: i.internCode, name: i.fullName, startup: i.startup, college: i.college, department: i.department, designation: i.designation,
      mentorId: i.mentorId, startDate: i.startDate, endDate: i.endDate, status: i.status, hasAccount: Boolean(i.userId),
      period: ended ? "ENDED" : upcoming ? "UPCOMING" : "CURRENT",
      hrStipend: i.stipend,
      stipendAmount: i.stipendAmount,
      suggestion: s.confirmed ? null : s,
      bank: presentBank(i.bankAccounts[0]),
      payStatus: i.stipendAmount != null ? "CONFIRMED" : "NEEDS_CONFIRMATION",
      warning: ended ? "Internship period has ended but HR still shows them as active — they won't be included in stipend runs until HR updates the dates or status" : null,
    };
  });

  return {
    employees: emp,
    interns: int,
    summary: {
      employees: emp.length,
      employeesConfirmed: emp.filter((e) => e.payStatus === "CONFIRMED").length,
      interns: int.length,
      internsConfirmed: int.filter((i) => i.payStatus === "CONFIRMED").length,
      internsEndedButActive: int.filter((i) => i.period === "ENDED").length,
      withoutBankDetails: [...emp, ...int].filter((p) => !p.bank).length,
    },
  };
}

export type CompensationInput = {
  monthlyGross: string | number;
  annualCtc?: string | number | null;
  components?: Array<{ name: string; amount: string | number }>;
  effectiveFrom: string;
  frequency?: PayFrequency;
  basis?: "CONFIRMED_FROM_HR" | "ENTERED";
  note?: string | null;
};

/** Confirm an employee's pay from a date. The previous pay ends the day before — history is kept, not overwritten. */
export async function confirmCompensation(access: FinanceAccess, employeeId: string, input: CompensationInput) {
  assertApprove(access);
  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, startupId: true, joinedAt: true } });
  if (!employee) throw new AppError(404, "Not found", "NOT_FOUND");
  const monthly = rupeesToPaise(input.monthlyGross);
  const annual = input.annualCtc == null || input.annualCtc === "" ? null : rupeesToPaise(input.annualCtc);
  const components = (input.components?.length ? input.components : [{ name: "Gross salary", amount: monthly / 100 }]).map((c) => {
    const name = String(c.name ?? "").trim();
    if (!name) throw new AppError(400, "Give every pay component a name", "COMPONENT_NAME");
    return { name: name.slice(0, 60), amountPaise: rupeesToPaise(c.amount, { allowZero: true }) };
  });
  const sum = components.reduce((s, c) => s + c.amountPaise, 0);
  if (sum !== monthly) throw new AppError(400, `The components add up to ₹${sum / 100}, but the monthly pay is ₹${monthly / 100}`, "COMPONENTS_MISMATCH");
  const from = parseDate(input.effectiveFrom, "start date");

  return prisma.$transaction(async (tx) => {
    const open = await tx.employeeCompensation.findFirst({ where: { employeeId, effectiveTo: null }, orderBy: { effectiveFrom: "desc" } });
    if (open) {
      if (from <= open.effectiveFrom) {
        throw new AppError(409, `Current pay already starts on ${open.effectiveFrom.toISOString().slice(0, 10)}. New pay must start after that.`, "OVERLAPPING_PAY");
      }
      await tx.employeeCompensation.update({ where: { id: open.id }, data: { effectiveTo: new Date(from.getTime() - 86400_000) } });
    }
    const row = await tx.employeeCompensation.create({
      data: {
        employeeId, startupId: employee.startupId, effectiveFrom: from, annualCtcPaise: annual, monthlyGrossPaise: monthly,
        components: components as unknown as Prisma.InputJsonValue, frequency: input.frequency ?? "MONTHLY",
        basis: input.basis === "CONFIRMED_FROM_HR" ? "CONFIRMED_FROM_HR" : "ENTERED", note: input.note?.trim() || null, confirmedBy: access.userId,
      },
    });
    await audit({
      action: "finance.pay.confirmed", entity: "FinanceCompensation", entityId: row.id, actorId: access.userId, startupId: employee.startupId,
      metadata: { employeeId, monthlyGrossPaise: monthly, annualCtcPaise: annual, effectiveFrom: from, previousId: open?.id ?? null, basis: row.basis },
    }, tx);
    return row;
  });
}

/** Confirm an intern's monthly stipend (whole rupees, 0 for unpaid). Stored on Intern.stipendAmount, which the stipend engine reads. */
export async function confirmStipend(access: FinanceAccess, internId: string, input: { monthly: string | number; note?: string | null }) {
  assertApprove(access);
  const intern = await prisma.intern.findUnique({ where: { id: internId }, select: { id: true, startupId: true, stipendAmount: true } });
  if (!intern) throw new AppError(404, "Not found", "NOT_FOUND");
  const paise = rupeesToPaise(input.monthly, { allowZero: true });
  if (paise % 100 !== 0) throw new AppError(400, "Stipends are whole rupees", "WHOLE_RUPEES");
  const updated = await setStipendAmount({ startupId: intern.startupId, internId, amount: paise / 100, actorId: access.userId });
  await audit({
    action: "finance.stipend.confirmed", entity: "FinanceCompensation", entityId: internId, actorId: access.userId, startupId: intern.startupId,
    metadata: { internId, from: intern.stipendAmount, to: paise / 100, note: input.note ?? null },
  });
  return { id: updated.id, stipendAmount: updated.stipendAmount };
}

export type BankInput = { employeeId?: string | null; internId?: string | null; accountHolder: string; accountNumber: string; ifsc: string; bankName?: string | null; upiId?: string | null };

/**
 * Where to send someone's pay. The account number and UPI ID are encrypted;
 * only the last four digits are ever shown. The previous details are kept,
 * deactivated, so a change is visible in history.
 */
export async function saveBankAccount(access: FinanceAccess, input: BankInput) {
  assertApprove(access);
  if (!secretsAvailable()) throw new AppError(503, "Bank details can't be stored: the server's encryption key (CREDENTIAL_ENCRYPTION_KEY) is not set", "ENCRYPTION_UNAVAILABLE");
  if (Boolean(input.employeeId) === Boolean(input.internId)) throw new AppError(400, "Choose one employee or intern", "PERSON_REQUIRED");
  const person = input.employeeId
    ? await prisma.employee.findUnique({ where: { id: input.employeeId }, select: { id: true, startupId: true } })
    : await prisma.intern.findUnique({ where: { id: input.internId! }, select: { id: true, startupId: true } });
  if (!person) throw new AppError(404, "Not found", "NOT_FOUND");

  const account = String(input.accountNumber ?? "").replace(/\s/g, "");
  if (!/^\d{9,18}$/.test(account)) throw new AppError(400, "Account numbers are 9 to 18 digits", "INVALID_ACCOUNT");
  const ifsc = String(input.ifsc ?? "").trim().toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw new AppError(400, "That IFSC isn't valid — it looks like SBIN0001234", "INVALID_IFSC");
  const holder = String(input.accountHolder ?? "").trim();
  if (holder.length < 2) throw new AppError(400, "Enter the account holder's name", "HOLDER_REQUIRED");
  const upi = input.upiId?.trim() || null;
  if (upi && !/^[\w.-]{2,256}@[a-zA-Z][\w.-]{1,64}$/.test(upi)) throw new AppError(400, "That UPI ID isn't valid — it looks like name@bank", "INVALID_UPI");

  const a = seal(account);
  const u = upi ? seal(upi) : null;
  const key = input.employeeId ? { employeeId: input.employeeId } : { internId: input.internId! };
  return prisma.$transaction(async (tx) => {
    const previous = await tx.payeeBankAccount.findMany({ where: { ...key, deactivatedAt: null }, select: { id: true, accountLast4: true } });
    if (previous.length) await tx.payeeBankAccount.updateMany({ where: { id: { in: previous.map((p) => p.id) } }, data: { deactivatedAt: new Date(), deactivatedBy: access.userId } });
    const row = await tx.payeeBankAccount.create({
      data: {
        ...key, startupId: person.startupId, accountHolder: holder.slice(0, 120), accountCipher: a.cipher, accountIv: a.iv, accountTag: a.tag,
        accountLast4: account.slice(-4), ifsc, bankName: input.bankName?.trim() || null, upiCipher: u?.cipher ?? null, upiIv: u?.iv ?? null, upiTag: u?.tag ?? null, addedBy: access.userId,
      },
      select: bankSelect,
    });
    // Last four digits only — never the number itself, not even in the audit log.
    await audit({ action: "finance.bank.saved", entity: "FinanceBankAccount", entityId: row.id, actorId: access.userId, startupId: person.startupId, metadata: { ...key, last4: row.accountLast4, ifsc, replaced: previous.map((p) => p.accountLast4) } }, tx);
    return presentBank(row);
  });
}
