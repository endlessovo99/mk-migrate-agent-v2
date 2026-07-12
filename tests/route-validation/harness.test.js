import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeDsl } from "../../src/executor/execute.js";
import { NEWOA_SIT_BASE_URL } from "../../src/executor/newoa-client.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { resolveRouteFixture } from "./fixture.js";
import { validateRouteManifest } from "./manifest.js";
import { withNetworkGuard } from "./network-guard.js";
import { runRouteCase } from "./run-route-case.js";
import { appendTranscriptEntry, assertNoSecretLeak } from "./transcript.js";

describe("Route-validation harness integrity", { concurrency: false }, () => {
  it("rejects unknown Route case names as integrity errors", async () => {
    await assert.rejects(
      runRouteCase("not-a-route-case"),
      (error) => error?.name === "RouteIntegrityError" && error?.code === "route.case.unknown"
    );
  });

  it("rejects a missing tracked fixture as an integrity error", () => {
    assert.throws(
      () => resolveRouteFixture({
        kind: "form-only",
        relativePath: "missing/missing_SysFormTemplate.xml"
      }),
      (error) => error?.name === "RouteIntegrityError" && error?.code === "route.fixture.missing"
    );
  });

  it("rejects executable manifest values and unknown finite scenarios", () => {
    const callbackManifest = manifestWith({ callback: () => undefined });
    assert.throws(
      () => validateRouteManifest(callbackManifest),
      (error) => error?.code === "route.manifest.not_data"
    );

    assert.throws(
      () => validateRouteManifest(manifestWith({ reviewScenario: "arbitrary-review" })),
      (error) => error?.code === "route.scenario.review_unknown"
    );
    assert.throws(
      () => validateRouteManifest(manifestWith({ newoaScenario: "arbitrary-transport" })),
      (error) => error?.code === "route.scenario.newoa_unknown"
    );
    assert.throws(
      () => appendTranscriptEntry([], { operation: "arbitrary-operation" }),
      (error) => error?.code === "route.transcript.invalid"
    );
    assert.throws(
      () => appendTranscriptEntry([], { operation: "update", templateId: { raw: "payload" } }),
      (error) => error?.code === "route.transcript.invalid"
    );

    assert.doesNotThrow(() => validateRouteManifest(manifestWith({
      expected: {
        terminalStage: "review",
        reviewStatus: "blocked",
        reviewStage: "agent-review.input",
        operations: []
      }
    })));
  });

  it("fails on a caught fetch attempt and restores global fetch", async () => {
    const originalFetch = globalThis.fetch;
    await assert.rejects(
      withNetworkGuard(async () => {
        try {
          await globalThis.fetch("https://example.invalid/should-not-run");
        } catch {
          // The guard must still fail after callers swallow the immediate error.
        }
      }),
      (error) => error?.code === "route.network_attempt" && error?.details?.attempts === 1
    );
    assert.equal(globalThis.fetch, originalFetch);
  });

  it("records credential-free transcripts and rejects credentials in a whole result", async () => {
    const adapter = new FakeNewoaAdapter("persist");
    const username = "internal-route-user";
    const encryptedPassword = "internal-encrypted-password";
    await adapter.login({ username, encryptedPassword });

    assert.deepEqual(adapter.transcript(), [{ operation: "login" }]);
    assert.equal(JSON.stringify(adapter.transcript()).includes(username), false);
    assert.equal(JSON.stringify(adapter.transcript()).includes(encryptedPassword), false);
    const unsafeResult = {
      review: { status: "passed" },
      dsl: { artifact: "migration-dsl" },
      dryRun: { status: "passed" },
      execution: { status: "written", accidentalEcho: username },
      transcript: adapter.transcript()
    };
    assert.throws(
      () => assertNoSecretLeak(unsafeResult, [username, encryptedPassword]),
      (error) => error?.code === "route.secret_leak"
    );
  });

  it("supports the finite fail-at-update adapter scenario", async () => {
    const { dsl } = await runRouteCase("form-only-success");
    const adapter = new FakeNewoaAdapter("fail-at-update");
    const result = await executeDsl(dsl, {
      client: adapter,
      credentials: {
        username: "internal-route-user",
        encryptedPassword: "internal-encrypted-password"
      },
      confirmWrite: true,
      targetCategoryId: "route-category-id",
      baseUrl: NEWOA_SIT_BASE_URL,
      now: new Date("2026-07-10T00:00:00.000Z")
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.stage, "update");
    assert.deepEqual(result.createdFdIds, ["route-created-template"]);
    assert.deepEqual(adapter.transcript().map((entry) => entry.operation), [
      "login",
      "init",
      "generate-table-name",
      "load-parent-category",
      "add",
      "get-before-update",
      "update"
    ]);
  });
});

function manifestWith(overrides = {}) {
  return {
    version: 1,
    cases: [{
      id: "internal-case",
      source: {
        kind: "form-only",
        relativePath: "form-only/route-form-only_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: []
      },
      ...overrides
    }]
  };
}
