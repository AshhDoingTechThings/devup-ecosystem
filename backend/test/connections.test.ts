/**
 * Connections show each side only what it should see of the other, and the
 * request endpoints reject malformed input instead of failing in the database.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, testDatabaseUrl, Person } from "./support/harness";

const PRIVATE = { phone: "9876543210", cgpa: 9.1, resumeUrl: "https://storage.example.test/cv.pdf", graduationYear: 2027 };

const DB = testDatabaseUrl();
if (!DB) {
  test("connections (needs TEST_DATABASE_URL on localhost)", { skip: true }, () => {});
} else {
  describe("connections", () => {
    let h: Awaited<ReturnType<typeof startHarness>>;
    let founder: Person, other: Person, student: Person;

    const leaks = (row: any, label: string, { emailAllowed }: { emailAllowed: boolean }) => {
      const json = JSON.stringify(row);
      for (const k of ["passwordHash", "phone", "cgpa", "resumeUrl", "graduationYear", "lastLoginAt", "role", "emailVerifiedAt"]) {
        assert.ok(!json.includes(`"${k}"`), `${label} must not carry ${k}`);
      }
      assert.ok(!json.includes(PRIVATE.phone), `${label} must not carry the phone number`);
      assert.equal(json.includes('"email"'), emailAllowed, `${label}: email ${emailAllowed ? "expected" : "must not appear"}`);
    };

    before(async () => {
      h = await startHarness(DB);
      founder = await h.person("founder", "FOUNDER", PRIVATE);
      other = await h.person("other", "FOUNDER", PRIVATE);
      student = await h.person("student", "STUDENT", PRIVATE);
      await h.prisma.user.updateMany({ where: { id: { in: [founder.id, other.id] } }, data: { passwordHash: "$2b$10$legacyhashlegacyhashlegacyhashlegacyhashlegacyhashleg" } });
    });
    after(async () => h?.close());

    test("a pending request shows the recipient only the sender's public profile", async () => {
      const sent = await h.call("POST", "/api/connections/request", founder.token, { toUserId: other.id, message: "Hi" });
      assert.equal(sent.status, 201, JSON.stringify(sent.body));

      const inbox = await h.call("GET", "/api/connections", other.token);
      assert.equal(inbox.status, 200);
      const req = inbox.body.data.pendingRequests[0];
      assert.equal(req.fromUser.id, founder.id);
      assert.equal(req.fromUser.profile.name, "founder person");
      leaks(req.fromUser, "pending requester", { emailAllowed: false });

      const accepted = await h.call("POST", `/api/connections/${sent.body.data.id}/respond`, other.token, { status: "ACCEPTED" });
      assert.equal(accepted.status, 200);
    });

    test("accepted connections share the email (for team invites) and nothing else private", async () => {
      for (const [p, partner] of [[founder, other], [other, founder]] as const) {
        const list = await h.call("GET", "/api/connections", p.token);
        const conn = list.body.data.acceptedConnections[0];
        const them = conn.fromUserId === p.id ? conn.toUser : conn.fromUser;
        assert.equal(them.id, partner.id);
        assert.equal(them.email, partner.email);
        leaks(conn.fromUser, "accepted fromUser", { emailAllowed: true });
        leaks(conn.toUser, "accepted toUser", { emailAllowed: true });
      }
    });

    test("malformed requests are refused before the database", async () => {
      const cases: Array<[string, unknown, number]> = [
        ["missing target", { message: "hi" }, 400],
        ["a name instead of an id", { toUserId: "Akshay", message: "hi" }, 400],
        ["unknown user", { toUserId: "00000000-0000-4000-8000-000000000000", message: "hi" }, 404],
        ["oversized note", { toUserId: student.id, message: "x".repeat(501) }, 400],
      ];
      for (const [label, body, status] of cases) {
        const r = await h.call("POST", "/api/connections/request", founder.token, body);
        assert.equal(r.status, status, `${label}: ${JSON.stringify(r.body)}`);
      }
      const noNote = await h.call("POST", "/api/connections/request", founder.token, { toUserId: student.id });
      assert.equal(noNote.status, 201, "the note is optional");

      const pending = await h.call("GET", "/api/connections", student.token);
      const id = pending.body.data.pendingRequests[0].id;
      const bad = await h.call("POST", `/api/connections/${id}/respond`, student.token, { status: "MAYBE" });
      assert.equal(bad.status, 400);
      const row = await h.prisma.connectionRequest.findUnique({ where: { id } });
      assert.equal(row.status, "PENDING", "an invalid answer leaves the request untouched");
    });
  });
}
