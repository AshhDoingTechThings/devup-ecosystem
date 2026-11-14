/**
 * Creating a startup from the admin portal: a taken slug is refused before any
 * image is uploaded, and a dropped storage connection is reported as an upload
 * failure rather than "Internal Server Error". Real Express and Postgres;
 * storage is a stub that records uploads and can throw.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, testDatabaseUrl, Person } from "./support/harness";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR-fake-image-data")]);
const sw = { throwOnUpload: false };
const uploads: string[] = [];

const stubs = {
  "config/supabase": {
    supabase: {},
    createSessionClient: () => ({ auth: { signInWithPassword: async () => ({ data: { session: null }, error: { status: 400 } }) } }),
    verifySupabaseAuthConfig: async () => true,
    supabaseAdmin: {
      auth: {
        getUser: async (t: string) =>
          t.startsWith("tok-") ? { data: { user: { id: t.slice(4) } }, error: null } : { data: { user: null }, error: { status: 403, message: "invalid JWT" } },
        admin: {},
      },
      storage: {
        from: (bucket: string) => ({
          upload: async (p: string) => {
            if (sw.throwOnUpload) throw new TypeError("fetch failed");
            uploads.push(`${bucket}/${p}`);
            return { data: { path: p }, error: null };
          },
          getPublicUrl: (p: string) => ({ data: { publicUrl: `https://storage.example.test/${bucket}/${p}` } }),
          createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://storage.example.test/signed/${p}` }, error: null }),
          remove: async () => ({ error: null }),
        }),
      },
    },
  },
};

const DB = testDatabaseUrl();
if (!DB) {
  test("startup creation (needs TEST_DATABASE_URL on localhost)", { skip: true }, () => {});
} else {
  describe("startup creation", () => {
    let h: Awaited<ReturnType<typeof startHarness>>;
    let admin: Person;

    const create = (fields: Record<string, string>, screenshots = 2) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      form.append("logo", new Blob([PNG], { type: "image/png" }), "logo.png");
      for (let i = 0; i < screenshots; i++) form.append("screenshots", new Blob([PNG], { type: "image/png" }), `s${i}.png`);
      return h.upload("/api/startups", form, { Authorization: `Bearer ${admin.token}` });
    };
    const partner = (slug: string) => ({
      name: "CatoDrive", slug, tagline: "Drive away certain.", description: "Peer-to-peer car rental.",
      domain: "OTHER", stage: "SERIES_A", type: "ECOSYSTEM_PARTNER", foundedYear: "2026", headcount: "51-100",
      location: "USA,DALLAS", website: "https://www.catodrive.com/", githubUrl: "", founderNames: JSON.stringify(["Syed Ali Iqbal"]),
    });

    before(async () => {
      h = await startHarness(DB, { stubs });
      admin = await h.person("create-admin", "ADMIN");
    });
    after(async () => h?.close());

    test("an admin-created partner has its logo and screenshots — and the admin is not listed as a co-founder", async () => {
      const r = await create(partner("catodrive"));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.data.type, "ECOSYSTEM_PARTNER");
      assert.equal(r.body.data.screenshotUrls.length, 2);
      const id = r.body.data.id;
      // Owner of record (required), but not a public founder and no founder seat.
      assert.equal(r.body.data.founderId, admin.id);
      assert.equal(await h.prisma.startupMember.count({ where: { startupId: id } }), 0);
      const pub = await h.call("GET", "/api/startups/catodrive", "");
      assert.equal(pub.status, 200);
      assert.deepEqual(pub.body.data.founders, []);
      assert.deepEqual(pub.body.data.founderNames, ["Syed Ali Iqbal"]);
      // DevUp admins still manage it.
      const edit = new FormData();
      edit.append("tagline", "Drive away certain, always.");
      const upd = await fetch(`${h.origin}/api/startups/${id}`, { method: "PATCH", body: edit, headers: { Authorization: `Bearer ${admin.token}` } });
      assert.equal(upd.status, 200, await upd.text());
    });

    test("a founder creating their own startup is still its founder and owner", async () => {
      const founder = await h.person("self-founder", "FOUNDER");
      const form = new FormData();
      for (const [k, v] of Object.entries({ ...partner("self-made"), type: "DEVUP_VENTURE" })) form.append(k, v);
      form.append("logo", new Blob([PNG], { type: "image/png" }), "logo.png");
      const r = await h.upload("/api/startups", form, { Authorization: `Bearer ${founder.token}` });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(await h.prisma.startupMember.count({ where: { startupId: r.body.data.id, userId: founder.id, role: "FOUNDER", status: "ACTIVE" } }), 1);
      const pub = await h.call("GET", "/api/startups/self-made", "");
      assert.equal(pub.body.data.founders.length, 1);
    });

    test("an admin naming a real founder makes that person the founder and owner", async () => {
      const real = await h.person("named-founder", "FOUNDER");
      const r = await create({ ...partner("named-one"), founderId: real.id });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.data.founderId, real.id);
      assert.equal(await h.prisma.startupMember.count({ where: { startupId: r.body.data.id, userId: real.id, role: "FOUNDER" } }), 1);
      assert.equal(await h.prisma.startupMember.count({ where: { startupId: r.body.data.id, userId: admin.id } }), 0);
    });

    test("a taken slug is refused with a clear 409 — before any image is uploaded", async () => {
      const before = uploads.length;
      const r = await create(partner("catodrive"));
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "SLUG_TAKEN");
      assert.match(r.body.error, /catodrive/);
      assert.equal(uploads.length, before, "nothing was uploaded");
      assert.equal(await h.prisma.startup.count({ where: { slug: "catodrive" } }), 1);
    });

    test("a dropped storage connection → 502 UPLOAD_FAILED (not 'Internal Server Error'), nothing saved", async () => {
      sw.throwOnUpload = true;
      let r;
      try {
        r = await create(partner("catodrive-two"));
      } finally {
        sw.throwOnUpload = false;
      }
      assert.equal(r.status, 502, JSON.stringify(r.body));
      assert.equal(r.body.code, "UPLOAD_FAILED");
      assert.doesNotMatch(r.body.error, /internal server error/i);
      assert.equal(await h.prisma.startup.count({ where: { slug: "catodrive-two" } }), 0);
      // And it works on retry.
      assert.equal((await create(partner("catodrive-two"))).status, 201);
    });
  });
}
