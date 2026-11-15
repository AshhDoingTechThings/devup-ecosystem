/**
 * Finance, slice 2: budgets, recurring office bills, the daily job,
 * subscriptions and seats, meetings and events. Real Express and Postgres via
 * the harness. Every figure is checked to the paisa against hand-worked values.
 */
import "./support/finance-env";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, testDatabaseUrl, Person } from "./support/harness";
// Pure module only: server modules must not load before startHarness().
import { dueDates } from "../src/modules/finance/recurringDates";

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("recurring due dates", () => {
  test("monthly, quarterly, yearly and weekly bills fall on the right days, and stop at the end date", () => {
    const m = dueDates({ frequency: "MONTHLY", dueDay: 10, startsOn: D("2026-01-15"), endsOn: null }, D("2026-01-01"), D("2026-05-31"));
    assert.deepEqual(m.map(iso), ["2026-02-10", "2026-03-10", "2026-04-10", "2026-05-10"]);
    const q = dueDates({ frequency: "QUARTERLY", dueDay: 5, startsOn: D("2026-04-01"), endsOn: null }, D("2026-01-01"), D("2027-01-31"));
    assert.deepEqual(q.map(iso), ["2026-04-05", "2026-07-05", "2026-10-05", "2027-01-05"]);
    const y = dueDates({ frequency: "YEARLY", dueDay: 1, startsOn: D("2026-03-01"), endsOn: null }, D("2026-01-01"), D("2028-12-31"));
    assert.deepEqual(y.map(iso), ["2026-03-01", "2027-03-01", "2028-03-01"]);
    const w = dueDates({ frequency: "WEEKLY", dueDay: 1, startsOn: D("2026-11-11"), endsOn: D("2026-11-30") }, D("2026-11-01"), D("2026-12-31"));
    assert.deepEqual(w.map(iso), ["2026-11-16", "2026-11-23", "2026-11-30"]);
    const ended = dueDates({ frequency: "MONTHLY", dueDay: 10, startsOn: D("2026-01-01"), endsOn: D("2026-02-20") }, D("2026-01-01"), D("2026-12-31"));
    assert.deepEqual(ended.map(iso), ["2026-01-10", "2026-02-10"]);
  });
});

const DB = testDatabaseUrl();
if (!DB) {
  test("finance slice 2 (needs TEST_DATABASE_URL on localhost)", { skip: true }, () => {});
} else {
  describe("finance slice 2", () => {
    let h: Awaited<ReturnType<typeof startHarness>>;
    let cfo: Person, mgrA: Person, viewerA: Person, superAdmin: Person, staff: Person;
    let A: any, B: any;
    let cat: Record<string, string>;

    const F = (p: string) => `/api/finance${p}`;
    const as = (p: Person) => ({
      get: (path: string) => h.call("GET", F(path), p.token),
      post: (path: string, body?: unknown) => h.call("POST", F(path), p.token, body ?? {}),
      patch: (path: string, body: unknown) => h.call("PATCH", F(path), p.token, body),
      del: (path: string) => h.call("DELETE", F(path), p.token),
    });
    const expect = (r: { status: number; body: any }, status: number) => assert.equal(r.status, status, JSON.stringify(r.body));
    const spend = (scope: string, key: string, amount: string, incurredOn: string, action: "paid" | "submit" = "paid") =>
      as(cfo).post("/expenses", { scope, title: `${key} ${amount}`, categoryId: cat[key], amount, incurredOn, action });
    const approve = async (r: { body: any }) => as(cfo).post(`/expenses/${r.body.data.id}/approve`);

    before(async () => {
      h = await startHarness(DB);
      superAdmin = await h.person("s2-super", "SUPER_ADMIN");
      cfo = await h.person("s2-cfo");
      mgrA = await h.person("s2-mgr");
      viewerA = await h.person("s2-viewer");
      staff = await h.person("s2-staff");
      const founder = await h.person("s2-founder", "FOUNDER");
      A = await h.startup(founder, { name: "Alpha S2" });
      B = await h.startup(founder, { name: "Beta S2" });
      for (const [u, role, s] of [[cfo, "ECOSYSTEM_CFO", null], [mgrA, "STARTUP_FINANCE_MANAGER", A.id], [viewerA, "FINANCE_VIEWER", A.id]] as const) {
        expect(await h.call("POST", "/api/finance/roles", superAdmin.token, { userId: u.id, role, startupId: s }), 201);
      }
      const cats = (await as(cfo).get("/categories")).body.data;
      cat = Object.fromEntries(cats.map((c: any) => [c.key, c.id]));
    });
    after(async () => h?.close());

    /* Budgets */

    test("an ecosystem budget: available = allocated − spent − committed, each cost once", async () => {
      // September: central ₹10,000 paid; Alpha ₹5,000 paid; Alpha ₹2,000 approved, not paid; a draft that must not count.
      await spend("central", "office_rent", "10000", "2026-09-05");
      await spend(A.id, "software", "5000", "2026-09-08");
      await approve(await spend(A.id, "travel", "2000", "2026-09-09", "submit"));
      await as(cfo).post("/expenses", { scope: A.id, title: "draft", categoryId: cat.travel, amount: "999", incurredOn: "2026-09-10", action: "draft" });
      await spend("central", "office_rent", "7000", "2026-10-05"); // outside the period

      const b = await as(cfo).post("/budgets", { name: "September", scope: "ECOSYSTEM", period: "MONTHLY", anchor: "2026-09-15", lines: [{ amount: "50000" }] });
      expect(b, 201);
      assert.equal(iso(new Date(b.body.data.periodStart)), "2026-09-01");
      assert.equal(iso(new Date(b.body.data.periodEnd)), "2026-09-30");
      assert.deepEqual(
        [b.body.data.totals.allocatedPaise, b.body.data.totals.spentPaise, b.body.data.totals.committedPaise, b.body.data.totals.availablePaise],
        [5000000, 1500000, 200000, 3300000],
      );
      assert.equal(b.body.data.totals.usedPercent, 34);

      const snap = (await as(cfo).get("/overview?period=custom&from=2026-09-01&to=2026-09-30")).body.data.budget;
      assert.equal(snap.availablePaise, 3300000);
    });

    test("budget lines are either one total or per group, never both; only the CFO sets budgets", async () => {
      const mixed = await as(cfo).post("/budgets", { name: "Test budget", scope: "ECOSYSTEM", period: "MONTHLY", lines: [{ amount: "1" }, { categoryGroup: "People", amount: "1" }] });
      assert.equal(mixed.body.code, "MIXED_LINES");
      const dup = await as(cfo).post("/budgets", { name: "Test budget", scope: "ECOSYSTEM", period: "MONTHLY", lines: [{ categoryGroup: "People", amount: "1" }, { categoryGroup: "People", amount: "2" }] });
      assert.equal(dup.body.code, "DUPLICATE_LINE");
      assert.equal((await as(cfo).post("/budgets", { name: "Test budget", scope: "ECOSYSTEM", period: "MONTHLY", lines: [{ categoryGroup: "Snacks", amount: "1" }] })).body.code, "UNKNOWN_GROUP");
      assert.equal((await as(cfo).post("/budgets", { name: "Test budget", scope: "STARTUP", period: "MONTHLY", lines: [{ amount: "1" }] })).body.code, "STARTUP_REQUIRED");
      expect(await as(mgrA).post("/budgets", { name: "Mine", scope: "STARTUP", startupId: A.id, period: "MONTHLY", lines: [{ amount: "1" }] }), 403);
    });

    test("a startup budget counts its own spending plus its share of shared costs, and shows what isn't budgeted", async () => {
      // October: central rent ₹7,000 (from the test above) split 50% to Alpha → ₹3,500 share; Alpha's own office supplies ₹1,000 and marketing ₹800.
      const rent = (await as(cfo).get("/expenses?scope=central&from=2026-10-01&to=2026-10-31")).body.data.rows[0];
      expect(await h.call("PUT", F(`/expenses/${rent.id}/allocations`), cfo.token, { method: "PERCENT", shares: [{ scope: A.id, percent: 50 }, { scope: "central", percent: 50 }] }), 200);
      await spend(A.id, "office_supplies", "1000", "2026-10-07");
      await spend(A.id, "marketing", "800", "2026-10-09");
      const b = await as(cfo).post("/budgets", { name: "Alpha October", scope: "STARTUP", startupId: A.id, period: "MONTHLY", anchor: "2026-10-01", lines: [{ categoryGroup: "Office & operations", amount: "6000" }, { categoryGroup: "People", amount: "20000" }] });
      expect(b, 201);
      const office = b.body.data.lines.find((l: any) => l.categoryGroup === "Office & operations");
      assert.equal(office.spentPaise, 450000, "₹3,500 share of rent + ₹1,000 supplies");
      assert.equal(office.availablePaise, 150000);
      assert.equal(b.body.data.sharedCostSharePaise, 350000);
      assert.deepEqual(b.body.data.unbudgeted, [{ group: "Marketing", spentPaise: 80000, committedPaise: 0 }]);

      // The viewer of Alpha sees Alpha's budget, not the ecosystem's.
      const seen = (await as(viewerA).get("/budgets")).body.data;
      assert.ok(seen.every((x: any) => x.scope === "STARTUP" && x.startup.id === A.id) && seen.length >= 1);
      const eco = (await as(cfo).get("/budgets?scope=all")).body.data[0];
      expect(await as(viewerA).get(`/budgets/${eco.id}`), 404);
    });

    test("revising amounts needs a reason, bumps the version and keeps the before and after", async () => {
      const b = (await as(cfo).get("/budgets?scope=all")).body.data[0];
      assert.equal((await as(cfo).patch(`/budgets/${b.id}`, { lines: [{ amount: "60000" }] })).body.code, "REASON_REQUIRED");
      const r = await as(cfo).patch(`/budgets/${b.id}`, { lines: [{ amount: "60000" }], reason: "Added a new hire" });
      expect(r, 200);
      assert.equal(r.body.data.version, 2);
      assert.equal(r.body.data.totals.availablePaise, 4300000);
      const rev = r.body.data.history.find((x: any) => x.action === "finance.budget.revised");
      assert.deepEqual([rev.details.before[0].allocatedPaise, rev.details.after[0].allocatedPaise, rev.details.reason], [5000000, 6000000, "Added a new hire"]);
    });

    /* Recurring bills */

    test("a monthly bill becomes one expense per due date, created ahead of time and never twice", async () => {
      const bill = await as(cfo).post("/recurring", { scope: "central", title: "Office rent", categoryId: cat.office_rent, amount: "45000", dueDay: 10, startsOn: "2026-01-01", leadDays: 5, autoApprove: true });
      expect(bill, 201);
      // Run "on" 8 Sept 2026: due dates within the last 60 days and the next 5 → 10 Jul, 10 Aug, 10 Sep.
      const { generateDue } = await import("../src/modules/finance/recurring.service");
      const r1 = await generateDue({ today: D("2026-09-08") });
      const mine = r1.created.filter((c) => c.billId === bill.body.data.id);
      assert.deepEqual(mine.map((c) => c.dueDate), ["2026-07-10", "2026-08-10", "2026-09-10"]);
      // Again, and twice at once: nothing new.
      const [r2, r3] = await Promise.all([generateDue({ today: D("2026-09-08") }), generateDue({ today: D("2026-09-08") })]);
      assert.equal([...r2.created, ...r3.created].filter((c) => c.billId === bill.body.data.id).length, 0);
      assert.equal(await h.prisma.recurringBillRun.count({ where: { billId: bill.body.data.id } }), 3);

      const sept = await h.prisma.expense.findFirst({ where: { source: "RECURRING_BILL", sourceId: bill.body.data.id, dueOn: D("2026-09-10") } });
      assert.equal(sept!.status, "APPROVED", "a fixed bill the CFO set up is created ready to pay");
      assert.equal(sept!.approvedBy, cfo.id);
      assert.equal(iso(sept!.incurredOn), "2026-09-08", "created before it's due, dated the day it was created");
      assert.equal(sept!.amountPaise, 4500000);
    });

    test("only the CFO sets automatic approval; a paused bill creates nothing", async () => {
      const bad = await as(mgrA).post("/recurring", { scope: A.id, title: "Alpha internet", categoryId: cat.internet, amount: "999", dueDay: 3, startsOn: "2026-01-01", autoApprove: true });
      assert.equal(bad.body.code, "CFO_ONLY");
      const ok = await as(mgrA).post("/recurring", { scope: A.id, title: "Alpha internet", categoryId: cat.internet, amount: "999", dueDay: 3, startsOn: "2026-01-01" });
      expect(ok, 201);
      expect(await as(mgrA).post("/recurring", { scope: B.id, title: "Beta x", categoryId: cat.internet, amount: "1", dueDay: 3, startsOn: "2026-01-01" }), 404);
      assert.equal((await as(cfo).post("/recurring", { scope: "central", title: "Bad day", categoryId: cat.water, amount: "1", dueDay: 31, startsOn: "2026-01-01" })).body.code, "INVALID_DUE_DAY");
      expect(await as(mgrA).patch(`/recurring/${ok.body.data.id}`, { isActive: false }), 200);
      const { generateDue } = await import("../src/modules/finance/recurring.service");
      const r = await generateDue({ today: D("2026-09-01") });
      assert.equal(r.created.filter((c) => c.billId === ok.body.data.id).length, 0);
    });

    test("the daily job needs its secret, and sends the CFO one digest a day", async () => {
      const cron = (secret?: string) => h.call("POST", "/api/finance/cron/daily", undefined, {}, secret ? { "x-cron-secret": secret } : {});
      expect(await cron(), 401);
      expect(await cron("wrong-secret-wrong-secret-wrong"), 401);
      const before = h.mails.length;
      const r1 = await cron(process.env.FINANCE_CRON_SECRET);
      expect(r1, 200);
      assert.equal(r1.body.data.digestsSent, 1);
      const mail = h.mails.slice(before).find((m) => /due/.test(m.subject));
      assert.ok(mail, "the CFO got a digest email");
      const r2 = await cron(process.env.FINANCE_CRON_SECRET);
      assert.equal(r2.body.data.digestsSent, 0, "no second digest the same day");
    });

    /* Subscriptions */

    test("subscriptions: seats are used only when assigned, and the alerts say what needs attention", async () => {
      const soon = iso(new Date(Date.now() + 5 * 86400_000));
      const s = await as(cfo).post("/subscriptions", { scope: "central", name: "Design tool", provider: "Figma Inc", plan: "Pro", cost: "2000", seatsPurchased: 3, renewalOn: soon, paymentMethodNote: "Company card ending 4242" });
      expect(s, 201);
      const id = s.body.data.id;
      expect(await as(cfo).post(`/subscriptions/${id}/seats`, { userId: staff.id }), 201);
      assert.equal((await as(cfo).post(`/subscriptions/${id}/seats`, { userId: staff.id })).body.code, "ALREADY_ASSIGNED");
      expect(await as(cfo).post(`/subscriptions/${id}/seats`, { name: "Contractor Ravi" }), 201);
      const list = (await as(cfo).get("/subscriptions?scope=central")).body.data;
      const mine = list.subscriptions.find((x: any) => x.id === id);
      assert.deepEqual([mine.seatsAssigned, mine.seatsUnassigned, mine.monthlyPaise], [2, 1, 200000]);
      const kinds = list.alerts.filter((x: any) => x.subscriptionId === id).map((x: any) => x.kind).sort();
      assert.deepEqual(kinds, ["RENEWAL_SOON", "UNASSIGNED_SEATS"]);
      expect(await as(cfo).post(`/subscriptions/${id}/seats`, { name: "Third" }), 201);
      assert.equal((await as(cfo).post(`/subscriptions/${id}/seats`, { name: "Fourth" })).body.code, "NO_FREE_SEAT");

      const usage = (await as(cfo).get("/subscriptions/usage?scope=central")).body.data.filter((u: any) => u.subscriptionId === id);
      assert.deepEqual(usage.map((u: any) => u.person).sort(), ["Contractor Ravi", "Third", "s2-staff person"]);

      assert.equal((await as(cfo).post("/subscriptions", { scope: "central", name: "Test sub", provider: "Test provider", cost: "1", paymentMethodNote: "card 4111 1111 1111 1111" })).body.code, "CARD_NUMBER");
    });

    test("a charge is an expense; the renewal moves on; price rises, duplicates and charges after cancelling are flagged", async () => {
      const today = new Date();
      const day = (n: number) => iso(new Date(today.getTime() - n * 86400_000));
      const s = await as(cfo).post("/subscriptions", { scope: A.id, name: "AI assistant", provider: "Acme AI", plan: "Team", billingCycle: "MONTHLY", cost: "1000", renewalOn: day(1) });
      const id = s.body.data.id;
      const c1 = await as(cfo).post(`/subscriptions/${id}/charges`, { on: day(1), paid: true, paymentRef: "TXN1" });
      expect(c1, 201);
      assert.equal(c1.body.data.status, "PAID");
      const exp = await h.prisma.expense.findUnique({ where: { id: c1.body.data.id } });
      assert.deepEqual([exp!.source, exp!.sourceId, exp!.startupId, exp!.amountPaise], ["SUBSCRIPTION", id, A.id, 100000]);
      const after = (await as(cfo).get(`/subscriptions/${id}`)).body.data;
      assert.ok(new Date(after.renewalOn) > new Date(day(1)), "renewal moved to the next cycle");
      await as(cfo).post(`/subscriptions/${id}/charges`, { on: day(0), amount: "1250", paid: true });
      // A second active "Acme AI / Team" anywhere is a possible duplicate.
      await as(cfo).post("/subscriptions", { scope: B.id, name: "AI for Beta", provider: "ACME AI", plan: "team", cost: "1000" });
      // Cancel, then a charge arrives anyway.
      expect(await as(cfo).patch(`/subscriptions/${id}`, { status: "CANCELLED", cancelledOn: day(3) }), 200);
      const alerts = (await as(cfo).get("/subscriptions")).body.data.alerts.filter((x: any) => x.subscriptionId === id).map((x: any) => x.kind).sort();
      assert.deepEqual(alerts, ["CHARGED_AFTER_CANCEL", "COST_INCREASE"]);
      const dups = (await as(cfo).get("/subscriptions")).body.data.alerts.filter((x: any) => x.kind === "POSSIBLE_DUPLICATE");
      assert.equal(dups.length, 0, "the cancelled one no longer counts as a duplicate");
      expect(await as(mgrA).get(`/subscriptions/${(await as(cfo).get(`/subscriptions?scope=${B.id}`)).body.data.subscriptions[0].id}`), 404);
    });

    test("the dashboard shows the monthly cost of active subscriptions", async () => {
      const v = (await as(cfo).get("/overview?scope=central")).body.data;
      assert.equal(v.cards.monthlySubscriptionsPaise, 200000);
      const y = await as(cfo).post("/subscriptions", { scope: "central", name: "Yearly hosting", provider: "Host Co", cost: "12000", billingCycle: "YEARLY" });
      expect(y, 201);
      assert.equal((await as(cfo).get("/overview?scope=central")).body.data.cards.monthlySubscriptionsPaise, 300000);
    });

    /* Events */

    test("an event holds many costs; its total counts only live ones", async () => {
      const ev = await as(mgrA).post("/events", { scope: A.id, name: "Team dinner", kind: "TEAM_EVENT", date: "2026-10-20", startTime: "19:30", location: "Hyderabad", participants: [{ userId: staff.id, name: "Staff" }, { name: "Guest" }] });
      expect(ev, 201);
      const id = ev.body.data.id;
      expect(await as(mgrA).post(`/events/${id}/costs`, { title: "Food", categoryId: cat.food_hospitality, amount: "4200", incurredOn: "2026-10-20" }), 201);
      expect(await as(mgrA).post(`/events/${id}/costs`, { title: "Cabs", categoryId: cat.travel, amount: "800.50", incurredOn: "2026-10-20" }), 201);
      expect(await as(mgrA).post(`/events/${id}/costs`, { title: "Draft decor", categoryId: cat.team_events, amount: "500", incurredOn: "2026-10-20", action: "draft" }), 201);
      const food = (await as(cfo).get(`/events/${id}`)).body.data.costs.find((c: any) => c.title === "Food");
      await as(cfo).post(`/expenses/${food.id}/approve`);
      await as(cfo).post(`/expenses/${food.id}/pay`, { paymentRef: "UPI-1" });
      const got = (await as(cfo).get(`/events/${id}`)).body.data;
      assert.deepEqual([got.totalPaise, got.paidPaise, got.pendingPaise, got.costCount, got.waitingApproval], [500050, 420000, 80050, 2, 1]);
      assert.equal(got.costs.length, 3);
      const listed = (await as(cfo).get(`/expenses?scope=${A.id}&q=Cabs`)).body.data.rows[0];
      assert.equal(listed.source, "EVENT");
      assert.equal((await as(mgrA).post("/events", { scope: B.id, name: "Nope", date: "2026-10-20" })).status, 404);
      expect(await as(mgrA).patch(`/events/${id}`, { status: "CANCELLED" }), 200);
      assert.equal((await as(mgrA).post(`/events/${id}/costs`, { title: "Late", categoryId: cat.travel, amount: "1", incurredOn: "2026-10-21" })).body.code, "CANCELLED");
      assert.equal((await as(mgrA).post("/events", { scope: A.id, name: "Bad time", date: "2026-10-20", startTime: "25:99" })).body.code, "INVALID_TIME");
    });
  });
}
