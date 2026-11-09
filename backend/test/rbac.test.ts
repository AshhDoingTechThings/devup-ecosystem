/**
 * SUPER_ADMIN outranks ADMIN: anything an ADMIN may do, a SUPER_ADMIN may do,
 * and nobody else gains anything.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { startHarness, testDatabaseUrl, Person, SRC } from "./support/harness";

const DB = testDatabaseUrl();
if (!DB) {
  test("role hierarchy over HTTP (needs TEST_DATABASE_URL on localhost)", { skip: true }, () => {});
} else {
  describe("role hierarchy over HTTP", () => {
    let h: Awaited<ReturnType<typeof startHarness>>;
    let superAdmin: Person, admin: Person, founder: Person, outsider: Person;
    let startupId: string, applicationId: string;

    before(async () => {
      h = await startHarness(DB);
      superAdmin = await h.person("super", "SUPER_ADMIN");
      admin = await h.person("admin", "ADMIN");
      founder = await h.person("founder", "FOUNDER");
      outsider = await h.person("outsider", "FOUNDER");
      startupId = (await h.startup(founder)).id;
      applicationId = (await h.prisma.application.create({
        data: { startupName: "X", domain: "AI_ML", oneLiner: "x", stage: "IDEA", teamMembers: [], needs: [], submittedBy: founder.id },
      })).id;
    });
    after(async () => h?.close());

    // Loaded only after the harness has stubbed Supabase: requiring the auth
    // middleware earlier would cache the real client for the whole file.
    test("isPlatformAdmin", () => {
      /* eslint-disable @typescript-eslint/no-var-requires */
      const { isPlatformAdmin } = require(path.join(SRC, "middleware/auth"));
      assert.equal(isPlatformAdmin("ADMIN"), true);
      assert.equal(isPlatformAdmin("SUPER_ADMIN"), true);
      for (const r of ["FOUNDER", "STUDENT", "STARTUP_MEMBER", "INVESTOR", "MENTOR", "JUDGE", "", undefined, null]) assert.equal(isPlatformAdmin(r), false, String(r));
    });

    test("ADMIN-only route guards admit SUPER_ADMIN and still refuse everyone else", async () => {
      for (const url of ["/api/applications", "/api/admin/stats"]) {
        assert.equal((await h.call("GET", url, admin.token)).status, 200, `admin ${url}`);
        assert.equal((await h.call("GET", url, superAdmin.token)).status, 200, `super admin ${url}`);
        assert.equal((await h.call("GET", url, founder.token)).status, 403, `founder ${url}`);
      }
    });

    test("inline platform-staff checks admit SUPER_ADMIN", async () => {
      // A startup the super admin is not a member of.
      const patch = await h.call("PATCH", `/api/startups/${startupId}`, superAdmin.token, { tagline: "Edited by staff" });
      assert.equal(patch.status, 200, JSON.stringify(patch.body));
      assert.equal((await h.call("PATCH", `/api/startups/${startupId}`, outsider.token, { tagline: "nope" })).status, 403);

      // Someone else's startup application.
      assert.equal((await h.call("GET", `/api/applications/${applicationId}`, superAdmin.token)).status, 200);
      assert.equal((await h.call("GET", `/api/applications/${applicationId}`, outsider.token)).status, 403);

      // A startup's documents.
      assert.equal((await h.call("GET", `/api/startups/${startupId}/documents`, superAdmin.token)).status, 200);
      assert.equal((await h.call("GET", `/api/startups/${startupId}/documents`, outsider.token)).status, 403);
    });
  });
}
