/**
 * Editing an employee's or intern's record from the startup workspace:
 * HR-and-above can change any detail except email, input is validated, only
 * real changes are written, and each edit appears in the request's history.
 * Real Express and Postgres via the harness.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { startHarness, testDatabaseUrl, Person } from "./support/harness";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const DB = testDatabaseUrl();
if (!DB) {
  test("person edit (needs TEST_DATABASE_URL on localhost)", { skip: true }, () => {});
} else {
  describe("editing team records", () => {
    let h: Awaited<ReturnType<typeof startHarness>>;
    let zappy: any, other: any;
    let founder: Person, hr: Person, manager: Person, mentor: Person, otherFounder: Person;
    let intern: Person, internId: string, requestId: string;
    let employeeId: string;

    const seat = (startupId: string, p: Person, role: string) =>
      h.prisma.startupMember.create({
        data: { startupId, userId: p.id, email: p.email, role, status: "ACTIVE", invitedBy: p.id, inviteToken: sha(randomUUID()) },
      });
    const w = (s: any, path: string) => `/api/w/${s.code}${path}`;
    const edit = (by: Person, id: string, body: unknown, s = zappy) => h.call("PATCH", w(s, `/team/${id}`), by.token, body);

    before(async () => {
      h = await startHarness(DB);
      founder = await h.person("pe-founder", "FOUNDER");
      otherFounder = await h.person("pe-other", "FOUNDER");
      zappy = await h.startup(founder, { name: "Zappy Edit" });
      other = await h.startup(otherFounder, { name: "Other Edit" });
      hr = await h.person("pe-hr");
      await seat(zappy.id, hr, "HR");
      manager = await h.person("pe-manager");
      await seat(zappy.id, manager, "MANAGER");
      mentor = await h.person("pe-mentor");
      await seat(zappy.id, mentor, "ADMIN");

      intern = await h.person("pe-intern");
      const r = await h.call("POST", "/api/me/affiliations", intern.token, {
        startupId: zappy.id, kind: "INTERN", fullName: "TABASSUM BEGUM", phone: "7780355044",
        department: "Engineering CSE(AI&ML)", designation: "", college: "", joiningDate: "2026-11-15", endDate: "2027-05-15",
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      requestId = r.body.data.id;
      const a = await h.call("POST", w(zappy, `/join-requests/${requestId}/approve`), founder.token, { issueOfferLetter: false });
      assert.equal(a.status, 200, JSON.stringify(a.body));
      internId = a.body.data.personId;

      const emp = await h.person("pe-employee");
      const r2 = await h.call("POST", "/api/me/affiliations", emp.token, {
        startupId: zappy.id, kind: "EMPLOYEE", fullName: "Emp Loyee", designation: "Engineer", joiningDate: "2026-10-01",
      });
      assert.equal(r2.status, 201, JSON.stringify(r2.body));
      const a2 = await h.call("POST", w(zappy, `/join-requests/${r2.body.data.id}/approve`), founder.token, { issueOfferLetter: false });
      assert.equal(a2.status, 200, JSON.stringify(a2.body));
      employeeId = a2.body.data.personId;
    });
    after(async () => h?.close());

    test("an admin can edit every intern detail; the record and the history show it", async () => {
      const r = await edit(founder, internId, {
        fullName: "Tabassum Begum", phone: "+91 77803 55044", designation: "AI/ML Intern", department: "Engineering",
        college: "BVRIT Hyderabad", startDate: "2026-11-20", endDate: "2027-06-30", stipend: "Rs 10,000/month",
        stipendAmount: 10000, supervisorUserId: mentor.id,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const p = r.body.data;
      assert.equal(p.fullName, "Tabassum Begum");
      assert.equal(p.designation, "AI/ML Intern");
      assert.equal(p.college, "BVRIT Hyderabad");
      assert.equal(p.stipend, "Rs 10,000/month");
      assert.equal(p.stipendAmount, 10000);
      assert.equal(p.managerId, mentor.id);
      assert.equal(String(p.joinedAt).slice(0, 10), "2026-11-20");
      assert.equal(String(p.endDate).slice(0, 10), "2027-06-30");
      assert.ok(p.supervisors.some((s: any) => s.userId === mentor.id));

      const list = await h.call("GET", w(zappy, "/team/affiliates"), hr.token);
      assert.equal(list.status, 200);
      assert.ok(list.body.data.some((x: any) => x.id === internId && x.fullName === "Tabassum Begum"));

      const req = await h.call("GET", w(zappy, `/join-requests/${requestId}`), founder.token);
      const edits = req.body.data.history.filter((e: any) => e.action === "hrms.person_updated");
      assert.equal(edits.length, 1);
      assert.match(edits[0].note, /designation/);
      assert.match(edits[0].note, /mentor/);
    });

    test("HR can edit; saving the same values writes nothing new", async () => {
      const r = await edit(hr, internId, { designation: "AI/ML Intern", phone: "" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.phone, null, "blank clears an optional field");
      const n = await h.prisma.auditLog.count({ where: { action: "hrms.person_updated", entityId: internId } });
      assert.equal(n, 2, "only the phone change was recorded");
      await edit(hr, internId, { designation: "AI/ML Intern" });
      assert.equal(await h.prisma.auditLog.count({ where: { action: "hrms.person_updated", entityId: internId } }), 2);
    });

    test("employees: CTC, joining date, type and manager are editable", async () => {
      const r = await edit(founder, employeeId, { ctc: "6 LPA", joinedAt: "2026-09-15", employmentType: "PART_TIME", supervisorUserId: hr.id });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.ctc, "6 LPA");
      assert.equal(r.body.data.employmentType, "PART_TIME");
      assert.equal(r.body.data.managerId, hr.id);
      assert.equal(String(r.body.data.joinedAt).slice(0, 10), "2026-09-15");
    });

    test("bad input is refused clearly and changes nothing", async () => {
      const before = await h.prisma.intern.findUnique({ where: { id: internId } });
      for (const [body, code] of [
        [{ endDate: "2026-11-01" }, "INVALID_DATE"],
        [{ startDate: "not-a-date" }, "VALIDATION_ERROR"],
        [{ fullName: "   " }, "VALIDATION_ERROR"],
        [{ stipendAmount: -5 }, "VALIDATION_ERROR"],
        [{ supervisorUserId: otherFounder.id }, "INVALID_SUPERVISOR"],
        [{ supervisorUserId: intern.id }, "INVALID_SUPERVISOR"],
      ] as const) {
        const r = await edit(founder, internId, body);
        assert.equal(r.status, 400, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, code, JSON.stringify(body));
      }
      const after = await h.prisma.intern.findUnique({ where: { id: internId } });
      assert.deepEqual(after, before);
    });

    test("email can't be changed through edit", async () => {
      const r = await edit(founder, internId, { email: "someone-else@example.test", designation: "Intern, AI" });
      assert.equal(r.status, 200);
      assert.equal(r.body.data.email, intern.email);
      assert.equal(r.body.data.designation, "Intern, AI");
    });

    test("managers, the intern themself and other startups can't edit", async () => {
      assert.equal((await edit(manager, internId, { designation: "x" })).status, 403);
      assert.notEqual((await edit(intern, internId, { designation: "x" })).status, 200);
      // Another startup's founder, through their own workspace: not found there.
      assert.equal((await edit(otherFounder, internId, { designation: "x" }, other)).status, 404);
      assert.equal((await h.prisma.intern.findUnique({ where: { id: internId } }))!.designation, "Intern, AI");
    });
  });
}
