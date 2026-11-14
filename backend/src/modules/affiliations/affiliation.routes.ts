import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import * as affiliation from "./affiliation.service";
import * as offerLetters from "./offerLetter.service";

const ok = (res: any, data: unknown, status = 200) => res.status(status).json({ success: true, data });

const id = z.string().uuid("Unknown request");
const optionalText = (max: number) => z.string().trim().max(max).optional();
const optionalDate = z
  .string()
  .refine((v) => v === "" || !Number.isNaN(Date.parse(v)), "Use a valid date")
  .optional();

/**
 * Only these fields are read. Anything else in the body — status, role,
 * userId, email — is stripped by zod before the service ever sees it.
 */
const requestBody = z.object({
  kind: z.enum(["EMPLOYEE", "INTERN"], { error: "Choose Intern or Employee" }),
  fullName: z.string().trim().min(2, "Enter your full name").max(120),
  phone: z
    .string()
    .trim()
    .regex(/^[+\d][\d\s-]{6,19}$/, "Enter a valid phone number")
    .optional()
    .or(z.literal("")),
  department: optionalText(120),
  designation: optionalText(120),
  college: optionalText(200),
  joiningDate: optionalDate,
  endDate: optionalDate,
  note: optionalText(1000),
});

// ── Requester: /api/me/affiliations ──────────────────────────────────────
export const meAffiliationRouter = Router();
meAffiliationRouter.use(requireAuth);

meAffiliationRouter.get("/", async (req, res) => {
  ok(res, await affiliation.myAffiliations(req.user!.id));
});

meAffiliationRouter.get("/startups", async (req, res) => {
  ok(res, await affiliation.joinableStartups(req.user!.id));
});

meAffiliationRouter.get(
  "/employment",
  validate(z.object({ query: z.object({ startup: z.string().regex(/^[A-Za-z0-9]{2,5}$/).optional() }) })),
  async (req, res) => {
    ok(res, await affiliation.myEmployment(req.user!.id, req.query.startup as string | undefined));
  }
);

meAffiliationRouter.post(
  "/",
  validate(z.object({ body: requestBody.extend({ startupId: z.string().uuid("Choose a startup") }) })),
  async (req, res) => {
    ok(res, await affiliation.submitRequest(req.user!.id, req.body), 201);
  }
);

meAffiliationRouter.patch(
  "/:id",
  validate(z.object({ params: z.object({ id }), body: requestBody.partial() })),
  async (req, res) => {
    ok(res, await affiliation.updateRequest(req.user!.id, req.params.id as string, req.body));
  }
);

meAffiliationRouter.post(
  "/:id/cancel",
  validate(z.object({ params: z.object({ id }) })),
  async (req, res) => {
    ok(res, await affiliation.cancelRequest(req.user!.id, req.params.id as string));
  }
);

// ── Startup admin: mounted into the tenant workspace router ──────────────
export const approveBody = z.object({
  designation: optionalText(120),
  department: optionalText(120),
  joiningDate: optionalDate,
  endDate: optionalDate,
  supervisorUserId: z.string().uuid().optional(),
  issueOfferLetter: z.boolean().optional(),
  stipend: optionalText(120),
  ctc: optionalText(120),
  workMode: z.enum(["OFFICE", "REMOTE", "HYBRID"]).optional(),
  location: optionalText(200),
});
export const reasonBody = (field: "reason" | "message", label: string) =>
  z.object({ [field]: z.string().trim().min(3, `${label} (at least 3 characters)`).max(1000) });

// ── Platform admin: /api/admin/affiliations ──────────────────────────────
export const adminAffiliationRouter = Router();
// requireRole(["ADMIN"]) also admits SUPER_ADMIN. Startup-level admins are
// not platform admins and never pass this.
adminAffiliationRouter.use(requireAuth, requireRole(["ADMIN"]));

adminAffiliationRouter.get("/overview", async (_req, res) => {
  ok(res, await affiliation.platformOverview());
});

/**
 * Join requests across all startups. DevUp admins review them with exactly the
 * same rules as a startup's own HR (same service calls, same checks, same
 * offer letter and audit trail); the request's own startup is the tenant.
 */
adminAffiliationRouter.get(
  "/requests",
  validate(
    z.object({
      query: z.object({
        status: z.string().optional(),
        startup: z.string().regex(/^[A-Za-z0-9]{2,5}$/).optional(),
      }),
    })
  ),
  async (req, res) => {
    ok(res, await affiliation.listAllRequests({ status: req.query.status as string | undefined, startupCode: req.query.startup as string | undefined }));
  }
);

adminAffiliationRouter.get("/requests/:id", validate(z.object({ params: z.object({ id }) })), async (req, res) => {
  const startup = await affiliation.requestStartup(req.params.id as string);
  ok(res, { ...(await affiliation.getRequest(startup.id, req.params.id as string)), startup });
});

adminAffiliationRouter.post(
  "/requests/:id/approve",
  validate(z.object({ params: z.object({ id }), body: approveBody })),
  async (req, res) => {
    const startup = await affiliation.requestStartup(req.params.id as string);
    ok(
      res,
      await affiliation.approveRequest({
        ...req.body,
        startupId: startup.id,
        startupCode: startup.code ?? "GEN",
        requestId: req.params.id as string,
        actorId: req.user!.id,
      })
    );
  }
);

adminAffiliationRouter.post(
  "/requests/:id/reject",
  validate(z.object({ params: z.object({ id }), body: reasonBody("reason", "Give a reason") })),
  async (req, res) => {
    const startup = await affiliation.requestStartup(req.params.id as string);
    ok(res, await affiliation.rejectRequest({ startupId: startup.id, requestId: req.params.id as string, actorId: req.user!.id, reason: req.body.reason }));
  }
);

adminAffiliationRouter.post(
  "/requests/:id/request-info",
  validate(z.object({ params: z.object({ id }), body: reasonBody("message", "Say what you need") })),
  async (req, res) => {
    const startup = await affiliation.requestStartup(req.params.id as string);
    ok(res, await affiliation.requestMoreInfo({ startupId: startup.id, requestId: req.params.id as string, actorId: req.user!.id, message: req.body.message }));
  }
);

adminAffiliationRouter.post("/requests/:id/offer", validate(z.object({ params: z.object({ id }) })), async (req, res) => {
  const startup = await affiliation.requestStartup(req.params.id as string);
  const result = await offerLetters.retryOfferLetter({ startupId: startup.id, requestId: req.params.id as string, actorId: req.user!.id });
  ok(res, { ...result, message: offerLetters.offerReasonText(result.error) });
});
