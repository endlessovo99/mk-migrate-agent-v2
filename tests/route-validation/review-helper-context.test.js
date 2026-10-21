import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createReviewCheckpoint, validateReviewCheckpoint } from "../../src/agent-review/checkpoint.js";
import { buildAgentReviewPrompt, AGENT_REVIEW_PROMPT_VERSION } from "../../src/agent-review/prompt.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/review-helper-context/shared-helper_SysFormTemplate.xml";
const base = readFileSync(fixture, "utf8");
const helpers = "function sharedRound(value) { return roundValue(value); } function roundValue(value) { return Math.round(Number(value) * 100) / 100; }";
const caller = 'AttachXFormValueChangeEventById("fd_amount", function(value) { SetXFormFieldValueById("fd_total", sharedRound(value)); });';

describe("review helper context Route-validation", () => {
  it("includes only called cross-script helpers with exact source ranges", () => {
    const result = inspect([helpers, caller, "function unusedHelper(){return 9;}"]);
    assert.deepEqual(names(result), ["sharedRound", "roundValue"]);
    const source = result.source.scripts.sources[0];
    for (const helper of result.definitions) {
      assert.equal(helper.sourceRef, source.sourceRef);
      assert.equal(source.javascript.slice(helper.sourceRange.start, helper.sourceRange.end), helper.definition);
    }
    assert.deepEqual(result.definitions.map((helper) => helper.depth), [0, 1]);
  });

  it("preserves same-script helper evidence", () => {
    assert.deepEqual(names(inspect([helpers + caller])), ["sharedRound", "roundValue"]);
  });

  it("excludes unrelated functions and calls inside uninvoked named functions", () => {
    const result = inspect([
      helpers + " function unusedHelper(){return unrelated();} function unrelated(){return 9;}",
      caller
    ]);
    assert.deepEqual(names(result), ["sharedRound", "roundValue"]);
  });

  it("does not follow a function expression merely assigned inside the action", () => {
    for (const body of ["function(){unusedHelper();}", "()=>unusedHelper()"]) {
      const result = inspect([
        helpers + " function unusedHelper(){return 9;}",
        caller.replace("SetXFormFieldValueById", `var dormant=${body}; SetXFormFieldValueById`)
      ]);
      assert.deepEqual(names(result), ["sharedRound", "roundValue"]);
    }
  });

  it("rejects conflicting declarations across scripts", () => {
    const result = inspect([helpers, caller, "function sharedRound(value){return 7;}"]);
    assert.deepEqual(result.definitions, []);
    assert.ok(result.audit.omitted.some((item) => item.reason === "ambiguous_declaration"));
  });

  it("rejects assignments, destructuring, loop writes and global-property overrides", () => {
    for (const mutation of [
      "sharedRound = replacement;",
      "window.sharedRound = replacement;",
      'globalThis["sharedRound"] = replacement;',
      "function later(){sharedRound = replacement;}",
      "({sharedRound} = registry);",
      "for (sharedRound of values) {}",
      "if (flag) { function sharedRound(value) { return 0; } }"
    ]) {
      const result = inspect([helpers, caller, mutation]);
      assert.deepEqual(result.definitions, [], mutation);
      assert.ok(result.audit.omitted.some((item) => item.reason === "runtime_binding_unverified"));
    }
  });

  for (const [label, mutation] of [
    ["simple global alias", "var host=window; host.sharedRound=replacement;"],
    ["global alias chain", "var host=window; var next=host; next.sharedRound=replacement;"],
    ["assigned global alias", "var host; host=window; host.sharedRound=replacement;"],
    ["reassigned global alias", "var host={}; host=window; Object.assign(host,{sharedRound:replacement});"],
    ["top-level this", "this.sharedRound=replacement;"],
    ["Object.assign", "Object.assign(window,{sharedRound:replacement});"],
    ["Object.defineProperty", 'Object.defineProperty(window,"sharedRound",{value:replacement});'],
    ["Object.defineProperties", "Object.defineProperties(window,{sharedRound:{value:replacement}});"],
    ["Reflect.set", 'Reflect.set(globalThis,"sharedRound",replacement);'],
    ["Reflect.defineProperty", 'Reflect.defineProperty(globalThis,"sharedRound",{value:replacement});'],
    ["Reflect.deleteProperty", 'Reflect.deleteProperty(globalThis,"sharedRound");'],
    ["eval", 'eval("sharedRound=replacement");'],
    ["indirect eval", '(0,eval)("sharedRound=replacement");'],
    ["eval alias", 'var evaluate=eval; evaluate("sharedRound=replacement");'],
    ["assigned eval alias", 'var evaluate; evaluate=eval; evaluate("sharedRound=replacement");']
  ]) {
    it(`excludes an overwritten helper through ${label}`, () => {
      const result = inspect([helpers, caller, mutation]);
      assert.deepEqual(result.definitions, []);
      assert.ok(result.audit.omitted.length > 0);
      const evidence = result.audit.omitted.flatMap((item) => item.writeEvidence || []);
      assert.ok(evidence.some((write) => write.sourceRef === result.source.scripts.sources[2].sourceRef));
    });
  }

  it("does not treat an ordinary object write as a global helper override", () => {
    for (const mutation of [
      "var local={}; local.sharedRound=replacement;",
      "Object.assign({}, {sharedRound:replacement});",
      'Object.defineProperty({}, "sharedRound", {value:replacement});'
    ]) assert.deepEqual(names(inspect([helpers, caller, mutation])), ["sharedRound", "roundValue"]);
  });

  it("preserves unrelated global writes and locally shadowed write APIs", () => {
    for (const mutation of [
      'Object.assign(window,{"unrelated":1});',
      "function local(window) { window.sharedRound=replacement; }",
      "function local(Object) { Object.assign(window,{sharedRound:replacement}); }",
      'function local(eval) { eval("sharedRound=replacement"); }'
    ]) assert.deepEqual(names(inspect([helpers, caller, mutation])), ["sharedRound", "roundValue"]);
    assert.deepEqual(names(inspect([
      helpers, caller, "var host=window;",
      "function local(host) { host.sharedRound=replacement; }"
    ])), ["sharedRound", "roundValue"]);
  });

  it("audits unknown keys and uncertain aliases without choosing an implementation", () => {
    for (const mutation of [
      "Object.assign(window, overrides);",
      "Reflect.set(window,key,replacement);",
      "var host=flag?window:{}; host.sharedRound=replacement;",
      "var host=window; host=unknown; host.sharedRound=replacement;"
    ]) {
      const result = inspect([helpers, caller, mutation]);
      assert.deepEqual(result.definitions, []);
      assert.ok(result.audit.omitted.flatMap((item) => item.writeEvidence || []).length > 0);
    }
    assert.deepEqual(inspect([helpers, caller, "var host=window;", "host.sharedRound=replacement;"]).definitions, []);
  });

  it("propagates explicit assignment taint across scripts without contaminating local bindings", () => {
    assert.deepEqual(inspect([
      helpers, caller, "var host;", "host=window;", "host.sharedRound=replacement;"
    ]).definitions, []);
    assert.deepEqual(inspect([
      helpers, caller, "var evaluate;", "evaluate=eval;", 'evaluate("sharedRound=replacement");'
    ]).definitions, []);
    assert.deepEqual(inspect([
      helpers, caller, "function later(){var host;host=window;host.sharedRound=replacement;}"
    ]).definitions, []);
    assert.deepEqual(names(inspect([
      helpers, caller, "var host;host=window;",
      "function local(host){host.sharedRound=replacement;}"
    ])), ["sharedRound", "roundValue"]);
    assert.deepEqual(names(inspect([
      helpers, caller, "var host;host={};host.sharedRound=replacement;"
    ])), ["sharedRound", "roundValue"]);
    assert.deepEqual(names(inspect([
      helpers, caller, "var evaluate;evaluate=eval;",
      'function local(evaluate){evaluate("sharedRound=replacement");}'
    ])), ["sharedRound", "roundValue"]);
  });

  it("fails closed for a dynamic global write or unparseable sibling source", () => {
    const dynamic = inspect([helpers, caller, "window[key] = replacement;"]);
    assert.deepEqual(dynamic.definitions, []);
    assert.equal(dynamic.audit.omitted[0].reason, "dynamic_global_write");
    const invalid = inspect([helpers, caller], {
      mutate(source) {
        source.scripts.sources.push({ sourceRef: "source.form.jsp.invalid", javascript: "function broken(" });
      }
    });
    assert.deepEqual(invalid.definitions, []);
    assert.equal(invalid.audit.omitted[0].reason, "source_parse_unverified");
  });

  it("does not treat expressions, comments or strings as function declarations", () => {
    for (const declaration of [
      "var sharedRound=function(value){return value;};",
      "/* function sharedRound(value){return value;} */",
      'var sample="function sharedRound(value){return value;}";'
    ]) {
      assert.deepEqual(inspect([declaration, caller]).definitions, []);
    }
  });

  it("respects caller and helper parameters that shadow global helper names", () => {
    const shadowed = caller.replace("function(value)", "function(value, sharedRound)");
    assert.deepEqual(inspect([helpers, shadowed]).definitions, []);
    const result = inspect([
      "function sharedRound(roundValue){return roundValue(1);} function roundValue(value){return value;}",
      caller
    ]);
    assert.deepEqual(names(result), ["sharedRound"]);
    assert.ok(result.audit.omitted.some((item) => item.name === "roundValue" && item.reason === "shadowed_or_local_binding"));
  });

  it("does not resolve names mentioned only in strings or member calls", () => {
    assert.deepEqual(inspect([helpers, caller.replace("sharedRound(value)", "object.sharedRound(value)")]).definitions, []);
    assert.deepEqual(inspect([helpers, caller.replace("sharedRound(value)", '"sharedRound(value)"')]).definitions, []);
  });

  it("requires action-owned source evidence before searching sibling scripts", () => {
    const result = inspect([helpers, caller], {
      mutate(source, draft, index) {
        source.scripts.sources = source.scripts.sources.filter((script) =>
          !draft.scripts.actions[index].sourceRefs.includes(script.sourceRef));
      }
    });
    assert.deepEqual(result.definitions, []);
    assert.equal(result.audit.omitted[0].reason, "action_source_missing");
  });

  it("retains helper displayGate without widening action runWhen", () => {
    const result = inspect([
      { html: `<xform:editShow><script>${helpers}</script></xform:editShow>` },
      caller
    ]);
    assert.equal(result.definitions[0].displayGate, "xform:editShow");
    assert.equal(result.action.runWhen, undefined);
    assert.match(result.prompt.system, /not proof of runtime availability/);
  });

  it("preserves full and compact evidence budgets with an explicit omission", () => {
    for (const compact of [false, true]) {
      const result = inspect([
        `function sharedRound(value){var padding="${"x".repeat(11000)}";return roundValue(value);} function roundValue(value){return value;}`,
        caller
      ], { compact });
      assert.deepEqual(result.definitions, []);
      assert.equal(result.audit.maxCharacters, compact ? 5200 : 10000);
      assert.equal(result.audit.usedCharacters, 0);
      assert.ok(result.audit.omitted.some((item) => item.reason === "character_budget"));
    }
  });

  it("retains the existing dependency depth limit", () => {
    const result = inspect([
      "function sharedRound(v){return one(v);} function one(v){return two(v);} function two(v){return three(v);} function three(v){return v;}",
      caller
    ]);
    assert.deepEqual(names(result), ["sharedRound", "one", "two"]);
    assert.ok(result.audit.omitted.some((item) => item.name === "three" && item.reason === "depth_limit"));
  });

  it("rejects a correctly signed v14 checkpoint under the current prompt contract", () => {
    const { source, draft } = inspect([helpers, caller]);
    const options = {
      sourceDraft: source,
      originalDslDraft: draft,
      reviewedDslDraft: draft,
      batchSize: 12,
      maxAttemptsPerAction: 2,
      signingKey: "test-review-helper-context-signing-key-32-bytes",
      reviewer: { provider: "test", promptVersion: "agent-review.scoped-batches.v14", reviewedAt: "2026-10-14T00:00:00Z" }
    };
    const checkpoint = createReviewCheckpoint({ ...options, promptVersion: "agent-review.scoped-batches.v14" });
    assert.equal(validateReviewCheckpoint(checkpoint, { ...options, promptVersion: "agent-review.scoped-batches.v14" }).ok, true);
    assert.equal(AGENT_REVIEW_PROMPT_VERSION, "agent-review.scoped-batches.v17");
    const result = validateReviewCheckpoint(checkpoint, { ...options, promptVersion: AGENT_REVIEW_PROMPT_VERSION });
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics.map((item) => item.code).sort(), [
      "agent.checkpoint.cache_key_mismatch", "agent.checkpoint.contract_mismatch"
    ]);
  });

  it("keeps executable trust gated when the reviewer only accepts the supplied evidence", async () => {
    const result = await runRouteCase("review-helper-context-remains-gated");
    assert.equal(result.review.ok, false);
    assert.equal(result.review.stage, "agent-review.incomplete");
    assert.equal(result.execution, undefined);
    assert.deepEqual(result.transcript, []);
  });
});

function names(result) {
  return result.definitions.map((helper) => helper.name);
}

function inspect(scripts, options = {}) {
  const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const html = scripts.map((script) => typeof script === "string" ? `<script>${script}</script>` : script.html).join("");
  const xml = base.replace(
    /<string>fdDisplayJsp<\/string><string>[^]*?<\/string><\/void>/,
    `<string>fdDisplayJsp</string><string>${escape(html)}</string></void>`
  );
  const directory = mkdtempSync(join(tmpdir(), "review-helper-context-"));
  try {
    const file = join(directory, "helper_SysFormTemplate.xml");
    writeFileSync(file, xml);
    const source = cleanSourceFile(file);
    const draft = draftSourceDraft(source);
    const index = draft.scripts.actions.findIndex((action) => action.event === "onChange" && action.controlId === "fd_amount");
    assert.ok(index >= 0);
    const action = draft.scripts.actions[index];
    const originalRefs = structuredClone(action.sourceRefs);
    options.mutate?.(source, draft, index);
    const prompt = buildAgentReviewPrompt(source, draft, {
      compact: options.compact,
      reviewScope: { actionIndexes: [index], actionIds: [action.id], includeFormTargets: false }
    });
    const summary = prompt.context.dslDraft.scripts.actions[0];
    assert.deepEqual(action.sourceRefs, originalRefs);
    assert.deepEqual(summary.sourceRefs, originalRefs);
    assert.ok(prompt.context.allowedConcretePatchPaths.every((target) => target.startsWith(`/scripts/actions/${index}/`)));
    return {
      source, draft, action, prompt, summary,
      definitions: summary.actionSource?.localHelperDefinitions || [],
      audit: summary.actionSource?.helperDefinitionAudit
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
