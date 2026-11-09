/**
 * Client mistakes come back as 4xx in the standard envelope
 * ({ success: false, error, code }), not as 500s.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { startHarness, testDatabaseUrl, SRC } from "./support/harness";

describe("error handler", () => {
  test("a missing foreign-key target is a 400, not a 500", () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { Prisma } = require("@prisma/client");
    const { errorHandler } = require(path.join(SRC, "middleware/errorHandler"));
    const err = new Prisma.PrismaClientKnownRequestError("Foreign key constraint violated", { code: "P2003", clientVersion: "test" });
    let status = 0;
    let body: any;
    const res: any = { locals: {}, status(s: number) { status = s; return this; }, json(b: unknown) { body = b; return this; } };
    errorHandler(err, {} as any, res, () => undefined);
    assert.equal(status, 400);
    assert.deepEqual([body.success, body.code], [false, "INVALID_REFERENCE"]);
  });
});

const DB = testDatabaseUrl();
if (!DB) {
  test("error contract over HTTP (needs TEST_DATABASE_URL on localhost)", { skip: true }, () => {});
} else {
  describe("error contract over HTTP", () => {
    let h: Awaited<ReturnType<typeof startHarness>>;
    before(async () => { h = await startHarness(DB); });
    after(async () => h?.close());

    const preflight = (origin: string) =>
      fetch(`${h.origin}/api/auth/login`, {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
      });

    test("an origin we don't serve is refused with 403, not a server error", async () => {
      const r = await preflight("https://evil.example");
      assert.equal(r.status, 403);
      assert.equal(r.headers.get("access-control-allow-origin"), null);
      const body = await r.json();
      assert.deepEqual([body.success, body.code], [false, "CORS_FORBIDDEN"]);
    });

    test("our own front end is still allowed", async () => {
      const r = await preflight("https://app.example.test");
      assert.equal(r.status, 204);
      assert.equal(r.headers.get("access-control-allow-origin"), "https://app.example.test");
    });

    test("validation errors use the standard envelope and keep per-field details", async () => {
      const r = await h.call("POST", "/api/auth/login", undefined, { email: "not-an-email" });
      assert.equal(r.status, 400);
      assert.equal(r.body.success, false);
      assert.equal(r.body.code, "VALIDATION_ERROR");
      assert.equal(typeof r.body.error, "string");
      assert.ok(r.body.error.length > 0);
      assert.ok(Array.isArray(r.body.errors) && r.body.errors.length > 0);
      assert.equal(r.body.error, r.body.errors[0].message, "the summary is the first field message");
      assert.ok(r.body.errors.every((e: any) => typeof e.path === "string" && typeof e.message === "string"));
    });
  });
}
