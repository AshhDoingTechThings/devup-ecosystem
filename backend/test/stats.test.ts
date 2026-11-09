/**
 * The public statistics are real counts, and a failure is reported as one —
 * never as success with invented numbers.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, testDatabaseUrl } from "./support/harness";

const DB = testDatabaseUrl();
if (!DB) {
  test("public stats (needs TEST_DATABASE_URL on localhost)", { skip: true }, () => {});
} else {
  describe("public stats", () => {
    let h: Awaited<ReturnType<typeof startHarness>>;
    before(async () => { h = await startHarness(DB); });
    after(async () => h?.close());

    test("counts come from the database, including zero", async () => {
      const r = await h.call("GET", "/api/stats");
      assert.equal(r.status, 200);
      assert.equal(r.body.data.totalStartups, await h.prisma.startup.count({ where: { isActive: true, isVerified: true } }));
      assert.equal(r.body.data.totalUsers, await h.prisma.user.count());
      assert.equal(r.body.data.totalJobs, 0);
    });

    test("a database failure is a 503, not made-up figures", async () => {
      const original = h.prisma.user.count;
      h.prisma.user.count = async () => { throw new Error("database down"); };
      try {
        const r = await h.call("GET", "/api/stats");
        assert.equal(r.status, 503);
        assert.equal(r.body.success, false);
        assert.equal(r.body.data, undefined);
        assert.ok(!JSON.stringify(r.body).includes("1200"));
      } finally {
        h.prisma.user.count = original;
      }
    });
  });
}
