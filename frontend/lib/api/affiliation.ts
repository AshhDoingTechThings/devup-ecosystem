import { api } from "./client";

/**
 * Employee / intern affiliation with a startup.
 *
 * Every status here is read from the server. The client never decides what
 * someone may open — it only shows what the API says and asks it to act.
 */

export type AffiliationKind = "INTERN" | "EMPLOYEE";
export type AffiliationStatus =
  | "ACTIVE"
  | "PENDING"
  | "NEEDS_INFO"
  | "REJECTED"
  | "DEACTIVATED"
  | "INVITED"
  | "APPROVED"
  | "CANCELLED";

export interface AffiliationItem {
  startup: { id: string; name: string; code: string | null; logoUrl: string | null };
  status: AffiliationStatus;
  kind: AffiliationKind | null;
  role: string | null;
  requestId?: string;
  reviewNote?: string | null;
  designation?: string | null;
  department?: string | null;
  submittedAt?: string;
  reviewedAt?: string | null;
  joinedAt?: string | null;
  deactivatedAt?: string | null;
  canEnter: boolean;
  destination: string | null;
}

export interface MyAffiliations {
  emailVerified: boolean;
  isPlatformAdmin: boolean;
  items: AffiliationItem[];
}

export interface JoinableStartup {
  id: string;
  name: string;
  logoUrl: string | null;
  tagline: string | null;
  description: string | null;
  category: string | null;
  type: string | null;
  location: string | null;
  affiliation: { status: AffiliationStatus; kind: string | null } | null;
}

export interface JoinRequestInput {
  kind: AffiliationKind;
  fullName: string;
  phone?: string;
  department?: string;
  designation?: string;
  college?: string;
  joiningDate?: string;
  endDate?: string;
  note?: string;
}

export interface EmploymentRecord {
  kind: AffiliationKind;
  personId: string;
  code: string;
  fullName: string;
  designation: string;
  department: string | null;
  employmentType: string;
  status: string;
  startDate: string;
  endDate: string | null;
  college: string | null;
  supervisor: string | null;
  onboardingCompletedAt: string | null;
  startup: { id: string; name: string; code: string; logoUrl: string | null; tagline: string | null; domain: string | null };
}

export const affiliationApi = {
  mine: () => api.get<MyAffiliations>("/api/me/affiliations"),
  startups: () => api.get<JoinableStartup[]>("/api/me/affiliations/startups"),
  employment: (code?: string) =>
    api.get<EmploymentRecord[]>(`/api/me/affiliations/employment${code ? `?startup=${encodeURIComponent(code)}` : ""}`),
  submit: (startupId: string, body: JoinRequestInput) =>
    api.post<{ id: string; status: AffiliationStatus }>("/api/me/affiliations", { ...body, startupId }),
  update: (id: string, body: Partial<JoinRequestInput>) =>
    api.patch<{ id: string; status: AffiliationStatus }>(`/api/me/affiliations/${id}`, body),
  cancel: (id: string) => api.post<{ cancelled: boolean }>(`/api/me/affiliations/${id}/cancel`, {}),
};

const w = (code: string, path: string) => `/api/w/${code}${path}`;

export const joinRequestAdminApi = {
  list: (code: string, status = "ALL") => api.get<any>(w(code, `/join-requests?status=${status}`)),
  get: (code: string, id: string) => api.get<any>(w(code, `/join-requests/${id}`)),
  approve: (code: string, id: string, body: Record<string, unknown>) => api.post<any>(w(code, `/join-requests/${id}/approve`), body),
  reject: (code: string, id: string, reason: string) => api.post<any>(w(code, `/join-requests/${id}/reject`), { reason }),
  requestInfo: (code: string, id: string, message: string) =>
    api.post<any>(w(code, `/join-requests/${id}/request-info`), { message }),
  /** Send, or re-send after a failure, the offer letter of an approved request. */
  retryOffer: (code: string, id: string) => api.post<any>(w(code, `/join-requests/${id}/offer`), {}),
  affiliates: (code: string) => api.get<any[]>(w(code, "/team/affiliates")),
  deactivate: (code: string, personId: string, reason?: string) =>
    api.post<any>(w(code, `/team/${personId}/deactivate`), { reason }),
  reactivate: (code: string, personId: string) => api.post<any>(w(code, `/team/${personId}/reactivate`), {}),
};

export const platformAffiliationApi = {
  overview: () => api.get<any>("/api/admin/affiliations/overview"),
};

/** One label and tone per status, shared by every screen that shows a badge. */
export const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  ACTIVE: { label: "Active", className: "bg-[#c8f135]/10 text-[#c8f135] border-[#c8f135]/25" },
  APPROVED: { label: "Approved", className: "bg-[#c8f135]/10 text-[#c8f135] border-[#c8f135]/25" },
  PENDING: { label: "Pending approval", className: "bg-amber-500/10 text-amber-300 border-amber-500/25" },
  NEEDS_INFO: { label: "Info requested", className: "bg-sky-500/10 text-sky-300 border-sky-500/25" },
  INVITED: { label: "Invited", className: "bg-sky-500/10 text-sky-300 border-sky-500/25" },
  REJECTED: { label: "Not approved", className: "bg-red-500/10 text-red-300 border-red-500/25" },
  DEACTIVATED: { label: "Deactivated", className: "bg-white/5 text-[#8b8b8b] border-white/10" },
  CANCELLED: { label: "Withdrawn", className: "bg-white/5 text-[#8b8b8b] border-white/10" },
  NO_ACCOUNT: { label: "No account yet", className: "bg-white/5 text-[#8b8b8b] border-white/10" },
  NOTICE: { label: "Notice period", className: "bg-amber-500/10 text-amber-300 border-amber-500/25" },
};

export const ROLE_LABEL: Record<string, string> = {
  INTERN: "Intern",
  EMPLOYEE: "Employee",
  MEMBER: "Member",
  MANAGER: "Manager",
  RECRUITER: "Recruiter",
  HR: "HR",
  ADMIN: "Admin",
  OWNER: "Owner",
  FOUNDER: "Founder",
  SUPER_ADMIN: "Platform admin",
};

export const CATEGORY_LABEL: Record<string, string> = {
  AI_ML: "AI/ML", FINTECH: "FinTech", HEALTHTECH: "HealthTech", DEVTOOLS: "DevTools", SAAS: "SaaS",
  EDTECH: "EdTech", WEB3: "Web3", E_COMMERCE: "E-commerce", CLEANTECH: "CleanTech", DEEPTECH: "DeepTech", OTHER: "Other",
};
