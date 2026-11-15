/**
 * The CFO finance portal, slice 1: roles and access, expenses and their
 * workflow, splitting shared costs, the dashboard figures, staff claims, pay
 * setup and bank details. Real Express and Postgres via the harness.
 *
 * Every money figure is checked to the paisa against a hand-worked value.
 */
import "./support/finance-env";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, testDatabaseUrl, Person } from "./support/harness";
import { splitByWeights, rupeesToPaise, periodRange } from "../src/modules/finance/money";
// Pure modules only here: importing a server module before startHarness() would load the
// real Supabase client and bypass the harness stubs (the harness now refuses to start if so).
import { suggestEmployeePay, suggestStipend } from "../src/modules/finance/paySuggest";

/* Pure arithmetic — no database */

describe("finance arithmetic", () => {
  test("rupees become exact paise; ambiguous input is refused", () => {
    assert.equal(rupeesToPaise("1,250.50"), 125050);
    assert.equal(rupeesToPaise(99.9), 9990);
    assert.equal(rupeesToPaise("₹ 7,00,000"), 70000000);
    for (const bad of ["12.345", "abc", "", "1e5", "-5"]) assert.throws(() => rupeesToPaise(bad), bad);
    assert.throws(() => rupeesToPaise(0));
    assert.equal(rupeesToPaise("-120", { allowNegative: true }), -12000);
    assert.throws(() => rupeesToPaise("10000001"), /over ₹1 crore/);
  });

  test("splits always add up to the total, to the paisa", () => {
    assert.deepEqual(splitByWeights(100000, [3333, 3333, 3334]), [33330, 33330, 33340]);
    assert.deepEqual(splitByWeights(100, [1, 1, 1]), [34, 33, 33]);
    assert.deepEqual(splitByWeights(10000, [2, 1]), [6667, 3333]);
    assert.deepEqual(splitByWeights(-100, [1, 1, 1]), [-34, -33, -33]);
    for (let i = 0; i < 200; i++) {
      const total = Math.floor(Math.random() * 1e7) + 1;
      const w = Array.from({ length: 1 + (i % 7) }, () => Math.floor(Math.random() * 1000) + 1);
      assert.equal(splitByWeights(total, w).reduce((a, b) => a + b, 0), total);
    }
  });

  test("periods follow the Indian financial year; weeks start Monday", () => {
    const d = new Date("2026-11-15T00:00:00Z"); // a Sunday
    const iso = (r: { from: Date; to: Date }) => [r.from.toISOString().slice(0, 10), r.to.toISOString().slice(0, 10)];
    assert.deepEqual(iso(periodRange("week", d)), ["2026-11-09", "2026-11-15"]);
    assert.deepEqual(iso(periodRange("month", d)), ["2026-11-01", "2026-11-30"]);
    assert.deepEqual(iso(periodRange("quarter", d)), ["2026-10-01", "2026-12-31"]);
    assert.deepEqual(iso(periodRange("year", d)), ["2026-04-01", "2027-03-31"]);
    assert.deepEqual(iso(periodRange("year", new Date("2027-02-10T00:00:00Z"))), ["2026-04-01", "2027-03-31"]);
    assert.deepEqual(iso(periodRange("quarter", new Date("2027-02-10T00:00:00Z"))), ["2027-01-01", "2027-03-31"]);
  });

  test("pay suggestions read HR figures the way the live data is written, and never guess", () => {
    const a = suggestEmployeePay("7,00,000");
    assert.equal(a.monthlyPaise, 5833333); // ₹7,00,000 / 12 = ₹58,333.33
    assert.ok(a.monthlyPaise !== null && a.basis === "ANNUAL_CTC" && a.confidence === "check");
    const b = suggestEmployeePay("25,00,000");
    assert.equal(b.monthlyPaise, 20833333);
    const c = suggestEmployeePay("25000");
    assert.ok(c.monthlyPaise === 2500000 && c.basis === "MONTHLY_FIGURE" && c.confidence === "check");
    const d = suggestEmployeePay("Rs 10,000/month");
    assert.ok(d.monthlyPaise === 1000000 && d.confidence === "high");
    assert.equal(suggestEmployeePay("12 LPA").monthlyPaise, 10000000); // ₹12,00,000 a year = ₹1,00,000 a month
    assert.equal(suggestEmployeePay("Remote").monthlyPaise, null);
    assert.equal(suggestEmployeePay("10k-15k").monthlyPaise, null);
    assert.equal(suggestEmployeePay(null).monthlyPaise, null);

    assert.equal(suggestStipend(null, "5000").monthlyRupees, 5000);
    assert.equal(suggestStipend(null, "Rs 10,000/month").monthlyRupees, 10000);
    assert.equal(suggestStipend(null, "10k-15k").monthlyRupees, null);
    assert.equal(suggestStipend(null, null).monthlyRupees, null);
    assert.equal(suggestStipend(3000, "anything").confirmed, true);
  });
});

const DB = testDatabaseUrl();
if (!DB) {
  test("finance portal (needs TEST_DATABASE_URL on localhost)", { skip: true }, () => {});
} else {
  describe("finance portal", () => {
    let h: Awaited<ReturnType<typeof startHarness>>;
    let superAdmin: Person, superAdmin2: Person, admin: Person, cfo: Person, mgrA: Person, viewerA: Person, outsider: Person, internUser: Person;
    let A: any, B: any;
    let rent: any, software: any, travel: any;

    const F = (p: string) => `/api/finance${p}`;
    const as = (p: Person) => ({
      get: (path: string) => h.call("GET", F(path), p.token),
      post: (path: string, body?: unknown) => h.call("POST", F(path), p.token, body ?? {}),
      patch: (path: string, body: unknown) => h.call("PATCH", F(path), p.token, body),
      put: (path: string, body: unknown) => h.call("PUT", F(path), p.token, body),
      del: (path: string) => h.call("DELETE", F(path), p.token),
    });
    const expect = (r: { status: number; body: any }, status: number) => assert.equal(r.status, status, JSON.stringify(r.body));
    const expense = (by: Person, body: Record<string, unknown>) =>
      as(by).post("/expenses", { title: "Test", categoryId: rent.id, amount: "100", incurredOn: "2026-10-05", ...body });

    let n = 0;
    const employee = (startupId: string, extra: Record<string, unknown> = {}) =>
      h.prisma.employee.create({ data: { startupId, employeeCode: `E-${++n}-${h.uniq()}`, fullName: `Emp ${n}`, email: `emp${n}-${h.uniq()}@x.test`, designation: "Engineer", employmentType: "FULL_TIME", joinedAt: new Date("2026-01-01"), ...extra } });
    const intern = (startupId: string, extra: Record<string, unknown> = {}) =>
      h.prisma.intern.create({ data: { startupId, internCode: `I-${++n}-${h.uniq()}`, fullName: `Intern ${n}`, email: `int${n}-${h.uniq()}@x.test`, designation: "Intern", startDate: new Date("2026-01-01"), endDate: new Date("2030-01-01"), ...extra } });

    before(async () => {
      h = await startHarness(DB);
      superAdmin = await h.person("fin-super", "SUPER_ADMIN");
      superAdmin2 = await h.person("fin-super2", "SUPER_ADMIN");
      admin = await h.person("fin-admin", "ADMIN");
      cfo = await h.person("fin-cfo", "INVESTOR");
      mgrA = await h.person("fin-mgr");
      viewerA = await h.person("fin-viewer");
      outsider = await h.person("fin-out");
      internUser = await h.person("fin-intern");
      const founder = await h.person("fin-founder", "FOUNDER");
      A = await h.startup(founder, { name: "Alpha Fin" });
      B = await h.startup(founder, { name: "Beta Fin" });
      const cats = (await as(founder).get("/categories")).body.data;
      rent = cats.find((c: any) => c.key === "office_rent");
      software = cats.find((c: any) => c.key === "software");
      travel = cats.find((c: any) => c.key === "travel");
      assert.ok(rent && software && travel, "default categories exist");
    });
    after(async () => h?.close());

    /* Roles */

    test("no finance role, no finance data — platform admins included", async () => {
      for (const p of [admin, superAdmin, outsider]) {
        expect(await as(p).get("/overview"), 403);
        expect(await as(p).get("/expenses"), 403);
      }
      const me = await as(admin).get("/me");
      expect(me, 200);
      assert.deepEqual(me.body.data.roles, []);
    });

    test("only a super admin assigns roles, only to verified accounts, never to themselves", async () => {
      expect(await as(admin).post("/roles", { userId: cfo.id, role: "ECOSYSTEM_CFO" }), 403);
      expect(await as(superAdmin).post("/roles", { userId: superAdmin.id, role: "ECOSYSTEM_CFO" }), 403);

      await h.prisma.user.update({ where: { id: cfo.id }, data: { emailVerifiedAt: null } });
      const unverified = await as(superAdmin).post("/roles", { userId: cfo.id, role: "ECOSYSTEM_CFO" });
      expect(unverified, 409);
      assert.equal(unverified.body.code, "ACCOUNT_NOT_VERIFIED");
      const cand = await as(superAdmin).get(`/roles/candidates?q=fin-cfo`);
      assert.equal(cand.body.data[0].canGrant, false);
      await h.prisma.user.update({ where: { id: cfo.id }, data: { emailVerifiedAt: new Date() } });

      expect(await as(superAdmin).post("/roles", { userId: cfo.id, role: "ECOSYSTEM_CFO", startupId: A.id }), 400);
      expect(await as(superAdmin).post("/roles", { userId: cfo.id, role: "ECOSYSTEM_CFO" }), 201);
      // More than one CFO is allowed; the same person twice is not.
      expect(await as(superAdmin).post("/roles", { userId: cfo.id, role: "ECOSYSTEM_CFO" }), 409);

      expect(await as(superAdmin).post("/roles", { userId: mgrA.id, role: "STARTUP_FINANCE_MANAGER" }), 400);
      expect(await as(superAdmin).post("/roles", { userId: mgrA.id, role: "STARTUP_FINANCE_MANAGER", startupId: A.id }), 201);
      expect(await as(superAdmin).post("/roles", { userId: mgrA.id, role: "STARTUP_FINANCE_MANAGER", startupId: A.id }), 409);
      expect(await as(superAdmin).post("/roles", { userId: viewerA.id, role: "FINANCE_VIEWER", startupId: A.id }), 201);

      const sl = await as(superAdmin).get("/roles/startups");
      expect(sl, 200);
      assert.ok(sl.body.data.some((x: any) => x.id === A.id));
      expect(await as(admin).get("/roles/startups"), 403);
      const list = await as(superAdmin).get("/roles");
      assert.equal(list.body.data.filter((r: any) => r.active).length, 3);
      const note = await h.prisma.notification.findFirst({ where: { userId: cfo.id, type: "FINANCE_ACCESS" } });
      assert.ok(note, "the new CFO is told");
      const log = await h.prisma.auditLog.count({ where: { entity: "FinanceRole", action: "finance.role.granted" } });
      assert.equal(log, 3);
    });

    test("a revoked role stops working at once and stays on record", async () => {
      const r = await as(superAdmin).post("/roles", { userId: outsider.id, role: "FINANCE_VIEWER" });
      expect(r, 201);
      expect(await as(outsider).get("/overview"), 200);
      expect(await as(superAdmin2).post(`/roles/${r.body.data.id}/revoke`, { reason: "test" }), 200);
      expect(await as(outsider).get("/overview"), 403);
      const row = await h.prisma.financeRole.findUnique({ where: { id: r.body.data.id } });
      assert.ok(row?.revokedAt && row.revokedBy === superAdmin2.id);
    });

    /* Expenses and scope */

    test("expense numbers run per scope and financial year", async () => {
      const c1 = await expense(cfo, { scope: "central", title: "Rent Oct" });
      expect(c1, 201);
      assert.match(c1.body.data.number, /^EXP-DEV-2026-27-\d{4}$/);
      const a1 = await expense(cfo, { scope: A.id, title: "Alpha thing" });
      assert.equal(a1.body.data.number, `EXP-${A.code}-2026-27-0001`);
      const old = await expense(cfo, { scope: A.id, incurredOn: "2026-03-20" });
      assert.equal(old.body.data.number, `EXP-${A.code}-2025-26-0001`);
    });

    test("a startup finance manager sees and changes only their startup, and cannot approve", async () => {
      const mine = await expense(mgrA, { scope: A.id, title: "Alpha supplies", amount: "250" });
      expect(mine, 201);
      assert.equal(mine.body.data.status, "SUBMITTED");
      expect(await expense(mgrA, { scope: B.id }), 404);
      expect(await expense(mgrA, { scope: "central" }), 404);
      expect(await expense(mgrA, { scope: A.id, action: "paid" }), 403);

      const bExp = await expense(cfo, { scope: B.id, title: "Beta secret" });
      expect(await as(mgrA).get(`/expenses/${bExp.body.data.id}`), 404);
      const list = await as(mgrA).get("/expenses");
      assert.ok(list.body.data.rows.every((r: any) => r.startupId === A.id));
      expect(await as(mgrA).get("/expenses?scope=central"), 404);
      expect(await as(mgrA).get(`/expenses?scope=${B.id}`), 404);

      const ap = await as(mgrA).post(`/expenses/${mine.body.data.id}/approve`);
      expect(ap, 403);
      assert.equal(ap.body.code, "CFO_ONLY");
      expect(await as(mgrA).get("/pay"), 403);
    });

    test("a viewer can read their startup but change nothing", async () => {
      expect(await as(viewerA).get(`/expenses?scope=${A.id}`), 200);
      const r = await expense(viewerA, { scope: A.id });
      expect(r, 403);
      assert.equal(r.body.code, "FINANCE_READ_ONLY");
      expect(await as(viewerA).post("/vendors", { name: "Nope Ltd" }), 403);
    });

    test("approve → pay is recorded once; a paid expense is final and fixed by a correction", async () => {
      const e = (await expense(mgrA, { scope: A.id, title: "Laptop", categoryId: travel.id, amount: "45,000" })).body.data;
      expect(await as(cfo).post(`/expenses/${e.id}/pay`, { paymentRef: "UTR1" }), 409); // not approved yet
      expect(await as(cfo).post(`/expenses/${e.id}/approve`, { note: "ok" }), 200);
      const paid = await as(cfo).post(`/expenses/${e.id}/pay`, { paymentRef: "UTR123", paymentMethod: "BANK_TRANSFER", paidOn: "2026-10-07" });
      expect(paid, 200);
      assert.equal(paid.body.data.status, "PAID");
      // Same call again: nothing changes. A different reference: refused.
      expect(await as(cfo).post(`/expenses/${e.id}/pay`, { paymentRef: "UTR123" }), 200);
      const again = await as(cfo).post(`/expenses/${e.id}/pay`, { paymentRef: "UTR999" });
      expect(again, 409);
      assert.equal(again.body.code, "ALREADY_PAID");

      const edit = await as(cfo).patch(`/expenses/${e.id}`, { amount: "40000" });
      expect(edit, 409);
      assert.equal(edit.body.code, "PAID_IS_FINAL");
      expect(await as(cfo).post(`/expenses/${e.id}/void`, { reason: "oops" }), 409);
      expect(await as(cfo).del(`/expenses/${e.id}`), 409);

      const fix = await as(cfo).post(`/expenses/${e.id}/correct`, { amount: "-5000", reason: "Refund from vendor" });
      expect(fix, 201);
      assert.equal(fix.body.data.kind, "ADJUSTMENT");
      assert.equal(fix.body.data.amountPaise, -500000);
      assert.equal(fix.body.data.correctsId, e.id);
      const detail = (await as(cfo).get(`/expenses/${e.id}`)).body.data;
      assert.equal(detail.amountPaise, 4500000, "the original is untouched");
      assert.equal(detail.corrections.length, 1);
      assert.deepEqual(detail.history.map((x: any) => x.action), ["finance.expense.created", "finance.expense.approved", "finance.expense.paid", "finance.expense.corrected"]);
    });

    test("edits are recorded field by field; rejection and info requests carry a reason", async () => {
      const e = (await expense(mgrA, { scope: A.id, title: "Cab", categoryId: travel.id, amount: "300" })).body.data;
      const ed = await as(mgrA).patch(`/expenses/${e.id}`, { amount: "350", title: "Cab to client" });
      expect(ed, 200);
      const hist = (await as(cfo).get(`/expenses/${e.id}`)).body.data.history;
      const change = hist.find((x: any) => x.action === "finance.expense.edited").details.changes;
      assert.deepEqual(change.amountPaise, { from: 30000, to: 35000 });
      expect(await as(cfo).post(`/expenses/${e.id}/reject`, {}), 400);
      expect(await as(cfo).post(`/expenses/${e.id}/request-info`, { message: "Attach the receipt" }), 200);
      const re = await as(mgrA).post(`/expenses/${e.id}/submit`);
      expect(re, 200);
      assert.equal(re.body.data.status, "SUBMITTED");
      expect(await as(cfo).post(`/expenses/${e.id}/reject`, { reason: "Personal trip" }), 200);
      // Editing a rejected expense puts it back to draft.
      assert.equal((await as(mgrA).patch(`/expenses/${e.id}`, { notes: "was a client visit" })).body.data.status, "DRAFT");
    });

    test("a status change that races another one is refused, not applied twice", async () => {
      const e = (await expense(cfo, { scope: A.id, amount: "10" })).body.data;
      const [x, y] = await Promise.all([as(cfo).post(`/expenses/${e.id}/approve`), as(cfo).post(`/expenses/${e.id}/approve`)]);
      assert.deepEqual([x.status, y.status].sort(), [200, 409]);
      assert.equal(await h.prisma.auditLog.count({ where: { entityId: e.id, action: "finance.expense.approved" } }), 1);
    });

    /* Shared costs */

    test("a central cost splits exactly, by percent, amount, headcount or usage", async () => {
      const e = (await expense(cfo, { scope: "central", title: "Office rent Oct", amount: "1000", action: "paid", paymentRef: "R-OCT" })).body.data;
      const pct = await as(cfo).put(`/expenses/${e.id}/allocations`, { method: "PERCENT", shares: [{ scope: A.id, percent: 33.33 }, { scope: B.id, percent: 33.33 }, { scope: "central", percent: 33.34 }] });
      expect(pct, 200);
      const byScope = Object.fromEntries(pct.body.data.allocations.map((x: any) => [x.startupId ?? "central", x.amountPaise]));
      assert.deepEqual(byScope, { [A.id]: 33330, [B.id]: 33330, central: 33340 });

      const bad = await as(cfo).put(`/expenses/${e.id}/allocations`, { method: "PERCENT", shares: [{ scope: A.id, percent: 50 }, { scope: B.id, percent: 40 }] });
      assert.equal(bad.body.code, "ALLOCATION_NOT_100");
      const mismatch = await as(cfo).put(`/expenses/${e.id}/allocations`, { method: "FIXED", shares: [{ scope: A.id, amount: "600" }, { scope: B.id, amount: "300" }] });
      assert.equal(mismatch.body.code, "ALLOCATION_MISMATCH");
      expect(await as(cfo).put(`/expenses/${e.id}/allocations`, { method: "FIXED", shares: [{ scope: A.id, amount: "600" }, { scope: A.id, amount: "400" }] }), 400);

      // Headcount: Alpha has 2 people working now, Beta 1. An intern whose period ended doesn't count.
      await employee(A.id);
      await intern(A.id);
      await employee(B.id);
      await intern(B.id, { endDate: new Date("2026-02-01") });
      const hc = await as(cfo).put(`/expenses/${e.id}/allocations`, { method: "HEADCOUNT", shares: [{ scope: A.id }, { scope: B.id }] });
      expect(hc, 200);
      const hcBy = Object.fromEntries(hc.body.data.allocations.map((x: any) => [x.startupId, [x.amountPaise, x.basis]]));
      assert.deepEqual(hcBy, { [A.id]: [66667, 2], [B.id]: [33333, 1] });

      const use = await as(cfo).put(`/expenses/${e.id}/allocations`, { method: "USAGE", shares: [{ scope: A.id, units: 3 }, { scope: B.id, units: 1 }] });
      assert.deepEqual(use.body.data.allocations.map((x: any) => x.amountPaise).sort((p: number, q: number) => q - p), [75000, 25000]);

      expect(await as(mgrA).put(`/expenses/${e.id}/allocations`, { method: "USAGE", shares: [] }), 404);
      const aExp = (await expense(cfo, { scope: A.id })).body.data;
      assert.equal((await as(cfo).put(`/expenses/${aExp.id}/allocations`, { method: "PERCENT", shares: [{ scope: B.id, percent: 100 }] })).body.code, "NOT_CENTRAL");
    });

    test("the dashboard counts every cost once; a startup sees its share of shared costs beside its own", async () => {
      // A fresh pair of startups so earlier tests don't change the figures.
      const founder = await h.person("fin-founder2", "FOUNDER");
      const X = await h.startup(founder, { name: "Xeno Fin" });
      const Y = await h.startup(founder, { name: "Ypsi Fin" });
      const range = "period=custom&from=2026-08-01&to=2026-08-31";
      const inAug = { incurredOn: "2026-08-10" };
      const central = (await expense(cfo, { ...inAug, scope: "central", title: "Aug rent", amount: "10000", action: "paid" })).body.data;
      await expense(cfo, { ...inAug, scope: X.id, title: "X ads", categoryId: software.id, amount: "2,500.50", action: "paid" });
      await expense(cfo, { ...inAug, scope: Y.id, title: "Y tools", categoryId: software.id, amount: "1000", action: "paid" });
      const unpaid = (await expense(cfo, { ...inAug, scope: Y.id, title: "Y bill", amount: "700", dueOn: "2026-01-01" })).body.data;
      await as(cfo).post(`/expenses/${unpaid.id}/approve`);
      await expense(cfo, { ...inAug, scope: X.id, title: "X draft", amount: "999", action: "draft" });
      await as(cfo).put(`/expenses/${central.id}/allocations`, { method: "PERCENT", shares: [{ scope: X.id, percent: 60 }, { scope: Y.id, percent: 40 }] });

      const xv = (await as(cfo).get(`/overview?scope=${X.id}&${range}`)).body.data;
      assert.equal(xv.cards.spentPaise, 250050, "X's own spending only");
      assert.equal(xv.cards.sharedCostSharePaise, 600000, "60% of ₹10,000 shown separately");
      const yv = (await as(cfo).get(`/overview?scope=${Y.id}&${range}`)).body.data;
      assert.equal(yv.cards.spentPaise, 100000);
      assert.equal(yv.cards.sharedCostSharePaise, 400000);
      assert.equal(yv.cards.billsToPayPaise, 70000);
      assert.equal(yv.cards.overduePaise, 70000);

      const all = (await as(cfo).get(`/overview?${range}`)).body.data;
      const row = (id: string) => all.byStartup.find((r: any) => r.id === id);
      assert.equal(row("central").spentPaise, 1000000);
      assert.equal(row(X.id).spentPaise, 250050);
      assert.equal(row(Y.id).sharedCostSharePaise, 400000);
      // Ecosystem spent = central + X + Y direct, never the shares again: 10000 + 2500.50 + 1000 = ₹13,500.50
      // (other startups from earlier tests spent nothing in August).
      assert.equal(all.cards.spentPaise, 1350050);
      assert.equal(all.byStartup.reduce((s: number, r: any) => s + r.spentPaise, 0), all.cards.spentPaise);
      assert.equal(all.budget, null, "no budget set: says so, rather than 0");
      assert.equal(all.cards.moneyReceivedPaise, null, "modules not built yet say so, rather than 0");
      assert.ok(all.payroll, "the CFO sees payroll");
      const aug = all.trend.find((m: any) => m.month === "2026-08");
      if (aug) assert.equal(aug.spentPaise, 1350050);
      expect(await as(mgrA).get(`/overview?scope=${X.id}`), 404);
      assert.equal((await as(viewerA).get(`/overview?scope=${A.id}`)).body.data.payroll, null, "viewers never see pay");
    });

    /* Claims */

    test("staff claim expenses for their own startup; finance reviews them", async () => {
      await intern(A.id, { userId: internUser.id, email: internUser.email });
      const claim = await as(internUser).post("/me/claims", { scope: A.id, title: "Client lunch", categoryId: travel.id, amount: "640", incurredOn: "2026-10-12", businessPurpose: "Lunch with Acme to demo the app" });
      expect(claim, 201);
      assert.equal(claim.body.data.kind, "REIMBURSEMENT");
      assert.equal(claim.body.data.claimantUserId, internUser.id);
      expect(await as(internUser).post("/me/claims", { scope: B.id, title: "Other startup", categoryId: travel.id, amount: "1", incurredOn: "2026-10-12", businessPurpose: "not mine" }), 403);
      expect(await as(outsider).post("/me/claims", { scope: A.id, title: "Not my startup", categoryId: travel.id, amount: "1", incurredOn: "2026-10-12", businessPurpose: "not mine" }), 403);

      assert.equal((await as(internUser).get("/me/claims")).body.data.length, 1);
      expect(await as(internUser).get("/expenses"), 403);
      expect(await as(internUser).post(`/expenses/${claim.body.data.id}/approve`), 403);

      const forMgr = await as(mgrA).get(`/expenses?kind=REIMBURSEMENT&scope=${A.id}`);
      assert.ok(forMgr.body.data.rows.some((r: any) => r.id === claim.body.data.id));
      expect(await as(cfo).post(`/expenses/${claim.body.data.id}/request-info`, { message: "Need the bill" }), 200);
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
      const form = new FormData();
      form.append("file", new Blob([png], { type: "image/png" }), "bill.png");
      const up = await h.upload(F(`/me/claims/${claim.body.data.id}/attachments`), form, { Authorization: `Bearer ${internUser.token}` });
      assert.equal(up.status, 201, JSON.stringify(up.body));
      assert.equal(up.body.data.storagePath, undefined, "the storage path is never sent out");
      const link = await as(internUser).get(`/attachments/${up.body.data.id}/link`);
      expect(link, 200);
      assert.match(link.body.data.url, /signed/);
      expect(await as(outsider).get(`/attachments/${up.body.data.id}/link`), 404);
      expect(await as(internUser).post(`/me/claims/${claim.body.data.id}/submit`), 200);
      expect(await as(cfo).post(`/expenses/${claim.body.data.id}/approve`), 200);
      expect(await as(cfo).post(`/expenses/${claim.body.data.id}/pay`, { paymentRef: "UPI-77" }), 200);
      assert.equal((await as(internUser).get("/me/claims")).body.data[0].status, "PAID");
    });

    test("a fake file is refused, whatever its name says", async () => {
      const e = (await expense(mgrA, { scope: A.id })).body.data;
      const form = new FormData();
      form.append("file", new Blob([Buffer.from("<script>alert(1)</script>")], { type: "image/png" }), "receipt.png");
      const up = await h.upload(F(`/expenses/${e.id}/attachments`), form, { Authorization: `Bearer ${mgrA.token}` });
      assert.equal(up.status, 400, JSON.stringify(up.body));
    });

    /* Pay setup */

    test("pay setup suggests from HR, uses nothing until the CFO confirms, and keeps history", async () => {
      const emp = await employee(A.id, { ctc: "7,00,000", fullName: "Salaried One" });
      await intern(A.id, { stipend: "5000", fullName: "Stipend One" });
      await intern(A.id, { stipend: null, fullName: "No Stipend" });
      await intern(A.id, { stipend: "3000", fullName: "Ended One", endDate: new Date("2026-02-01") });

      const setup = await as(cfo).get(`/pay?startup=${A.id}`);
      expect(setup, 200);
      const e1 = setup.body.data.employees.find((x: any) => x.id === emp.id);
      assert.equal(e1.payStatus, "NEEDS_CONFIRMATION");
      assert.equal(e1.suggestion.monthlyPaise, 5833333);
      const s1 = setup.body.data.interns.find((x: any) => x.name === "Stipend One");
      assert.equal(s1.suggestion.monthlyRupees, 5000);
      assert.equal(setup.body.data.interns.find((x: any) => x.name === "No Stipend").suggestion.monthlyRupees, null);
      assert.ok(setup.body.data.interns.find((x: any) => x.name === "Ended One").warning);
      for (const p of [mgrA, viewerA]) expect(await as(p).get("/pay"), 403);

      const bad = await as(cfo).put(`/pay/employees/${emp.id}/compensation`, { monthlyGross: "58333.33", effectiveFrom: "2026-11-01", components: [{ name: "Basic", amount: "30000" }, { name: "HRA", amount: "20000" }] });
      assert.equal(bad.body.code, "COMPONENTS_MISMATCH");
      const ok1 = await as(cfo).put(`/pay/employees/${emp.id}/compensation`, {
        monthlyGross: "58333.33", annualCtc: "700000", effectiveFrom: "2026-11-01", basis: "CONFIRMED_FROM_HR",
        components: [{ name: "Basic", amount: "30000" }, { name: "HRA", amount: "15000" }, { name: "Special allowance", amount: "13333.33" }],
      });
      expect(ok1, 200);
      expect(await as(cfo).put(`/pay/employees/${emp.id}/compensation`, { monthlyGross: "60000", effectiveFrom: "2026-10-01" }), 409);
      expect(await as(cfo).put(`/pay/employees/${emp.id}/compensation`, { monthlyGross: "62000", effectiveFrom: "2027-04-01", note: "Raise" }), 200);
      const hist = await h.prisma.employeeCompensation.findMany({ where: { employeeId: emp.id }, orderBy: { effectiveFrom: "asc" } });
      assert.equal(hist.length, 2);
      assert.equal(hist[0].effectiveTo?.toISOString().slice(0, 10), "2027-03-31");
      assert.equal(hist[1].effectiveTo, null);

      expect(await as(cfo).put(`/pay/interns/${s1.id}/stipend`, { monthly: "5000" }), 200);
      expect(await as(cfo).put(`/pay/interns/${s1.id}/stipend`, { monthly: "5000.50" }), 400);
      const after = (await as(cfo).get(`/pay?startup=${A.id}`)).body.data;
      assert.equal(after.employees.find((x: any) => x.id === emp.id).compensation.monthlyGrossPaise, 6200000);
      assert.equal(after.interns.find((x: any) => x.id === s1.id).payStatus, "CONFIRMED");
      assert.equal((await h.prisma.intern.findUnique({ where: { id: s1.id } }))!.stipendAmount, 5000);
    });

    test("bank details are encrypted, never listed in full, and replaced with history", async () => {
      const emp = await employee(A.id, { fullName: "Bank Person" });
      expect(await as(cfo).put("/pay/bank", { employeeId: emp.id, accountHolder: "Bank Person", accountNumber: "1234", ifsc: "SBIN0001234" }), 400);
      expect(await as(cfo).put("/pay/bank", { employeeId: emp.id, accountHolder: "Bank Person", accountNumber: "123456789012", ifsc: "BADIFSC1234" }), 400);
      const r = await as(cfo).put("/pay/bank", { employeeId: emp.id, accountHolder: "Bank Person", accountNumber: "123456789012", ifsc: "sbin0001234", upiId: "bank.person@okaxis" });
      expect(r, 200);
      assert.deepEqual([r.body.data.accountLast4, r.body.data.ifsc, r.body.data.hasUpi], ["9012", "SBIN0001234", true]);
      assert.equal(JSON.stringify(r.body).includes("123456789012"), false);
      const row = await h.prisma.payeeBankAccount.findFirst({ where: { employeeId: emp.id } });
      assert.ok(row && !row.accountCipher.includes("123456789012"));
      await as(cfo).put("/pay/bank", { employeeId: emp.id, accountHolder: "Bank Person", accountNumber: "999988887777", ifsc: "HDFC0000001" });
      const all = await h.prisma.payeeBankAccount.findMany({ where: { employeeId: emp.id } });
      assert.equal(all.length, 2);
      assert.equal(all.filter((b) => !b.deactivatedAt).length, 1);
      const audits = await h.prisma.auditLog.findMany({ where: { entity: "FinanceBankAccount" } });
      assert.equal(JSON.stringify(audits).includes("123456789012"), false, "not even the audit log holds the number");
      const setup = (await as(cfo).get(`/pay?startup=${A.id}`)).body.data;
      assert.equal(setup.employees.find((x: any) => x.id === emp.id).bank.accountLast4, "7777");
      expect(await as(mgrA).put("/pay/bank", { employeeId: emp.id, accountHolder: "X", accountNumber: "123456789012", ifsc: "SBIN0001234" }), 403);
    });
  });
}
