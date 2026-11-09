/**
 * The public KYC upload answers an applicant's mistakes with 400s that say
 * what to fix, not a 500.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, testDatabaseUrl } from "./support/harness";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF-fake")]);

const DB = testDatabaseUrl();
if (!DB) {
  test("KYC upload errors (needs TEST_DATABASE_URL on localhost)", { skip: true }, () => {});
} else {
  describe("KYC upload errors", () => {
    let h: Awaited<ReturnType<typeof startHarness>>;
    let url: string;

    before(async () => {
      h = await startHarness(DB);
      const application = await h.prisma.leadApplication.create({
        data: {
          applicationNo: `LA-${h.uniq()}`, role: "CAMPUS_DIRECTOR", fullName: "Applicant", email: `kyc-${h.uniq()}@example.test`,
          phone: "6123456782", state: "S", city: "C", college: "Col", whyLead: "because",
        },
      });
      const token = `kyc-${h.uniq()}${h.uniq()}`;
      await h.prisma.leadKyc.create({
        data: { applicationId: application.id, token, expiresAt: new Date(Date.now() + 86_400_000), documents: { create: [{ docType: "PHOTOGRAPH" }] } },
      });
      url = `/api/kyc/${token}/upload`;
    });
    after(async () => h?.close());

    const form = (docType?: string, withFile = true) => {
      const f = new FormData();
      if (docType !== undefined) f.append("docType", docType);
      if (withFile) f.append("file", new Blob([JPEG], { type: "image/jpeg" }), "me.jpg");
      return f;
    };

    test("an unknown document type is a 400", async () => {
      for (const d of ["PASSPORT_SCAN", undefined]) {
        const r = await h.upload(url, form(d));
        assert.equal(r.status, 400, `${d}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, "INVALID_DOC_TYPE");
      }
    });

    test("a missing file is a 400", async () => {
      const r = await h.upload(url, form("PHOTOGRAPH", false));
      assert.equal(r.status, 400);
      assert.equal(r.body.code, "FILE_REQUIRED");
    });

    test("a correct upload still works", async () => {
      assert.equal((await h.upload(url, form("PHOTOGRAPH"))).status, 200);
    });
  });
}
