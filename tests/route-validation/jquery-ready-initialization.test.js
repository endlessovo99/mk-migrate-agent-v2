import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { runRouteCase } from "./run-route-case.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";

const fixture = "tests/fixtures/route-validation/jquery-ready-initialization/ready-initialization_SysFormTemplate.xml";
const source = cleanSourceFile(fixture);
const original = source.scripts.sources[0].javascript;
function translated(text = original) {
  const changed = structuredClone(source);
  changed.scripts.sources[0].javascript = text;
  return { source: changed, draft: draftSourceDraft(changed) };
}
const readyActions = draft => draft.scripts.actions.filter(action => action.semanticHints?.jqueryReadyInitialization);

describe("source-bound jQuery ready initialization Route-validation", () => {
  it("retains initialization as a separate pending load without altering the source or change callback identity", () => {
    const before = JSON.stringify(source);
    const draft = draftSourceDraft(source);
    const ready = readyActions(draft);
    assert.equal(ready.length, 1);
    assert.equal(JSON.stringify(source), before);
    assert.equal(checkDraft(draft).ok, true);
    assert.equal(ready[0].translationStatus, "needs_review");
    assert.equal(ready[0].event, "onLoad");
    assert.equal(ready[0].scope, "global");
    assert.equal(ready[0].id, source.scripts.sources[0].id + ".ready.1");
    assert.deepEqual(ready[0].sourceRefs, [source.scripts.sources[0].sourceRef]);
    assert.deepEqual(ready[0].runWhen.viewStatusIn, ["add", "edit"]);
    assert.match(ready[0].function, /bindInputs\(\);recomputeTotal\(\);/);
    assert.equal(ready[0].deterministicBranchProof, undefined);
    const changes = draft.scripts.actions.filter(action => action.event === "onChange");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].id, source.scripts.sources[0].id + ".event.1");
    assert.match(changes[0].function, /setTimeout\(recomputeTotal,150\)/);
    const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true, reviewerName: "route-test" });
    assert.equal(checkTrust(source, trusted).ok, false);
    assert.equal(buildDryRunPlan(trusted).ok, false);
  });

  for (const [label, edit] of [
    ["global scheduler shadow", text => "var $ = other;\n" + text],
    ["class scheduler shadow", text => "class $ {}\n" + text],
    ["later scheduler overwrite", text => text + "\n$ = other;"],
    ["callback parameter", text => text.replace("$(function(){", "$(function(value){")],
    ["async callback", text => text.replace("$(function(){", "$(async function(){")],
    ["nested ready", text => text.replace("$(function(){bindInputs();recomputeTotal();});", "function outer(){ $(function(){bindInputs();recomputeTotal();}); }")],
    ["string lookalike", text => text.replace("$(function(){bindInputs();recomputeTotal();});", 'var example = "$(function(){bindInputs();recomputeTotal();});";')]
  ]) it(`does not assert the narrow ready contract for ${label}`, () => {
    const { draft } = translated(edit(original));
    assert.equal(readyActions(draft).length, 0);
  });

  for (const [label, edit] of [
    ["callback helper shadow", text => text.replace("bindInputs();recomputeTotal();", "class recomputeTotal {} bindInputs();recomputeTotal();")],
    ["helper reassignment", text => text + "\nrecomputeTotal = other;"],
    ["duplicate helper", text => text + "\nfunction recomputeTotal(){}"],
    ["unknown initializer", text => text.replace("bindInputs();recomputeTotal();", "bindInputs();unknownInitializer();")],
    ["binder not called", text => text.replace("bindInputs();recomputeTotal();", "recomputeTotal();")]
  ]) it(`retains the real ready callback pending for ${label}`, () => {
    const { source: changed, draft } = translated(edit(original));
    const ready = readyActions(draft);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].translationStatus, "needs_review");
    assert.equal(ready[0].semanticHints.jqueryReadyInitialization.bindingStatus, "unproven");
    const trusted = createTrustedMigrationDsl(changed, draft, { externalAgentReviewed: true, reviewerName: "route-negative" });
    assert.equal(checkTrust(changed, trusted).ok, false);
  });

  it("keeps extra callback effects and repeated initial calls visible and pending", () => {
    const text = original.replace("bindInputs();recomputeTotal();", "bindInputs();auditEffect();recomputeTotal();recomputeTotal();");
    const { draft } = translated(text);
    const ready = readyActions(draft)[0];
    assert.ok(ready);
    assert.match(ready.function, /bindInputs\(\);auditEffect\(\);recomputeTotal\(\);recomputeTotal\(\);/);
    assert.equal(ready.translationStatus, "needs_review");
    assert.equal(ready.coverage.status, "uncovered");
  });

  it("retains dynamic callback effects as unproven without mistaking them for an empty initializer", () => {
    const { draft } = translated(original.replace("bindInputs();recomputeTotal();", 'bindInputs();eval("extraEffect()");recomputeTotal();'));
    const ready = readyActions(draft)[0];
    assert.ok(ready);
    assert.match(ready.function, /eval\("extraEffect\(\)"\)/);
    assert.equal(ready.semanticHints.jqueryReadyInitialization.bindingStatus, "unproven");
    assert.equal(ready.translationStatus, "needs_review");
  });

  it("recognizes an unshadowed jQuery spelling without changing the retained callback", () => {
    const { draft } = translated(original.replace("$(function(){", "jQuery(function(){"));
    assert.equal(readyActions(draft).length, 1);
    assert.match(readyActions(draft)[0].function, /jQuery\(function\(\)/);
  });

  it("keeps a separate explicit window load alongside the ready initialization", () => {
    const { draft } = translated(original + '\nCom_AddEventListener(window,"load",function(){recomputeTotal();});');
    assert.equal(readyActions(draft).length, 1);
    assert.equal(draft.scripts.actions.filter(action => action.event === "onLoad").length, 2);
  });

  it("keeps accept-only review incomplete and performs no target operations", async () => {
    const result = await runRouteCase("jquery-ready-initialization-remains-gated");
    assert.equal(result.review.ok, false);
    assert.equal(result.review.stage, "agent-review.incomplete");
    assert.deepEqual(result.transcript, []);
  });

  it("keeps acceptance blocked solely by initialization after the change callback is reviewed", async () => {
    const partial = reviewChangeCallback();
    assert.deepEqual(partial.scripts.actions.filter(action => action.translationStatus === "needs_review").map(action => action.id), [source.scripts.sources[0].id + ".ready.1"]);
    const result = await runAgentReview(source, partial, { provider: createFakeReviewProvider("accept"), maxAttemptsPerAction: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.incomplete");
  });

  it("cannot accept an unknown initial helper after reviewing the unchanged future callback", async () => {
    const { source: changed } = translated(original.replace("bindInputs();recomputeTotal();", "bindInputs();unknownInitializer();"));
    const partial = reviewChangeCallback(changed);
    assert.equal(partial.scripts.actions.filter(action => action.translationStatus === "needs_review").length, 1);
    const result = await runAgentReview(changed, partial, { provider: createFakeReviewProvider("accept"), maxAttemptsPerAction: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.incomplete");
  });

  for (const kind of ["mapped no-op", "omitted", "cleared residual"]) {
    it(`rejects ${kind} through the patch boundary`, () => {
      const draft = reviewChangeCallback(), index = draft.scripts.actions.findIndex(action => action.semanticHints?.jqueryReadyInitialization);
      const values = kind === "cleared residual" ? { coverage: { status: "uncovered", nativeRules: [], residuals: [] } } : {
        function: kind === "omitted" ? "" : "function onLoad(){}", translationStatus: kind === "omitted" ? "omitted" : "mapped",
        coverage: { status: "translated", nativeRules: [], residuals: [] },
        functionMappings: [{ source: "ready lifecycle", target: "none", basis: "semantic-translation", reviewRequired: false }]
      };
      const result = applyEvidenceBackedPatches(draft, patches(draft, index, values), { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some(item => item.code === "agent.patch.ready_lifecycle_unproven"));
    });
  }

  it("rederives patch protection from source when the input hint and residual are removed", () => {
    const draft = reviewChangeCallback(), index = draft.scripts.actions.findIndex(action => action.semanticHints?.jqueryReadyInitialization);
    delete draft.scripts.actions[index].semanticHints;
    draft.scripts.actions[index].coverage.residuals = [];
    const result = applyEvidenceBackedPatches(draft, patches(draft, index, {
      function: "function onLoad(){}", translationStatus: "mapped",
      coverage: { status: "translated", nativeRules: [], residuals: [] }
    }), { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(item => item.code === "agent.patch.ready_lifecycle_unproven"));
  });

  for (const kind of ["mapped no-op", "omitted", "removed hint", "removed action"]) {
    it(`rejects direct external trust with ${kind} from authoritative source evidence`, () => {
      const draft = reviewChangeCallback(), index = draft.scripts.actions.findIndex(action => action.semanticHints?.jqueryReadyInitialization);
      const action = draft.scripts.actions[index];
      action.function = kind === "omitted" ? "" : "function onLoad(){}";
      action.translationStatus = kind === "omitted" ? "omitted" : "mapped";
      action.coverage = { status: "translated", nativeRules: [], residuals: [] };
      action.functionMappings = [{ source: "ready lifecycle", target: "none", basis: "semantic-translation", reviewRequired: false }];
      if (kind === "removed hint") delete action.semanticHints;
      if (kind === "removed action") draft.scripts.actions.splice(index, 1);
      const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true, reviewerName: "route-negative" });
      const result = checkTrust(source, trusted);
      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some(item => item.code === "trust.script_ready_lifecycle_unproven"));
    });
  }

  it("reports failed CLI external trust even when the proposed DSL deletes the initialization", t => {
    const draft = reviewChangeCallback();
    draft.scripts.actions = draft.scripts.actions.filter(action => !action.semanticHints?.jqueryReadyInitialization);
    const dir = mkdtempSync(join(tmpdir(), "ready-external-trust-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const sourcePath = join(dir, "source.json"), draftPath = join(dir, "draft.json");
    writeFileSync(sourcePath, JSON.stringify(source)); writeFileSync(draftPath, JSON.stringify(draft));
    const result = spawnSync(process.execPath, ["src/cli/main.js", "trust", sourcePath, draftPath, "--external-agent-reviewed"], { encoding: "utf8" });
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.diagnostics.some(item => item.code === "trust.script_ready_lifecycle_unproven"));
  });
});

function patches(draft, index, values) {
  return Object.entries(values).map(([key, value]) => ({
    op: "replace", path: `/scripts/actions/${index}/${key}`, value, sourceRefs: draft.scripts.actions[index].sourceRefs,
    evidence: ["Fixture-only review; the future change callback does not cover initial ready execution."],
    rationale: "Keep initialization independently gated.", confidence: 0.99
  }));
}

function reviewChangeCallback(reviewSource = source) {
  const draft = draftSourceDraft(reviewSource);
  const result = applyEvidenceBackedPatches(draft, patches(draft, 0, {
    function: 'function onChange(value,rowNum,parentRowNum){setTimeout(function(){MKXFORM.setValue("fd_total",MKXFORM.getValue("fd_amount"));},150);}',
    translationStatus: "mapped", coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{ source: "deferred field-copy helper", target: "same 150ms callback read/write", basis: "semantic-translation", reviewRequired: false }]
  }), { sourceDraft: reviewSource, sourceRefs: collectSourceRefs(reviewSource) });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.dslDraft;
}
