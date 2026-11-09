/**
 * List endpoints validate their query strings: bad paging or filter values are
 * a 400 instead of a 500/503, and the page size is capped.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { startHarness, testDatabaseUrl, Person, SRC } from "./support/harness";

/* eslint-disable @typescript-eslint/no-var-requires */
const { pageParams, enumParam, textParam, MAX_PAGE_SIZE } = require(path.join(SRC, "lib/listQuery"));

describe("list query parsing", () => {
  test("defaults, paging and the cap", () => {
    assert.deepEqual(pageParams({}), { page: 1, limit: 10, skip: 0 });
    assert.deepEqual(pageParams({ page: "3", limit: "20" }), { page: 3, limit: 20, skip: 40 });
    assert.deepEqual(pageParams({ limit: "100000" }), { page: 1, limit: MAX_PAGE_SIZE, skip: 0 });
    assert.deepEqual(pageParams({ limit: "500" }, { maxLimit: 200 }), { page: 1, limit: 200, skip: 0 });
    assert.deepEqual(pageParams({ page: "" }, { defaultLimit: 25 }), { page: 1, limit: 25, skip: 0 });
  });

  test("anything that is not a whole number from 1 is refused", () => {
    for (const q of [{ page: "0" }, { page: "-1" }, { limit: "abc" }, { limit: "-5" }, { limit: "0" }, { limit: "2.5" }, { page: "1e3" }, { page: ["1", "2"] }]) {
      assert.throws(() => pageParams(q), (e: any) => e.statusCode === 400 && e.code === "INVALID_QUERY", JSON.stringify(q));
    }
  });

  test("enum and text filters", () => {
    const Colour = { RED: "RED", BLUE: "BLUE" };
    assert.equal(enumParam(undefined, Colour, "colour"), undefined);
    assert.equal(enumParam("", Colour, "colour"), undefined);
    assert.equal(enumParam("RED", Colour, "colour"), "RED");
    for (const v of ["red", "GREEN", ["RED"]]) assert.throws(() => enumParam(v, Colour, "colour"), (e: any) => e.statusCode === 400);
    assert.equal(textParam("ai", "search"), "ai");
    assert.throws(() => textParam("x".repeat(101), "search"), (e: any) => e.statusCode === 400);
    assert.throws(() => textParam(["a", "b"], "search"), (e: any) => e.statusCode === 400);
  });
});

const DB = testDatabaseUrl();
if (!DB) {
  test("list endpoints (needs TEST_DATABASE_URL on localhost)", { skip: true }, () => {});
} else {
  describe("list endpoints", () => {
    let h: Awaited<ReturnType<typeof startHarness>>;
    let admin: Person;

    before(async () => {
      h = await startHarness(DB);
      admin = await h.person("admin", "ADMIN");
      const founder = await h.person("founder", "FOUNDER");
      for (let i = 0; i < 3; i++) await h.startup(founder, { domain: i ? "FINTECH" : "AI_ML" });
    });
    after(async () => h?.close());

    test("bad paging and filters are a 400 on every public list, never a 500", async () => {
      const bad = [
        "startups?limit=abc", "startups?page=-1", "startups?page=0", "startups?domain=NOPE", "startups?stage=NOPE", "startups?search=a&search=b",
        "jobs?limit=abc", "jobs?type=NOPE", "hackathons?page=0", "hackathons?mode=NOPE", "cofounders?limit=abc", "cofounders?role=NOPE", "cofounders?stage=NOPE",
      ];
      for (const q of bad) {
        const r = await h.call("GET", `/api/${q}`);
        assert.equal(r.status, 400, `${q}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, "INVALID_QUERY", q);
      }
    });

    test("valid filters still work, and the page size is capped", async () => {
      const ai = await h.call("GET", "/api/startups?domain=AI_ML");
      assert.equal(ai.status, 200);
      assert.equal(ai.body.data.length, 1);
      const paged = await h.call("GET", "/api/startups?limit=2&page=2");
      assert.equal(paged.status, 200);
      assert.equal(paged.body.data.length, 1);
      assert.deepEqual([paged.body.meta.page, paged.body.meta.limit, paged.body.meta.total, paged.body.meta.totalPages], [2, 2, 3, 2]);
      const huge = await h.call("GET", "/api/startups?limit=100000");
      assert.equal(huge.status, 200);
      assert.equal(huge.body.meta.limit, 100);
      for (const q of ["jobs?type=INTERNSHIP&limit=5", "hackathons?mode=ONLINE", "cofounders?role=DEVELOPER&stage=IDEA"]) {
        assert.equal((await h.call("GET", `/api/${q}`)).status, 200, q);
      }
    });

    test("admin lists validate too", async () => {
      assert.equal((await h.call("GET", "/api/admin/analytics/audit?limit=-1", admin.token)).status, 400);
      assert.equal((await h.call("GET", "/api/admin/analytics/trends?months=abc", admin.token)).status, 400);
      assert.equal((await h.call("GET", "/api/admin/analytics/trends?months=12", admin.token)).status, 200);
      assert.equal((await h.call("GET", "/api/applications?status=NOPE", admin.token)).status, 400);
    });
  });
}
