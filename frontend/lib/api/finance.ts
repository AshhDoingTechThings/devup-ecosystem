import { api, apiClient, downloadFile } from "./client";

/**
 * The CFO finance portal (/api/finance). Every permission is decided by the
 * server; the client only hides doors the server would refuse.
 * Money is whole paise; format with `inr()`.
 */

export type Scope = "all" | "central" | string;
export type Period = "day" | "week" | "month" | "quarter" | "year" | "custom";
export type ExpenseStatus = "DRAFT" | "SUBMITTED" | "NEEDS_INFO" | "APPROVED" | "REJECTED" | "PAID" | "VOID";
export type ExpenseKind = "VENDOR_BILL" | "REIMBURSEMENT" | "ADJUSTMENT";
export type PaymentMethod = "BANK_TRANSFER" | "UPI" | "CARD" | "CASH" | "CHEQUE" | "OTHER";

export interface FinanceStartup { id: string; name: string; code: string | null; isActive: boolean; type: string; logoUrl: string | null }
export interface FinanceMe {
  roles: Array<{ id: string; role: "ECOSYSTEM_CFO" | "STARTUP_FINANCE_MANAGER" | "FINANCE_VIEWER"; startupId: string | null }>;
  isCfo: boolean;
  viewAll: boolean;
  canApprove: boolean;
  canSeePay: boolean;
  canManageAnything: boolean;
  startups: FinanceStartup[];
  claimStartups: Array<{ id: string; name: string; code: string | null }>;
}
export interface Category { id: string; key: string; name: string; group: string; description: string | null }
export interface Vendor { id: string; name: string; kind: string | null }

export interface Expense {
  id: string;
  number: string;
  startupId: string | null;
  startup: { id: string; name: string; code: string | null } | null;
  kind: ExpenseKind;
  title: string;
  description: string | null;
  businessPurpose: string | null;
  category: { id: string; key: string; name: string; group: string };
  vendor: { id: string; name: string } | null;
  payee: string | null;
  amountPaise: number;
  currency: string;
  originalAmount: number | null;
  incurredOn: string;
  dueOn: string | null;
  paymentMethod: PaymentMethod | null;
  status: ExpenseStatus;
  claimantUserId: string | null;
  submittedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  reviewNote: string | null;
  paidAt: string | null;
  paymentRef: string | null;
  correctsId: string | null;
  notes: string | null;
  isOverdue: boolean;
  allocatedPaise: number;
  allocations: Array<{ id: string; startupId: string | null; startup: { name: string } | null; method: string; basis: number | null; amountPaise: number }>;
}
export interface ExpenseDetail extends Expense {
  attachments: Array<{ id: string; kind: string; fileName: string | null; mimeType: string; sizeBytes: number; createdAt: string; uploadedBy: string }>;
  corrections: Array<{ id: string; number: string; amountPaise: number; notes: string | null; createdAt: string }>;
  history: Array<{ at: string; action: string; by: string | null; details: any }>;
  splitCleared?: boolean;
}

export interface Overview {
  period: { kind: Period; from: string; to: string };
  cards: {
    spentPaise: number; spentCount: number;
    billsToPayPaise: number; billsToPayCount: number;
    overduePaise: number; overdueCount: number;
    waitingApprovalPaise: number; waitingApprovalCount: number;
    claimsOpenPaise: number; claimsOpenCount: number;
    sharedCostSharePaise?: number;
    moneyReceivedPaise: number | null; expectedFromStartupsPaise: number | null;
    monthlySubscriptionsPaise: number | null; cashBalancePaise: number | null;
  };
  budget: null | (MoneyFigures & { count: number; overCount: number });
  payroll: null | {
    payDuePaise: number;
    monthlySalariesPaise: number; employees: number; employeesWithoutConfirmedPay: number;
    monthlyStipendsPaise: number; internsNow: number; internsWithoutConfirmedStipend: number;
  };
  byCategoryGroup: Array<{ group: string; amountPaise: number }>;
  byStartup: Array<{ id: string; name: string; code: string | null; spentPaise: number; sharedCostSharePaise: number; peopleNow: number }>;
  ecosystemTotalNote: string | null;
  trend: Array<{ month: string; spentPaise: number; approvedUnpaidPaise: number }>;
  upcoming: Array<{ id: string; number: string; title: string; amountPaise: number; dueOn: string; startup: { name: string } | null; vendor: { name: string } | null; payee: string | null }>;
  recent: Array<{ id: string; number: string; title: string; amountPaise: number; status: ExpenseStatus; kind: ExpenseKind; incurredOn: string; startup: { name: string } | null; category: { name: string } }>;
  workforce: { startups: number; peopleNow: number };
}

export interface PaySetup {
  employees: Array<{
    id: string; code: string; name: string; startup: { id: string; name: string; code: string | null }; designation: string; department: string | null;
    employmentType: string; status: string; joinedAt: string; hasAccount: boolean; hrCtc: string | null;
    compensation: null | { id: string; monthlyGrossPaise: number; annualCtcPaise: number | null; components: Array<{ name: string; amountPaise: number }>; frequency: string; effectiveFrom: string; basis: string };
    suggestion: null | { monthlyPaise: number | null; annualCtcPaise?: number | null; basis?: string; confidence?: "high" | "check"; explanation: string };
    bank: Bank | null;
    payStatus: "CONFIRMED" | "NEEDS_CONFIRMATION";
  }>;
  interns: Array<{
    id: string; code: string; name: string; startup: { id: string; name: string; code: string | null }; college: string | null; department: string | null; designation: string;
    startDate: string; endDate: string; status: string; hasAccount: boolean; period: "CURRENT" | "UPCOMING" | "ENDED";
    hrStipend: string | null; stipendAmount: number | null;
    suggestion: null | { monthlyRupees: number | null; explanation: string };
    bank: Bank | null; payStatus: "CONFIRMED" | "NEEDS_CONFIRMATION"; warning: string | null;
  }>;
  summary: { employees: number; employeesConfirmed: number; interns: number; internsConfirmed: number; internsEndedButActive: number; withoutBankDetails: number };
}
export interface Bank { id: string; accountHolder: string; accountLast4: string; ifsc: string; bankName: string | null; hasUpi: boolean; addedAt: string }


/* Slice 2: budgets, recurring bills, subscriptions, events */

export type BudgetScope = "ECOSYSTEM" | "CENTRAL" | "STARTUP";
export type BudgetPeriod = "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY" | "CUSTOM";
export interface MoneyFigures { allocatedPaise: number; spentPaise: number; committedPaise: number; availablePaise: number; usedPercent: number; over: boolean }
export interface Budget {
  id: string; name: string; scope: BudgetScope; startup: { id: string; name: string } | null; purpose: string | null; period: BudgetPeriod;
  periodStart: string; periodEnd: string; approvalLimitPaise: number | null; notes: string | null; version: number; archivedAt: string | null;
  totals: MoneyFigures;
  lines: Array<MoneyFigures & { id: string; categoryGroup: string | null; note: string | null }>;
  unbudgeted: Array<{ group: string; spentPaise: number; committedPaise: number }>;
  sharedCostSharePaise: number | null;
  history?: Array<{ at: string; action: string; by: string | null; details: any }>;
}
export type Frequency = "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";
export interface RecurringBill {
  id: string; startupId: string | null; startup: { name: string } | null; title: string; categoryId: string; payee: string | null; amountPaise: number;
  frequency: Frequency; dueDay: number; startsOn: string; endsOn: string | null; leadDays: number; autoApprove: boolean; isActive: boolean; notes: string | null;
  nextDue: string | null; recent: Array<{ dueDate: string; expense: { id: string; number: string; status: ExpenseStatus; amountPaise: number } | null }>;
}
export interface Subscription {
  id: string; startupId: string | null; startup: { name: string } | null; name: string; provider: string; plan: string | null; billingCycle: Frequency;
  costPaise: number; monthlyPaise: number; seatsPurchased: number | null; seatsAssigned: number; seatsUnassigned: number | null; renewalOn: string | null;
  paymentMethodNote: string | null; status: "ACTIVE" | "PAUSED" | "CANCELLED"; cancelledAt: string | null; notes: string | null;
  seats: Array<{ id: string; userId: string | null; name: string | null; email: string | null; assignedAt: string }>;
  charges?: Array<{ id: string; number: string; amountPaise: number; status: ExpenseStatus; incurredOn: string }>;
}
export interface SubAlert { kind: "RENEWAL_SOON" | "UNASSIGNED_SEATS" | "CHARGED_AFTER_CANCEL" | "COST_INCREASE" | "POSSIBLE_DUPLICATE"; subscriptionId: string; name: string; message: string }
export type EventKind = "TEAM_MEETING" | "STARTUP_MEETING" | "FOUNDER_MEETING" | "INVESTOR_MEETING" | "CLIENT_MEETING" | "TEAM_EVENT" | "WORKSHOP" | "TRAVEL" | "OTHER";
export interface FinanceEvent {
  id: string; startupId: string | null; startup: { name: string } | null; name: string; kind: EventKind; date: string; startTime: string | null;
  purpose: string | null; location: string | null; participants: Array<{ userId: string | null; name: string }>; status: "PLANNED" | "DONE" | "CANCELLED";
  totalPaise: number; paidPaise: number; pendingPaise: number; costCount: number; waitingApproval: number;
  costs?: Array<{ id: string; number: string; title: string; amountPaise: number; status: ExpenseStatus; category: { name: string }; payee: string | null }>;
}

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  TEAM_MEETING: "Team meeting", STARTUP_MEETING: "Startup meeting", FOUNDER_MEETING: "Founder meeting", INVESTOR_MEETING: "Investor meeting",
  CLIENT_MEETING: "Client meeting", TEAM_EVENT: "Team get-together", WORKSHOP: "Workshop", TRAVEL: "Travel", OTHER: "Other",
};
export const FREQ_LABEL: Record<Frequency, string> = { WEEKLY: "Every week", MONTHLY: "Every month", QUARTERLY: "Every 3 months", YEARLY: "Every year" };

/* Slice 3: payroll and stipend runs */

export type PayrollKind = "SALARY" | "STIPEND";
export type PayrollRunStatus = "DRAFT" | "REVIEW" | "APPROVED" | "PROCESSING" | "PAID" | "PARTIALLY_PAID" | "CANCELLED";
export type AdjustmentKind = "INCENTIVE" | "BONUS" | "DEDUCTION" | "REIMBURSEMENT" | "SETTLEMENT";
export interface PayrollTotals { people: number; netPaise: number; paidPaise: number; unpaidPaise: number; failed: number; onHold: number; missingBank: number }
export interface PayrollRunSummary extends PayrollTotals { id: string; kind: PayrollKind; startup: { id: string; name: string; code: string | null }; periodStart: string; status: PayrollRunStatus; basis: string; approvedAt: string | null }
export interface PayrollLine {
  id: string; type: PayrollKind; personId: string; name: string; code: string; detail: string | null; workedDays: number; periodDays: number;
  basePaise: number; adjustments: Array<{ kind: AdjustmentKind; label: string; amountPaise: number }>; netPaise: number;
  status: "PENDING" | "ON_HOLD" | "PAID" | "FAILED"; paidOn: string | null; paymentRef: string | null; failureReason: string | null; bankLast4: string | null;
  isFinalSettlement: boolean; note: string | null;
}
export interface PayrollRun {
  id: string; kind: PayrollKind; startup: { id: string; name: string; code: string | null }; periodStart: string; periodEnd: string; status: PayrollRunStatus; basis: string;
  approvedAt: string | null; exportedAt: string | null; cancelReason: string | null; notes: string | null; lines: PayrollLine[]; totals: PayrollTotals;
  history: Array<{ at: string; action: string; by: string | null; details: any }>;
}
export interface MyPay {
  currentPay: Array<{ startup: string; monthlyGrossPaise: number; since: string }>;
  salary: Array<{ id: string; startup: string; period: string; netPaise: number; status: string; paidOn: string | null }>;
  stipends: Array<{ id: string; startup: string; period: string; netPaise: number; status: string; paidOn: string | null }>;
}
export const RUN_STATUS_LABEL: Record<PayrollRunStatus, string> = {
  DRAFT: "Draft", REVIEW: "In review", APPROVED: "Approved — ready to pay", PROCESSING: "Paying (bank file prepared)", PAID: "Paid", PARTIALLY_PAID: "Partly paid", CANCELLED: "Cancelled",
};

const q = (params: Record<string, string | number | undefined | null>) => {
  const s = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
  return s ? `?${s}` : "";
};

export const financeApi = {
  me: () => api.get<FinanceMe>("/api/finance/me"),
  categories: () => api.get<Category[]>("/api/finance/categories"),
  vendors: (search?: string) => api.get<Vendor[]>(`/api/finance/vendors${q({ q: search })}`),
  createVendor: (body: { name: string; kind?: string; contactName?: string; contactEmail?: string; contactPhone?: string; gstin?: string }) => api.post<Vendor>("/api/finance/vendors", body),

  overview: (p: { scope?: Scope; period?: Period; anchor?: string; from?: string; to?: string }) => api.get<Overview>(`/api/finance/overview${q(p)}`),

  expenses: (f: { scope?: Scope; status?: ExpenseStatus; kind?: ExpenseKind; categoryId?: string; from?: string; to?: string; q?: string; page?: number }) =>
    api.get<{ rows: Expense[]; total: number; page: number; pageSize: number; totals: Record<string, { count: number; amountPaise: number }> }>(`/api/finance/expenses${q(f)}`),
  expense: (id: string) => api.get<ExpenseDetail>(`/api/finance/expenses/${id}`),
  createExpense: (body: Record<string, unknown>) => api.post<Expense>("/api/finance/expenses", body),
  updateExpense: (id: string, body: Record<string, unknown>) => api.patch<ExpenseDetail>(`/api/finance/expenses/${id}`, body),
  deleteDraft: (id: string) => api.delete(`/api/finance/expenses/${id}`),
  submit: (id: string) => api.post<ExpenseDetail>(`/api/finance/expenses/${id}/submit`, {}),
  approve: (id: string, note?: string) => api.post<ExpenseDetail>(`/api/finance/expenses/${id}/approve`, { note }),
  reject: (id: string, reason: string) => api.post<ExpenseDetail>(`/api/finance/expenses/${id}/reject`, { reason }),
  requestInfo: (id: string, message: string) => api.post<ExpenseDetail>(`/api/finance/expenses/${id}/request-info`, { message }),
  voidIt: (id: string, reason: string) => api.post<ExpenseDetail>(`/api/finance/expenses/${id}/void`, { reason }),
  pay: (id: string, body: { paidOn?: string; paymentMethod?: PaymentMethod; paymentRef?: string }) => api.post<ExpenseDetail>(`/api/finance/expenses/${id}/pay`, body),
  correct: (id: string, body: { amount: string; reason: string; on?: string; paymentRef?: string }) => api.post<Expense>(`/api/finance/expenses/${id}/correct`, body),
  split: (id: string, body: { method: string; shares: Array<{ scope: string; percent?: number | string; amount?: string; units?: number | string }>; note?: string }) =>
    api.put<ExpenseDetail>(`/api/finance/expenses/${id}/allocations`, body),
  upload: (id: string, file: File, kind = "RECEIPT", claim = false) => {
    const fd = new FormData();
    fd.append("kind", kind);
    fd.append("file", file);
    return apiClient<any>(claim ? `/api/finance/me/claims/${id}/attachments` : `/api/finance/expenses/${id}/attachments`, { method: "POST", body: fd });
  },
  fileLink: (attachmentId: string) => api.get<{ url: string; fileName: string | null }>(`/api/finance/attachments/${attachmentId}/link`),


  // Budgets
  budgets: (scope?: Scope, current?: boolean) => api.get<Budget[]>(`/api/finance/budgets${q({ scope, current: current ? 1 : undefined })}`),
  budget: (id: string) => api.get<Budget>(`/api/finance/budgets/${id}`),
  budgetGroups: () => api.get<string[]>("/api/finance/budgets/groups"),
  createBudget: (body: Record<string, unknown>) => api.post<Budget>("/api/finance/budgets", body),
  reviseBudget: (id: string, body: Record<string, unknown>) => api.patch<Budget>(`/api/finance/budgets/${id}`, body),
  archiveBudget: (id: string) => api.post<Budget>(`/api/finance/budgets/${id}/archive`, {}),
  // Recurring bills
  recurring: (scope?: Scope) => api.get<RecurringBill[]>(`/api/finance/recurring${q({ scope })}`),
  createRecurring: (body: Record<string, unknown>) => api.post<RecurringBill>("/api/finance/recurring", body),
  updateRecurring: (id: string, body: Record<string, unknown>) => api.patch<RecurringBill>(`/api/finance/recurring/${id}`, body),
  generateRecurring: () => api.post<{ created: Array<{ number: string }> }>("/api/finance/recurring/generate", {}),
  // Subscriptions
  subscriptions: (scope?: Scope) => api.get<{ subscriptions: Subscription[]; totals: { activeCount: number; monthlyPaise: number; yearlyPaise: number }; alerts: SubAlert[] }>(`/api/finance/subscriptions${q({ scope })}`),
  subscription: (id: string) => api.get<Subscription>(`/api/finance/subscriptions/${id}`),
  seatUsage: (scope?: Scope) => api.get<Array<{ subscriptionId: string; software: string; provider: string; plan: string | null; renewalOn: string | null; startup: string; person: string | null; email: string | null }>>(`/api/finance/subscriptions/usage${q({ scope })}`),
  createSubscription: (body: Record<string, unknown>) => api.post<Subscription>("/api/finance/subscriptions", body),
  updateSubscription: (id: string, body: Record<string, unknown>) => api.patch<Subscription>(`/api/finance/subscriptions/${id}`, body),
  assignSeat: (id: string, body: { userId?: string; name?: string; email?: string }) => api.post(`/api/finance/subscriptions/${id}/seats`, body),
  removeSeat: (seatId: string) => api.delete(`/api/finance/subscriptions/seats/${seatId}`),
  recordCharge: (id: string, body: { amount?: string; on: string; paid?: boolean; paymentRef?: string }) => api.post(`/api/finance/subscriptions/${id}/charges`, body),
  // Events
  events: (scope?: Scope) => api.get<FinanceEvent[]>(`/api/finance/events${q({ scope })}`),
  event: (id: string) => api.get<FinanceEvent>(`/api/finance/events/${id}`),
  createEvent: (body: Record<string, unknown>) => api.post<FinanceEvent>("/api/finance/events", body),
  updateEvent: (id: string, body: Record<string, unknown>) => api.patch<FinanceEvent>(`/api/finance/events/${id}`, body),
  addEventCost: (id: string, body: Record<string, unknown>) => api.post<Expense>(`/api/finance/events/${id}/costs`, body),


  // Payroll (CFO)
  payrollRuns: (startup?: string) => api.get<PayrollRunSummary[]>(`/api/finance/payroll/runs${q({ startup })}`),
  payrollRun: (id: string) => api.get<PayrollRun>(`/api/finance/payroll/runs/${id}`),
  createPayrollRun: (body: { kind: PayrollKind; startupId: string; year: number; month: number; basis?: "FIXED" | "ATTENDANCE" }) => api.post<{ id: string; skipped: Array<{ name: string; reason: string }> }>("/api/finance/payroll/runs", body),
  changePayrollLine: (runId: string, lineId: string, body: { adjustments?: Array<{ kind: AdjustmentKind; label: string; amount: string }>; hold?: boolean; note?: string }) => api.patch<PayrollRun>(`/api/finance/payroll/runs/${runId}/lines/${lineId}`, body),
  payrollAction: (runId: string, action: "submit" | "reopen") => api.post<PayrollRun>(`/api/finance/payroll/runs/${runId}/${action}`, {}),
  approvePayroll: (runId: string) => api.post<PayrollRun>(`/api/finance/payroll/runs/${runId}/approve`, { confirm: true }),
  cancelPayroll: (runId: string, reason: string) => api.post<PayrollRun>(`/api/finance/payroll/runs/${runId}/cancel`, { reason }),
  bankFile: (runId: string) => api.post<{ filename: string; csv: string; included: number; totalPaise: number; missing: string[] }>(`/api/finance/payroll/runs/${runId}/bank-file`, {}),
  payrollReport: (runId: string) => api.get<{ filename: string; csv: string }>(`/api/finance/payroll/runs/${runId}/report`),
  payLine: (runId: string, lineId: string, body: { paidOn: string; paymentRef?: string; paymentMethod?: PaymentMethod }) => api.post<PayrollRun>(`/api/finance/payroll/runs/${runId}/lines/${lineId}/pay`, body),
  failLine: (runId: string, lineId: string, reason: string) => api.post<PayrollRun>(`/api/finance/payroll/runs/${runId}/lines/${lineId}/fail`, { reason }),
  // My pay (staff)
  myPay: () => api.get<MyPay>("/api/finance/me/pay"),
  downloadPayslip: (itemId: string) => downloadFile(`/api/finance/payslips/${itemId}`, "payslip.pdf"),
  downloadStipendStatement: (payoutId: string) => downloadFile(`/api/finance/stipend-statements/${payoutId}`, "stipend-statement.pdf"),

  // Staff claims
  myClaims: () => api.get<Array<Expense & { category: { name: string }; startup: { name: string; code: string | null } }>>("/api/finance/me/claims"),
  claim: (id: string) => api.get<ExpenseDetail>(`/api/finance/me/claims/${id}`),
  submitClaim: (body: Record<string, unknown>) => api.post<Expense>("/api/finance/me/claims", body),
  updateClaim: (id: string, body: Record<string, unknown>) => api.patch<ExpenseDetail>(`/api/finance/me/claims/${id}`, body),
  resubmitClaim: (id: string) => api.post<ExpenseDetail>(`/api/finance/me/claims/${id}/submit`, {}),

  // Pay setup (CFO)
  paySetup: (startup?: string) => api.get<PaySetup>(`/api/finance/pay${q({ startup })}`),
  confirmPay: (employeeId: string, body: { monthlyGross: string; annualCtc?: string | null; effectiveFrom: string; components?: Array<{ name: string; amount: string }>; basis?: string; note?: string }) =>
    api.put(`/api/finance/pay/employees/${employeeId}/compensation`, body),
  confirmStipend: (internId: string, monthly: string, note?: string) => api.put(`/api/finance/pay/interns/${internId}/stipend`, { monthly, note }),
  saveBank: (body: { employeeId?: string; internId?: string; accountHolder: string; accountNumber: string; ifsc: string; bankName?: string; upiId?: string }) => api.put<Bank>("/api/finance/pay/bank", body),
};

/** ₹ in Indian grouping, from paise. */
export function inr(paise: number | null | undefined, opts: { compact?: boolean } = {}) {
  if (paise == null) return "—";
  const r = paise / 100;
  if (opts.compact && Math.abs(r) >= 100000) {
    return Math.abs(r) >= 10000000 ? `₹${(r / 10000000).toFixed(2).replace(/\.00$/, "")} Cr` : `₹${(r / 100000).toFixed(2).replace(/\.00$/, "")} L`;
  }
  return `₹${r.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** Plain words for statuses, as shown to people with no finance background. */
export const STATUS_LABEL: Record<ExpenseStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Waiting for approval",
  NEEDS_INFO: "More info needed",
  APPROVED: "Approved — to pay",
  REJECTED: "Rejected",
  PAID: "Paid",
  VOID: "Cancelled",
};

export const STATUS_TONE: Record<ExpenseStatus, string> = {
  DRAFT: "text-[#8b8b8b] bg-white/5",
  SUBMITTED: "text-amber-300 bg-amber-400/10",
  NEEDS_INFO: "text-orange-300 bg-orange-400/10",
  APPROVED: "text-sky-300 bg-sky-400/10",
  REJECTED: "text-red-300 bg-red-400/10",
  PAID: "text-[#c8f135] bg-[#c8f135]/10",
  VOID: "text-[#6b6b6b] bg-white/5 line-through",
};

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  BANK_TRANSFER: "Bank transfer", UPI: "UPI", CARD: "Card", CASH: "Cash", CHEQUE: "Cheque", OTHER: "Other",
};

export const today = () => new Date().toISOString().slice(0, 10);
