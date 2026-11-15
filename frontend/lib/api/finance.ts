import { api, apiClient } from "./client";

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
    budgetAllocatedPaise: number | null; moneyReceivedPaise: number | null; expectedFromStartupsPaise: number | null;
    monthlySubscriptionsPaise: number | null; cashBalancePaise: number | null;
  };
  payroll: null | {
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
