/**
 * Employee & intern affiliation, end to end: a person asks to join a startup,
 * that startup's admins decide, and only an approval grants access — to that
 * startup and no other. Real Express app and Postgres via the harness.
 *
 * Covers the lifecycle scenarios (new intern, new employee, several startups,
 * restricted states, platform admin) and the tenant-isolation checks.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { startHarness, testDatabaseUrl, Person } from "./support/harness";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR-fake-image-data")]);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const DB = testDatabaseUrl();
if (!DB) {
  test("startup affiliation (needs TEST_DATABASE_URL on localhost)", { skip: true }, () => {});
} else {
  describe("startup affiliation", () => {
    let h: Awaited<ReturnType<typeof startHarness>>;
    let zappy: any, yarnia: any, elunora: any;
    let zFounder: Person, zHr: Person, zManager: Person, yFounder: Person, eFounder: Person;
    let superAdmin: Person, platformAdmin: Person;

    const seat = (startupId: string, p: Person, role: string, status = "ACTIVE") =>
      h.prisma.startupMember.create({
        data: { startupId, userId: p.id, email: p.email, role, status, invitedBy: p.id, inviteToken: sha(randomUUID()) },
      });

    const ask = (p: Person, startupId: string, kind: "INTERN" | "EMPLOYEE", extra: Record<string, unknown> = {}) =>
      h.call("POST", "/api/me/affiliations", p.token, {
        startupId,
        kind,
        fullName: `${p.email.split("@")[0]} Full`,
        phone: "+91 98765 43210",
        department: "Engineering",
        designation: kind === "INTERN" ? "Frontend Intern" : "Backend Engineer",
        ...(kind === "INTERN" ? { college: "VJIT", joiningDate: "2026-11-01", endDate: "2027-04-30" } : { joiningDate: "2026-11-01" }),
        ...extra,
      });

    const w = (s: any, path: string) => `/api/w/${s.code}${path}`;
    const approve = (s: any, by: Person, id: string, body: Record<string, unknown> = {}) =>
      h.call("POST", w(s, `/join-requests/${id}/approve`), by.token, body);
    const mine = async (p: Person) => (await h.call("GET", "/api/me/affiliations", p.token)).body.data;
    const entry = async (p: Person, s: any) => (await mine(p)).items.find((i: any) => i.startup.id === s.id);

    /** A verified user who has asked to join `s` and been approved by its founder. */
    async function approvedMember(tag: string, s: any, founder: Person, kind: "INTERN" | "EMPLOYEE") {
      const p = await h.person(tag);
      const r = await ask(p, s.id, kind);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const a = await approve(s, founder, r.body.data.id);
      assert.equal(a.status, 200, JSON.stringify(a.body));
      return { person: p, requestId: r.body.data.id as string, personId: a.body.data.personId as string };
    }

    before(async () => {
      h = await startHarness(DB);
      zFounder = await h.person("zfounder", "FOUNDER");
      yFounder = await h.person("yfounder", "FOUNDER");
      eFounder = await h.person("efounder", "FOUNDER");
      zappy = await h.startup(zFounder, { name: "Zappy" });
      yarnia = await h.startup(yFounder, { name: "Yarnia Kroshay" });
      elunora = await h.startup(eFounder, { name: "Elunora Crafts" });
      zHr = await h.person("zhr");
      await seat(zappy.id, zHr, "HR");
      zManager = await h.person("zmanager");
      await seat(zappy.id, zManager, "MANAGER");
      superAdmin = await h.person("superadmin", "SUPER_ADMIN");
      platformAdmin = await h.person("platformadmin", "ADMIN");
    });
    after(async () => h?.close());

    // ── Scenario A — new intern ──────────────────────────────────────────
    test("A. new intern: request → review → approve → intern dashboard → upload", async () => {
      const intern = await h.person("intern-a");

      // Startups come from the database, with this person's status on each.
      const list = await h.call("GET", "/api/me/affiliations/startups", intern.token);
      assert.equal(list.status, 200);
      const z = list.body.data.find((s: any) => s.id === zappy.id);
      assert.ok(z, "Zappy is listed");
      assert.equal(z.affiliation, null);
      assert.ok(!("code" in z), "workspace codes are not needed to choose a startup");

      const r = await ask(intern, zappy.id, "INTERN");
      assert.equal(r.status, 201);
      assert.equal(r.body.data.status, "PENDING");

      // Reviewers hear about it in-app.
      const notes = await h.prisma.notification.findMany({ where: { userId: { in: [zFounder.id, zHr.id] } } });
      assert.ok(notes.some((n: any) => n.userId === zHr.id && /intern request/i.test(n.title)));

      // While pending: no dashboard, no records, no workspace.
      assert.equal((await entry(intern, zappy)).status, "PENDING");
      assert.equal((await entry(intern, zappy)).canEnter, false);
      assert.equal((await h.call("GET", w(zappy, "/dashboard"), intern.token)).status, 404);
      assert.deepEqual((await h.call("GET", "/api/me/affiliations/employment", intern.token)).body.data, []);
      assert.deepEqual((await h.call("GET", "/api/me/onboarding", intern.token)).body.data, []);

      // HR sees it and opens it.
      const queue = await h.call("GET", w(zappy, "/join-requests?status=OPEN"), zHr.token);
      assert.equal(queue.status, 200);
      assert.ok(queue.body.data.items.some((i: any) => i.id === r.body.data.id));
      assert.ok(queue.body.data.summary.pending >= 1);
      const detail = await h.call("GET", w(zappy, `/join-requests/${r.body.data.id}`), zHr.token);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.user.emailVerified, true);
      assert.equal(detail.body.data.college, "VJIT");
      assert.deepEqual(detail.body.data.history.map((e: any) => e.action), ["affiliation.requested"]);

      // Approve.
      const a = await approve(zappy, zHr, r.body.data.id);
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.equal(a.body.data.kind, "INTERN");
      assert.match(a.body.data.code, new RegExp(zappy.code));

      const record = await h.prisma.intern.findUnique({ where: { id: a.body.data.personId } });
      assert.equal(record.userId, intern.id);
      assert.equal(record.status, "ACTIVE");
      assert.equal(record.designation, "Frontend Intern");
      const membership = await h.prisma.startupMember.findFirst({ where: { startupId: zappy.id, userId: intern.id } });
      assert.equal(membership.status, "ACTIVE");
      assert.equal(membership.role, "INTERN");
      // The platform role is never rewritten to describe a startup job.
      assert.equal((await h.prisma.user.findUnique({ where: { id: intern.id } })).role, "STUDENT");

      // Approving again creates nothing new.
      const again = await approve(zappy, zFounder, r.body.data.id);
      assert.equal(again.status, 200);
      assert.equal(again.body.data.alreadyApproved, true);
      assert.equal(await h.prisma.intern.count({ where: { startupId: zappy.id, userId: intern.id } }), 1);
      assert.equal(await h.prisma.startupMember.count({ where: { startupId: zappy.id, userId: intern.id } }), 1);

      // Now: active, routed to the existing intern dashboard for this startup.
      const now = await entry(intern, zappy);
      assert.equal(now.status, "ACTIVE");
      assert.equal(now.canEnter, true);
      assert.equal(now.destination, `/dashboard/internship?startup=${zappy.code}`);

      const employment = await h.call("GET", `/api/me/affiliations/employment?startup=${zappy.code}`, intern.token);
      assert.equal(employment.body.data.length, 1);
      assert.equal(employment.body.data[0].kind, "INTERN");
      assert.equal(employment.body.data[0].college, "VJIT");

      // Onboarding: checklist appears, upload goes to the private identity bucket.
      const onboarding = await h.call("GET", "/api/me/onboarding", intern.token);
      assert.equal(onboarding.body.data.length, 1);
      const form = new FormData();
      form.append("docType", "PHOTO");
      form.append("file", new Blob([PNG], { type: "image/png" }), "me.png");
      const up = await h.upload(`/api/me/onboarding/${record.id}/documents`, form, { Authorization: `Bearer ${intern.token}` });
      assert.equal(up.status, 201, JSON.stringify(up.body));
      assert.equal(h.stored.at(-1)?.bucket, "identity-documents");
      const doc = await h.prisma.onboardingDocument.findFirst({ where: { internId: record.id } });
      assert.equal(doc.fileUrl, null, "no public URL is stored");
      assert.ok(doc.storagePath);

      // An intern is still not staff: the hiring workspace stays closed.
      assert.equal((await h.call("GET", w(zappy, "/dashboard"), intern.token)).status, 403);

      // History shows both steps, in order.
      const history = (await h.call("GET", w(zappy, `/join-requests/${r.body.data.id}`), zHr.token)).body.data.history;
      // No branding is configured for this startup, so the letter could not be
      // issued — recorded, and the approval stood regardless.
      assert.deepEqual(history.map((e: any) => e.action), ["affiliation.requested", "affiliation.approved", "affiliation.offer_failed"]);
      assert.equal(a.body.data.offer.status, "FAILED");
      assert.equal(a.body.data.offer.error, "BRANDING_MISSING");
    });

    // ── Scenario B — new employee ────────────────────────────────────────
    test("B. new employee: approve with admin's designation → employee dashboard", async () => {
      const emp = await h.person("employee-b");
      const r = await ask(emp, zappy.id, "EMPLOYEE");
      assert.equal(r.status, 201);

      const a = await approve(zappy, zFounder, r.body.data.id, {
        designation: "Senior Backend Engineer",
        department: "Platform",
        supervisorUserId: zHr.id,
      });
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.equal(a.body.data.kind, "EMPLOYEE");

      const record = await h.prisma.employee.findUnique({ where: { id: a.body.data.personId } });
      assert.equal(record.userId, emp.id);
      assert.equal(record.designation, "Senior Backend Engineer");
      assert.equal(record.department, "Platform");
      assert.equal(record.managerId, zHr.id);

      const e = await entry(emp, zappy);
      assert.equal(e.status, "ACTIVE");
      assert.equal(e.role, "EMPLOYEE");
      assert.equal(e.destination, `/dashboard/employment?startup=${zappy.code}`);

      const employment = (await h.call("GET", "/api/me/affiliations/employment", emp.token)).body.data;
      assert.equal(employment[0].kind, "EMPLOYEE");
      assert.equal(employment[0].supervisor, "zhr person");

      // A supervisor from outside the startup is refused.
      const other = await h.person("employee-b2");
      const r2 = await ask(other, zappy.id, "EMPLOYEE");
      const bad = await approve(zappy, zFounder, r2.body.data.id, { supervisorUserId: yFounder.id });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, "INVALID_SUPERVISOR");
      // …and the failed approval left the request open (the transaction rolled back).
      assert.equal((await h.prisma.startupJoinRequest.findUnique({ where: { id: r2.body.data.id } })).status, "PENDING");
      assert.equal(await h.prisma.employee.count({ where: { startupId: zappy.id, email: other.email } }), 0);
    });

    // ── Scenario C — several startups ────────────────────────────────────
    test("C. one person, several startups: each approved separately, data stays apart", async () => {
      const p = await h.person("multi");
      const rz = await ask(p, zappy.id, "INTERN");
      const ry = await ask(p, yarnia.id, "EMPLOYEE");
      const re = await ask(p, elunora.id, "INTERN");
      assert.equal(rz.status, 201);
      assert.equal(ry.status, 201);
      assert.equal(re.status, 201);

      // Zappy's admin cannot approve the Yarnia request, through either startup.
      assert.equal((await approve(zappy, zFounder, ry.body.data.id)).status, 404);
      assert.equal((await approve(yarnia, zFounder, ry.body.data.id)).status, 404);

      assert.equal((await approve(zappy, zHr, rz.body.data.id)).status, 200);
      assert.equal((await approve(yarnia, yFounder, ry.body.data.id)).status, 200);

      const all = await mine(p);
      const byName = Object.fromEntries(all.items.map((i: any) => [i.startup.name, i]));
      assert.equal(byName["Zappy"].status, "ACTIVE");
      assert.equal(byName["Zappy"].role, "INTERN");
      assert.equal(byName["Yarnia Kroshay"].status, "ACTIVE");
      assert.equal(byName["Yarnia Kroshay"].role, "EMPLOYEE");
      assert.equal(byName["Elunora Crafts"].status, "PENDING");
      assert.equal(byName["Elunora Crafts"].canEnter, false);

      // Switching context: each startup's view holds only that startup's record.
      const z = (await h.call("GET", `/api/me/affiliations/employment?startup=${zappy.code}`, p.token)).body.data;
      const y = (await h.call("GET", `/api/me/affiliations/employment?startup=${yarnia.code}`, p.token)).body.data;
      const e = (await h.call("GET", `/api/me/affiliations/employment?startup=${elunora.code}`, p.token)).body.data;
      assert.deepEqual(z.map((r: any) => [r.startup.id, r.kind]), [[zappy.id, "INTERN"]]);
      assert.deepEqual(y.map((r: any) => [r.startup.id, r.kind]), [[yarnia.id, "EMPLOYEE"]]);
      assert.deepEqual(e, []);

      // Yarnia's team list shows Yarnia people only.
      const yTeam = (await h.call("GET", w(yarnia, "/team/affiliates"), yFounder.token)).body.data;
      assert.ok(yTeam.every((m: any) => m.code.includes(yarnia.code)));
      assert.ok(!yTeam.some((m: any) => m.kind === "INTERN"));
    });

    // ── Scenario D — restricted states ───────────────────────────────────
    test("D1. rejected: no access, reason shown, may ask again (same row)", async () => {
      const p = await h.person("rejected");
      const r = await ask(p, zappy.id, "INTERN");
      const rej = await h.call("POST", w(zappy, `/join-requests/${r.body.data.id}/reject`), zHr.token, { reason: "We could not confirm your internship." });
      assert.equal(rej.status, 200);

      const e = await entry(p, zappy);
      assert.equal(e.status, "REJECTED");
      assert.equal(e.reviewNote, "We could not confirm your internship.");
      assert.equal(e.canEnter, false);
      assert.equal((await h.call("GET", w(zappy, "/dashboard"), p.token)).status, 404);
      assert.deepEqual((await h.call("GET", "/api/me/affiliations/employment", p.token)).body.data, []);

      // A decided request cannot be approved afterwards.
      assert.equal((await approve(zappy, zHr, r.body.data.id)).status, 409);

      const again = await ask(p, zappy.id, "INTERN");
      assert.equal(again.status, 201);
      assert.equal(again.body.data.id, r.body.data.id, "the row is reused, not duplicated");
      assert.equal(await h.prisma.startupJoinRequest.count({ where: { userId: p.id, startupId: zappy.id } }), 1);
    });

    test("D2. needs info: user edits and resubmits; history keeps every step", async () => {
      const p = await h.person("needsinfo");
      const r = await ask(p, zappy.id, "EMPLOYEE", { designation: "" });
      const info = await h.call("POST", w(zappy, `/join-requests/${r.body.data.id}/request-info`), zHr.token, { message: "Which team are you on?" });
      assert.equal(info.status, 200);
      assert.equal((await entry(p, zappy)).status, "NEEDS_INFO");

      // A second request is refused; the existing one is edited instead.
      assert.equal((await ask(p, zappy.id, "EMPLOYEE")).body.code, "REQUEST_EXISTS");
      const edit = await h.call("PATCH", `/api/me/affiliations/${r.body.data.id}`, p.token, { designation: "Data Analyst", department: "Growth" });
      assert.equal(edit.status, 200);
      assert.equal(edit.body.data.status, "PENDING");
      assert.equal(edit.body.data.designation, "Data Analyst");

      const history = (await h.call("GET", w(zappy, `/join-requests/${r.body.data.id}`), zHr.token)).body.data.history;
      assert.deepEqual(history.map((x: any) => x.action), ["affiliation.requested", "affiliation.info_requested", "affiliation.updated"]);
      assert.equal(history[1].note, "Which team are you on?");
    });

    test("D3. deactivated: loses access on the next request; reactivation restores it", async () => {
      const { person: p, personId } = await approvedMember("deact", zappy, zFounder, "INTERN");
      await h.prisma.intern.update({
        where: { id: personId },
        data: { startDate: new Date(Date.now() - 30 * 864e5), endDate: new Date(Date.now() + 90 * 864e5), officeDays: [1, 2, 3, 4, 5, 6] },
      });

      // HR may review requests but not withdraw access.
      assert.equal((await h.call("POST", w(zappy, `/team/${personId}/deactivate`), zHr.token, {})).status, 403);

      const d = await h.call("POST", w(zappy, `/team/${personId}/deactivate`), zFounder.token, { reason: "Internship ended early" });
      assert.equal(d.status, 200);
      assert.equal((await h.call("POST", w(zappy, `/team/${personId}/deactivate`), zFounder.token, {})).status, 409);

      const e = await entry(p, zappy);
      assert.equal(e.status, "DEACTIVATED");
      assert.equal(e.canEnter, false);
      assert.deepEqual((await h.call("GET", "/api/me/affiliations/employment", p.token)).body.data, []);
      assert.deepEqual((await h.call("GET", "/api/me/onboarding", p.token)).body.data, []);
      assert.deepEqual((await h.call("GET", "/api/me/attendance", p.token)).body.data, []);
      assert.equal((await h.call("POST", `/api/me/attendance/${personId}/check-in`, p.token, {})).status, 404);
      assert.equal((await h.call("GET", `/api/me/worklog/${personId}`, p.token)).status, 404);
      const form = new FormData();
      form.append("docType", "PHOTO");
      form.append("file", new Blob([PNG], { type: "image/png" }), "me.png");
      assert.equal((await h.upload(`/api/me/onboarding/${personId}/documents`, form, { Authorization: `Bearer ${p.token}` })).status, 404);

      const team = (await h.call("GET", w(zappy, "/team/affiliates"), zFounder.token)).body.data;
      assert.equal(team.find((m: any) => m.id === personId).access, "DEACTIVATED");

      const re = await h.call("POST", w(zappy, `/team/${personId}/reactivate`), zFounder.token, {});
      assert.equal(re.status, 200);
      assert.equal((await entry(p, zappy)).status, "ACTIVE");
      assert.equal((await h.call("GET", "/api/me/affiliations/employment", p.token)).body.data.length, 1);
      assert.equal((await h.call("POST", w(zappy, `/team/${personId}/reactivate`), zFounder.token, {})).status, 409);

      const audits = await h.prisma.auditLog.findMany({ where: { entityId: personId, action: { startsWith: "affiliation." } }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(audits.map((a: any) => a.action), ["affiliation.deactivated", "affiliation.reactivated"]);
    });

    test("D4. withdrawn, unverified, already-member and invited cases", async () => {
      const p = await h.person("withdraw");
      const r = await ask(p, zappy.id, "INTERN");
      assert.equal((await h.call("POST", `/api/me/affiliations/${r.body.data.id}/cancel`, p.token, {})).status, 200);
      assert.equal((await h.call("POST", `/api/me/affiliations/${r.body.data.id}/cancel`, p.token, {})).status, 409);
      assert.equal((await approve(zappy, zHr, r.body.data.id)).status, 409);

      const unverified = await h.person("unverified");
      await h.prisma.user.update({ where: { id: unverified.id }, data: { emailVerifiedAt: null } });
      const u = await ask(unverified, zappy.id, "INTERN");
      assert.equal(u.status, 403);
      assert.equal(u.body.code, "EMAIL_NOT_VERIFIED");

      // The founder is already staff: no request, and no staff seat is ever downgraded.
      const f = await ask(zFounder, zappy.id, "EMPLOYEE");
      assert.equal(f.status, 409);
      assert.equal(f.body.code, "ALREADY_MEMBER");

      const invited = await h.person("invited");
      await seat(elunora.id, invited, "ADMIN", "INVITED");
      assert.equal((await ask(invited, elunora.id, "EMPLOYEE")).body.code, "INVITE_PENDING");

      // Inactive or unknown startups cannot be requested.
      assert.equal((await ask(p, randomUUID(), "INTERN")).status, 404);
    });

    // ── Scenario E — platform admin ──────────────────────────────────────
    test("E. platform admins see every startup and can act in any of them", async () => {
      const ov = await h.call("GET", "/api/admin/affiliations/overview", superAdmin.token);
      assert.equal(ov.status, 200);
      const z = ov.body.data.items.find((i: any) => i.id === zappy.id);
      const realInterns = await h.prisma.intern.count({ where: { startupId: zappy.id, status: { in: ["ACTIVE", "NOTICE"] } } });
      const realEmployees = await h.prisma.employee.count({ where: { startupId: zappy.id, status: { in: ["ACTIVE", "NOTICE"] } } });
      const realPending = await h.prisma.startupJoinRequest.count({ where: { startupId: zappy.id, status: { in: ["PENDING", "NEEDS_INFO"] } } });
      assert.equal(z.interns, realInterns);
      assert.equal(z.employees, realEmployees);
      assert.equal(z.pending, realPending);
      assert.ok(ov.body.data.items.some((i: any) => i.id === yarnia.id));
      assert.ok(ov.body.data.items.some((i: any) => i.id === elunora.id));

      assert.equal((await h.call("GET", "/api/admin/affiliations/overview", platformAdmin.token)).status, 200);
      // A startup founder is not a platform admin.
      assert.equal((await h.call("GET", "/api/admin/affiliations/overview", zFounder.token)).status, 403);
      assert.equal((await h.call("GET", "/api/admin/affiliations/overview", zHr.token)).status, 403);

      // SUPER_ADMIN works inside any startup without holding a seat there.
      const p = await h.person("by-superadmin");
      const r = await ask(p, elunora.id, "EMPLOYEE");
      const q = await h.call("GET", w(elunora, "/join-requests"), superAdmin.token);
      assert.equal(q.status, 200);
      assert.ok(q.body.data.items.some((i: any) => i.id === r.body.data.id));
      assert.equal((await approve(elunora, superAdmin, r.body.data.id)).status, 200);
      assert.equal((await entry(p, elunora)).status, "ACTIVE");
    });

    // ── Scenario F — tenant isolation & tampering ────────────────────────
    test("F. cross-startup access and payload tampering are refused", async () => {
      const zIntern = await approvedMember("z-intern", zappy, zFounder, "INTERN");
      const zEmp = await approvedMember("z-emp", zappy, zFounder, "EMPLOYEE");
      const yIntern = await approvedMember("y-intern", yarnia, yFounder, "INTERN");
      const eEmp = await approvedMember("e-emp", elunora, eFounder, "EMPLOYEE");

      // 1. A Zappy intern cannot reach Yarnia documents, by route or by record id.
      assert.equal((await h.call("GET", w(yarnia, "/documents"), zIntern.person.token)).status, 404);
      const form = new FormData();
      form.append("docType", "PHOTO");
      form.append("file", new Blob([PNG], { type: "image/png" }), "x.png");
      assert.equal(
        (await h.upload(`/api/me/onboarding/${yIntern.personId}/documents`, form, { Authorization: `Bearer ${zIntern.person.token}` })).status,
        404
      );
      assert.equal((await h.call("GET", `/api/me/worklog/${yIntern.personId}`, zIntern.person.token)).status, 404);

      // 2. A Zappy employee cannot read Elunora employee data.
      assert.equal((await h.call("GET", w(elunora, "/employees"), zEmp.person.token)).status, 404);
      assert.equal((await h.call("GET", w(elunora, `/team/${eEmp.personId}`), zEmp.person.token)).status, 404);

      // 6–7. A startup admin cannot see or act on another startup's requests or people.
      const pending = await h.person("pending-y");
      const py = await ask(pending, yarnia.id, "INTERN");
      assert.equal((await h.call("GET", w(yarnia, "/join-requests"), zFounder.token)).status, 404);
      assert.equal((await h.call("GET", w(zappy, `/join-requests/${py.body.data.id}`), zFounder.token)).status, 404);
      assert.equal((await h.call("POST", w(zappy, `/join-requests/${py.body.data.id}/reject`), zFounder.token, { reason: "nope nope" })).status, 404);
      assert.equal((await h.call("POST", w(zappy, `/team/${yIntern.personId}/deactivate`), zFounder.token, {})).status, 404);
      const zQueue = (await h.call("GET", w(zappy, "/join-requests?status=ALL"), zFounder.token)).body.data.items;
      assert.ok(!zQueue.some((i: any) => i.id === py.body.data.id));

      // Below HR, staff cannot review requests; members cannot at all.
      assert.equal((await h.call("GET", w(zappy, "/join-requests"), zManager.token)).status, 403);
      assert.equal((await approve(zappy, zIntern.person, py.body.data.id)).status, 403);

      // 9–10, 12. Tampered payloads: status, role, owner and email are ignored.
      const attacker = await h.person("attacker");
      const victim = await h.person("victim");
      const t = await ask(attacker, zappy.id, "EMPLOYEE", {
        status: "APPROVED",
        role: "ADMIN",
        userId: victim.id,
        email: victim.email,
        reviewedById: zFounder.id,
        employeeId: zEmp.personId,
      });
      assert.equal(t.status, 201);
      const stored = await h.prisma.startupJoinRequest.findUnique({ where: { id: t.body.data.id } });
      assert.equal(stored.status, "PENDING");
      assert.equal(stored.userId, attacker.id);
      assert.equal(stored.email, attacker.email.toLowerCase());
      assert.equal(stored.reviewedById, null);
      assert.equal(stored.employeeId, null);
      assert.equal((await entry(attacker, zappy)).canEnter, false);
      assert.equal(await h.prisma.startupMember.count({ where: { startupId: zappy.id, userId: attacker.id } }), 0);
      // …and the requester cannot approve themselves.
      assert.equal((await approve(zappy, attacker, t.body.data.id)).status, 404);
      // Editing cannot smuggle a status in either.
      await h.call("PATCH", `/api/me/affiliations/${t.body.data.id}`, attacker.token, { status: "APPROVED", designation: "CEO" });
      assert.equal((await h.prisma.startupJoinRequest.findUnique({ where: { id: t.body.data.id } })).status, "PENDING");

      // 11. Someone else's request id is "not found" to you.
      assert.equal((await h.call("PATCH", `/api/me/affiliations/${py.body.data.id}`, attacker.token, { designation: "x" })).status, 404);
      assert.equal((await h.call("POST", `/api/me/affiliations/${py.body.data.id}/cancel`, attacker.token, {})).status, 404);

      // Approving a Zappy employee never touches Yarnia or Elunora.
      assert.equal(await h.prisma.startupMember.count({ where: { userId: zEmp.person.id } }), 1);
    });

    test("duplicate submissions racing each other create one request", async () => {
      const p = await h.person("racer");
      const results = await Promise.all([ask(p, yarnia.id, "INTERN"), ask(p, yarnia.id, "INTERN"), ask(p, yarnia.id, "INTERN")]);
      assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
      assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409));
      assert.equal(await h.prisma.startupJoinRequest.count({ where: { userId: p.id, startupId: yarnia.id } }), 1);
    });

    test("concurrent approvals create one record", async () => {
      const p = await h.person("double-approve");
      const r = await ask(p, yarnia.id, "EMPLOYEE");
      const [a, b] = await Promise.all([approve(yarnia, yFounder, r.body.data.id), approve(yarnia, superAdmin, r.body.data.id)]);
      assert.ok([a.status, b.status].every((s) => s === 200 || s === 409), `${a.status} ${b.status}`);
      assert.equal(await h.prisma.employee.count({ where: { startupId: yarnia.id, userId: p.id } }), 1);
      assert.equal(await h.prisma.startupMember.count({ where: { startupId: yarnia.id, userId: p.id } }), 1);
    });

    test("admin portal: DevUp admins list every startup's requests and approve, reject or ask for info", async () => {
      const a = await h.person("adm-a");
      const b = await h.person("adm-b");
      const c = await h.person("adm-c");
      const ra = (await ask(a, zappy.id, "EMPLOYEE")).body.data.id;
      const rb = (await ask(b, yarnia.id, "INTERN")).body.data.id;
      const rc = (await ask(c, elunora.id, "EMPLOYEE")).body.data.id;

      // Only platform admins.
      for (const who of [zFounder, zHr, a]) {
        assert.equal((await h.call("GET", "/api/admin/affiliations/requests", who.token)).status, 403, `${who.email} reached the admin list`);
        assert.equal((await h.call("POST", `/api/admin/affiliations/requests/${ra}/approve`, who.token, {})).status, 403);
      }
      assert.equal((await h.call("GET", "/api/admin/affiliations/requests", "")).status, 401);

      // Every startup's requests, with the startup named; filters work.
      const all = await h.call("GET", "/api/admin/affiliations/requests?status=PENDING", platformAdmin.token);
      assert.equal(all.status, 200, JSON.stringify(all.body));
      const ids = all.body.data.items.map((i: any) => i.id);
      for (const id of [ra, rb, rc]) assert.ok(ids.includes(id), "missing a startup's request");
      const rowB = all.body.data.items.find((i: any) => i.id === rb);
      assert.equal(rowB.startup.code, yarnia.code);
      assert.equal(rowB.startup.name, "Yarnia Kroshay");
      assert.ok(all.body.data.counts.PENDING >= 3);
      const onlyZappy = await h.call("GET", `/api/admin/affiliations/requests?status=ALL&startup=${zappy.code}`, superAdmin.token);
      assert.ok(onlyZappy.body.data.items.every((i: any) => i.startup.code === zappy.code));
      assert.equal((await h.call("GET", "/api/admin/affiliations/requests?status=NOPE", platformAdmin.token)).status, 400);

      // Detail carries the startup and the same review data HR sees.
      const detail = await h.call("GET", `/api/admin/affiliations/requests/${rb}`, platformAdmin.token);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.startup.id, yarnia.id);
      assert.equal(detail.body.data.kind, "INTERN");
      assert.equal((await h.call("GET", `/api/admin/affiliations/requests/${randomUUID()}`, platformAdmin.token)).status, 404);

      // Approve (not a member of Yarnia): the same path as the startup's own approval.
      const ok1 = await h.call("POST", `/api/admin/affiliations/requests/${rb}/approve`, platformAdmin.token, { designation: "Design Intern", issueOfferLetter: false });
      assert.equal(ok1.status, 200, JSON.stringify(ok1.body));
      assert.equal(await h.prisma.intern.count({ where: { startupId: yarnia.id, userId: b.id } }), 1);
      const seatB = await h.prisma.startupMember.findFirst({ where: { startupId: yarnia.id, userId: b.id } });
      assert.equal(seatB?.status, "ACTIVE");
      assert.equal(seatB?.role, "INTERN");
      // Visible to the startup's own HR as approved, by the admin.
      const yList = await h.call("GET", w(yarnia, "/join-requests?status=APPROVED"), yFounder.token);
      assert.ok(yList.body.data.items.some((i: any) => i.id === rb));
      const log = await h.prisma.auditLog.findFirst({ where: { entity: "StartupJoinRequest", entityId: rb, action: "affiliation.approved" } });
      assert.equal(log?.adminId, platformAdmin.id, "audit names the DevUp admin");
      // Approving again changes nothing.
      const again = await h.call("POST", `/api/admin/affiliations/requests/${rb}/approve`, platformAdmin.token, {});
      assert.equal(again.status, 200);
      assert.equal(await h.prisma.intern.count({ where: { startupId: yarnia.id, userId: b.id } }), 1);

      // Ask for info, then reject — with reasons, and closed requests stay closed.
      const info = await h.call("POST", `/api/admin/affiliations/requests/${rc}/request-info`, superAdmin.token, { message: "Which team are you in?" });
      assert.equal(info.status, 200, JSON.stringify(info.body));
      assert.equal((await h.call("POST", `/api/admin/affiliations/requests/${ra}/reject`, platformAdmin.token, { reason: "x" })).status, 400, "reason too short");
      const rej = await h.call("POST", `/api/admin/affiliations/requests/${ra}/reject`, platformAdmin.token, { reason: "Not on the team list" });
      assert.equal(rej.status, 200);
      assert.equal((await h.call("POST", `/api/admin/affiliations/requests/${ra}/approve`, platformAdmin.token, {})).status, 409);
      assert.equal(await h.prisma.employee.count({ where: { startupId: zappy.id, userId: a.id } }), 0);
      const aView = await entry(a, zappy);
      assert.equal(aView.status, "REJECTED");
      assert.equal(aView.reviewNote, "Not on the team list");
    });
  });
}
