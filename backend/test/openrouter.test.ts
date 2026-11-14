/**
 * lib/openrouter: retired models (404) fall through to current ones, and
 * provider failures become clear errors instead of a bare 500. fetch is
 * stubbed — no network, no API key used.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { openrouterChat, candidateModels, FALLBACK_MODELS } from "../src/lib/openrouter";
import { AppError } from "../src/middleware/errorHandler";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answers per model: a status, or 200 with a reply. Records models asked for. */
function stubOpenRouter(byModel: Record<string, number>, fallbackStatus = 200) {
  const asked: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    asked.push(body.model);
    const status = byModel[body.model] ?? fallbackStatus;
    if (status !== 200) return new Response(JSON.stringify({ error: { message: `stub ${status}` } }), { status });
    return new Response(JSON.stringify({ choices: [{ message: { content: `hi from ${body.model}` } }], usage: { total_tokens: 7 } }), { status: 200 });
  }) as typeof fetch;
  return asked;
}

describe("openrouterChat", () => {
  test("a retired model (404) falls through to the next; the answering model is reported", async () => {
    const asked = stubOpenRouter({ "openai/gpt-3.5-turbo": 404 });
    const r = await openrouterChat(["openai/gpt-3.5-turbo"], { messages: [{ role: "user", content: "x" }] });
    assert.deepEqual(asked, ["openai/gpt-3.5-turbo", FALLBACK_MODELS[0]]);
    assert.equal(r.model, FALLBACK_MODELS[0]);
    assert.equal(r.data.choices[0].message.content, `hi from ${FALLBACK_MODELS[0]}`);
  });

  test("a working preferred model is used first, with no extra calls", async () => {
    const asked = stubOpenRouter({});
    const r = await openrouterChat(["anthropic/claude-sonnet-4.5"], { messages: [] });
    assert.deepEqual(asked, ["anthropic/claude-sonnet-4.5"]);
    assert.equal(r.model, "anthropic/claude-sonnet-4.5");
  });

  test("every model retired → AI_MODEL_UNAVAILABLE (502), naming them", async () => {
    stubOpenRouter({}, 404);
    await assert.rejects(openrouterChat(["old/model"], { messages: [] }), (e: unknown) => {
      assert.ok(e instanceof AppError);
      assert.equal(e.statusCode, 502);
      assert.equal(e.code, "AI_MODEL_UNAVAILABLE");
      assert.match(e.message, /old\/model/);
      return true;
    });
  });

  test("bad key, no credits, rate limit and other errors are clear — and stop at once", async () => {
    for (const [status, code, http] of [[401, "AI_KEY_REJECTED", 502], [402, "AI_NO_CREDITS", 502], [429, "AI_RATE_LIMITED", 429], [500, "AI_PROVIDER_ERROR", 502]] as const) {
      const asked = stubOpenRouter({}, status);
      await assert.rejects(openrouterChat(["some/model"], { messages: [] }), (e: unknown) => {
        assert.ok(e instanceof AppError, `status ${status}`);
        assert.equal(e.code, code);
        assert.equal(e.statusCode, http);
        assert.doesNotMatch(e.message, /Bearer|sk-/);
        return true;
      });
      assert.equal(asked.length, 1, `no fallback after a ${status}`);
    }
  });

  test("network failure → AI_UNREACHABLE", async () => {
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await assert.rejects(openrouterChat(["m"], { messages: [] }), (e: unknown) => e instanceof AppError && e.code === "AI_UNREACHABLE");
  });

  test("candidate list: preferred first, blanks dropped, no duplicates, fallbacks last", () => {
    assert.deepEqual(candidateModels([undefined, "", FALLBACK_MODELS[1], "x/y"]), [FALLBACK_MODELS[1], "x/y", FALLBACK_MODELS[0]]);
  });
});
