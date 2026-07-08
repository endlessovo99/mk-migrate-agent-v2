import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgentReview } from "../../src/agent-review/index.js";
import { buildAgentReviewPrompt } from "../../src/agent-review/prompt.js";
import { OpenAIResponsesReviewProvider } from "../../src/agent-review/provider.js";
import { main } from "../../src/cli/main.js";
import { checkTrust } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sampleDraftDsl, sampleSourceDraft } from "../helpers/sample-dsl.js";

describe("agent-review", () => {
  it("applies valid evidence-backed patches and records audit metadata", async () => {
    const sourceDraft = sampleSourceDraft();
    const dslDraft = sampleDraftDsl();
    const provider = new FakeReviewProvider(reviewResponse({
      patches: [titlePatch("/form/fields/2/title", "IT设备明细", "source.form.detailTable.fd_detail")]
    }));

    const result = await runAgentReview(sourceDraft, dslDraft, {
      provider,
      reviewedAt: "2026-07-06T00:00:00.000Z"
    });
    const trust = checkTrust(sourceDraft, result.dsl);

    assert.equal(result.ok, true);
    assert.equal(result.dsl.artifact, "migration-dsl");
    assert.equal(result.dsl.trust.level, "trusted");
    assert.equal(result.dsl.trust.executable, true);
    assert.equal(result.dsl.form.fields[2].title, "IT设备明细");
    assert.equal(result.dsl.review.decisions.length, 1);
    assert.equal(result.dsl.review.decisions[0].targetRefs[0], "/form/fields/2/title");
    assert.equal(result.dsl.review.agentReview.provider, "openai");
    assert.equal(result.dsl.review.agentReview.baseUrl, "fake://agent-review");
    assert.equal(result.dsl.review.agentReview.model, "fake-model");
    assert.equal(result.dsl.review.agentReview.patchCount, 1);
    assert.equal(JSON.stringify(result.dsl).includes("sk-test-secret"), false);
    assert.equal(trust.ok, true);
  });

  it("exposes an agent-review CLI command that writes DSL and optional report offline through injection", async () => {
    const tempDir = cleanTempDir("cli-happy");
    const sourcePath = join(tempDir, "source-draft.json");
    const draftPath = join(tempDir, "dsl-draft.json");
    const outPath = join(tempDir, "migration.dsl.json");
    const reportPath = join(tempDir, "agent-review.report.json");
    writeJson(sourcePath, sampleSourceDraft());
    writeJson(draftPath, sampleDraftDsl());

    const restoreLog = captureConsoleLog();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    await main([
      "agent-review",
      sourcePath,
      draftPath,
      "--out",
      outPath,
      "--report-out",
      reportPath
    ], {
      agentReviewProvider: new FakeReviewProvider(reviewResponse({
        patches: [titlePatch("/form/fields/2/title", "IT设备明细", "source.form.detailTable.fd_detail")]
      })),
      reviewedAt: "2026-07-06T00:00:00.000Z"
    });
    const output = restoreLog();

    assert.equal(process.exitCode, undefined);
    process.exitCode = previousExitCode;
    assert.equal(existsSync(outPath), true);
    assert.equal(existsSync(reportPath), true);
    assert.equal(JSON.parse(readFileSync(outPath, "utf8")).artifact, "migration-dsl");
    assert.equal(JSON.parse(readFileSync(reportPath, "utf8")).ok, true);
    assert.equal(output.includes("agent-review.complete"), true);
  });

  it("rejects workflow patches and does not produce executable DSL", async () => {
    const result = await runAgentReview(sampleSourceDraft(), sampleDraftDsl(), {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [{
          ...titlePatch("/workflow/edges/0/condition", "should not apply", "source.workflow.edge.L1"),
          sourceRefs: ["source.workflow.edge.L1"]
        }]
      }))
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.patch-validation");
    assert.equal(result.report.diagnostics.some((item) => item.code === "agent.patch.path_disallowed"), true);
    assert.equal(result.dsl, undefined);
  });

  it("rejects illegal form paths and invalid JSON responses", async () => {
    const illegalPath = await runAgentReview(sampleSourceDraft(), sampleDraftDsl(), {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [titlePatch("/form/layout/mkTree/0/id", "layout-change", "source.form.layout.row.row-0")]
      }))
    });
    const invalidJson = await runAgentReview(sampleSourceDraft(), sampleDraftDsl(), {
      provider: new FakeReviewProvider("{not json")
    });

    assert.equal(illegalPath.ok, false);
    assert.equal(illegalPath.report.diagnostics.some((item) => item.code === "agent.patch.path_disallowed"), true);
    assert.equal(invalidJson.ok, false);
    assert.equal(invalidJson.report.diagnostics.some((item) => item.code === "agent.response.invalid_json"), true);
  });

  it("blocks low-confidence patches without applying them", async () => {
    const result = await runAgentReview(sampleSourceDraft(), sampleDraftDsl(), {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [{
          ...titlePatch("/form/fields/2/title", "IT设备明细", "source.form.detailTable.fd_detail"),
          confidence: 0.69
        }]
      }))
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.diagnostics.some((item) => item.code === "agent.patch.low_confidence"), true);
  });

  it("repairs invalid patch responses once and records retry history", async () => {
    const sourceDraft = sampleSourceDraft();
    const dslDraft = sampleDraftDsl();
    const provider = new FakeReviewProvider(reviewResponse({
      patches: [{
        op: "replace",
        path: "/form/fields/99/title",
        value: "IT设备明细",
        sourceRefs: ["source.form.detailTable.fd_detail"],
        evidence: [],
        confidence: 0.86,
        rationale: "The title looked placeholder-like."
      }]
    }), {
      repairRawText: reviewResponse({
        patches: [titlePatch("/form/fields/2/title", "IT设备明细", "source.form.detailTable.fd_detail")]
      })
    });

    const result = await runAgentReview(sourceDraft, dslDraft, {
      provider,
      reviewedAt: "2026-07-06T00:00:00.000Z"
    });

    assert.equal(result.ok, true);
    assert.equal(provider.repairCalls.length, 1);
    assert.equal(provider.repairCalls[0].attempt, 1);
    assert.equal(provider.repairCalls[0].diagnostics.some((item) => item.code === "agent.patch.path_missing"), true);
    assert.equal(provider.repairCalls[0].diagnostics.some((item) => item.code === "agent.patch.evidence_required"), true);
    assert.equal(result.dsl.form.fields[2].title, "IT设备明细");
    assert.equal(result.dsl.review.agentReview.patchCount, 1);
    assert.equal(result.report.repairAttempts, 1);
    assert.equal(result.report.repairHistory.length, 1);
    assert.equal(result.report.repairHistory[0].stage, "agent-review.patch-validation");
    assert.equal(result.report.repairHistory[0].rejectedPatches[0].path, "/form/fields/99/title");
  });

  it("applies metadata-backed props patches and keeps workflow diagnostics warning-only", async () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/route-validation-lbpm");
    const dslDraft = draftSourceDraft(sourceDraft);
    dslDraft.form.fields[1].props = {};
    const result = await runAgentReview(sourceDraft, dslDraft, {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [{
          op: "replace",
          path: "/form/fields/1/props",
          value: { required: true },
          sourceRefs: ["source.form.control.fd_org"],
          evidence: ["source metadata identifies an organization control and required=true"],
          confidence: 0.91,
          rationale: "Carry metadata-backed organization props into the address component."
        }],
        diagnostics: [{
          level: "warning",
          code: "agent.workflow.condition_display_only",
          path: "/workflow/edges/1/condition",
          message: "Workflow condition remains diagnostic-only in Agent Review v1."
        }]
      }))
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.dsl.form.fields[1].props, { required: true });
    assert.equal(result.dsl.review.warnings.some((item) => item.code === "agent.workflow.condition_display_only"), true);
  });

  it("blocks error diagnostics from the model before trusted output", async () => {
    const result = await runAgentReview(sampleSourceDraft(), sampleDraftDsl(), {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [],
        diagnostics: [{
          level: "error",
          code: "agent.workflow.needs_human_review",
          path: "/workflow/edges/0/condition",
          message: "Workflow condition cannot be reviewed safely."
        }]
      }))
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.diagnostics");
    assert.equal(result.report.diagnostics.some((item) => item.code === "agent.workflow.needs_human_review"), true);
  });

  it("fails closed on missing OpenAI env without calling fetch", async () => {
    let fetchCalled = false;
    const provider = new OpenAIResponsesReviewProvider({
      env: {},
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error("should not call network");
      }
    });
    const result = await runAgentReview(sampleSourceDraft(), sampleDraftDsl(), { provider });

    assert.equal(result.ok, false);
    assert.equal(fetchCalled, false);
    assert.equal(result.report.stage, "agent-review.env");
    assert.equal(result.report.diagnostics.some((item) => item.code === "agent.provider.env_missing"), true);
  });

  it("does not leak OPENAI_API_KEY into reports when provider errors include it", async () => {
    const secret = "sk-test-secret";
    const provider = new OpenAIResponsesReviewProvider({
      env: {
        OPENAI_BASE_URL: "https://example.test",
        OPENAI_API_KEY: secret,
        OPENAI_MODEL: "fake-model"
      },
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        text: async () => `upstream echoed ${secret}`
      })
    });
    const result = await runAgentReview(sampleSourceDraft(), sampleDraftDsl(), { provider });

    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result.report).includes(secret), false);
    assert.equal(JSON.stringify(result.report).includes("https://example.test"), true);
  });

  it("keeps ordinary translate deterministic and provider-free", async () => {
    const tempDir = cleanTempDir("translate");
    const outPath = join(tempDir, "dsl-draft.json");
    const provider = new FakeReviewProvider(reviewResponse({ patches: [] }));
    const restoreLog = captureConsoleLog();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    await main([
      "translate",
      "tests/fixtures/source/route-validation-lbpm",
      "--out",
      outPath
    ], {
      agentReviewProvider: provider
    });
    restoreLog();

    assert.equal(process.exitCode, undefined);
    process.exitCode = previousExitCode;
    assert.equal(provider.called, false);
    assert.equal(JSON.parse(readFileSync(outPath, "utf8")).artifact, "dsl-draft");
  });

  it("builds prompt context from structured source facts without raw XML", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/19bb55286bd93a6081a33e44c3791374");
    const dslDraft = draftSourceDraft(sourceDraft);
    const prompt = buildAgentReviewPrompt(sourceDraft, dslDraft);
    const text = JSON.stringify(prompt);

    assert.equal(text.includes("_SysFormTemplate.xml"), false);
    assert.equal(text.includes("<xform"), false);
    assert.equal(text.includes("itTable"), true);
    assert.equal(text.includes("/workflow"), true);
    assert.equal(text.includes("/form/fields/*/columns/*/props"), true);
    assert.equal(prompt.context.patchTargetSummary.fieldCount > 0, true);
    assert.match(prompt.context.patchTargetSummary.validFieldIndexRange, /^0\.\.\d+$/);
    assert.equal(prompt.context.allowedConcretePatchPaths.includes("/form/fields/0/title"), true);
    assert.equal(prompt.context.allowedConcretePatchPaths.some((path) => /\/columns\/0\/title$/.test(path)), true);
  });
});

class FakeReviewProvider {
  constructor(rawText, options = {}) {
    this.rawText = rawText;
    this.called = false;
    this.repairCalls = [];
    if (options.repairRawText !== undefined) {
      this.repairReviewResponse = async (input) => {
        this.repairCalls.push(input);
        return {
          ok: true,
          status: "received",
          stage: "agent-review.provider-repair",
          provider: "openai",
          baseUrl: "fake://agent-review",
          model: "fake-model",
          promptVersion: "test-prompt",
          rawText: options.repairRawText,
          rawResponsePreview: options.repairRawText.slice(0, 2000)
        };
      };
    }
  }

  metadata() {
    return {
      provider: "openai",
      baseUrl: "fake://agent-review",
      model: "fake-model"
    };
  }

  async review() {
    this.called = true;
    return {
      ok: true,
      status: "received",
      stage: "agent-review.provider",
      provider: "openai",
      baseUrl: "fake://agent-review",
      model: "fake-model",
      promptVersion: "test-prompt",
      rawText: this.rawText,
      rawResponsePreview: this.rawText.slice(0, 2000)
    };
  }
}

function reviewResponse(overrides = {}) {
  return JSON.stringify({
    summary: "Reviewed form DSL and proposed semantic repairs.",
    patches: overrides.patches || [],
    diagnostics: overrides.diagnostics || []
  });
}

function titlePatch(path, value, sourceRef) {
  return {
    op: "replace",
    path,
    value,
    sourceRefs: [sourceRef],
    evidence: ["source fields and columns provide matching business semantics"],
    confidence: 0.86,
    rationale: "The draft title is placeholder-like and source evidence supports the replacement."
  };
}

function cleanTempDir(name) {
  const path = join(".tmp", "agent-review-tests", name);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  return path;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function captureConsoleLog() {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  return () => {
    console.log = original;
    return lines.join("\n");
  };
}
