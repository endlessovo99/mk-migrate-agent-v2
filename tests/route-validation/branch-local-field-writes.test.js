import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { branchLocalLiteralWrites } from "../../src/translator/branch-local-field-writes.js";
import { checkDraft, checkExecute } from "../../src/dsl/checks.js";
import { checkTrust } from "../../src/dsl/trust.js";
import { inspectDeterministicScriptBranchProof } from "../../src/dsl/deterministic-script-translations.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { executeDsl } from "../../src/executor/execute.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";
import { runtime } from "../helpers/literal-array-row/observe.js";

const fixture = "tests/fixtures/route-validation/branch-local-field-writes/route-branch-local-writes_SysFormTemplate.xml";
const hash = text => createHash("sha256").update(text).digest("hex");
function inputs() { const source = cleanSourceFile(fixture), draft = draftSourceDraft(source); return { source, draft, script: source.scripts.sources[0] }; }

describe("branch-local literal main-field writes Route-validation", () => {
  it("binds exactly the adjacent declaration/write pairs and source ranges in nested branches", () => {
    const { source, draft, script } = inputs(), original = structuredClone(source);
    const evidence = branchLocalLiteralWrites(script, draft.form);
    assert.equal(evidence.sourceJavascriptSha256, hash(script.javascript));
    assert.deepEqual(evidence.pairs.map(pair => [pair.fieldId, pair.value]), [["fd_mirror", "nested-on"], ["fd_mirror", ""]]);
    for (const pair of evidence.pairs) {
      assert.equal(pair.sourceSha256, hash(script.javascript.slice(pair.start, pair.end)));
      assert.match(script.javascript.slice(pair.start, pair.writeStart), /var [hk]=GetXFormFieldById/);
    }
    const action = draft.scripts.actions[0];
    assert.equal(action.translationStatus, "mapped");
    assert.equal(inspectDeterministicScriptBranchProof(action).ok, true);
    assert.deepEqual(action.semanticHints.branchLocalLiteralWrites, evidence);
    assert.match(action.function, /setTimeout/);
    assert.match(action.function, /\}, 510\);/);
    assert.match(action.function, /setValue\("fd_mirror", "nested-on"\)/);
    assert.deepEqual(source, original);
  });

  it("keeps nested branch/write/row order and reads fresh values only when the timer fires", () => {
    const { draft, script } = inputs(), action = draft.scripts.actions[0];
    for (const [mode, gate] of [["A", "YES"], ["A", "NO"], ["B", "YES"], ["", ""]]) {
      const state = { fd_mode: "before", fd_gate: "before", fd_mirror: "unchanged" };
      const original = runtime(script.javascript, draft.form, { state });
      const migrated = runtime(action.function, draft.form, { state, target: true });
      original.handlers[0].fn(); migrated.action();
      assert.deepEqual(original.trace, [["schedule", 510]]);
      assert.deepEqual(migrated.snapshot(), original.snapshot());
      original.values.fd_mode = migrated.values.fd_mode = mode;
      original.values.fd_gate = migrated.values.fd_gate = gate;
      original.timers.shift()(); migrated.timers.shift()();
      assert.deepEqual(migrated.snapshot(), original.snapshot(), `${mode}/${gate}`);
      if (mode === "A") assert.ok(migrated.trace.findIndex(t => t[0] === "write") < migrated.trace.findIndex(t => t[0] === "attribute"));
      else assert.equal(migrated.values.fd_mirror, "unchanged");
    }
  });

  for (const [name, mutate] of [
    ["live handle read", text => text.replace('h.value="nested-on";', 'h.value="nested-on";console.log(h.value);')],
    ["alias", text => text.replace('h.value="nested-on";', 'var alias=h;alias.value="nested-on";')],
    ["escaped handle", text => text.replace('h.value="nested-on";', 'h.value="nested-on";window.saved=h;')],
    ["nonadjacent write", text => text.replace('h.value="nested-on";', 'console.log(mode);h.value="nested-on";')],
    ["duplicate binding", text => text.replace('h.value="nested-on";', 'h.value="nested-on";var h;')],
    ["dynamic value", text => text.replace('h.value="nested-on";', 'h.value=mode;')],
    ["computed value property", text => text.replace('h.value="nested-on";', 'h["value"]="nested-on";')],
    ["shadowed platform getter", text => text + '\nfunction GetXFormFieldById(){return [];}' ],
    ["global platform mutation", text => text + '\nGetXFormFieldById=function(){return [];};'],
    ["window platform mutation", text => text + '\nwindow["SetXFormFieldValueById"]=function(){};']
  ]) it("does not silently project " + name, () => {
    const { source, draft, script } = inputs(), text = mutate(script.javascript);
    assert.notEqual(text, script.javascript);
    const changed = { ...script, javascript: text }, evidence = branchLocalLiteralWrites(changed, draft.form);
    assert.equal(evidence?.pairs.some(pair => pair.value === "nested-on") || false, false);
    source.scripts.sources[0].javascript = text;
    const candidate = draftSourceDraft(source);
    assert.ok(candidate.scripts.actions.some(action => action.translationStatus === "needs_review"), name);
    const gate = checkExecute(candidate);
    assert.equal(gate.ok, false, name);
    assert.ok(gate.diagnostics.some(diagnostic => diagnostic.code === "dsl.scripts.needs_review"), name);
  });

  it("requires unique existing String metadata instead of inventing a missing field", () => {
    const { draft, script } = inputs();
    for (const fields of [
      draft.form.fields.filter(field => field.id !== "fd_mirror"),
      [...draft.form.fields, structuredClone(draft.form.fields.find(field => field.id === "fd_mirror"))],
      draft.form.fields.map(field => field.id === "fd_mirror" ? { ...field, sourceProps: { ...field.sourceProps, metadataAttributes: { type: "Number" } } } : field),
      draft.form.fields.map(field => field.id === "fd_mirror" ? { ...field, sourceProps: { ...field.sourceProps, metadataKind: "element" } } : field)
    ]) assert.equal(branchLocalLiteralWrites(script, { ...draft.form, fields }), undefined);
  });

  it("runs the public XML through trust, dry-run, fake API readback and one recorded receipt", async () => withNetworkGuard(async () => {
    const { source, draft } = inputs();
    assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
    const reviewed = await runAgentReview(source, draft, { provider: createFakeReviewProvider("accept") });
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed.report?.diagnostics));
    assert.equal(checkTrust(source, reviewed.dsl).ok, true);
    assert.equal(buildDryRunPlan(reviewed.dsl).ok, true);
    const client = new FakeNewoaAdapter("persist");
    const report = await executeDsl(reviewed.dsl, { client, confirmWrite: true, targetCategoryId: "route-category-id",
      credentials: { username: "route-user", encryptedPassword: "route-password" },
      transferRecordIdFactory: () => "route0000000000000000000000000000000" });
    assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
    assert.equal(report.readback.ok, true);
    assert.equal(report.transferRecord.status, "recorded");
    assert.equal(client.transcript().filter(call => call.operation === "add-transfer-record").length, 1);
    const forged = structuredClone(reviewed.dsl);
    forged.scripts.actions[0].function = forged.scripts.actions[0].function.replace("nested-on", "forged");
    assert.equal(checkTrust(source, forged).ok, false);
  }));
});
