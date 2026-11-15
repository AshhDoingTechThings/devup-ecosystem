/**
 * Finance, slice 4: bills from DevUp to its startups, payments against them,
 * reminders with limits, the startup's view-by-link, income received, and
 * collaborations. Real Express and Postgres via the harness.
 */
import "./support/finance-env";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, testDatabaseUrl, Person } from "./support/harness";

const DB = testDatabaseUrl();
if (!DB) {
  test("startup bills (needs TEST_DATABASE_URL on localhost)", { skip: true }, () => {});
} else {
  describe("startup bills, revenue and collaborations", () => {
    let h: Awaited<ReturnType<typeof startHarness>>;
    let cfo: Person, superAdmin: Person, mgrA: Person, mgrC: Person, viewerA: Person, founderA: Person;
    let A: any, B: any, C: any;
    let cat: Record<string, string>;
    const F = (p: string) => `/api/finance${p}`;
    const as = (p: Person) => ({
      get: (path: string) => h.call("GET", F(path), p.token),
      post: (path: string, body?: unknown) => h.call("POST", F(path), p.token, body ?? {}),
      patch: (path: string, body: unknown) => h.call("PATCH", F(path), p.token, body),
      put: (path: string, body: unknown) => h.call("PUT", F(path), p.token, body),
    });
    const expect = (r: { status: number; body: any }, status: number) => assert.equal(r.status, status, JSON.stringify(r.body));
    const bill = (body: Record<string, unknown> = {}) =>
      as(cfo).post("/invoices", { recipientStartupId: A.id, title: "Shared costs — October", lines: [{ label: "Office rent share", amount: "6000" }, { label: "Internet share", amount: "4000" }], billingEmail: "billing@alpha.test", ...body });

    before(async () => {
      h = await startHarness(DB);
      superAdmin = await h.person("inv-super", "SUPER_ADMIN");
      cfo = await h.person("inv-cfo");
      mgrA = await h.person("inv-mgr-a");
      mgrC = await h.person("inv-mgr-c");
      viewerA = await h.person("inv-viewer");
      founderA = await h.person("inv-founder", "FOUNDER");
      A = await h.startup(founderA, { name: "Alpha Bills" });
      B = await h.startup(founderA, { name: "Beta Bills" });
      C = await h.startup(founderA, { name: "Gamma Bills" });
      for (const [u, role, s] of [[cfo, "ECOSYSTEM_CFO", null], [mgrA, "STARTUP_FINANCE_MANAGER", A.id], [mgrC, "STARTUP_FINANCE_MANAGER", C.id], [viewerA, "FINANCE_VIEWER", A.id]] as const) {
        expect(await h.call("POST", "/api/finance/roles", superAdmin.token, { userId: u.id, role, startupId: s }), 201);
      }
      cat = Object.fromEntries((await as(cfo).get("/categories")).body.data.map((c: any) => [c.key, c.id]));
    });
    after(async () => h?.close());

    let invId: string;
    let viewUrl: string;

    test("a bill adds up its lines, is numbered per financial year, and is private until issued", async () => {
      const r = await bill();
      expect(r, 201);
      invId = r.body.data.id;
      assert.match(r.body.data.number, /^INV-DEV-\d{4}-\d{2}-0001$/);
      assert.deepEqual([r.body.data.amountPaise, r.body.data.status, r.body.data.outstandingPaise], [1000000, "DRAFT", 0]);
      assert.equal(r.body.data.viewToken, undefined, "the token itself is never sent; only the link");
      viewUrl = r.body.data.viewUrl;
      const token = viewUrl.split("/bill/")[1];
      expect(await h.call("GET", F(`/public/bills/${token}`)), 404);
      const issued = await as(cfo).post(`/invoices/${invId}/issue`, { dueDate: "2026-10-31" });
      expect(issued, 200);
      assert.deepEqual([issued.body.data.status, issued.body.data.outstandingPaise], ["ISSUED", 1000000]);
      const pub = await h.call("GET", F(`/public/bills/${token}`));
      expect(pub, 200);
      assert.deepEqual([pub.body.data.recipient, pub.body.data.outstandingPaise], ["Alpha Bills", 1000000]);
      assert.equal(JSON.stringify(pub.body.data).includes("billing@alpha.test"), false, "no internal details on the public page");
      expect(await h.call("GET", F("/public/bills/not-a-real-token-xxxxxxxxxx")), 404);
    });

    test("a bill can start from a startup's share of central costs", async () => {
      const rent = await as(cfo).post("/expenses", { scope: "central", title: "Office rent", categoryId: cat.office_rent, amount: "45000", incurredOn: "2026-10-05", action: "paid" });
      expect(await as(cfo).put(`/expenses/${rent.body.data.id}/allocations`, { method: "PERCENT", shares: [{ scope: A.id, percent: 40 }, { scope: "central", percent: 60 }] }), 200);
      const s = await as(cfo).get(`/invoices/suggest?startupId=${A.id}&from=2026-10-01&to=2026-10-31`);
      expect(s, 200);
      assert.deepEqual(s.body.data.map((x: any) => x.amount), ["18000.00"]);
    });

    test("payments: partial, full, never more than owed, never the same reference twice; reversals restore the balance", async () => {
      const part = await as(cfo).post(`/invoices/${invId}/receipts`, { amount: "3000", receivedOn: "2026-10-20", reference: "UTR-A1" });
      expect(part, 201);
      assert.deepEqual([part.body.data.status, part.body.data.outstandingPaise], ["PART_PAID", 700000]);
      assert.equal((await as(cfo).post(`/invoices/${invId}/receipts`, { amount: "8000", receivedOn: "2026-10-21" })).body.code, "OVERPAYMENT");
      assert.equal((await as(cfo).post(`/invoices/${invId}/receipts`, { amount: "100", receivedOn: "2026-10-21", reference: "UTR-A1" })).body.code, "DUPLICATE_RECEIPT");
      assert.equal((await as(cfo).get("/overview?scope=" + A.id)).body.data.cards.expectedFromStartupsPaise, 700000);
      const full = await as(cfo).post(`/invoices/${invId}/receipts`, { amount: "7000", receivedOn: "2026-10-25", reference: "UTR-A2" });
      assert.equal(full.body.data.status, "PAID");
      const rid = full.body.data.receipts.find((r: any) => r.reference === "UTR-A2").id;
      const rev = await as(cfo).post(`/invoices/${invId}/receipts/${rid}/reverse`, { reason: "Bounced" });
      assert.deepEqual([rev.body.data.status, rev.body.data.outstandingPaise], ["PART_PAID", 700000]);
      // Payments from startups are internal: never DevUp income.
      assert.equal((await as(cfo).get("/overview?period=year&anchor=2026-10-15")).body.data.cards.moneyReceivedPaise, null);
    });

    test("reminders: at most one a day, paused while disputed, never past the limit; each records its delivery", async () => {
      const r1 = await as(cfo).post(`/invoices/${invId}/remind`);
      expect(r1, 200);
      assert.equal(r1.body.data.level, 1);
      assert.ok(h.mails.some((m) => m.to === "billing@alpha.test" && /Reminder: bill INV-DEV/.test(m.subject)));
      assert.equal((await as(cfo).post(`/invoices/${invId}/remind`)).body.code, "TOO_SOON");
      await h.prisma.financeInvoice.update({ where: { id: invId }, data: { lastReminderAt: new Date(Date.now() - 2 * 86400_000) } });
      expect(await as(cfo).post(`/invoices/${invId}/flag`, { flag: "DISPUTED", note: "Alpha says the internet share is wrong" }), 200);
      assert.equal((await as(cfo).post(`/invoices/${invId}/remind`)).body.code, "FLAGGED");
      expect(await as(cfo).post(`/invoices/${invId}/flag`, { flag: null }), 200);
      await h.prisma.financeInvoice.update({ where: { id: invId }, data: { maxReminders: 1 } });
      assert.equal((await as(cfo).post(`/invoices/${invId}/remind`)).body.code, "REMINDER_LIMIT");
      const got = (await as(cfo).get(`/invoices/${invId}`)).body.data;
      assert.deepEqual([got.reminderCount, got.reminders.length, got.reminders[0].delivery], [1, 1, "SENT"]);
    });

    test("the daily job reminds only overdue, unflagged bills, once a week", async () => {
      const b = await bill({ title: "Old bill", lines: [{ label: "Tools share", amount: "2000" }], billingEmail: "alpha-ops@alpha.test" });
      await as(cfo).post(`/invoices/${b.body.data.id}/issue`, { dueDate: "2026-09-01" });
      const { automaticReminders } = await import("../src/modules/finance/invoices.service");
      const before = h.mails.length;
      await automaticReminders();
      assert.ok(h.mails.slice(before).some((m) => m.to === "alpha-ops@alpha.test"), "the overdue bill was reminded");
      const again = h.mails.length;
      await automaticReminders();
      assert.equal(h.mails.slice(again).filter((m) => m.to === "alpha-ops@alpha.test").length, 0, "not twice in a week");
      const row = await h.prisma.paymentReminder.findFirst({ where: { invoiceId: b.body.data.id } });
      assert.equal(row!.automatic, true);
    });

    test("a startup's finance people see their own bills only; only the CFO bills", async () => {
      const mine = (await as(mgrA).get("/invoices")).body.data.invoices;
      assert.ok(mine.length >= 2 && mine.every((i: any) => i.recipientStartupId === A.id));
      expect(await as(viewerA).get(`/invoices/${invId}`), 200);
      expect(await as(mgrC).get(`/invoices/${invId}`), 404);
      expect(await as(mgrA).post("/invoices", { recipientStartupId: A.id, title: "Self bill", lines: [{ label: "x y", amount: "1" }] }), 403);
      expect(await as(mgrA).post(`/invoices/${invId}/remind`), 403);
    });

    test("income is counted when received; B2B-style references can't be recorded twice", async () => {
      expect(await as(cfo).post("/income", { scope: "central", source: "SPONSORSHIP", title: "DevThon sponsorship", payer: "Acme Corp", amount: "50000", receivedOn: "2026-10-10", reference: "SP-1" }), 201);
      expect(await as(mgrA).post("/income", { scope: A.id, source: "CLIENT_PAYMENT", title: "Website project", payer: "Client Co", amount: "5000", receivedOn: "2026-10-12" }), 201);
      assert.equal((await as(cfo).post("/income", { scope: "central", source: "SPONSORSHIP", title: "Again", payer: "Acme Corp", amount: "50000", receivedOn: "2026-10-10", reference: "SP-1" })).body.code, "DUPLICATE_INCOME");
      expect(await as(mgrA).post("/income", { scope: B.id, source: "OTHER", title: "Not mine", payer: "X Y", amount: "1", receivedOn: "2026-10-12" }), 404);
      const all = (await as(cfo).get("/overview?period=custom&from=2026-10-01&to=2026-10-31")).body.data.cards;
      assert.equal(all.moneyReceivedPaise, 5500000, "₹50,000 + ₹5,000 — startup bill payments are not included");
      const rev = (await as(cfo).get("/revenue?period=custom&from=2026-10-01&to=2026-10-31")).body.data;
      assert.deepEqual(rev.bySource.map((x: any) => [x.source, x.amountPaise]), [["SPONSORSHIP", 5000000], ["CLIENT_PAYMENT", 500000]]);
      assert.equal((await as(mgrA).get("/overview?scope=" + A.id + "&period=custom&from=2026-10-01&to=2026-10-31")).body.data.cards.moneyReceivedPaise, 500000);
    });

    test("a collaboration tracks agreed contributions, costs, income and what's left of its budget", async () => {
      const c = await as(cfo).post("/collaborations", { name: "Campus hackathon", partnerName: "IEC Council", budget: "20000", shares: [{ startupId: A.id, agreedContribution: "10000" }, { startupId: B.id, agreedContribution: "5000" }] });
      expect(c, 201);
      const id = c.body.data.id;
      expect(await as(mgrA).post(`/collaborations/${id}/costs`, { scope: A.id, title: "Venue", categoryId: cat.events, amount: "2000", incurredOn: "2026-10-15" }), 201);
      const venue = await h.prisma.expense.findFirst({ where: { source: "COLLABORATION", sourceId: id } });
      await as(cfo).post(`/expenses/${venue!.id}/approve`);
      await as(cfo).post(`/expenses/${venue!.id}/pay`, { paymentRef: "V-1" });
      expect(await as(cfo).post(`/collaborations/${id}/costs`, { scope: "central", title: "Prizes", categoryId: cat.events, amount: "3000", incurredOn: "2026-10-16" }), 201);
      assert.equal((await as(cfo).post(`/collaborations/${id}/costs`, { scope: C.id, title: "No", categoryId: cat.events, amount: "1", incurredOn: "2026-10-16" })).body.code, "NOT_IN_COLLABORATION");
      expect(await as(cfo).post("/income", { scope: "central", source: "PARTNER_CONTRIBUTION", title: "IEC contribution", payer: "IEC Council", amount: "6000", receivedOn: "2026-10-17", collaborationId: id }), 201);
      const list = (await as(cfo).get("/collaborations")).body.data.find((x: any) => x.id === id);
      assert.deepEqual(
        [list.spentPaise, list.committedPaise, list.incomePaise, list.netPaise, list.agreedContributionsPaise, list.budgetLeftPaise],
        [200000, 300000, 600000, 400000, 1500000, 1500000],
      );
      expect(await as(viewerA).get(`/collaborations/${id}`), 200);
      expect(await as(mgrC).get(`/collaborations/${id}`), 404);
    });
  });
}
