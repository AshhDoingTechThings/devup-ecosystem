/**
 * After approval: the offer letter goes out automatically (interns), through
 * the existing generator and mailer, and survives failures without duplicates;
 * onboarding uploads are validated, private, reviewable and tenant-scoped.
 *
 * The PDF renderer, the mail provider and storage are stubs with failure
 * switches, so every failure path runs for real. Real Express and Postgres.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { startHarness, testDatabaseUrl, Person } from "./support/harness";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n%%EOF\n");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR-fake-image-data")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF-fake")]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');

// Failure switches flipped by the tests.
const sw = { pdf: true, mail: true, storage: true };
const mails: Array<{ to: string; subject: string; attachments?: Array<{ filename: string }> }> = [];
const removed: string[] = [];
const uploads: Array<{ bucket: string; path: string; contentType?: string }> = [];
// Objects in the (stubbed) public documents bucket, for the legacy backfill test.
const publicObjects = new Map<string, Buffer>();

const stubs = {
  "lib/pdf": {
    htmlToPdf: async () => (sw.pdf ? Buffer.from("%PDF-1.4 rendered letter") : null),
    rendererMayFetch: async () => false,
    isPdfAvailable: () => sw.pdf,
    pdfUnavailableReason: () => (sw.pdf ? null : "stub: renderer off"),
    closePdfBrowser: async () => undefined,
  },
  "lib/resend": {
    MAIL_FROM: "test@example.test",
    resend: {
      emails: {
        send: async (p: any) => {
          if (!sw.mail) return { data: null, error: { name: "rate_limit_exceeded", message: "stub outage" } };
          mails.push(p);
          return { data: { id: randomUUID() }, error: null };
        },
      },
    },
    sendTeamInviteEmail: async () => undefined,
    sendDocumentReadyEmail: async () => undefined,
    sendDocumentSignedEmail: async () => undefined,
    EmailTemplates: new Proxy({}, { get: () => () => "<p>stub</p>" }),
  },
  // Same contract as the harness's stub, plus a storage switch and a record of deletions.
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
          upload: async (p: string, _b: Buffer, o?: { contentType?: string }) => {
            if (!sw.storage) return { data: null, error: { message: "stub: bucket identity-documents unavailable" } };
            uploads.push({ bucket, path: p, contentType: o?.contentType });
            return { data: { path: p }, error: null };
          },
          getPublicUrl: (p: string) => ({ data: { publicUrl: `https://storage.example.test/storage/v1/object/public/${bucket}/${p}` } }),
          createSignedUrl: async (p: string, secs: number) => ({ data: { signedUrl: `https://storage.example.test/storage/v1/object/sign/${bucket}/${p}?token=stub&expires=${secs}` }, error: null }),
          download: async (p: string) => {
            const b = publicObjects.get(`${bucket}/${p}`);
            return b ? { data: new Blob([b]), error: null } : { data: null, error: { message: "Object not found" } };
          },
          remove: async (paths: string[]) => {
            removed.push(...paths);
            for (const x of paths) publicObjects.delete(`${bucket}/${x}`);
            return { error: null };
          },
        }),
      },
    },
  },
};

const DB = testDatabaseUrl();
if (!DB) {
  test("offer letters and onboarding uploads (needs TEST_DATABASE_URL on localhost)", { skip: true }, () => {});
} else {
  describe("offer letters and onboarding uploads", () => {
    let h: Awaited<ReturnType<typeof startHarness>>;
    let zappy: any, yarnia: any, zFounder: Person, yFounder: Person, zManager: Person;

    const seat = (startupId: string, p: Person, role: string) =>
      h.prisma.startupMember.create({ data: { startupId, userId: p.id, email: p.email, role, status: "ACTIVE", invitedBy: p.id, inviteToken: sha(randomUUID()) } });
    const brand = (startupId: string) =>
      h.prisma.startupBranding.create({ data: { startupId, legalName: "Test Ventures Pvt Ltd", signatoryName: "Asha Signatory", signatoryTitle: "Director" } });
    const w = (s: any, p: string) => `/api/w/${s.code}${p}`;
    const ask = (p: Person, s: any, kind: "INTERN" | "EMPLOYEE") =>
      h.call("POST", "/api/me/affiliations", p.token, {
        startupId: s.id, kind, fullName: `${p.email.split("@")[0]} Name`, designation: kind === "INTERN" ? "Design Intern" : "Engineer",
        department: "Design", ...(kind === "INTERN" ? { college: "VJIT", joiningDate: "2026-12-01", endDate: "2027-05-31" } : { joiningDate: "2026-12-01" }),
      });
    const approve = (s: any, by: Person, id: string, body: Record<string, unknown> = {}) => h.call("POST", w(s, `/join-requests/${id}/approve`), by.token, body);
    const retry = (s: any, by: Person, id: string) => h.call("POST", w(s, `/join-requests/${id}/offer`), by.token, {});
    const mailsTo = (email: string) => mails.filter((m) => m.to === email);
    const upload = (personId: string, token: string, docType: string, buf: Buffer, name: string, type: string) => {
      const form = new FormData();
      form.append("docType", docType);
      form.append("file", new Blob([buf], { type }), name);
      return h.upload(`/api/me/onboarding/${personId}/documents`, form, { Authorization: `Bearer ${token}` });
    };
    async function approvedIntern(tag: string, s: any, founder: Person, body: Record<string, unknown> = {}) {
      const p = await h.person(tag);
      const r = await ask(p, s, "INTERN");
      const a = await approve(s, founder, r.body.data.id, body);
      assert.equal(a.status, 200, JSON.stringify(a.body));
      return { person: p, requestId: r.body.data.id as string, personId: a.body.data.personId as string, approval: a.body.data };
    }

    before(async () => {
      h = await startHarness(DB, { stubs });
      zFounder = await h.person("zfounder", "FOUNDER");
      yFounder = await h.person("yfounder", "FOUNDER");
      zappy = await h.startup(zFounder, { name: "Zappy" });
      yarnia = await h.startup(yFounder, { name: "Yarnia Kroshay" });
      zManager = await h.person("zmanager");
      await seat(zappy.id, zManager, "MANAGER");
      await brand(zappy.id);
    });
    after(async () => h?.close());

    // ── Offer letters ────────────────────────────────────────────────────
    test("intern approval issues, numbers, stores and emails the offer letter — once", async () => {
      const { person, requestId, personId, approval } = await approvedIntern("intern-ok", zappy, zFounder, {
        stipend: "Rs 15,000 / month", workMode: "HYBRID", location: "Hyderabad", supervisorUserId: zManager.id,
      });
      assert.equal(approval.offer.status, "SENT", JSON.stringify(approval.offer));
      assert.match(approval.offer.documentNo, new RegExp(`^DEVUP/${zappy.code}/OL/\\d{4}-\\d{2}/0001$`));

      const docs = await h.prisma.hrDocument.findMany({ where: { internId: personId } });
      assert.equal(docs.length, 1);
      assert.equal(docs[0].docType, "OFFER_LETTER");
      assert.equal(docs[0].templateKey, "OFFER_LETTER");
      assert.equal(docs[0].pdfUrl, null, "no public URL is stored");
      assert.equal(docs[0].storagePath, `hr-documents/${zappy.id}/offer_letter/${docs[0].id}.pdf`, "the PDF is stored privately and linked");
      assert.ok(uploads.some((u) => u.bucket === "identity-documents" && u.path === docs[0].storagePath && u.contentType === "application/pdf"));
      assert.ok(!uploads.some((u) => u.bucket === "legal-documents"), "nothing goes to the public documents bucket");
      const payload = docs[0].payload as any;
      assert.equal(payload.candidateName, `${person.email.split("@")[0]} Name`);
      assert.equal(payload.stipend, "Rs 15,000 / month");
      assert.equal(payload.workMode, "HYBRID");
      assert.equal(payload.location, "Hyderabad");
      assert.equal(payload.durationMonths, 6);
      assert.equal(payload._branding.legalName, "Test Ventures Pvt Ltd");

      // Emailed to the account's own address, with the PDF attached.
      const sent = mailsTo(person.email);
      assert.equal(sent.length, 1, "one email: the offer letter doubles as the welcome");
      assert.match(sent[0].subject, /internship offer letter/i);
      assert.equal(sent[0].attachments?.length, 1);
      assert.match(sent[0].attachments![0].filename, /^Offer-Letter-DEVUP-.*\.pdf$/);

      // Visible on their dashboard; the admin was told it went out.
      const mine = await h.call("GET", "/api/me/documents", person.token);
      assert.ok(mine.body.data.some((d: any) => d.docType === "OFFER_LETTER" && d.documentNo === approval.offer.documentNo));
      const adminNote = await h.prisma.notification.findFirst({ where: { userId: zFounder.id, title: { startsWith: "Offer letter sent" } } });
      assert.ok(adminNote);
      const req = await h.prisma.startupJoinRequest.findUnique({ where: { id: requestId } });
      assert.equal(req.offerStatus, "SENT");
      assert.ok(req.offerSentAt);

      // Re-approving and retrying change nothing and send nothing.
      const again = await approve(zappy, zFounder, requestId);
      assert.equal(again.body.data.alreadyApproved, true);
      const r = await retry(zappy, zFounder, requestId);
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "ALREADY_SENT");
      assert.equal(mailsTo(person.email).length, 1);
      assert.equal(await h.prisma.hrDocument.count({ where: { internId: personId } }), 1);
    });

    test("employees get a letter only when the admin asks for one", async () => {
      const a = await h.person("emp-noletter");
      const ra = await ask(a, zappy, "EMPLOYEE");
      const aa = await approve(zappy, zFounder, ra.body.data.id);
      assert.equal(aa.body.data.offer, null);
      assert.equal(mailsTo(a.email).length, 1, "the welcome email only");
      assert.match(mailsTo(a.email)[0].subject, /You.re in/);

      const b = await h.person("emp-letter");
      const rb = await ask(b, zappy, "EMPLOYEE");
      const ab = await approve(zappy, zFounder, rb.body.data.id, { issueOfferLetter: true, ctc: "Rs 6 LPA" });
      assert.equal(ab.body.data.offer.status, "SENT");
      const doc = await h.prisma.hrDocument.findFirst({ where: { employeeId: ab.body.data.personId } });
      assert.equal((doc.payload as any).ctc, "Rs 6 LPA");
    });

    test("F. renderer down → recorded failure → retries reuse the same letter and number", async () => {
      sw.pdf = false;
      const { person, requestId, personId, approval } = await approvedIntern("intern-pdfdown", zappy, zFounder);
      // The approval stands; the letter is issued (numbered) but not sent.
      assert.equal(approval.offer.status, "FAILED");
      assert.equal(approval.offer.error, "PDF_UNAVAILABLE");
      assert.match(approval.offer.message, /PDF renderer/);
      assert.equal((await h.prisma.intern.findUnique({ where: { id: personId } })).status, "ACTIVE");
      const number = approval.offer.documentNo;
      assert.ok(number);
      assert.equal(mailsTo(person.email).length, 0);
      const failNote = await h.prisma.notification.findFirst({ where: { userId: zFounder.id, title: { startsWith: "Offer letter not sent" } } });
      assert.ok(failNote, "the admin is told, not left guessing");

      const r1 = await retry(zappy, zFounder, requestId);
      assert.equal(r1.body.data.status, "FAILED");
      assert.equal(r1.body.data.documentNo, number);
      assert.equal(r1.body.data.attempts, 2);

      sw.pdf = true;
      const r2 = await retry(zappy, zFounder, requestId);
      assert.equal(r2.body.data.status, "SENT");
      assert.equal(r2.body.data.documentNo, number, "same number on retry");
      assert.equal(mailsTo(person.email).length, 1);
      assert.equal(await h.prisma.hrDocument.count({ where: { internId: personId } }), 1, "one document, never a second");

      // The sequence did not move: the next letter is the very next number.
      const next = await approvedIntern("intern-next", zappy, zFounder);
      const n = (s: string) => Number(s.split("/").pop());
      assert.equal(n(next.approval.offer.documentNo), n(number) + 1);
    });

    test("mail outage → FAILED with reason → retry after recovery sends exactly once", async () => {
      sw.mail = false;
      const { person, requestId, approval } = await approvedIntern("intern-maildown", zappy, zFounder);
      sw.mail = true;
      assert.equal(approval.offer.status, "FAILED");
      assert.match(approval.offer.error, /^EMAIL_/);
      assert.equal(mailsTo(person.email).length, 0);
      const r = await retry(zappy, zFounder, requestId);
      assert.equal(r.body.data.status, "SENT");
      assert.equal(r.body.data.documentNo, approval.offer.documentNo);
      assert.equal(mailsTo(person.email).length, 1);
    });

    test("no branding → FAILED, no number spent; branding added → retry issues 0001", async () => {
      const { requestId, personId, approval } = await approvedIntern("intern-nobrand", yarnia, yFounder);
      assert.equal(approval.offer.status, "FAILED");
      assert.equal(approval.offer.error, "BRANDING_MISSING");
      assert.equal(approval.offer.documentNo, null);
      assert.equal(await h.prisma.hrDocument.count({ where: { internId: personId } }), 0);
      await brand(yarnia.id);
      const r = await retry(yarnia, yFounder, requestId);
      assert.equal(r.body.data.status, "SENT");
      assert.match(r.body.data.documentNo, /\/0001$/);
    });

    test("concurrent retries send one email", async () => {
      sw.mail = false;
      const { person, requestId } = await approvedIntern("intern-race", zappy, zFounder);
      sw.mail = true;
      const results = await Promise.all([retry(zappy, zFounder, requestId), retry(zappy, zFounder, requestId), retry(zappy, zFounder, requestId)]);
      const statuses = results.map((r) => r.status).sort();
      assert.equal(statuses.filter((s) => s === 200).length, 1, JSON.stringify(statuses));
      assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 409));
      assert.equal(mailsTo(person.email).length, 1);
    });

    test("a letter left at SENDING by a restart is shown as stuck after 10 minutes and can be sent again — once", async () => {
      const { person, requestId } = await approvedIntern("intern-stuck", zappy, zFounder);
      const sent = mailsTo(person.email).length;
      // What a restart mid-send leaves behind: SENDING, no result recorded.
      await h.prisma.$executeRaw`UPDATE "StartupJoinRequest" SET "offerStatus"='SENDING', "offerSentAt"=NULL, "updatedAt"=(now() at time zone 'utc') WHERE id=${requestId}`;
      let d = (await h.call("GET", w(zappy, `/join-requests/${requestId}`), zFounder.token)).body.data;
      assert.equal(d.offer.stuck, false, "a send in progress is not stuck");
      assert.equal((await retry(zappy, zFounder, requestId)).status, 409);

      await h.prisma.$executeRaw`UPDATE "StartupJoinRequest" SET "updatedAt"=(now() at time zone 'utc') - interval '11 minutes' WHERE id=${requestId}`;
      d = (await h.call("GET", w(zappy, `/join-requests/${requestId}`), zFounder.token)).body.data;
      assert.equal(d.offer.stuck, true);
      const docNo = d.offer.documentNo;
      const r = await retry(zappy, zFounder, requestId);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      d = (await h.call("GET", w(zappy, `/join-requests/${requestId}`), zFounder.token)).body.data;
      assert.equal(d.offer.status, "SENT");
      assert.equal(d.offer.stuck, false);
      assert.equal(d.offer.documentNo, docNo, "same letter, same number");
      assert.equal(mailsTo(person.email).length, sent + 1);
      assert.equal((await retry(zappy, zFounder, requestId)).status, 409, "a SENT letter is never re-sent");
    });

    test("letters are tenant-scoped: other startups and non-HR cannot touch them", async () => {
      sw.mail = false;
      const { person, requestId } = await approvedIntern("intern-scope", zappy, zFounder);
      sw.mail = true;
      assert.equal((await retry(yarnia, yFounder, requestId)).status, 404);
      assert.equal((await retry(zappy, yFounder, requestId)).status, 404);
      assert.equal((await retry(zappy, zManager, requestId)).status, 403);
      assert.equal((await retry(zappy, person, requestId)).status, 403);
      assert.equal(mailsTo(person.email).length, 0);
      const detail = await h.call("GET", w(zappy, `/join-requests/${requestId}`), zFounder.token);
      assert.equal(detail.body.data.offer.status, "FAILED");
      assert.ok(detail.body.data.offer.documentNo);
    });

    // ── Onboarding uploads ───────────────────────────────────────────────
    test("upload validation: formats, empty, size, document type", async () => {
      const { person, personId } = await approvedIntern("intern-upl", zappy, zFounder);
      const t = person.token;
      assert.equal((await upload(personId, t, "PHOTO", JPEG, "me.jpg", "image/jpeg")).status, 201);
      assert.equal((await upload(personId, t, "COLLEGE_ID", PNG, "id.png", "image/png")).status, 201);
      assert.equal((await upload(personId, t, "RESUME", PDF, "cv.pdf", "application/pdf")).status, 201);

      const svg = await upload(personId, t, "MARKSHEET", SVG, "m.svg", "image/svg+xml");
      assert.equal(svg.status, 400);
      assert.equal(svg.body.code, "INVALID_FILE_TYPE");
      const disguised = await upload(personId, t, "MARKSHEET", SVG, "m.pdf", "application/pdf");
      assert.equal(disguised.status, 400, "the type comes from the bytes, not the name");
      const empty = await upload(personId, t, "MARKSHEET", Buffer.alloc(0), "e.pdf", "application/pdf");
      assert.equal(empty.status, 400);
      const big = await upload(personId, t, "MARKSHEET", Buffer.concat([PDF, Buffer.alloc(9 * 1024 * 1024)]), "big.pdf", "application/pdf");
      assert.equal(big.status, 413);
      const notAsked = await upload(personId, t, "BANK_DETAILS", PDF, "bank.pdf", "application/pdf");
      assert.equal(notAsked.status, 400);
      assert.equal(notAsked.body.code, "DOC_TYPE_NOT_REQUIRED");
      const garbage = await upload(personId, t, "../../etc", PDF, "x.pdf", "application/pdf");
      assert.equal(garbage.status, 400);

      // Stored privately, by path, under this startup and this person.
      const docs = await h.prisma.onboardingDocument.findMany({ where: { internId: personId } });
      assert.equal(docs.length, 3);
      for (const d of docs) {
        assert.equal(d.fileUrl, null);
        assert.ok(d.storagePath.startsWith(`onboarding/${zappy.id}/${personId}/`), d.storagePath);
        assert.equal(d.status, "SUBMITTED");
      }
      // The person sees short-lived signed links, never public ones.
      const list = (await h.call("GET", "/api/me/onboarding", t)).body.data[0];
      const photo = list.items.find((i: any) => i.docType === "PHOTO");
      assert.match(photo.fileUrl, /\/object\/sign\/identity-documents\/.*expires=300$/);
      assert.ok(!list.items.some((i: any) => String(i.fileUrl ?? "").includes("/public/")));
    });

    test("E. upload → HR rejects with reason → re-upload → HR approves → locked", async () => {
      const { person, personId } = await approvedIntern("intern-review", zappy, zFounder);
      const up1 = await upload(personId, person.token, "AADHAAR", PDF, "aadhaar.pdf", "application/pdf");
      assert.equal(up1.status, 201);
      const first = await h.prisma.onboardingDocument.findFirst({ where: { internId: personId, docType: "AADHAAR" } });

      // HR of this startup sees it with a signed link.
      const checklist = await h.call("GET", w(zappy, `/onboarding/${personId}`), zFounder.token);
      assert.equal(checklist.status, 200);
      const item = checklist.body.data.items.find((i: any) => i.docType === "AADHAAR");
      assert.equal(item.status, "SUBMITTED");
      assert.match(item.fileUrl, /\/object\/sign\/identity-documents\//);

      const reject = await h.call("POST", w(zappy, `/onboarding/documents/${first.id}/review`), zFounder.token, { approve: false, reason: "Back side is missing" });
      assert.equal(reject.status, 200, JSON.stringify(reject.body));
      const seen = (await h.call("GET", "/api/me/onboarding", person.token)).body.data[0].items.find((i: any) => i.docType === "AADHAAR");
      assert.equal(seen.status, "REJECTED");
      assert.equal(seen.rejectReason, "Back side is missing");
      assert.ok(mails.some((m) => m.to === person.email && /re-upload/i.test(m.subject)));

      const up2 = await upload(personId, person.token, "AADHAAR", PDF, "aadhaar-both-sides.pdf", "application/pdf");
      assert.equal(up2.status, 201);
      const second = await h.prisma.onboardingDocument.findFirst({ where: { internId: personId, docType: "AADHAAR" } });
      assert.equal(second.id, first.id, "one row per document type");
      assert.equal(second.status, "SUBMITTED");
      assert.equal(second.rejectReason, null);
      assert.notEqual(second.storagePath, first.storagePath);
      assert.ok(removed.includes(first.storagePath), "the replaced file is deleted, not orphaned");

      const ok = await h.call("POST", w(zappy, `/onboarding/documents/${first.id}/review`), zFounder.token, { approve: true });
      assert.equal(ok.status, 200);
      const locked = await upload(personId, person.token, "AADHAAR", PDF, "again.pdf", "application/pdf");
      assert.equal(locked.status, 409);
      assert.equal(locked.body.code, "ALREADY_APPROVED");
    });

    test("storage failure → 503, nothing saved; DB failure after storage → file removed", async () => {
      const { person, personId } = await approvedIntern("intern-fail", zappy, zFounder);
      sw.storage = false;
      const down = await upload(personId, person.token, "PHOTO", PNG, "p.png", "image/png");
      sw.storage = true;
      assert.equal(down.status, 503);
      assert.equal(down.body.code, "UPLOAD_FAILED");
      assert.ok(!JSON.stringify(down.body).includes("identity-documents"), "no bucket names in the response");
      assert.equal(await h.prisma.onboardingDocument.count({ where: { internId: personId } }), 0);

      const realCreate = h.prisma.onboardingDocument.create;
      h.prisma.onboardingDocument.create = async () => { throw new Error("stub: database unavailable"); };
      const before = removed.length;
      try {
        const dbDown = await upload(personId, person.token, "PHOTO", PNG, "p.png", "image/png");
        assert.equal(dbDown.status, 500);
      } finally {
        h.prisma.onboardingDocument.create = realCreate;
      }
      assert.equal(removed.length, before + 1, "the stored file was cleaned up");
      assert.match(removed.at(-1)!, new RegExp(`^onboarding/${zappy.id}/${personId}/PHOTO-`));
      // And it works on retry.
      assert.equal((await upload(personId, person.token, "PHOTO", PNG, "p.png", "image/png")).status, 201);
    });

    test("documents are private to the person and their startup's HR", async () => {
      const a = await approvedIntern("intern-a", zappy, zFounder);
      const b = await approvedIntern("intern-b", zappy, zFounder);
      await upload(a.personId, a.person.token, "PHOTO", PNG, "a.png", "image/png");
      const doc = await h.prisma.onboardingDocument.findFirst({ where: { internId: a.personId } });

      // Another intern, by person id.
      assert.equal((await upload(a.personId, b.person.token, "RESUME", PDF, "x.pdf", "application/pdf")).status, 404);
      // Another startup's admin, by route and by document id.
      assert.equal((await h.call("GET", w(yarnia, `/onboarding/${a.personId}`), yFounder.token)).status, 404);
      assert.equal((await h.call("GET", w(zappy, `/onboarding/${a.personId}`), yFounder.token)).status, 404);
      assert.equal((await h.call("POST", w(yarnia, `/onboarding/documents/${doc.id}/review`), yFounder.token, { approve: true })).status, 404);
      // Staff below HR cannot open the checklist or review.
      assert.equal((await h.call("GET", w(zappy, `/onboarding/${a.personId}`), zManager.token)).status, 403);
      assert.equal((await h.call("POST", w(zappy, `/onboarding/documents/${doc.id}/review`), zManager.token, { approve: true })).status, 403);
      // The intern themselves cannot review their own document.
      assert.equal((await h.call("POST", w(zappy, `/onboarding/documents/${doc.id}/review`), a.person.token, { approve: true })).status, 403);
      assert.equal((await h.prisma.onboardingDocument.findUnique({ where: { id: doc.id } })).status, "SUBMITTED");
    });

    // ── Issued letters: private storage, signed links, access control ──────
    test("issued letters are private: signed short-lived links, owner and own-startup HR only", async () => {
      const a = await approvedIntern("letter-owner", zappy, zFounder);
      const b = await approvedIntern("letter-other", zappy, zFounder);
      const doc = await h.prisma.hrDocument.findFirst({ where: { internId: a.personId, docType: "OFFER_LETTER" } });
      assert.ok(doc?.storagePath);
      const isSigned = (u: string) =>
        assert.match(u, new RegExp(`/object/sign/identity-documents/${doc!.storagePath}\\?token=.+&expires=300$`));

      // The owner: in their list, and on demand.
      const mine = await h.call("GET", "/api/me/documents", a.person.token);
      assert.equal(mine.status, 200);
      const listed = mine.body.data.find((d: any) => d.id === doc!.id);
      isSigned(listed.pdfUrl);
      assert.equal(listed.storagePath, undefined, "storage paths never leave the API");
      const fresh = await h.call("GET", `/api/me/documents/${doc!.id}/file`, a.person.token);
      assert.equal(fresh.status, 200);
      isSigned(fresh.body.data.url);
      assert.equal(fresh.body.data.expiresIn, 300);

      // Someone else — another intern at the same startup, or a stranger — cannot name it.
      assert.equal((await h.call("GET", `/api/me/documents/${doc!.id}/file`, b.person.token)).status, 404);
      assert.ok(!(await h.call("GET", "/api/me/documents", b.person.token)).body.data.some((d: any) => d.id === doc!.id));
      const stranger = await h.person("letter-stranger");
      assert.equal((await h.call("GET", `/api/me/documents/${doc!.id}/file`, stranger.token)).status, 404);
      assert.equal((await h.call("GET", `/api/me/documents/${doc!.id}/file`, "")).status, 401);

      // Own startup's HR+: yes. Staff below HR: no. Another startup's founder: not via either startup.
      const hr = await h.call("GET", w(zappy, `/documents/${doc!.id}/file`), zFounder.token);
      assert.equal(hr.status, 200);
      isSigned(hr.body.data.url);
      assert.equal((await h.call("GET", w(zappy, `/documents/${doc!.id}/file`), zManager.token)).status, 403);
      assert.equal((await h.call("GET", w(zappy, `/documents/${doc!.id}/file`), a.person.token)).status, 403);
      assert.equal((await h.call("GET", w(zappy, `/documents/${doc!.id}/file`), yFounder.token)).status, 404);
      assert.equal((await h.call("GET", w(yarnia, `/documents/${doc!.id}/file`), yFounder.token)).status, 404);

      // Lists HR sees carry signed links too, never a stored path.
      const list = await h.call("GET", w(zappy, "/documents?docType=OFFER_LETTER"), zFounder.token);
      const row = list.body.data.find((d: any) => d.id === doc!.id);
      isSigned(row.pdfUrl);
      assert.equal(row.storagePath, undefined);
      const person = await h.call("GET", w(zappy, `/team/${a.personId}`), zFounder.token);
      assert.equal(person.status, 200, JSON.stringify(person.body));
      isSigned(person.body.data.issuedDocuments.find((d: any) => d.id === doc!.id).pdfUrl);
      // A manager can open the person, but gets no file links — letters or ID scans.
      await upload(a.personId, a.person.token, "PHOTO", PNG, "p.png", "image/png");
      const asManager = await h.call("GET", w(zappy, `/team/${a.personId}`), zManager.token);
      assert.equal(asManager.status, 200);
      assert.equal(asManager.body.data.issuedDocuments.find((d: any) => d.id === doc!.id).pdfUrl, null);
      assert.ok(asManager.body.data.onboarding.items.some((i: any) => i.status === "SUBMITTED"), "statuses still visible");
      assert.ok(asManager.body.data.onboarding.items.every((i: any) => i.fileUrl === null), "no ID-scan links");
      const asFounder = await h.call("GET", w(zappy, `/team/${a.personId}`), zFounder.token);
      assert.ok(asFounder.body.data.onboarding.items.some((i: any) => /object\/sign\/identity-documents\//.test(i.fileUrl ?? "")));

      // A revoked letter is withheld from its owner.
      await h.prisma.hrDocument.update({ where: { id: doc!.id }, data: { revokedAt: new Date(), revokeReason: "test" } });
      assert.equal((await h.call("GET", `/api/me/documents/${doc!.id}/file`, a.person.token)).status, 404);
    });

    test("letter rendered but not stored → FAILED STORAGE_FAILED, no email; retry sends exactly once", async () => {
      const p = await h.person("letter-storage");
      const r = await ask(p, zappy, "INTERN");
      sw.storage = false;
      let a;
      try {
        a = await approve(zappy, zFounder, r.body.data.id);
      } finally {
        sw.storage = true;
      }
      assert.equal(a.status, 200, "the approval stands");
      assert.equal(a.body.data.offer.status, "FAILED");
      assert.equal(a.body.data.offer.error, "STORAGE_FAILED");
      assert.equal(mailsTo(p.email).filter((m) => /offer/i.test(m.subject)).length, 0, "not emailed before it is stored");
      const before = await h.prisma.hrDocument.findMany({ where: { internId: a.body.data.personId } });
      assert.equal(before.length, 1);

      const again = await retry(zappy, zFounder, r.body.data.id);
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.data.status, "SENT");
      const after = await h.prisma.hrDocument.findMany({ where: { internId: a.body.data.personId } });
      assert.equal(after.length, 1, "same letter");
      assert.equal(after[0].documentNo, before[0].documentNo, "same number");
      assert.ok(after[0].storagePath);
      assert.equal(mailsTo(p.email).filter((m) => /offer/i.test(m.subject)).length, 1);
    });

    test("legacy public files: dry run changes nothing; apply moves them private and removes the public copy", async () => {
      const { moveLegacyHrDocuments, publicObjectPath } = require("../src/modules/hrms/documents/moveToPrivate");
      const { person, personId } = await approvedIntern("legacy", zappy, zFounder);
      const doc = await h.prisma.hrDocument.findFirst({ where: { internId: personId } });
      const legacyPath = `${zappy.id}/offer_letter/${doc!.id}.pdf`;
      const legacyUrl = `https://storage.example.test/storage/v1/object/public/legal-documents/${legacyPath}`;
      await h.prisma.hrDocument.update({ where: { id: doc!.id }, data: { storagePath: null, pdfUrl: legacyUrl } });
      publicObjects.set(`legal-documents/${legacyPath}`, PDF);
      assert.equal(publicObjectPath(legacyUrl), legacyPath);

      // Until moved, the owner still gets the old link (nothing breaks before the backfill).
      const legacyLink = await h.call("GET", `/api/me/documents/${doc!.id}/file`, person.token);
      assert.equal(legacyLink.body.data.url, legacyUrl);

      const dry = await moveLegacyHrDocuments({ apply: false, deletePublic: false });
      assert.ok(dry.items.some((i: any) => i.documentNo === doc!.documentNo && i.action === "move"));
      assert.equal((await h.prisma.hrDocument.findUnique({ where: { id: doc!.id } }))!.pdfUrl, legacyUrl, "dry run writes nothing");

      const run = await moveLegacyHrDocuments({ apply: true, deletePublic: true });
      assert.equal(run.failed, 0, JSON.stringify(run.items));
      const moved = await h.prisma.hrDocument.findUnique({ where: { id: doc!.id } });
      assert.equal(moved!.pdfUrl, null);
      assert.equal(moved!.storagePath, `hr-documents/${zappy.id}/offer_letter/${doc!.id}.pdf`);
      assert.ok(!publicObjects.has(`legal-documents/${legacyPath}`), "public copy removed");

      // Re-running is a no-op.
      const again = await moveLegacyHrDocuments({ apply: true, deletePublic: true });
      assert.ok(!again.items.some((i: any) => i.documentNo === doc!.documentNo));
    });
  });
}
