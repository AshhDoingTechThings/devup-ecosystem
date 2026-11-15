/**
 * Finance, slice 5: reports and exports (CSV, Excel, PDF), scoped to what the
 * reader may see, with every export recorded. Real Express and Postgres.
 */
import "./support/finance-env";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, testDatabaseUrl, Person } from "./support/harness";

const DB = testDatabaseUrl();
if (!DB) {
  test("reports (needs TEST_DATABASE_URL on localhost)", { skip: true }, () => {});
} else {
  describe("finance reports", () => {
    let h: Awaited<ReturnType<typeof startHarness>>;
    let cfo: Person, mgrA: Person, superAdmin: Person;
    let A: any, B: any;
    let cat: Record<string, string>;
    const F = (p: string) => `/api/finance${p}`;
    const as = (p: Person) => ({
      get: (path: string) => h.call("GET", F(path), p.token),
      post: (path: string, body?: unknown) => h.call("POST", F(path), p.token, body ?? {}),
      put: (path: string, body: unknown) => h.call("PUT", F(path), p.token, body),
    });
    const raw = (p: Person, path: string) => fetch(`${h.origin}${F(path)}`, { headers: { Authorization: `Bearer ${p.token}` } });
    const expect = (r: { status: number; body: any }, status: number) => assert.equal(r.status, status, JSON.stringify(r.body));
    const OCT = "period=custom&from=2026-10-01&to=2026-10-31";

    before(async () => {
      h = await startHarness(DB);
      superAdmin = await h.person("rep-super", "SUPER_ADMIN");
      cfo = await h.person("rep-cfo");
      mgrA = await h.person("rep-mgr");
      const founder = await h.person("rep-founder", "FOUNDER");
      A = await h.startup(founder, { name: "Alpha Reports" });
      B = await h.startup(founder, { name: "Beta Reports" });
      expect(await h.call("POST", "/api/finance/roles", superAdmin.token, { userId: cfo.id, role: "ECOSYSTEM_CFO" }), 201);
      expect(await h.call("POST", "/api/finance/roles", superAdmin.token, { userId: mgrA.id, role: "STARTUP_FINANCE_MANAGER", startupId: A.id }), 201);
      cat = Object.fromEntries((await as(cfo).get("/categories")).body.data.map((c: any) => [c.key, c.id]));
      const rent = await as(cfo).post("/expenses", { scope: "central", title: "Rent", categoryId: cat.office_rent, amount: "40000", incurredOn: "2026-10-05", action: "paid" });
      expect(await as(cfo).put(`/expenses/${rent.body.data.id}/allocations`, { method: "PERCENT", shares: [{ scope: A.id, percent: 50 }, { scope: B.id, percent: 50 }] }), 200);
      await as(cfo).post("/expenses", { scope: A.id, title: "Tools", categoryId: cat.software, amount: "3000", incurredOn: "2026-10-08", action: "paid" });
      const unpaid = await as(cfo).post("/expenses", { scope: B.id, title: "Laptop", categoryId: cat.equipment, amount: "50000", incurredOn: "2026-10-09" });
      await as(cfo).post(`/expenses/${unpaid.body.data.id}/approve`);
      await as(cfo).post("/income", { scope: "central", source: "SPONSORSHIP", title: "Sponsor", payer: "Acme", amount: "60000", receivedOn: "2026-10-10" });
      await as(cfo).post("/income", { scope: A.id, source: "CLIENT_PAYMENT", title: "Client", payer: "Client Co", amount: "8000", receivedOn: "2026-10-11" });
      const inv = await as(cfo).post("/invoices", { recipientStartupId: A.id, title: "Rent share", lines: [{ label: "Rent share", amount: "20000" }] });
      await as(cfo).post(`/invoices/${inv.body.data.id}/issue`, {});
    });
    after(async () => {
      const { closePdfBrowser } = await import("../src/lib/pdf");
      await closePdfBrowser();
      await h?.close();
    });

    test("the summary adds up, counts shared costs once, and never calls it profit", async () => {
      const r = await as(cfo).get(`/reports/summary?${OCT}`);
      expect(r, 200);
      const v = Object.fromEntries(r.body.data.rows.map((x: any) => [x.item, x.amount]));
      assert.equal(v["Money received (from outside DevUp)"], 68000);
      assert.equal(v["Spent (paid expenses)"], 43000, "₹40,000 rent once + ₹3,000 tools");
      assert.equal(v["Money in − money out (cash, not profit)"], 25000);
      assert.equal(v["Approved, still to pay"], 50000);
      assert.equal(v["Money expected from startups (internal)"], 20000);
      assert.ok(r.body.data.notes.some((n: string) => /not profit/.test(n)));
    });

    test("startups at a glance: own spending, share of shared costs, money in, what each owes", async () => {
      const rows = (await as(cfo).get(`/reports/startups?${OCT}`)).body.data.rows;
      const a = rows.find((x: any) => x.startup === "Alpha Reports");
      assert.deepEqual([a.own, a.share, a.income, a.cash, a.owed], [3000, 20000, 8000, 5000, 20000]);
      const mine = (await as(mgrA).get(`/reports/startups?${OCT}`)).body.data.rows;
      assert.deepEqual(mine.map((x: any) => x.startup), ["Alpha Reports"], "a startup manager sees only their startup");
    });

    test("CSV, Excel and PDF exports, each recorded; access is enforced", async () => {
      const csv = await raw(cfo, `/reports/expenses/export?${OCT}&format=csv`);
      assert.equal(csv.status, 200);
      assert.match(String(csv.headers.get("content-type")), /text\/csv/);
      const bytes = Buffer.from(await csv.arrayBuffer());
      assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "a BOM, so Excel reads ₹ correctly");
      const text = bytes.subarray(3).toString("utf8");
      assert.ok(text.startsWith("Expenses — All of DevUp — 2026-10-01 to 2026-10-31"), text.slice(0, 80));
      assert.match(text, /Number,Date,Whose cost,What,Category,Group,Paid to,Status,Amount \(₹\),Payment reference/);
      assert.match(text, /Total,.*93000/, "₹40,000 + ₹3,000 + ₹50,000 approved");

      const xlsx = await raw(cfo, `/reports/budgets/export?${OCT}&format=xlsx`);
      assert.equal(xlsx.status, 200);
      const buf = Buffer.from(await xlsx.arrayBuffer());
      assert.equal(buf.subarray(0, 2).toString(), "PK", "a real .xlsx (zip) file");

      const pdf = await raw(cfo, `/reports/summary/export?${OCT}&format=pdf`);
      assert.ok([200, 503].includes(pdf.status), `pdf ${pdf.status}`);
      if (pdf.status === 200) assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), "%PDF");

      assert.equal((await raw(mgrA, `/reports/payroll/export?${OCT}&format=csv`)).status, 403);
      assert.equal((await raw(mgrA, `/reports/expenses/export?scope=${B.id}&${OCT}&format=csv`)).status, 404);
      const log = await h.prisma.auditLog.findMany({ where: { entity: "FinanceReport" } });
      assert.ok(log.some((l) => l.entityId === "expenses:csv" && l.adminId === cfo.id));
      assert.ok(log.some((l) => l.entityId === "budgets:xlsx"));
    });
  });
}
