import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { env } from "../../config/env";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { loadFinance, requireCfo, requireFinance, canApprove, canSeePay } from "./access";
import * as expenses from "./expenses.service";
import * as pay from "./pay.service";
import * as roles from "./roles.service";
import { overview, visibleStartups } from "./overview.service";

/**
 * /api/finance — the CFO portal.
 *
 * Every route needs a signed-in user. Finance routes then need a finance role
 * (FinanceRole), and each service re-checks scope on the record itself, so a
 * startup finance manager can never reach another startup's data even by id.
 * Staff reimbursement claims (/me/claims) need no finance role — only that the
 * person works at the startup they claim for.
 */
const router = Router();
const ok = (res: any, data: unknown, status = 200) => res.status(status).json({ success: true, data });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_FILE_SIZE_MB * 1024 * 1024 } });

const uuid = z.string().uuid("Not found");
const idParam = z.object({ params: z.object({ id: uuid }) });
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const money = z.union([z.string().trim().min(1, "Enter an amount"), z.number()]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const scope = z.string().refine((v) => v === "central" || z.string().uuid().safeParse(v).success, "Choose central DevUp or a startup");
const method = z.enum(["BANK_TRANSFER", "UPI", "CARD", "CASH", "CHEQUE", "OTHER"]);

const expenseFields = {
  scope,
  title: z.string().trim().min(2, "Give the expense a short title").max(200),
  description: text(2000),
  businessPurpose: text(1000),
  categoryId: uuid,
  vendorId: uuid.nullable().optional(),
  payee: text(200),
  amount: money,
  currency: z.string().trim().length(3).optional(),
  originalAmount: money.nullable().optional(),
  incurredOn: date,
  dueOn: date.nullable().optional(),
  paymentMethod: method.nullable().optional(),
  notes: text(2000),
};

router.use(requireAuth, loadFinance);

/* What the signed-in person can do */

router.get("/me", async (req, res) => {
  const a = req.finance!;
  ok(res, {
    roles: a.roles,
    isCfo: a.isCfo,
    viewAll: a.viewAll,
    canApprove: canApprove(a),
    canSeePay: canSeePay(a),
    canManageAnything: a.isCfo || a.manageStartups.size > 0,
    startups: a.roles.length ? await visibleStartups(a) : [],
    claimStartups: await expenses.myStartups(req.user!.id),
  });
});

router.get("/categories", async (_req, res) => ok(res, await expenses.listCategories()));

/* Staff reimbursement claims — no finance role needed */

const claimBody = z.object({ ...expenseFields, businessPurpose: z.string().trim().min(3, "Say what the expense was for").max(1000), draft: z.boolean().optional() });

router.get("/me/claims", async (req, res) => ok(res, await expenses.myClaims(req.user!.id)));
router.post("/me/claims", validate(z.object({ body: claimBody })), async (req, res) => ok(res, await expenses.submitClaim(req.user!.id, req.body), 201));
router.get("/me/claims/:id", validate(idParam), async (req, res) => ok(res, await expenses.getExpense(req.finance!, req.params.id as string)));
router.patch("/me/claims/:id", validate(idParam.extend({ body: claimBody.partial() })), async (req, res) =>
  ok(res, await expenses.updateExpense(req.finance!, req.params.id as string, req.body)));
router.post("/me/claims/:id/submit", validate(idParam), async (req, res) => ok(res, await expenses.submitExpense(req.finance!, req.params.id as string)));
router.delete("/me/claims/:id", validate(idParam), async (req, res) => ok(res, await expenses.deleteDraft(req.finance!, req.params.id as string)));
router.post("/me/claims/:id/attachments", upload.single("file"), validate(idParam), async (req, res) =>
  ok(res, await expenses.addAttachment(req.finance!, req.params.id as string, req.file, String(req.body?.kind ?? "RECEIPT")), 201));

/** A short-lived link to a receipt; the service checks the caller may see the record it belongs to. */
router.get("/attachments/:id/link", validate(idParam), async (req, res) => ok(res, await expenses.attachmentLink(req.finance!, req.params.id as string)));

/* Super admin: who has finance access (no finance role needed, and none implied) */

const superAdmin = requireRole(["SUPER_ADMIN"]);
router.get("/roles", superAdmin, async (_req, res) => ok(res, await roles.listRoles()));
router.get("/roles/candidates", superAdmin, validate(z.object({ query: z.object({ q: z.string().trim().min(2).max(100) }) })), async (req, res) =>
  ok(res, await roles.findCandidates(String(req.query.q))));
router.get("/roles/log", superAdmin, async (_req, res) => ok(res, await roles.accessLog()));
/** Every startup, active or not — to choose which one a finance manager or viewer covers. */
router.get("/roles/startups", superAdmin, async (_req, res) => ok(res, await roles.allStartups()));
router.post(
  "/roles",
  superAdmin,
  validate(z.object({ body: z.object({ userId: uuid, role: z.enum(["ECOSYSTEM_CFO", "STARTUP_FINANCE_MANAGER", "FINANCE_VIEWER"]), startupId: uuid.nullable().optional(), note: text(500) }) })),
  async (req, res) => ok(res, await roles.grantRole({ actorId: req.user!.id, userId: req.body.userId, role: req.body.role, startupId: req.body.startupId, note: req.body.note }), 201),
);
router.post("/roles/:id/revoke", superAdmin, validate(idParam.extend({ body: z.object({ reason: text(500) }) })), async (req, res) =>
  ok(res, await roles.revokeRole({ actorId: req.user!.id, roleId: req.params.id as string, reason: req.body?.reason })));

/* Everything below needs a finance role */

router.use(requireFinance);

const periodQuery = z.object({
  query: z.object({
    scope: z.string().optional(),
    period: z.enum(["day", "week", "month", "quarter", "year", "custom"]).optional(),
    anchor: date.optional(),
    from: date.optional(),
    to: date.optional(),
  }),
});

router.get("/overview", validate(periodQuery), async (req, res) => ok(res, await overview(req.finance!, req.query as any)));
router.get("/startups", async (req, res) => ok(res, await visibleStartups(req.finance!)));

router.get("/vendors", async (req, res) => ok(res, await expenses.listVendors(typeof req.query.q === "string" ? req.query.q : undefined)));
router.post(
  "/vendors",
  validate(z.object({ body: z.object({ name: z.string().trim().min(2, "Enter the vendor's name").max(160), kind: text(60), contactName: text(120), contactEmail: z.string().trim().email().max(200).nullable().optional().or(z.literal("")), contactPhone: text(30), gstin: text(20), notes: text(1000) }) })),
  async (req, res) => ok(res, await expenses.createVendor(req.finance!, req.body), 201),
);

const listQuery = z.object({
  query: z.object({
    scope: z.string().optional(),
    status: z.enum(["DRAFT", "SUBMITTED", "NEEDS_INFO", "APPROVED", "REJECTED", "PAID", "VOID"]).optional(),
    kind: z.enum(["VENDOR_BILL", "REIMBURSEMENT", "ADJUSTMENT"]).optional(),
    categoryId: uuid.optional(),
    vendorId: uuid.optional(),
    from: date.optional(),
    to: date.optional(),
    q: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
  }),
});

router.get("/expenses", validate(listQuery), async (req, res) => {
  const q = req.query as Record<string, string>;
  ok(res, await expenses.listExpenses(req.finance!, { ...q, page: q.page ? Number(q.page) : undefined, pageSize: q.pageSize ? Number(q.pageSize) : undefined } as any));
});
router.post(
  "/expenses",
  validate(z.object({ body: z.object({ ...expenseFields, kind: z.enum(["VENDOR_BILL", "REIMBURSEMENT"]).optional(), action: z.enum(["draft", "submit", "paid"]).optional(), paymentRef: text(120), paidOn: date.nullable().optional() }) })),
  async (req, res) => ok(res, await expenses.createExpense(req.finance!, req.body), 201),
);
router.get("/expenses/:id", validate(idParam), async (req, res) => ok(res, await expenses.getExpense(req.finance!, req.params.id as string)));
router.patch("/expenses/:id", validate(idParam.extend({ body: z.object(expenseFields).partial() })), async (req, res) =>
  ok(res, await expenses.updateExpense(req.finance!, req.params.id as string, req.body)));
router.delete("/expenses/:id", validate(idParam), async (req, res) => ok(res, await expenses.deleteDraft(req.finance!, req.params.id as string)));

router.post("/expenses/:id/submit", validate(idParam), async (req, res) => ok(res, await expenses.submitExpense(req.finance!, req.params.id as string)));
router.post("/expenses/:id/approve", validate(idParam.extend({ body: z.object({ note: text(1000) }).optional() })), async (req, res) =>
  ok(res, await expenses.approveExpense(req.finance!, req.params.id as string, req.body?.note)));
router.post("/expenses/:id/reject", validate(idParam.extend({ body: z.object({ reason: z.string().trim().min(3, "Say why").max(1000) }) })), async (req, res) =>
  ok(res, await expenses.rejectExpense(req.finance!, req.params.id as string, req.body.reason)));
router.post("/expenses/:id/request-info", validate(idParam.extend({ body: z.object({ message: z.string().trim().min(3, "Say what is needed").max(1000) }) })), async (req, res) =>
  ok(res, await expenses.requestInfo(req.finance!, req.params.id as string, req.body.message)));
router.post("/expenses/:id/void", validate(idParam.extend({ body: z.object({ reason: z.string().trim().min(3, "Say why").max(1000) }) })), async (req, res) =>
  ok(res, await expenses.voidExpense(req.finance!, req.params.id as string, req.body.reason)));
router.post("/expenses/:id/pay", validate(idParam.extend({ body: z.object({ paidOn: date.nullable().optional(), paymentMethod: method.nullable().optional(), paymentRef: text(120) }) })), async (req, res) =>
  ok(res, await expenses.markPaid(req.finance!, req.params.id as string, req.body)));
router.post("/expenses/:id/correct", validate(idParam.extend({ body: z.object({ amount: money, reason: z.string().trim().min(3, "Say what the correction is for").max(1000), on: date.nullable().optional(), paymentRef: text(120) }) })), async (req, res) =>
  ok(res, await expenses.correctPaid(req.finance!, req.params.id as string, req.body), 201));
router.put(
  "/expenses/:id/allocations",
  validate(idParam.extend({
    body: z.object({
      method: z.enum(["FIXED", "PERCENT", "HEADCOUNT", "USAGE", "CUSTOM"]),
      shares: z.array(z.object({ scope, percent: z.union([z.number(), z.string()]).optional(), amount: money.optional(), units: z.union([z.number(), z.string()]).optional() })).max(50),
      note: text(500),
    }),
  })),
  async (req, res) => ok(res, await expenses.setAllocations(req.finance!, req.params.id as string, req.body)),
);
router.post("/expenses/:id/attachments", upload.single("file"), validate(idParam), async (req, res) =>
  ok(res, await expenses.addAttachment(req.finance!, req.params.id as string, req.file, String(req.body?.kind ?? "RECEIPT")), 201));

/* Pay setup — the CFO only */

router.get("/pay", requireCfo, async (req, res) => ok(res, await pay.paySetup(req.finance!, typeof req.query.startup === "string" ? req.query.startup : null)));
router.put(
  "/pay/employees/:id/compensation",
  requireCfo,
  validate(idParam.extend({
    body: z.object({
      monthlyGross: money,
      annualCtc: money.nullable().optional(),
      components: z.array(z.object({ name: z.string().trim().min(1).max(60), amount: money })).max(20).optional(),
      effectiveFrom: date,
      frequency: z.enum(["MONTHLY", "WEEKLY", "BIWEEKLY"]).optional(),
      basis: z.enum(["CONFIRMED_FROM_HR", "ENTERED"]).optional(),
      note: text(500),
    }),
  })),
  async (req, res) => ok(res, await pay.confirmCompensation(req.finance!, req.params.id as string, req.body)),
);
router.put("/pay/interns/:id/stipend", requireCfo, validate(idParam.extend({ body: z.object({ monthly: money, note: text(500) }) })), async (req, res) =>
  ok(res, await pay.confirmStipend(req.finance!, req.params.id as string, req.body)));
router.put(
  "/pay/bank",
  requireCfo,
  validate(z.object({
    body: z.object({
      employeeId: uuid.nullable().optional(), internId: uuid.nullable().optional(),
      accountHolder: z.string().trim().min(2).max(120), accountNumber: z.string().trim().min(9).max(24), ifsc: z.string().trim().length(11, "IFSC codes are 11 characters"),
      bankName: text(120), upiId: text(260),
    }),
  })),
  async (req, res) => ok(res, await pay.saveBankAccount(req.finance!, req.body)),
);

export default router;
