import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { OpenAIResponsesReviewProvider } from "../../src/agent-review/provider.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const response = JSON.parse(readFileSync(new URL("../fixtures/route-validation/provider-body-timeout/response.json", import.meta.url), "utf8"));
const prompt = { promptVersion: "deadline-fixture", system: "Review the fixture.", context: {} };
const env = {
  OPENAI_BASE_URL: "https://fixture.invalid", OPENAI_API_KEY: "fixture-provider-secret",
  OPENAI_MODEL: "fixture-model", OPENAI_REQUEST_TIMEOUT_MS: "25"
};

it("keeps the request deadline active after early response headers", async (t) => {
  let signal, finish, completed = false;
  t.after(() => clearTimeout(finish));
  const provider = new OpenAIResponsesReviewProvider({ env, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return { ok: true, status: 200, text: () => new Promise((resolve, reject) => {
      finish = setTimeout(() => { completed = true; resolve(JSON.stringify(response)); }, 150);
      signal.addEventListener("abort", () => { clearTimeout(finish); reject(new Error("fixture body cancelled")); }, { once: true });
    }) };
  } });
  const started = performance.now();
  const result = await bounded(provider.submitPrompt(prompt, "agent-review.provider"));
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, "agent.provider.request_timeout");
  assert.equal(result.diagnostics[0].details.phase, "body");
  assert.equal(signal.aborted, true);
  assert.equal(completed, false);
  assert.ok(performance.now() - started < 500);
});

it("bounds a text-only transport that ignores AbortSignal", async (t) => {
  let resolveText, signal;
  const text = new Promise((resolve) => { resolveText = resolve; });
  t.after(() => resolveText(JSON.stringify(response)));
  const provider = new OpenAIResponsesReviewProvider({ env, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return { ok: true, status: 200, text: () => text };
  } });
  const result = await bounded(provider.submitPrompt(prompt, "agent-review.provider"));
  assert.equal(result.diagnostics[0].code, "agent.provider.request_timeout");
  assert.equal(result.diagnostics[0].details.phase, "body");
  assert.equal(signal.aborted, true);
});

it("bounds uncooperative headers and cancels a late body without waiting for its cancel promise", async (t) => {
  let resolveHeaders, signal, bodyController, cancelled = false;
  const late = new Response(new ReadableStream({
    start(controller) { bodyController = controller; },
    cancel() { cancelled = true; return new Promise(() => {}); }
  }));
  t.after(() => { resolveHeaders(late); try { bodyController.close(); } catch {} });
  const provider = new OpenAIResponsesReviewProvider({ env, fetchImpl: (_url, options) => {
    signal = options.signal;
    return new Promise((resolve) => { resolveHeaders = resolve; });
  } });
  const result = await bounded(provider.submitPrompt(prompt, "agent-review.provider"));
  assert.equal(result.diagnostics[0].code, "agent.provider.request_timeout");
  assert.equal(result.diagnostics[0].details.phase, "headers");
  assert.equal(signal.aborted, true);
  resolveHeaders(late);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(late.body.locked, false);
});

it("cancels and releases a native body stream that never reaches EOF even after a valid JSON chunk", async (t) => {
  let bodyController, cancelled = false, signal;
  const body = new ReadableStream({
    start(controller) { bodyController = controller; controller.enqueue(new TextEncoder().encode(JSON.stringify(response))); },
    cancel() { cancelled = true; return new Promise(() => {}); }
  });
  t.after(() => { try { bodyController.close(); } catch {} });
  const provider = new OpenAIResponsesReviewProvider({ env, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Response(body);
  } });
  const result = await bounded(provider.submitPrompt(prompt, "agent-review.provider"));
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, "agent.provider.request_timeout");
  assert.equal(result.diagnostics[0].details.phase, "body");
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

it("still classifies cooperative header cancellation as a deadline failure", async () => {
  let signal;
  const provider = new OpenAIResponsesReviewProvider({ env, fetchImpl: (_url, options) => {
    signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error(env.OPENAI_API_KEY)), { once: true }));
  } });
  const result = await bounded(provider.submitPrompt(prompt, "agent-review.provider"));
  assert.equal(result.diagnostics[0].code, "agent.provider.request_timeout");
  assert.equal(result.diagnostics[0].details.phase, "headers");
  assert.equal(signal.aborted, true);
  assert.equal(JSON.stringify(result).includes(env.OPENAI_API_KEY), false);
});

it("redacts body failures and does not await or leak rejecting cleanup", async () => {
  for (const releaseRejects of [true, false]) {
    let signal, cancelCalled = false, releaseCalled = false;
    const reader = {
      read: async () => { throw new Error(`body failed ${env.OPENAI_API_KEY} Bearer echoed-token`); },
      cancel() { cancelCalled = true; return Promise.reject(new Error("cancel rejected")); },
      releaseLock() {
        releaseCalled = true;
        if (releaseRejects) return Promise.reject(new Error("release rejected"));
        throw new Error("release threw");
      }
    };
    const provider = new OpenAIResponsesReviewProvider({ env, fetchImpl: async (_url, options) => {
      signal = options.signal;
      return { ok: true, status: 200, body: { getReader: () => reader } };
    } });
    const result = await bounded(provider.submitPrompt(prompt, "agent-review.provider"));
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, "agent.provider.body_read_error");
    assert.equal(result.diagnostics[0].details.phase, "body");
    assert.equal(JSON.stringify(result).includes(env.OPENAI_API_KEY), false);
    assert.equal(JSON.stringify(result).includes("echoed-token"), false);
    assert.equal(signal.aborted, true);
    assert.equal(cancelCalled, true);
    assert.equal(releaseCalled, true);
    await new Promise((resolve) => setImmediate(resolve));
  }
});

it("reports text-only body rejection instead of converting it to an empty response", async () => {
  for (const cause of [new Error(`body failure ${env.OPENAI_API_KEY}`), `body failure ${env.OPENAI_API_KEY}`]) {
    let signal;
    const provider = new OpenAIResponsesReviewProvider({ env, fetchImpl: async (_url, options) => {
      signal = options.signal;
      return { ok: true, status: 200, text: async () => { throw cause; } };
    } });
    const result = await bounded(provider.submitPrompt(prompt, "agent-review.provider"));
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, "agent.provider.body_read_error");
    assert.equal(signal.aborted, true);
    assert.equal(JSON.stringify(result).includes(env.OPENAI_API_KEY), false);
  }
});

it("keeps header failures distinct and redacted", async () => {
  const provider = new OpenAIResponsesReviewProvider({ env, fetchImpl: async () => { throw new Error(`connection failed ${env.OPENAI_API_KEY}`); } });
  const result = await bounded(provider.submitPrompt(prompt, "agent-review.provider"));
  assert.equal(result.diagnostics[0].code, "agent.provider.network_error");
  assert.equal(result.diagnostics[0].details.phase, "headers");
  assert.equal(JSON.stringify(result).includes(env.OPENAI_API_KEY), false);
});

it("decodes UTF-8 across native chunks and validates only the complete response", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(response));
  const body = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const provider = new OpenAIResponsesReviewProvider({ env: { ...env, OPENAI_REQUEST_TIMEOUT_MS: "500" }, fetchImpl: async () => new Response(body) });
  const result = await bounded(provider.submitPrompt(prompt, "agent-review.provider"), 1000);
  assert.equal(result.ok, true);
  assert.equal(result.rawText, response.output_text);
  assert.equal(body.locked, false);
});

it("preserves HTTP, invalid JSON and missing-output validation without retrying", async () => {
  for (const [status, text, code] of [
    [429, `upstream ${env.OPENAI_API_KEY} Bearer echoed-token`, "agent.provider.http_error"],
    [200, `{invalid ${env.OPENAI_API_KEY}`, "agent.provider.response_json_invalid"],
    [200, JSON.stringify({ output: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "fixture" }] }] }), "agent.provider.output_text_missing"]
  ]) {
    let calls = 0;
    const provider = new OpenAIResponsesReviewProvider({ env, fetchImpl: async () => { calls++; return new Response(text, { status }); } });
    const result = await bounded(provider.submitPrompt(prompt, "agent-review.provider"));
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, code);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes(env.OPENAI_API_KEY), false);
    assert.equal(JSON.stringify(result).includes("echoed-token"), false);
  }
});

it("clears its timeout after a successful text-only response", async () => {
  let signal;
  const provider = new OpenAIResponsesReviewProvider({ env, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return { ok: true, status: 200, text: async () => JSON.stringify(response) };
  } });
  const result = await bounded(provider.submitPrompt(prompt, "agent-review.provider"));
  assert.equal(result.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(signal.aborted, false);
});

for (const mode of ["full", "compact"]) for (const operation of ["review", "repairReviewResponse"]) {
  it(`uses the same body deadline for ${mode} ${operation}`, async (t) => {
    const sourceDraft = cleanSourceFile("tests/fixtures/route-validation/provider-body-timeout/provider_SysFormTemplate.xml");
    const dslDraft = draftSourceDraft(sourceDraft);
    let rejectBody, calls = 0;
    t.after(() => rejectBody?.(new Error("fixture cleanup")));
    const provider = new OpenAIResponsesReviewProvider({ env: { ...env, OPENAI_REVIEW_CONTEXT: mode }, fetchImpl: async (_url, { signal }) => {
      calls++;
      return { ok: true, status: 200, text: () => new Promise((_, reject) => {
        rejectBody = reject;
        signal.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
      }) };
    } });
    const result = await bounded(provider[operation]({ sourceDraft, dslDraft, rawText: "{}", diagnostics: [], rejectedPatches: [], attempt: 1 }));
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, "agent.provider.request_timeout");
    assert.equal(result.diagnostics[0].details.phase, "body");
    assert.equal(calls, 1);
  });
}

it("rejects completion after a deadline even when the timer callback could not run yet", async () => {
  let signal, bodyRead = false, cancellations = 0;
  const provider = new OpenAIResponsesReviewProvider({ env, fetchImpl: (_url, options) => {
    signal = options.signal;
    const finish = performance.now() + 40;
    while (performance.now() < finish) { /* Deliberately delay this thread's timer callback. */ }
    return { ok: true, status: 200, body: { cancel() { cancellations++; } }, text: async () => { bodyRead = true; return JSON.stringify(response); } };
  } });
  const result = await bounded(provider.submitPrompt(prompt, "agent-review.provider"));
  assert.equal(result.diagnostics[0].code, "agent.provider.request_timeout");
  assert.equal(result.diagnostics[0].details.phase, "headers");
  assert.equal(signal.aborted, true);
  assert.equal(bodyRead, false);
  assert.equal(cancellations, 1);
});

async function bounded(promise, milliseconds = 500) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Provider exceeded the test watchdog.")), milliseconds); })
    ]);
  } finally { clearTimeout(timeout); }
}
