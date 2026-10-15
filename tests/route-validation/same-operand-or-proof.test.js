import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { buildScriptBranchProvenance, inspectMappedScriptBranchProvenance } from "../../src/dsl/script-branch-provenance.js";
import { checkDraft, checkExecute } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { reviewEventValueAssignment } from "./fake-review-scenarios/event-value-assignment.js";

const fixturePath = "tests/fixtures/route-validation/same-operand-or-proof/same-operand-or-proof_SysFormTemplate.xml";
const functions = JSON.parse(readFileSync(new URL("../fixtures/route-validation/same-operand-or-proof/reviewed-functions.json", import.meta.url), "utf8"));

describe("same-operand OR proof Route-validation", () => {
  it("retains the ordered binary OR tree from XML through patches, trust and dry-run", () => {
    const { source, draft } = scenario();
    assert.equal(checkDraft(draft).ok, true);
    for (const action of draft.scripts.actions) {
      assert.equal(action.branchProvenance.status, "proven");
      const [condition] = action.branchProvenance.conditions;
      assert.equal(condition.kind, "or");
      assert.equal(condition.left.kind, "or");
      assert.equal(condition.right.value, "C");
    }
    const result = reviewed(source, draft);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    const trusted = createTrustedMigrationDsl(source, result.dslDraft, { externalAgentReviewed: true, decisions: [] });
    assert.equal(checkTrust(source, trusted).ok, true, JSON.stringify(checkTrust(source, trusted).diagnostics));
    assert.equal(checkExecute(trusted).ok, true, JSON.stringify(checkExecute(trusted).diagnostics));
    assert.equal(buildDryRunPlan(trusted).ok, true);
  });

  it("preserves source row states and marker writes when triggering and restoring both events", () => {
    const { source } = scenario();
    const text = source.scripts.sources[0].javascript;
    for (const event of ["onLoad", "onChange"]) {
      const original = runtime(text, false);
      const translated = runtime(functions[event], true);
      for (const value of ["", "A", "D", "B", "C", "D", "AB", ""]) {
        original.invoke(event, value);
        translated.invoke(event, value);
        assert.deepEqual(translated.state, original.state, `${event} ${value}`);
      }
    }
  });

  for (const [name, edit] of [
    ["AND substitution", text => text.replaceAll("||", "&&")],
    ["missing leaf", text => text.replace(' || value.indexOf("C") >= 0', "")],
    ["new match value", text => text.replace('indexOf("C")', 'indexOf("D")')],
    ["reordered leaves", text => text.replace('indexOf("A") >= 0 || value.indexOf("B")', 'indexOf("B") >= 0 || value.indexOf("A")')],
    ["regrouped tree", text => text.replace('value.indexOf("A") >= 0 || value.indexOf("B") >= 0 || value.indexOf("C") >= 0', 'value.indexOf("A") >= 0 || (value.indexOf("B") >= 0 || value.indexOf("C") >= 0)')],
    ["different field", text => text.replace('value.indexOf("B")', 'MKXFORM.getValue("fd_payload").indexOf("B")')],
    ["transformed event", text => text.replaceAll('value.indexOf(', 'String(value).indexOf(')],
    ["assignment in condition", text => text.replace('value.indexOf("B")', '(value = "B").indexOf("B")')],
    ["negated branch", text => text.replace('if (value.indexOf("A") >= 0 || value.indexOf("B") >= 0 || value.indexOf("C") >= 0)', 'if (!(value.indexOf("A") >= 0 || value.indexOf("B") >= 0 || value.indexOf("C") >= 0))')],
    ["missing marker else", text => text.replace('MKXFORM.setValue("fd_marker", "");', "")],
    ["extra unrelated setter", text => text.replace('MKXFORM.setValue("fd_marker", "active");', 'MKXFORM.setValue("fd_marker", "active"); MKXFORM.setValue("fd_payload", "unexpected");')],
    ["missing row visibility", text => text.replace('MKXFORM.setFieldAttr("extra_row", 5);', "")],
    ["missing required reset", text => text.replace('MKXFORM.setFieldAttr("extra_row", 6);', "")]
  ]) {
    it(`rejects ${name}`, () => {
      const { source, draft } = scenario();
      const result = reviewed(source, draft, { ...functions, onChange: edit(functions.onChange) });
      assert.equal(result.ok, false, name);
    });
  }

  it("retains source binding and immutable tree checks", () => {
    const { source, draft } = scenario();
    const accepted = reviewed(source, draft);
    assert.equal(accepted.ok, true, JSON.stringify(accepted.diagnostics));
    const trusted = createTrustedMigrationDsl(source, accepted.dslDraft, { externalAgentReviewed: true, decisions: [] });
    trusted.scripts.actions[1].branchProvenance.conditions[0].right.value = "D";
    assert.equal(checkTrust(source, trusted).ok, false);
    const modifiedSource = structuredClone(source);
    modifiedSource.scripts.sources[0].javascript = modifiedSource.scripts.sources[0].javascript.replace('value.indexOf("C")', 'value.indexOf("D")');
    const originalTrusted = createTrustedMigrationDsl(source, accepted.dslDraft, { externalAgentReviewed: true, decisions: [] });
    assert.equal(checkTrust(modifiedSource, originalTrusted).ok, false);
    const stale = structuredClone(originalTrusted);
    stale.scripts.actions[1].branchProvenance = {
      ...stale.scripts.actions[1].branchProvenance,
      status: "unproven", conditions: [], reason: "condition_not_statically_supported"
    };
    assert.equal(checkTrust(source, stale).ok, false);
  });

  for (const event of ["onLoad", "onChange"]) {
    for (const [name, statement] of [
      ["direct setter", 'MKXFORM.setValue("fd_payload", "unexpected");'],
      ["computed setter", 'MKXFORM["setValue"]("fd_payload", "unexpected");'],
      ["method alias", 'var write = MKXFORM.setValue; write("fd_payload", "unexpected");'],
      ["object alias", 'var form = MKXFORM; form.setValue("fd_payload", "unexpected");'],
      ["nested setter", 'function write() { MKXFORM.setValue("fd_payload", "unexpected"); } write();'],
      ["global receiver", 'globalThis.MKXFORM.setValue("fd_payload", "unexpected");'],
      ["setProps value", 'MKXFORM.setProps("fd_payload", { value: "unexpected" });'],
      ["setProps readonly", 'MKXFORM.setProps("fd_payload", { readOnly: true });'],
      ["setProps visibility", 'MKXFORM.setProps("fd_payload", { hidden: true });'],
      ["computed setProps", 'MKXFORM["setProps"]("fd_payload", { value: "unexpected" });'],
      ["setProps method alias", 'var alter = MKXFORM.setProps; alter("fd_payload", { value: "unexpected" });'],
      ["nested setProps", 'function alter() { MKXFORM.setProps("fd_payload", { value: "unexpected" }); } alter();'],
      ["clear value", 'MKXFORM.setValue("fd_payload", "");'],
      ["update control", 'MKXFORM.updateControl("fd_payload", 0, "unexpected");'],
      ["update control style", 'MKXFORM.updateControlStyle("fd_payload", 0, { display: "none" });'],
      ["delete row", 'MKXFORM.deleteRow("fd_payload");'],
      ["unrelated attribute", 'MKXFORM.setFieldAttr("fd_payload", 1);'],
      ["hide unrelated field", 'MKXFORM.setFieldAttr("fd_payload", 4);'],
      ["duplicate row attribute", 'MKXFORM.setFieldAttr("extra_row", 5);']
    ]) {
      it(`rejects ${event} ${name} through the patch boundary`, () => {
        const { source, draft } = scenario();
        const modified = functions[event].replace('MKXFORM.setFieldAttr("extra_row", 5);', `MKXFORM.setFieldAttr("extra_row", 5); ${statement}`);
        assert.equal(reviewed(source, draft, { ...functions, [event]: modified }).ok, false);
      });
    }
  }

  it("allows the exact assignment-only OR while rejecting unrelated property and row mutations", () => {
    const { source } = scenario();
    const script = source.scripts.sources[0];
    script.javascript = script.javascript.slice(script.javascript.indexOf("AttachXFormValueChangeEventById"))
      .replace(/\s*common_dom_row_set_show_required_reset\([^\n]+\);/g, "");
    const draft = draftSourceDraft(source);
    const exact = functions.onChange.replace(/\s*MKXFORM\.setFieldAttr\([^\n]+\);/g, "");
    assert.equal(draft.scripts.actions.length, 1);
    assert.equal(reviewed(source, draft, { onChange: exact }).ok, true);
    for (const statement of [
      'MKXFORM.setFieldAttr("extra_row", 4);',
      'MKXFORM["setFieldAttr"]("extra_row", 4);',
      'MKXFORM.setFieldAttr("fd_payload", 1);',
      'var change = MKXFORM.setFieldAttr; change("fd_payload", 1);',
      'MKXFORM.setProps("fd_payload", { value: "unexpected" });',
      'MKXFORM.updateControl("fd_payload", 0, "unexpected");'
    ]) {
      const changed = exact.replace('MKXFORM.setValue("fd_marker", "active");', `MKXFORM.setValue("fd_marker", "active"); ${statement}`);
      assert.equal(reviewed(source, draft, { onChange: changed }).ok, false, statement);
    }
  });

  for (const [name, edit] of [
    ["duplicate same-target write", text => text.replace('MKXFORM.setValue("fd_marker", "active");', 'MKXFORM.setValue("fd_marker", "active"); MKXFORM.setValue("fd_marker", "active");')],
    ["write outside guard", text => text.replace('MKXFORM.setValue("fd_marker", "active");', "").replace('function onChange(value) {', 'function onChange(value) { MKXFORM.setValue("fd_marker", "active");')],
    ["swapped marker branches", text => text.replace('MKXFORM.setValue("fd_marker", "active");', 'MKXFORM.setValue("fd_marker", "SWAP");').replace('MKXFORM.setValue("fd_marker", "");', 'MKXFORM.setValue("fd_marker", "active");').replace('"SWAP"', '""')]
  ]) {
    it(`rejects ${name} through the patch boundary`, () => {
      const { source, draft } = scenario();
      assert.equal(reviewed(source, draft, { ...functions, onChange: edit(functions.onChange) }).ok, false);
    });
  }

  it("keeps source reset=true outside this proof extension", () => {
    const { source } = scenario();
    source.scripts.sources[0].javascript = source.scripts.sources[0].javascript.replace('"extra_row", true, true, false', '"extra_row", true, true, true');
    const result = reviewed(source, draftSourceDraft(source));
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some(d => d.code === "agent.patch.row_marker_reset_untranslated"), true, JSON.stringify(result.diagnostics));
  });

  for (const event of ["onLoad", "onChange"]) {
    for (const statement of [
      "return;", 'throw "unexpected";', "for (;;) {}", "while (true) {}",
      'try { throw "x"; } catch (error) { return; }',
      'switch (1) { case 1: return; }', "skip: { break skip; }",
      "for (;;) { continue; }", "do {} while (true);", "var ignored = null.value;"
    ]) {
      it(`rejects ${event} unproved control flow ${statement}`, () => {
        const { source, draft } = scenario();
        const changed = functions[event].replace(" {", ` { ${statement}`);
        assert.equal(reviewed(source, draft, { ...functions, [event]: changed }).ok, false);
      });
    }
    for (const prefix of ["function*", "async function", "async function*"]) {
      it(`rejects ${event} ${prefix} execution kind`, () => {
        const { source, draft } = scenario();
        const changed = functions[event].replace("function", prefix);
        assert.equal(reviewed(source, draft, { ...functions, [event]: changed }).ok, false);
      });
    }
    it(`rejects ${event} an unproved parameter initializer`, () => {
      const { source, draft } = scenario();
      const changed = functions[event].replace(
        event === "onLoad" ? "onLoad()" : "onChange(value)",
        event === "onLoad" ? "onLoad(unused = null.value)" : "onChange(value, unused = null.value)"
      );
      assert.equal(reviewed(source, draft, { ...functions, [event]: changed }).ok, false);
    });
  }

  it("rejects an unproved source early exit instead of inventing reachable effects", () => {
    const { source } = scenario();
    source.scripts.sources[0].javascript = source.scripts.sources[0].javascript.replace(
      'function (value) {', 'function (value) { return;'
    );
    assert.equal(reviewed(source, draftSourceDraft(source)).ok, false);
  });

  it("rejects an unproved source declaration initializer", () => {
    const { source } = scenario();
    source.scripts.sources[0].javascript = source.scripts.sources[0].javascript.replace(
      'function (value) {', 'function (value) { var ignored = null.value;'
    );
    assert.equal(reviewed(source, draftSourceDraft(source)).ok, false);
  });

  for (const statement of [
    'audit();', 'window.sourceFlag = "changed";', 'sourceFlag = "changed";',
    'document.getElementById("fd_payload").innerHTML = "changed";',
    'document.getElementById("fd_payload").style.display = "none";',
    '$("#fd_payload").hide();', '$("#fd_payload").val("changed");',
    'SetXFormFieldValueById("fd_payload", "changed");',
    'console.log(audit());', 'console.log(window.sourceFlag = "changed");'
  ]) {
    it(`rejects omission of unproved source effect ${statement}`, () => {
      const { source } = scenario();
      source.scripts.sources[0].javascript = source.scripts.sources[0].javascript.replace(
        'function (value) {', `function (value) { ${statement}`
      );
      const result = reviewed(source, draftSourceDraft(source));
      assert.equal(result.ok, false, statement);
    });
  }

  it("allows only cataloged debug-only console output with pure arguments beside proved source effects", () => {
    const { source } = scenario();
    source.scripts.sources[0].javascript = source.scripts.sources[0].javascript.replace(
      'function (value) {', 'function (value) { console.log("Mode", value); console.warn("Diagnostic");'
    );
    const result = reviewed(source, draftSourceDraft(source));
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  });

  it("does not omit an additional recognized source field assignment", () => {
    const { source } = scenario();
    source.scripts.sources[0].javascript = source.scripts.sources[0].javascript.replace(
      'var marker = GetXFormFieldById("fd_marker")[0];',
      'var marker = GetXFormFieldById("fd_marker")[0]; var extra = GetXFormFieldById("fd_payload")[0];'
    ).replace('marker.value = "active";', 'marker.value = "active"; extra.value = "changed";');
    assert.equal(reviewed(source, draftSourceDraft(source)).ok, false);
  });

  it("retains the existing typed checkbox-clear proof beside an OR row branch", () => {
    const source = cleanSourceFile("tests/fixtures/route-validation/event-value-assignment/event-prefix_SysFormTemplate.xml");
    source.scripts.sources[0].javascript = source.scripts.sources[0].javascript.replace(
      'value.indexOf("A")>=0', 'value.indexOf("A")>=0||value.indexOf("B")>=0'
    );
    const draft = draftSourceDraft(source);
    const response = reviewEventValueAssignment({ dslDraft: draft });
    const apply = patches => applyEvidenceBackedPatches(draft, patches, { sourceRefs: collectSourceRefs(source), sourceDraft: source });
    assert.equal(apply(response.patches).ok, true, JSON.stringify(apply(response.patches).diagnostics));
    for (const replacement of ["", 'MKXFORM.setValue("fd_clear", "");', 'MKXFORM.setValue("fd_clear", []); MKXFORM.setValue("fd_clear", []);']) {
      const patches = response.patches.map(patch => patch.path.endsWith("/function")
        ? { ...patch, value: patch.value.replace('MKXFORM.setValue("fd_clear", []);', replacement) } : patch);
      assert.equal(apply(patches).ok, false);
    }
  });

  it("keeps delayed source scheduling unresolved despite equal eventual row states", () => {
    const { source } = scenario();
    source.scripts.sources[0].javascript = source.scripts.sources[0].javascript
      .replace('function () {', 'function () { setTimeout(function () {')
      .replace('\n});\nAttachXFormValueChangeEventById', '\n}, 510);\n});\nAttachXFormValueChangeEventById');
    const draft = draftSourceDraft(source);
    assert.equal(draft.scripts.actions[0].branchProvenance.status, "proven");
    const result = reviewed(source, draft);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some(d => d.details?.reason === "source_or_scheduling_unproven"), true, JSON.stringify(result.diagnostics));
    assert.equal(draft.scripts.actions[0].coverage.residuals.some(r => r.code === "script.residual.window_load_listener"), true);
  });

  for (const expression of [
    'value == "A" || other == "B"',
    'value == "A" || value++ == 2',
    'value == "A" || getValue() == "B"',
    'value == "A" || (value == "B" && value == "C")',
    'value == "A" || !(value == "B")',
    Array.from({ length: 9 }, (_, i) => `value == "${i}"`).join(" || ")
  ]) {
    it(`fails closed for unsupported source ${expression.slice(0, 60)}`, () => {
      const proof = buildScriptBranchProvenance({ event: "onChange", source: `function onChange(value) { var other = MKXFORM.getValue("fd_other"); if (${expression}) {} }` });
      assert.equal(proof.status, "unproven");
    });
  }

  it("does not accept binding writes or shadowed event parameters inside OR", () => {
    for (const source of [
      'function onChange(value) { value = "A"; if (value == "A" || value == "B") {} }',
      'function onChange(value) { { let value = "A"; if (value == "A" || value == "B") {} } }'
    ]) assert.equal(buildScriptBranchProvenance({ event: "onChange", source }).status, "unproven");
  });

  it("keeps leaf coercion predicates and transforms in compound comparison", () => {
    const source = 'function onChange(value) { if (value == "A" || value == "B") {} }';
    const branchProvenance = buildScriptBranchProvenance({ event: "onChange", source });
    assert.equal(branchProvenance.status, "proven");
    for (const functionText of [source.replaceAll(" == ", " === "), source.replaceAll("value ==", "String(value) ==")]) {
      assert.equal(inspectMappedScriptBranchProvenance({ event: "onChange", translationStatus: "mapped", function: functionText, branchProvenance }).ok, false);
    }
  });
});

function scenario() {
  const source = cleanSourceFile(fixturePath);
  return { source, draft: draftSourceDraft(source) };
}

function reviewed(source, draft, mapped = functions) {
  const patches = draft.scripts.actions.flatMap((action, index) => Object.entries({
    function: mapped[action.event],
    translationStatus: "mapped",
    functionMappings: [{ source: "source OR row and assignment branches", target: "MKXFORM field APIs", basis: "semantic-translation", reviewRequired: false }],
    coverage: { status: "translated", nativeRules: [], residuals: [] }
  }).map(([property, value]) => ({
    op: "replace", path: `/scripts/actions/${index}/${property}`, value,
    sourceRefs: action.sourceRefs, confidence: 0.99,
    evidence: ["Preserve the ordered source condition tree, row states and marker writes."],
    rationale: "Fixture review validated by unchanged semantic gates."
  })));
  return applyEvidenceBackedPatches(draft, patches, { sourceRefs: collectSourceRefs(source), sourceDraft: source });
}

function runtime(text, target) {
  const state = { visible: true, required: true, marker: "retained" };
  let current;
  const listeners = {};
  const marker = { get value() { return state.marker; }, set value(value) { state.marker = value; } };
  const context = vm.createContext({
    window: {},
    Com_AddEventListener(_window, _event, callback) { listeners.onLoad = callback; },
    AttachXFormValueChangeEventById(_id, callback) { listeners.onChange = callback; },
    $() { return { val: () => current }; },
    GetXFormFieldById() { return [marker]; },
    common_dom_row_set_show_required_reset(_id, visible, required, reset) {
      assert.equal(reset, false); state.visible = visible; state.required = required;
    },
    MKXFORM: {
      getValue() { return current; },
      setValue(_id, value) { state.marker = value; },
      setFieldAttr(_id, value) {
        if (value === 4) state.visible = false;
        if (value === 5) state.visible = true;
        if (value === 6) state.required = false;
        if (value === 3) state.required = true;
      }
    }
  });
  vm.runInContext(text, context, { timeout: 1000 });
  return { state, invoke(event, value) { current = value; (target ? context[event] : listeners[event])(value); } };
}
