/**
 * Hackathon dates must be coherent, and registration never overfills an
 * event, even when sign-ups arrive at the same moment.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, testDatabaseUrl, Person } from "./support/harness";

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

const DB = testDatabaseUrl();
if (!DB) {
  test("hackathon schedule and capacity (needs TEST_DATABASE_URL on localhost)", { skip: true }, () => {});
} else {
  describe("hackathon schedule and capacity", () => {
    let h: Awaited<ReturnType<typeof startHarness>>;
    let admin: Person;

    const body = (over: Record<string, unknown> = {}) => ({
      title: `Hack ${Math.random().toString(36).slice(2, 7)}`, description: "d", organizer: "DevUp", prizePool: "₹1", mode: "ONLINE", domain: ["AI"],
      startDate: day(10), endDate: day(11), registrationDeadline: day(5), ...over,
    });
    const event = (maxParticipants?: number) =>
      h.prisma.hackathon.create({
        data: {
          title: `Cap ${h.uniq()}`, description: "d", organizer: "DevUp", prizePool: "₹1", mode: "ONLINE", isActive: true,
          startDate: new Date(day(10)), endDate: new Date(day(11)), registrationDeadline: new Date(day(5)), maxParticipants,
        },
      });

    before(async () => {
      h = await startHarness(DB);
      admin = await h.person("admin", "ADMIN");
    });
    after(async () => h?.close());

    test("incoherent dates are refused on create", async () => {
      for (const [label, over] of [
        ["ends before it starts", { startDate: day(10), endDate: day(9) }],
        ["registration closes after the end", { registrationDeadline: day(12) }],
      ] as const) {
        const r = await h.call("POST", "/api/hackathons", admin.token, body(over));
        assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, "INVALID_SCHEDULE");
      }
      const ok = await h.call("POST", "/api/hackathons", admin.token, body());
      assert.ok(ok.status === 201 || ok.status === 200, JSON.stringify(ok.body));
    });

    test("an update is checked against the dates already saved", async () => {
      const hk = await event();
      const bad = await h.call("PATCH", `/api/hackathons/${hk.id}`, admin.token, { endDate: day(1) });
      assert.equal(bad.status, 400, JSON.stringify(bad.body));
      assert.equal(bad.body.code, "INVALID_SCHEDULE");
      assert.equal((await h.call("PATCH", `/api/hackathons/${hk.id}`, admin.token, { endDate: day(20) })).status, 200);
      assert.equal((await h.call("PATCH", `/api/hackathons/${hk.id}`, admin.token, { title: "Renamed" })).status, 200, "non-date edits skip the check");
    });

    test("simultaneous sign-ups never exceed the cap", async () => {
      const hk = await event(3);
      const people = await Promise.all(Array.from({ length: 6 }, (_, i) => h.person(`p${i}`, "STUDENT")));
      const results = await Promise.all(people.map((p) => h.call("POST", `/api/hackathons/${hk.id}/register`, p.token, { teamSize: 1 })));
      const ok = results.filter((r) => r.status === 200 || r.status === 201).length;
      const full = results.filter((r) => r.status === 400 && r.body.code === "HACKATHON_FULL").length;
      assert.equal(ok, 3, JSON.stringify(results.map((r) => r.status)));
      assert.equal(full, 3);
      const after = await h.prisma.hackathon.findUnique({ where: { id: hk.id } });
      assert.equal(after.currentParticipants, 3);
      assert.equal(await h.prisma.hackathonRegistration.count({ where: { hackathonId: hk.id } }), 3);
    });

    test("a team only gets in if every member has a seat", async () => {
      const hk = await event(3);
      const a = await h.person("team-a", "STUDENT");
      const b = await h.person("team-b", "STUDENT");
      assert.ok([200, 201].includes((await h.call("POST", `/api/hackathons/${hk.id}/register`, a.token, { teamSize: 2 })).status));
      const r = await h.call("POST", `/api/hackathons/${hk.id}/register`, b.token, { teamSize: 2 });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, "HACKATHON_FULL");
      assert.equal((await h.prisma.hackathon.findUnique({ where: { id: hk.id } })).currentParticipants, 2);
      // Uncapped events have no seat check, so the size limit is what stops a
      // single request inflating the participant count.
      const open = await event();
      const huge = await h.call("POST", `/api/hackathons/${open.id}/register`, b.token, { teamSize: 11 });
      assert.equal(huge.status, 400, "team size is bounded");
      assert.equal((await h.prisma.hackathon.findUnique({ where: { id: open.id } })).currentParticipants, 0);
    });
  });
}
