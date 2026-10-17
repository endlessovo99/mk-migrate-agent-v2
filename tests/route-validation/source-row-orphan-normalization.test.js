import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { normalizeAuditedSourceRowOrphans } from "../../src/translator/source-row-orphan-normalization.js";
import { inlineRadioRowEffectCandidates } from "../../src/translator/inline-radio-row-effects.js";
const fixture = "tests/fixtures/route-validation/source-row-orphan-normalization/route-source-row-orphan_SysFormTemplate.xml";
const hash = text => createHash("sha256").update(text).digest("hex");
function stages() {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  return { source, draft, script: source.scripts.sources[0] };
}

describe("recomputed orphan-row statement normalization", () => {
  it("preserves original evidence, exact offsets, line endings, scope and literal reset flags", () => {
    const { draft, script } = stages(), before = structuredClone(script);
    for (const javascript of [script.javascript, script.javascript.replaceAll("\n", "\r\n")]) {
      const input = { ...script, javascript }, result = normalizeAuditedSourceRowOrphans(input, draft.form);
      assert.ok(result);
      assert.equal(result.javascript.length, javascript.length);
      assert.equal(result.javascript.indexOf("AttachXFormValueChangeEventById"), javascript.indexOf("AttachXFormValueChangeEventById"));
      assert.deepEqual([...result.javascript.matchAll(/\r?\n/g)].map(match => match.index), [...javascript.matchAll(/\r?\n/g)].map(match => match.index));
      assert.equal(result.evidence.sourceJavascriptSha256, hash(javascript));
      assert.equal(result.evidence.normalizedJavascriptSha256, hash(result.javascript));
      assert.equal(result.evidence.layoutMarkersSha256, hash(JSON.stringify(result.evidence.layoutMarkerIds)));
      assert.equal(result.evidence.removedStatements.length, 2);
      assert.deepEqual(result.evidence.removedStatements.map(range => range.flags), [[false, false, false], [true, true, true]]);
      for (const range of result.evidence.removedStatements) {
        assert.equal(hash(javascript.slice(range.start, range.end)), range.sourceSha256);
        assert.equal(result.javascript[range.start], ";");
        assert.match(javascript.slice(range.start, range.end), /common_dom_row_set_show_required_reset/);
        assert.match(result.javascript.slice(range.start + 1, range.end), /^[\s]*$/);
      }
    }
    assert.deepEqual(script, before);
  });

  it("retains exact timer deadlines and all reachable non-orphan effects across branches", () => {
    const { draft, script } = stages(), result = normalizeAuditedSourceRowOrphans(script, draft.form);
    for (const value of ["A", "B", "", "unknown"]) {
      const original = observe(script.javascript, { fd_mode: "A", fd_mirror: "before", fd_reset: ["Y"] });
      const normalized = observe(result.javascript, { fd_mode: "A", fd_mirror: "before", fd_reset: ["Y"] });
      original.load(); normalized.load(); assert.deepEqual(original.trace, normalized.trace);
      original.advance(509); normalized.advance(509); assert.deepEqual(original.trace, normalized.trace);
      original.values.fd_mode = value; normalized.values.fd_mode = value;
      original.advance(510); normalized.advance(510); assert.deepEqual(original.trace, normalized.trace);
      original.change(value); normalized.change(value); assert.deepEqual(original.trace, normalized.trace);
      assert.deepEqual(original.values, normalized.values);
    }
    const actions = inlineRadioRowEffectCandidates({ ...script, javascript: result.javascript }, draft.form);
    assert.equal(actions.length, 2);
    assert.ok(actions.every(action => action.translationStatus === "mapped"));
    assert.equal(actions[0].semanticHints.sourceTimerDelay, 510);
  });

  for (const [name, edit] of [
    ["another literal reference", script => { script.javascript += '\nvar retained = "fd_removed_row";'; }],
    ["dynamic DOM creation", script => { script.javascript += '\ndocument.createElement("input");'; }],
    ["shadowed row helper", script => { script.javascript = script.javascript.replace("function(value,domElement)", "function(value,common_dom_row_set_show_required_reset)"); }],
    ["helper replacement", script => { script.javascript += "\ncommon_dom_row_set_show_required_reset = replacement;"; }],
    ["window helper replacement", script => { script.javascript += "\nwindow.common_dom_row_set_show_required_reset = replacement;"; }],
    ["used return value", script => { script.javascript = script.javascript.replace('common_dom_row_set_show_required_reset("fd_removed_row",false,false,false);', 'consume(common_dom_row_set_show_required_reset("fd_removed_row",false,false,false));'); }],
    ["stale semantic facts", script => { script.semanticFacts.rowMarkers = script.semanticFacts.rowMarkers.filter(fact => fact.rowId !== "fd_removed_row"); }],
    ["non-boolean helper flag", script => { script.javascript = script.javascript.replace('"fd_removed_row",true,true,true)', '"fd_removed_row",true,true,1)'); }],
    ["syntax error", script => { script.javascript += "\n{"; }]
  ]) {
    it("refuses " + name + " rather than trusting an old orphan audit", () => {
      const { draft, script } = stages(), changed = structuredClone(script); edit(changed);
      const result = normalizeAuditedSourceRowOrphans(changed, draft.form);
      assert.equal(result, undefined);
    });
  }

  it("rechecks the current layout and field identities before declaring a row absent", () => {
    const { draft, script } = stages();
    const visible = structuredClone(draft.form);
    visible.layout.mkTree[0].sourceMarkers = [...(visible.layout.mkTree[0].sourceMarkers || []), "fd_removed_row"];
    assert.equal(normalizeAuditedSourceRowOrphans(script, visible), undefined);
    const field = structuredClone(draft.form);
    field.fields.push({ id: "fd_removed_row", type: "text", componentId: "xform-hidden" });
    assert.equal(normalizeAuditedSourceRowOrphans(script, field), undefined);
  });

  it("keeps an unaudited unknown effect and unrecognized literal marker in the work copy", () => {
    const { draft, script } = stages(), changed = structuredClone(script);
    changed.javascript += '\nunknownEffect();common_dom_row_set_show_required_reset("fd_unknown_row",true,true,false);';
    const result = normalizeAuditedSourceRowOrphans(changed, draft.form);
    assert.ok(result);
    assert.match(result.javascript, /unknownEffect/);
    assert.match(result.javascript, /fd_unknown_row/);
    assert.ok(inlineRadioRowEffectCandidates({ ...changed, javascript: result.javascript }, draft.form).some(action => action.translationStatus === "needs_review") ||
      inlineRadioRowEffectCandidates({ ...changed, javascript: result.javascript }, draft.form).length === 0);
  });
});

function observe(text, initial) {
  const values = structuredClone(initial), trace = [], timers = [];
  let load, change;
  const write = (id, value) => { values[id] = value; trace.push(["set", id, value]); };
  const jquery = selector => {
    const id = selector.match(/value\((fd_[\w]+)\)/)?.[1];
    return { val(...args) { if (!args.length) { trace.push(["read", id, values[id]]); return values[id]; } values[id] = args[0]; },
      prop(key, value) { assert.equal(key, "checked"); assert.equal(value, false); write(id, []); } };
  };
  new Function("Com_AddEventListener", "AttachXFormValueChangeEventById", "GetXFormFieldById", "common_dom_row_set_show_required_reset", "$", "setTimeout", "console", "window", text)(
    (_window, _event, fn) => { load = fn; }, (_id, fn) => { change = fn; },
    id => [{ get value() { return values[id] ?? ""; }, set value(value) { write(id, value); } }],
    (id, visible, required) => { if (id !== "fd_removed_row") trace.push(["attr", id, visible ? 5 : 4], ["attr", id, required ? 3 : 6]); },
    jquery, (fn, delay) => { trace.push(["schedule", delay]); timers.push({ fn, delay }); },
    { log: (...args) => trace.push(["log", ...args]) }, {}
  );
  return { values, trace, load: () => load(), change: value => change(value, []),
    advance(now) { for (const timer of timers) if (!timer.done && timer.delay <= now) { timer.done = true; timer.fn(); } } };
}


it("compiles a sole direct-getter load with complete main resets and audited orphan calls", () => {
  const path = "tests/fixtures/route-validation/source-row-orphan-normalization/route-single-reset-orphan_SysFormTemplate.xml";
  const source = cleanSourceFile(path), draft = draftSourceDraft(source);
  assert.equal(draft.scripts.actions.length, 1);
  assert.equal(draft.scripts.actions[0].translationStatus, "mapped");
  assert.ok(draft.scripts.actions[0].semanticHints.auditedOrphanRowNormalization);
  assert.match(draft.scripts.actions[0].function, /MKXFORM\.setValue\("fd_payload_a", ""\)/);
});

it("retains the original Source Draft and proves normalized actions through fake write and readback", async () => {
  const { runAgentReview } = await import("../../src/agent-review/index.js");
  const { createFakeReviewProvider } = await import("./fake-review-provider.js");
  const { FakeNewoaAdapter } = await import("./fake-newoa-adapter.js");
  const { executeDsl } = await import("../../src/executor/execute.js");
  const { buildDryRunPlan } = await import("../../src/executor/dry-run.js");
  const { withNetworkGuard } = await import("./network-guard.js");
  await withNetworkGuard(async () => {
    for (const path of [fixture, "tests/fixtures/route-validation/source-row-orphan-normalization/route-single-reset-orphan_SysFormTemplate.xml"]) {
      const source = cleanSourceFile(path), original = structuredClone(source), draft = draftSourceDraft(source);
      assert.deepEqual(source, original);
      assert.ok(draft.scripts.actions.every(action => action.translationStatus === "mapped"));
      assert.ok(draft.scripts.actions.every(action => action.semanticHints.auditedOrphanRowNormalization));
      const reviewed = await runAgentReview(source, draft, { provider: createFakeReviewProvider("accept") });
      assert.equal(reviewed.ok, true, JSON.stringify(reviewed.report?.diagnostics));
      assert.equal(buildDryRunPlan(reviewed.dsl).ok, true);
      const client = new FakeNewoaAdapter("persist");
      const result = await executeDsl(reviewed.dsl, { client, confirmWrite: true, targetCategoryId: "route-category-id",
        credentials: { username: "fixture", encryptedPassword: "fixture-password" }, now: new Date("2026-10-17T00:00:00.000Z"),
        transferRecordIdFactory: () => "route0000000000000000000000000000000" });
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(result.readback.ok, true);
      assert.equal(client.transcript().at(-1).operation, "add-transfer-record");
    }
  });
});
