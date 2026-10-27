import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildAgentReviewPrompt, AGENT_REVIEW_PROMPT_VERSION } from "../../src/agent-review/prompt.js";
import { createReviewCheckpoint, validateReviewCheckpoint } from "../../src/agent-review/checkpoint.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/timer-helper-context/timer-helper_SysFormTemplate.xml";
const base = readFileSync(fixture, "utf8");
const helper = 'function recomputeTotal(){SetXFormFieldValueById("fd_total",readAmount());} function readAmount(){return GetXFormFieldValueById("fd_amount")[0];}';
const caller = 'AttachXFormValueChangeEventById("fd_amount",function(value){setTimeout(recomputeTotal,150);});';

describe("named timer helper context Route-validation", () => {
  it("includes the same-source callback declaration without rewriting the timer", () => {
    const source = cleanSourceFile(fixture);
    const result = inspectSource(source);
    assert.deepEqual(names(result), ["recomputeTotal"]);
    assert.match(result.actionSource.excerpt, /setTimeout\(recomputeTotal,150\)/);
    const reference = result.audit.callbackReferences[0];
    assert.equal(reference.api, "setTimeout");
    assert.equal(reference.callback, "recomputeTotal");
    assert.equal(reference.delaySource, "150");
    assert.equal(reference.rangeBasis, "action-source");
    assert.equal(result.actionSource.excerpt.slice(reference.range.start, reference.range.end), "setTimeout(recomputeTotal,150)");
    const definition = result.definitions[0];
    const script = source.scripts.sources.find((item) => item.sourceRef === definition.sourceRef);
    assert.equal(script.javascript.slice(definition.sourceRange.start, definition.sourceRange.end), definition.definition);
  });

  it("uses the existing bounded helper closure for a unique sibling callback", () => {
    const result = inspect([helper, caller, "function unrelated(){return 0;}"]);
    assert.deepEqual(names(result), ["recomputeTotal", "readAmount"]);
    assert.deepEqual(result.definitions.map((item) => item.depth), [0, 1]);
    assert.equal(result.definitions[0].sourceRef, result.source.scripts.sources[0].sourceRef);
    assert.notEqual(result.definitions[0].sourceRef, result.action.sourceRefs[0]);
  });

  it("audits timer references reached from helper bodies without widening depth", () => {
    const result = inspect([
      "function recomputeTotal(){setTimeout(one,1);} function one(){setTimeout(two,2);} function two(){setTimeout(three,3);} function three(){return 1;}",
      caller
    ]);
    assert.deepEqual(names(result), ["recomputeTotal", "one", "two"]);
    assert.ok(result.audit.callbackReferences.some((reference) => reference.callback === "one" && reference.rangeBasis === "helper-definition"));
    assert.ok(result.audit.omitted.some((item) => item.name === "three" && item.reason === "depth_limit"));
  });

  it("preserves delay expressions as evidence without evaluating them", () => {
    const result = inspect([helper, caller.replace(",150)", ",delayMs)")]);
    assert.deepEqual(names(result), ["recomputeTotal", "readAmount"]);
    assert.equal(result.audit.callbackReferences[0].delaySource, "delayMs");
    assert.match(result.actionSource.excerpt, /setTimeout\(recomputeTotal,delayMs\)/);
  });

  it("rejects a lexically shadowed or source-overridden scheduler", () => {
    for (const scripts of [
      [helper, caller.replace("function(value)", "function(value,setTimeout)")],
      [helper, caller.replace("setTimeout(recomputeTotal", "var setTimeout=schedule;setTimeout(recomputeTotal")],
      [helper, caller, "function setTimeout(callback){return callback;}"],
      [helper, caller, "window.setTimeout=replacement;"],
      [helper, caller, "var host;host=window;host.setTimeout=replacement;"]
    ]) {
      const result = inspect(scripts);
      assert.equal(names(result).includes("recomputeTotal"), false);
      assert.ok(result.audit.omitted.some((item) => item.reason === "scheduler_binding_unverified"));
    }
  });

  it("does not resolve a callback parameter or variable alias to a global declaration", () => {
    for (const changed of [
      caller.replace("function(value)", "function(value,recomputeTotal)"),
      caller.replace("setTimeout(recomputeTotal", "var callback=recomputeTotal;setTimeout(callback")
    ]) {
      const result = inspect([helper, changed]);
      assert.equal(names(result).includes("recomputeTotal"), false);
      assert.ok(result.audit.omitted.some((item) => item.reason === "scheduler_callback_binding_unverified"));
    }
  });

  it("records a named callback whose declaration is absent", () => {
    const result = inspect([caller]);
    assert.deepEqual(names(result), []);
    assert.ok(result.audit.omitted.some((item) => item.name === "recomputeTotal" && item.reason === "scheduler_callback_definition_missing"));
    assert.equal(result.audit.callbackReferences[0].callback, "recomputeTotal");
  });

  it("keeps duplicate and overwritten callback declarations unavailable", () => {
    for (const extra of [
      "function recomputeTotal(){return 9;}",
      'Reflect.set(window,"recomputeTotal",replacement);',
      "var host;host=window;host.recomputeTotal=replacement;"
    ]) {
      const result = inspect([helper, caller, extra]);
      assert.equal(names(result).includes("recomputeTotal"), false);
      assert.ok(result.audit.omitted.some((item) => ["ambiguous_declaration", "runtime_binding_unverified"].includes(item.reason)));
    }
  });

  it("does not generalize to strings, member expressions or arbitrary higher-order APIs", () => {
    for (const changed of [
      caller.replace("setTimeout(recomputeTotal,150)", 'setTimeout("recomputeTotal()",150)'),
      caller.replace("setTimeout(recomputeTotal,150)", "setTimeout(handlers.current,150)"),
      caller.replace("setTimeout(recomputeTotal,150)", "setInterval(recomputeTotal,150)"),
      caller.replace("setTimeout(recomputeTotal,150)", "window.setTimeout(recomputeTotal,150)"),
      caller.replace("setTimeout(recomputeTotal,150)", "defer(recomputeTotal,150)"),
      caller.replace("setTimeout(recomputeTotal,150)", "var timer=setTimeout;timer(recomputeTotal,150)")
    ]) assert.equal(names(inspect([helper, changed])).includes("recomputeTotal"), false);
  });

  it("preserves direct helper calls inside an anonymous timer callback", () => {
    const result = inspect([helper, caller.replace("setTimeout(recomputeTotal,150)", "setTimeout(function(){recomputeTotal();},150)")]);
    assert.deepEqual(names(result), ["recomputeTotal", "readAmount"]);
    assert.equal(result.audit.callbackReferences?.length || 0, 0);
  });

  it("retains helper display gates and masks comment-only field ids", () => {
    const result = inspect([
      { html: `<xform:editShow><script>${helper}</script></xform:editShow>` },
      caller.replace("setTimeout", "/* fd_comment_only */setTimeout")
    ]);
    assert.equal(result.definitions[0].displayGate, "xform:editShow");
    assert.equal(result.action.runWhen, undefined);
    assert.equal(result.actionSource.fieldIds.includes("fd_comment_only"), false);
  });

  it("keeps callback definitions under the existing full and compact budgets", () => {
    for (const compact of [false, true]) {
      const result = inspect([`function recomputeTotal(){var text="${"x".repeat(11000)}";return text;}`, caller], { compact });
      assert.deepEqual(result.definitions, []);
      assert.ok(result.audit.omitted.some((item) => item.reason === "character_budget"));
      assert.equal(result.audit.maxCharacters, compact ? 5200 : 10000);
    }
  });

  it("rejects a signed v15 checkpoint under the v16 review contract", () => {
    const result = inspect([helper, caller]);
    const options = {
      sourceDraft: result.source, originalDslDraft: result.draft, reviewedDslDraft: result.draft,
      batchSize: 12, maxAttemptsPerAction: 2, signingKey: "test-timer-helper-signing-key-at-least-32-bytes",
      reviewer: { provider: "test", promptVersion: "agent-review.scoped-batches.v15", reviewedAt: "2026-10-15T00:00:00Z" }
    };
    const checkpoint = createReviewCheckpoint({ ...options, promptVersion: "agent-review.scoped-batches.v15" });
    assert.equal(validateReviewCheckpoint(checkpoint, { ...options, promptVersion: "agent-review.scoped-batches.v15" }).ok, true);
    assert.equal(AGENT_REVIEW_PROMPT_VERSION, "agent-review.scoped-batches.v18");
    const checked = validateReviewCheckpoint(checkpoint, { ...options, promptVersion: AGENT_REVIEW_PROMPT_VERSION });
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.diagnostics.map((item) => item.code).sort(), ["agent.checkpoint.cache_key_mismatch", "agent.checkpoint.contract_mismatch"]);
  });

  it("does not promote executable trust merely because helper context is visible", async () => {
    const result = await runRouteCase("timer-helper-context-remains-gated");
    assert.equal(result.review.ok, false);
    assert.equal(result.review.stage, "agent-review.incomplete");
    assert.equal(result.execution, undefined);
    assert.deepEqual(result.transcript, []);
  });
});

function names(result) {
  return result.definitions.map((definition) => definition.name);
}

function inspect(scripts, options = {}) {
  const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const html = scripts.map((script) => typeof script === "string" ? `<script>${script}</script>` : script.html).join("");
  const xml = base.replace(/<string>fdDisplayJsp<\/string><string>[^]*?<\/string><\/void>/,
    `<string>fdDisplayJsp</string><string>${escape(html)}</string></void>`);
  const directory = mkdtempSync(join(tmpdir(), "timer-helper-context-"));
  try {
    const file = join(directory, "timer_SysFormTemplate.xml");
    writeFileSync(file, xml);
    return inspectSource(cleanSourceFile(file), options);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function inspectSource(source, options = {}) {
  const draft = draftSourceDraft(source);
  const before = JSON.stringify(draft);
  const index = draft.scripts.actions.findIndex((action) => action.event === "onChange" && action.controlId === "fd_amount");
  assert.ok(index >= 0);
  const action = draft.scripts.actions[index];
  const prompt = buildAgentReviewPrompt(source, draft, {
    compact: options.compact,
    reviewScope: { actionIndexes: [index], actionIds: [action.id], includeFormTargets: false }
  });
  assert.equal(JSON.stringify(draft), before);
  const summary = prompt.context.dslDraft.scripts.actions[0];
  assert.deepEqual(summary.sourceRefs, action.sourceRefs);
  assert.ok(prompt.context.allowedConcretePatchPaths.every((path) => path.startsWith(`/scripts/actions/${index}/`)));
  return {
    source, draft, action, prompt, actionSource: summary.actionSource,
    definitions: summary.actionSource?.localHelperDefinitions || [],
    audit: summary.actionSource?.helperDefinitionAudit || { omitted: [] }
  };
}
