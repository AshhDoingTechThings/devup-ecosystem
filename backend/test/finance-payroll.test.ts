/**
 * Finance, slice 3: payroll and stipend runs, the bank file, payments,
 * payslips and "my pay". Real Express and Postgres via the harness. Every
 * amount is checked to the paisa against a hand-worked figure.
 */
import "./support/finance-env";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, testDatabaseUrl, Person } from "./support/harness";
// Pure modules only before startHarness().
import { monthPeriod, overlapDays, salaryForMonth, stipendForMonth, netPay } from "../src/modules/finance/payrollMath";

const D = (s: string) => new Date(`${s}T00:00:00Z`);

describe("pay arithmetic", () => {
  const oct = monthPeriod(2026, 10);
  test("months and overlaps are calendar days, both ends included", () => {
    assert.equal(oct.days, 31);
    assert.equal(monthPeriod(2028, 2).days, 29);
    assert.equal(overlapDays(D("2026-10-01"), D("2026-10-31"), D("2026-10-16"), D("2027-01-01")), 16);
    assert.equal(overlapDays(D("2026-10-01"), D("2026-10-31"), D("2026-11-01"), D("2026-12-01")), 0);
  });

  test("a full month pays the monthly figure; a joiner, a leaver and a raise are prorated by days", () => {
    const seg = (from: string, to: string | null, monthly: number, components: Array<{ name: string; amountPaise: number }> = []) =>
      ({ id: from, effectiveFrom: D(from), effectiveTo: to ? D(to) : null, monthlyGrossPaise: monthly, components });
    const full = salaryForMonth({ periodStart: oct.start, periodEnd: oct.end, joinedAt: D("2026-01-01"), exitedAt: null, segments: [seg("2026-09-01", null, 6000000, [{ name: "Basic", amountPaise: 3000000 }, { name: "HRA", amountPaise: 3000000 }])] });
    assert.deepEqual([full.basePaise, full.workedDays, full.components], [6000000, 31, [{ name: "Basic", amountPaise: 3000000 }, { name: "HRA", amountPaise: 3000000 }]]);
    // Joined 16 Oct: 16 of 31 days of ₹31,000 = ₹16,000.
    assert.equal(salaryForMonth({ periodStart: oct.start, periodEnd: oct.end, joinedAt: D("2026-10-16"), exitedAt: null, segments: [seg("2026-10-16", null, 3100000)] }).basePaise, 1600000);
    // Left 10 Oct: 10 days of ₹31,000 = ₹10,000, flagged as the final month.
    const leaver = salaryForMonth({ periodStart: oct.start, periodEnd: oct.end, joinedAt: D("2025-01-01"), exitedAt: D("2026-10-10"), segments: [seg("2025-01-01", null, 3100000)] });
    assert.deepEqual([leaver.basePaise, leaver.isFinalSettlement], [1000000, true]);
    // ₹31,000 until 20 Oct, then ₹62,000: 20 days × 1,000 + 11 days × 2,000 = ₹42,000.
    const raise = salaryForMonth({ periodStart: oct.start, periodEnd: oct.end, joinedAt: D("2025-01-01"), exitedAt: null, segments: [seg("2025-01-01", "2026-10-20", 3100000), seg("2026-10-21", null, 6200000)] });
    assert.deepEqual([raise.basePaise, raise.workedDays], [4200000, 31]);
    assert.equal(raise.components.reduce((s, c) => s + c.amountPaise, 0), raise.basePaise, "components always add up");
  });

  test("stipends are whole rupees for the internship days in the month; net pay adds and subtracts lines", () => {
    assert.deepEqual(stipendForMonth({ periodStart: oct.start, periodEnd: oct.end, startDate: D("2026-10-21"), endDate: D("2027-03-01"), monthlyRupees: 3100 }), { activeDays: 11, periodDays: 31, grossRupees: 1100 });
    assert.equal(netPay(6000000, [{ kind: "BONUS", label: "Diwali", amountPaise: 500000 }, { kind: "DEDUCTION", label: "Advance", amountPaise: 200000 }]), 6300000);
  });
});

const DB = testDatabaseUrl();
if (!DB) {
  test("payroll (needs TEST_DATABASE_URL on localhost)", { skip: true }, () => {});
} else {
  describe("payroll runs", () => {
    let h: Awaited<ReturnType<typeof startHarness>>;
    let cfo: Person, superAdmin: Person, founder: Person, empUser: Person, outsider: Person, mgr: Person;
    let A: any;
    const people: Record<string, string> = {};
    const F = (p: string) => `/api/finance${p}`;
    const as = (p: Person) => ({
      get: (path: string) => h.call("GET", F(path), p.token),
      post: (path: string, body?: unknown) => h.call("POST", F(path), p.token, body ?? {}),
      patch: (path: string, body: unknown) => h.call("PATCH", F(path), p.token, body),
      put: (path: string, body: unknown) => h.call("PUT", F(path), p.token, body),
    });
    const expect = (r: { status: number; body: any }, status: number) => assert.equal(r.status, status, JSON.stringify(r.body));
    let n = 0;
    const employee = (name: string, extra: Record<string, unknown> = {}) =>
      h.prisma.employee.create({ data: { startupId: A.id, employeeCode: `E-${++n}-${h.uniq()}`, fullName: name, email: `e${n}-${h.uniq()}@x.test`, designation: "Engineer", employmentType: "FULL_TIME", joinedAt: D("2026-01-01"), ...extra } });
    const intern = (name: string, extra: Record<string, unknown> = {}) =>
      h.prisma.intern.create({ data: { startupId: A.id, internCode: `I-${++n}-${h.uniq()}`, fullName: name, email: `i${n}-${h.uniq()}@x.test`, designation: "Intern", startDate: D("2026-08-01"), endDate: D("2027-03-01"), ...extra } });
    const line = (run: any, name: string) => run.lines.find((l: any) => l.name === name);

    before(async () => {
      h = await startHarness(DB);
      superAdmin = await h.person("pr-super", "SUPER_ADMIN");
      cfo = await h.person("pr-cfo");
      founder = await h.person("pr-founder", "FOUNDER");
      empUser = await h.person("pr-emp");
      outsider = await h.person("pr-out");
      mgr = await h.person("pr-mgr");
      A = await h.startup(founder, { name: "Alpha Payroll" });
      expect(await h.call("POST", "/api/finance/roles", superAdmin.token, { userId: cfo.id, role: "ECOSYSTEM_CFO" }), 201);
      expect(await h.call("POST", "/api/finance/roles", superAdmin.token, { userId: mgr.id, role: "STARTUP_FINANCE_MANAGER", startupId: A.id }), 201);

      const e1 = await employee("Full Month", { userId: empUser.id, email: empUser.email });
      const e2 = await employee("Joiner", { joinedAt: D("2026-10-16") });
      const e3 = await employee("No Pay Yet");
      const e4 = await employee("Leaver", { joinedAt: D("2025-01-01"), status: "EXITED", exitedAt: D("2026-10-10") });
      Object.assign(people, { e1: e1.id, e2: e2.id, e3: e3.id, e4: e4.id });
      expect(await as(cfo).put(`/pay/employees/${e1.id}/compensation`, { monthlyGross: "60000", effectiveFrom: "2026-09-01", components: [{ name: "Basic", amount: "30000" }, { name: "HRA", amount: "30000" }] }), 200);
      expect(await as(cfo).put(`/pay/employees/${e2.id}/compensation`, { monthlyGross: "31000", effectiveFrom: "2026-10-16" }), 200);
      expect(await as(cfo).put(`/pay/employees/${e4.id}/compensation`, { monthlyGross: "31000", effectiveFrom: "2025-01-01" }), 200);
      expect(await as(cfo).put("/pay/bank", { employeeId: e1.id, accountHolder: "Full Month", accountNumber: "123456789012", ifsc: "SBIN0001234" }), 200);

      const i1 = await intern("Intern Full", { stipendAmount: 5000 });
      const i2 = await intern("Intern Late", { stipendAmount: 3100, startDate: D("2026-10-21") });
      await intern("Intern Unconfirmed", { stipend: "5000" });
      await intern("Intern Ended", { stipendAmount: 5000, endDate: D("2026-09-30") });
      const i5 = await intern("Intern Paid Already", { stipendAmount: 4000 });
      await h.prisma.stipendPayout.create({ data: { startupId: A.id, internId: i5.id, periodYear: 2026, periodMonth: 10, stipendAmount: 4000, workingDays: 31, presentDays: 31, lateDays: 0, halfDays: 0, absentDays: 0, leaveDays: 0, paidLeaveDays: 0, payableCentidays: 3100, grossAmount: 4000, netAmount: 4000, status: "PAID", paymentRef: "WS-1" } });
      Object.assign(people, { i1: i1.id, i2: i2.id });
    });
    after(async () => {
      // Payslips start a headless Chrome; close it or the test process never exits.
      const { closePdfBrowser } = await import("../src/lib/pdf");
      await closePdfBrowser();
      await h?.close();
    });

    let salaryRun: string;

    test("a salary run includes exactly who should be paid, at the right amounts, and says who was left out and why", async () => {
      const r = await as(cfo).post("/payroll/runs", { kind: "SALARY", startupId: A.id, year: 2026, month: 10 });
      expect(r, 201);
      salaryRun = r.body.data.id;
      assert.deepEqual(r.body.data.skipped, [{ name: "No Pay Yet", reason: "Pay not confirmed yet — confirm it in Salaries & stipends" }]);
      const run = (await as(cfo).get(`/payroll/runs/${salaryRun}`)).body.data;
      assert.equal(run.status, "DRAFT");
      assert.deepEqual([line(run, "Full Month").netPaise, line(run, "Joiner").netPaise, line(run, "Leaver").netPaise], [6000000, 1600000, 1000000]);
      assert.equal(line(run, "Leaver").isFinalSettlement, true);
      assert.equal(run.totals.netPaise, 8600000);
    });

    test("one run per startup, kind and month — even when two are created at once", async () => {
      const again = await as(cfo).post("/payroll/runs", { kind: "SALARY", startupId: A.id, year: 2026, month: 10 });
      assert.equal(again.body.code, "RUN_EXISTS");
      const [x, y] = await Promise.all([
        as(cfo).post("/payroll/runs", { kind: "SALARY", startupId: A.id, year: 2026, month: 11 }),
        as(cfo).post("/payroll/runs", { kind: "SALARY", startupId: A.id, year: 2026, month: 11 }),
      ]);
      assert.deepEqual([x.status, y.status].sort(), [201, 409]);
      for (const p of [mgr, outsider, founder]) expect(await as(p).get("/payroll/runs"), 403);
    });

    test("bonuses and deductions are explicit lines; nothing changes after approval", async () => {
      const id = line((await as(cfo).get(`/payroll/runs/${salaryRun}`)).body.data, "Full Month").id;
      const neg = await as(cfo).patch(`/payroll/runs/${salaryRun}/lines/${id}`, { adjustments: [{ kind: "DEDUCTION", label: "Advance", amount: "70000" }] });
      assert.equal(neg.body.code, "NEGATIVE_PAY");
      const ok = await as(cfo).patch(`/payroll/runs/${salaryRun}/lines/${id}`, { adjustments: [{ kind: "BONUS", label: "Diwali bonus", amount: "5000" }, { kind: "DEDUCTION", label: "Salary advance", amount: "2000" }] });
      expect(ok, 200);
      assert.equal(line(ok.body.data, "Full Month").netPaise, 6300000);
      const joiner = line(ok.body.data, "Joiner").id;
      expect(await as(cfo).patch(`/payroll/runs/${salaryRun}/lines/${joiner}`, { hold: true, note: "Documents pending" }), 200);

      expect(await as(cfo).post(`/payroll/runs/${salaryRun}/submit`), 200);
      assert.equal((await as(cfo).post(`/payroll/runs/${salaryRun}/approve`, { confirm: false })).body.code, "CONFIRM_REQUIRED");
      const ap = await as(cfo).post(`/payroll/runs/${salaryRun}/approve`, { confirm: true });
      expect(ap, 200);
      assert.equal(ap.body.data.status, "APPROVED");
      assert.equal(ap.body.data.totals.netPaise, 7300000, "₹63,000 + ₹10,000; the joiner is on hold");
      assert.equal((await as(cfo).patch(`/payroll/runs/${salaryRun}/lines/${id}`, { hold: true })).body.code, "WRONG_STATUS");
      assert.equal((await as(cfo).get("/overview")).body.data.payroll.payDuePaise, 7300000);
    });

    test("the bank file holds account numbers only in the file; who lacks bank details is listed", async () => {
      const f = await as(cfo).post(`/payroll/runs/${salaryRun}/bank-file`);
      expect(f, 200);
      assert.equal(f.body.data.included, 1);
      assert.deepEqual(f.body.data.missing, ["Leaver"]);
      assert.match(f.body.data.csv, /Full Month,123456789012,SBIN0001234,63000\.00,/);
      assert.ok(!f.body.data.csv.includes("Joiner"), "a line on hold is not in the file");
      const log = await h.prisma.auditLog.findMany({ where: { entity: "FinancePayroll", entityId: salaryRun } });
      assert.equal(JSON.stringify(log).includes("123456789012"), false);
      assert.equal((await as(cfo).get(`/payroll/runs/${salaryRun}`)).body.data.status, "PROCESSING");
    });

    test("payments are confirmed one by one, once; each becomes a paid expense; failures carry a reason", async () => {
      const run = (await as(cfo).get(`/payroll/runs/${salaryRun}`)).body.data;
      const full = line(run, "Full Month").id;
      const leaver = line(run, "Leaver").id;
      const p1 = await as(cfo).post(`/payroll/runs/${salaryRun}/lines/${full}/pay`, { paidOn: "2026-11-01", paymentRef: "UTR-OCT-1" });
      expect(p1, 200);
      assert.equal(p1.body.data.status, "PARTIALLY_PAID");
      expect(await as(cfo).post(`/payroll/runs/${salaryRun}/lines/${full}/pay`, { paidOn: "2026-11-01", paymentRef: "UTR-OCT-1" }), 200);
      assert.equal((await as(cfo).post(`/payroll/runs/${salaryRun}/lines/${full}/pay`, { paidOn: "2026-11-01", paymentRef: "OTHER" })).body.code, "ALREADY_PAID");
      const exp = await h.prisma.expense.findMany({ where: { source: "PAYROLL", sourceId: full } });
      assert.equal(exp.length, 1, "exactly one expense for one payment");
      assert.deepEqual([exp[0].amountPaise, exp[0].status, exp[0].startupId, exp[0].paymentRef], [6300000, "PAID", A.id, "UTR-OCT-1"]);
      const cat = await h.prisma.financeCategory.findUnique({ where: { id: exp[0].categoryId } });
      assert.equal(cat!.key, "salaries");

      expect(await as(cfo).post(`/payroll/runs/${salaryRun}/lines/${leaver}/fail`, { reason: "Account closed" }), 200);
      const failed = line((await as(cfo).get(`/payroll/runs/${salaryRun}`)).body.data, "Leaver");
      assert.deepEqual([failed.status, failed.failureReason], ["FAILED", "Account closed"]);
      const p2 = await as(cfo).post(`/payroll/runs/${salaryRun}/lines/${leaver}/pay`, { paidOn: "2026-11-03", paymentRef: "UTR-OCT-2" });
      assert.equal(p2.body.data.status, "PAID", "every line not on hold is paid");
      assert.equal((await as(cfo).post(`/payroll/runs/${salaryRun}/cancel`, { reason: "oops" })).body.code, "HAS_PAYMENTS");
      const report = (await as(cfo).get(`/payroll/runs/${salaryRun}/report`)).body.data;
      assert.match(report.csv, /Full Month,.*,63000\.00,PAID,2026-11-01,UTR-OCT-1/);
    });

    test("a stipend run uses confirmed stipends, skips months already paid, and locks them in the workspace", async () => {
      const r = await as(cfo).post("/payroll/runs", { kind: "STIPEND", startupId: A.id, year: 2026, month: 10 });
      expect(r, 201);
      const reasons = Object.fromEntries(r.body.data.skipped.map((s: any) => [s.name, s.reason]));
      assert.deepEqual(reasons, { "Intern Unconfirmed": "Stipend not confirmed yet — confirm it in Salaries & stipends", "Intern Paid Already": "Already paid for this month" });
      const run = (await as(cfo).get(`/payroll/runs/${r.body.data.id}`)).body.data;
      assert.deepEqual([line(run, "Intern Full").netPaise, line(run, "Intern Late").netPaise], [500000, 110000]);
      assert.equal(run.lines.length, 2, "an internship that ended before the month isn't included");

      const w = (path: string, body: unknown) => h.call("POST", `/api/w/${A.code}/finance/stipends${path}`, founder.token, body);
      const blocked = await w(`/${people.i1}/approve`, { year: 2026, month: 10 });
      assert.equal(blocked.body.code, "IN_PAYROLL_RUN", JSON.stringify(blocked.body));

      // Cancel: unpaid lines go, and the month can be prepared again.
      expect(await as(cfo).post(`/payroll/runs/${r.body.data.id}/cancel`, { reason: "Wrong basis" }), 200);
      assert.equal(await h.prisma.stipendPayout.count({ where: { payrollRunId: r.body.data.id } }), 0);
      expect(await as(cfo).post("/payroll/runs", { kind: "STIPEND", startupId: A.id, year: 2026, month: 10 }), 201);
    });

    test("staff see their own approved pay and payslip; nobody else's", async () => {
      const mine = (await h.call("GET", F("/me/pay"), empUser.token)).body.data;
      assert.equal(mine.salary.length, 1);
      assert.deepEqual([mine.salary[0].netPaise, mine.salary[0].status], [6300000, "PAID"]);
      assert.equal(mine.currentPay[0].monthlyGrossPaise, 6000000);
      const itemId = mine.salary[0].id;
      const slip = await h.call("GET", F(`/payslips/${itemId}`), empUser.token);
      // 503 only where Chrome isn't installed (the deploy installs it).
      assert.ok([200, 503].includes(slip.status), `payslip: ${slip.status}`);
      if (slip.status === 200) assert.match(String(slip.headers.get("content-type")), /application\/pdf/);
      expect(await h.call("GET", F(`/payslips/${itemId}`), outsider.token), 404);
      expect(await h.call("GET", F(`/payslips/${itemId}`), mgr.token), 404);
      assert.equal((await h.call("GET", F("/me/pay"), outsider.token)).body.data.salary.length, 0);
    });
  });
}
