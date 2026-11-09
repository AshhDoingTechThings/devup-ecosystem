/**
 * Direct messages: only between accepted connections, validated, and
 * rate-limited on sending.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, testDatabaseUrl, Person } from "./support/harness";

const LIMIT = 12; // above the 9 sends user `a` makes across these tests

const DB = testDatabaseUrl();
if (!DB) {
  test("messages (needs TEST_DATABASE_URL on localhost)", { skip: true }, () => {});
} else {
  describe("direct messages", () => {
    let h: Awaited<ReturnType<typeof startHarness>>;
    let a: Person, b: Person, stranger: Person, pending: Person, cofounder: Person;

    const send = (from: Person, to: string, content: unknown) => h.call("POST", `/api/messages/${to}`, from.token, { content });
    const connect = (x: Person, y: Person, status = "ACCEPTED") =>
      h.prisma.connectionRequest.create({ data: { fromUserId: x.id, toUserId: y.id, message: "hi", status } });

    before(async () => {
      h = await startHarness(DB, { env: { MESSAGE_RATE_LIMIT: String(LIMIT) } });
      a = await h.person("a", "FOUNDER");
      b = await h.person("b", "FOUNDER");
      stranger = await h.person("stranger", "STUDENT");
      pending = await h.person("pending", "FOUNDER");
      cofounder = await h.person("cofounder", "STUDENT");
      await connect(a, b);
      await connect(pending, a, "PENDING");
      await h.prisma.cofounderRequest.create({ data: { fromUserId: cofounder.id, toUserId: a.id, message: "build?", status: "ACCEPTED" } });
    });
    after(async () => h?.close());

    test("connected people can message each other, in both directions", async () => {
      const ab = await send(a, b.id, "  hello b  ");
      assert.equal(ab.status, 200, JSON.stringify(ab.body));
      assert.equal(ab.body.data.content, "hello b", "trimmed");
      const ba = await send(b, a.id, "hello a");
      assert.equal(ba.status, 200);

      const history = await h.call("GET", `/api/messages/${b.id}`, a.token);
      assert.equal(history.status, 200);
      assert.deepEqual(history.body.data.map((m: any) => m.content), ["hello b", "hello a"]);
      const unread = await h.prisma.message.count({ where: { receiverId: a.id, senderId: b.id, read: false } });
      assert.equal(unread, 0, "reading marks the other side's messages read");
    });

    test("an accepted co-founder request also counts as a connection", async () => {
      assert.equal((await send(cofounder, a.id, "hey")).status, 200);
    });

    test("strangers, pending requests and unknown users cannot message", async () => {
      for (const [label, from, to] of [
        ["stranger", stranger, a.id],
        ["pending request", pending, a.id],
        ["unknown user", a, "00000000-0000-4000-8000-000000000000"],
      ] as const) {
        const before = await h.prisma.message.count();
        const r = await send(from, to, "spam");
        assert.equal(r.status, 403, `${label}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, "NOT_CONNECTED");
        assert.equal(await h.prisma.message.count(), before, `${label}: nothing stored`);
      }
    });

    test("bad input is a 400, not a server error", async () => {
      const cases: Array<[string, string, unknown]> = [
        ["to yourself", a.id, "me"],
        ["not an id", "Akshay", "hi"],
        ["empty", b.id, "   "],
        ["not text", b.id, 12345],
        ["missing", b.id, undefined],
        ["too long", b.id, "x".repeat(2001)],
      ];
      for (const [label, to, content] of cases) {
        const r = await send(a, to, content);
        assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
      }
      assert.equal((await send(a, b.id, "x".repeat(2000))).status, 200, "2000 characters is allowed");
    });

    test("sending is rate-limited per account; reading is not", async () => {
      const sender = await h.person("chatty", "FOUNDER");
      await connect(sender, b);
      for (let i = 0; i < LIMIT; i++) assert.equal((await send(sender, b.id, `m${i}`)).status, 200, `message ${i}`);
      const over = await send(sender, b.id, "one too many");
      assert.equal(over.status, 429);
      assert.equal(await h.prisma.message.count({ where: { senderId: sender.id } }), LIMIT);
      for (let i = 0; i < LIMIT + 2; i++) assert.equal((await h.call("GET", `/api/messages/${b.id}`, sender.token)).status, 200);
      assert.equal((await send(b, sender.id, "reply")).status, 200, "the limit is per sender");
    });
  });
}
