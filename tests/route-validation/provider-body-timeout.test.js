import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { OpenAIResponsesReviewProvider } from "../../src/agent-review/provider.js";
import { checkTrust } from "../../src/dsl/trust.js";
import { runRouteCase } from "./run-route-case.js";
import { withNetworkGuard } from "./network-guard.js";

const fixture = "tests/fixtures/route-validation/provider-body-timeout/provider_SysFormTemplate.xml";
const response = JSON.parse(readFileSync(new URL("../fixtures/route-validation/provider-body-timeout/response.json", import.meta.url), "utf8"));

it("blocks the registered XML route when the real provider receives an unfinished fake body", async () => {
  const result = await runRouteCase("provider-body-timeout-blocks-review");
  assert.equal(result.review.status, "blocked");
  assert.ok(result.review.diagnostics.some((item) => item.code === "agent.provider.request_timeout" && item.details.phase === "body"), JSON.stringify(result.review.diagnostics));
  assert.equal(result.dsl.artifact, "dsl-draft");
  assert.equal(result.dsl.trust.executable, false);
  assert.equal(result.dryRun, undefined);
  assert.equal(result.execution, undefined);
  assert.deepEqual(result.transcript, []);
});

for (const mode of ["full", "compact"]) {
  it(`keeps complete model-response validation in the ${mode} XML review route`, async () => {
    await withNetworkGuard(async () => {
      const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
      const before = JSON.stringify({ source, draft });
      for (const [output, accepted] of [[response.output_text, true], ["not model JSON", false]]) {
        let calls = 0;
        const provider = new OpenAIResponsesReviewProvider({
          env: {
            OPENAI_BASE_URL: "https://fixture.invalid", OPENAI_API_KEY: "route-provider-fixture-key",
            OPENAI_MODEL: "route-provider-fixture", OPENAI_REQUEST_TIMEOUT_MS: "500", OPENAI_REVIEW_CONTEXT: mode
          },
          fetchImpl: async () => { calls++; return new Response(JSON.stringify({ output_text: output })); }
        });
        const result = await runAgentReview(source, draft, { provider, maxRepairAttempts: 0 });
        assert.equal(result.ok, accepted);
        assert.equal(calls, 1);
        if (accepted) assert.equal(checkTrust(source, result.dsl).ok, true);
        else {
          assert.equal(result.dsl, undefined);
          assert.ok(result.report.diagnostics.some((item) => item.code === "agent.response.invalid_json"));
        }
      }
      assert.equal(JSON.stringify({ source, draft }), before);
    });
  });
}
