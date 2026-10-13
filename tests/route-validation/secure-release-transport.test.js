import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { OpenAIResponsesReviewProvider } from "../../src/agent-review/provider.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/route-validation/secure-release/responses-compatibility.json", import.meta.url)));
const env = { OPENAI_BASE_URL: "https://fixture.invalid", OPENAI_API_KEY: "fixture-key", OPENAI_MODEL: fixture.request.model };
const prompt = { system: fixture.request.system, context: fixture.request.context, promptVersion: fixture.request.promptVersion };

it("sends explicit stream:false to a strict Responses proxy and preserves the original request", async () => {
  const requests = [];
  const provider = new OpenAIResponsesReviewProvider({ env, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });
    return typeof body.stream === "boolean"
      ? new Response(JSON.stringify(fixture.response), { status: 200 })
      : new Response(JSON.stringify({ error: "stream must be a boolean" }), { status: 400 });
  } });
  const result = await provider.submitPrompt(prompt, "agent-review.provider");
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://fixture.invalid/v1/responses");
  assert.equal(requests[0].options.headers.authorization, "Bearer fixture-key");
  assert.deepEqual(requests[0].body, {
    model: fixture.request.model, stream: false,
    input: [{ role: "system", content: fixture.request.system }, { role: "user", content: JSON.stringify(fixture.request.context, null, 2) }],
    text: { format: { type: "json_object" } }
  });
  assert.equal(result.rawText, fixture.response.output_text);
});

for (const status of fixture.nonRetriedStatuses) it(`returns HTTP ${status} without automatic transport retries`, async () => {
  let calls = 0;
  const provider = new OpenAIResponsesReviewProvider({ env, fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ error: "fixture rejection" }), { status });
  } });
  const result = await provider.submitPrompt(prompt, "agent-review.provider");
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, "agent.provider.http_error");
  assert.equal(result.diagnostics[0].details.status, status);
});
