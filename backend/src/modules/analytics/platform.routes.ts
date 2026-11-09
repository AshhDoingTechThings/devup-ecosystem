import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth";
import * as analytics from "./analytics.service";
import { prisma } from "../../lib/prisma";
import { pageParams, textParam } from "../../lib/listQuery";

const router = Router();
const ok = (res: any, data: unknown) => res.json({ success: true, data });

// Platform-wide figures. Aggregates only — never applicant PII.
router.use(requireAuth, requireRole(["ADMIN", "SUPER_ADMIN"]));

router.get("/overview", async (_req, res) => ok(res, await analytics.platformOverview()));
router.get("/comparison", async (_req, res) => ok(res, await analytics.startupComparison()));
router.get("/funnel", async (_req, res) => ok(res, await analytics.platformFunnel()));
router.get("/colleges", async (_req, res) => ok(res, await analytics.platformColleges()));

router.get("/trends", async (req, res) => {
  // Up to three years back; anything else is a 400 rather than an Invalid Date.
  const months = pageParams({ limit: req.query.months }, { defaultLimit: 6, maxLimit: 36 }).limit;
  const since = new Date();
  since.setMonth(since.getMonth() - months);

  const rows = await prisma.$queryRaw<Array<{ month: string; applications: bigint; hired: bigint }>>`
    SELECT to_char(date_trunc('month', "appliedAt"), 'YYYY-MM') AS month,
           count(*)                                             AS applications,
           count(*) FILTER (WHERE "outcome" = 'HIRED')          AS hired
    FROM "JobApplication"
    WHERE "appliedAt" >= ${since}
    GROUP BY 1 ORDER BY 1
  `;

  ok(
    res,
    rows.map((r) => ({
      month: r.month,
      applications: Number(r.applications),
      hired: Number(r.hired),
    }))
  );
});

router.get("/audit", async (req, res) => {
  const { limit } = pageParams(req.query, { defaultLimit: 50, maxLimit: 200 });
  const entity = textParam(req.query.entity, "entity");
  ok(
    res,
    await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      ...(entity ? { where: { entity } } : {}),
    })
  );
});

export default router;
