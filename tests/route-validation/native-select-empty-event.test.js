import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { checkExecute } from "../../src/dsl/checks.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { runRouteCase } from "./run-route-case.js";

const directory = "tests/fixtures/route-validation/native-select-empty-event/";
const fixture = `${directory}select-empty_SysFormTemplate.xml`;
const xml = readFileSync(fixture, "utf8");
const target = JSON.parse(readFileSync(`${directory}reviewed-functions.json`, "utf8")).onChange;
const raw = target.replace('(value === null ? "" : value)', "value");
const source = cleanSourceFile(fixture);
function patches(draft, fn = target) {
  const action = draft.scripts.actions[0];
  return Object.entries({ function: fn, translationStatus: "mapped",
    functionMappings: [{ source: "static singleSelect declared empty state", target: "native null-only event representation bridge", basis: "semantic-translation", reviewRequired: false }],
    coverage: { status: "translated", nativeRules: action.coverage.nativeRules, residuals: [] }
  }).map(([key, value]) => ({ op: "replace", path: `/scripts/actions/0/${key}`, value,
    sourceRefs: action.sourceRefs, confidence: 0.99, evidence: ["Preserve the source predicate, literal marker writes and native row rules; only null denotes the declared empty state."], rationale: "Fixture-only source-backed bridge." }));
}
function apply(original = source, fn = target) {
  const draft = draftSourceDraft(original);
  return { draft, result: applyEvidenceBackedPatches(draft, patches(draft, fn), { sourceDraft: original, sourceRefs: collectSourceRefs(original) }) };
}
function trusted(original = source, fn = target) {
  const draft = draftSourceDraft(original);
  for (const patch of patches(draft, fn)) draft.scripts.actions[0][patch.path.split("/").at(-1)] = patch.value;
  return createTrustedMigrationDsl(original, draft, { externalAgentReviewed: true });
}
function fromXml(text) {
  const directory = mkdtempSync(join(tmpdir(), "select-empty-"));
  try { const file = join(directory, "empty_SysFormTemplate.xml"); writeFileSync(file, text); return cleanSourceFile(file); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("native select empty-event Route-validation", () => {
  it("retains exact runtime empty-option facts from the source XML", () => {
    const fact = source.form.controls.find(field => field.id === "fd_choice").sourceProps.runtimeSelectEmpty;
    assert.equal(fact.status, "proven");
    assert.equal(fact.showPleaseSelect, true);
    assert.deepEqual(fact.options, [{ label: "Ready", value: "READY" }, { label: "Other", value: "OTHER" }]);
  });
  it("accepts the source-backed null-only bridge while preserving the actual function and native rules", () => {
    const { draft, result } = apply();
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.dslDraft.scripts.actions[0].function, target);
    assert.deepEqual(result.dslDraft.formRules, draft.formRules);
    assert.deepEqual(result.dslDraft.scripts.actions[0].coverage.nativeRules, draft.scripts.actions[0].coverage.nativeRules);
    const dsl = createTrustedMigrationDsl(source, result.dslDraft, { externalAgentReviewed: true });
    assert.equal(checkTrust(source, dsl).ok, true);
    assert.equal(checkExecute(dsl).ok, true);
    assert.equal(buildDryRunPlan(dsl).ok, true);
  });
  it("rejects the original raw callback in both public patch and fixed-source trust", () => {
    assert.equal(apply(source, raw).result.ok, false);
    assert.equal(checkTrust(source, trusted(source, raw)).ok, false);
  });
  for (const [name, edit] of [
    ["false empty option", text => text.replace('showPleaseSelect="true"', 'showPleaseSelect="false"')],
    ["missing empty option", text => text.replace(' showPleaseSelect="true"', "")],
    ["duplicate attribute", text => text.replace('showPleaseSelect="true"', 'showPleaseSelect="true" showPleaseSelect="false"')],
    ["dynamic empty option", text => text.replace('showPleaseSelect="true"', 'showPleaseSelect="${flag}"')],
    ["runtime option conflict", text => text.replace('value="READY"&gt;Ready', 'value="CHANGED"&gt;Ready')],
    ["JSP comment pseudo control", text => text.replace('&lt;xform:select', '&lt;%-- &lt;xform:select').replace('&lt;/xform:select&gt;', '&lt;/xform:select&gt; --%&gt;')],
    ["duplicate binding", text => text.replace('&lt;/xform:select&gt;', '&lt;/xform:select&gt;&lt;xform:select property="extendDataFormInfo.value(fd_choice)" showPleaseSelect="true"/&gt;')]
  ]) it(`rejects ${name} through complete XML intake and public gates`, () => {
    const altered = fromXml(edit(xml));
    assert.equal(apply(altered).result.ok, false);
    assert.equal(checkTrust(altered, trusted(altered)).ok, false);
  });
  for (const [name, edit] of [
    ["nullish comparison", text => text.replace("=== null", "== null")],
    ["undefined expansion", text => text.replace('(value === null ? "" : value)', '(value ?? "")')],
    ["falsy expansion", text => text.replace('(value === null ? "" : value)', '(value || "")')],
    ["string conversion", text => text.replace('(value === null ? "" : value)', 'String(value ?? "")')],
    ["different fallback", text => text.replace('? "" : value', '? "READY" : value')],
    ["different binding", text => text.replace('? "" : value', '? "" : rowNum')],
    ["rebound event", text => text.replace('  if (', '  value="OTHER"; if (')],
    ["extra write", text => text.replace('  if (', '  MKXFORM.setValue("fd_payload","changed"); if (')],
    ["changed predicate", text => text.replace('.indexOf("READY")', '.indexOf("OTHER")')]
  ]) it(`rejects ${name}`, () => assert.equal(apply(source, edit(target)).result.ok, false));
  it("does not let a trusted candidate delete or forge facts, source ownership or the bridge", () => {
    for (const change of [
      dsl => delete dsl.form.fields.find(field => field.id === "fd_choice").sourceProps.runtimeSelectEmpty,
      dsl => dsl.form.fields.find(field => field.id === "fd_choice").sourceProps.runtimeSelectEmpty = { status: "proven", showPleaseSelect: true },
      dsl => dsl.form.fields.find(field => field.id === "fd_choice").type = "text",
      dsl => dsl.scripts.actions[0].controlId = "fd_payload",
      dsl => dsl.scripts.actions = [],
      dsl => dsl.scripts.actions[0].function = raw
    ]) { const dsl = trusted(); change(dsl); assert.equal(checkTrust(source, dsl).ok, false); }
  });
  for (const [name, edit] of [
    ["HTML comment pseudo tag", text => text.replace('&lt;xform:select', '&lt;!-- &lt;xform:select').replace('&lt;/xform:select&gt;', '&lt;/xform:select&gt; --&gt;')],
    ["script-string pseudo tag", text => text.replace('&lt;xform:select', '&lt;script&gt;var fake="&lt;xform:select').replace('&lt;/xform:select&gt;', '&lt;/xform:select&gt;";&lt;/script&gt;')],
    ["textarea pseudo tag", text => text.replace('&lt;xform:select', '&lt;textarea&gt;&lt;xform:select').replace('&lt;/xform:select&gt;', '&lt;/xform:select&gt;&lt;/textarea&gt;')],
    ["conditional render", text => text.replace('&lt;xform:select', '&lt;c:if test="${flag}"&gt;&lt;xform:select').replace('&lt;/xform:select&gt;', '&lt;/xform:select&gt;&lt;/c:if&gt;')],
    ["server control flow", text => text.replace('&lt;xform:select', '&lt;% if (flag) { %&gt;&lt;xform:select').replace('&lt;/xform:select&gt;', '&lt;/xform:select&gt;&lt;% } %&gt;')],
    ["dynamic datasource", text => text.replace('value="READY"&gt;Ready', 'value="${option}"&gt;Ready')],
    ["extra datasource body", text => text.replace('value="READY"&gt;Ready', 'value="READY"&gt;&lt;b&gt;Ready&lt;/b&gt;')],
    ["conflicting runtime identity", text => text.replace('property="extendDataFormInfo.value(fd_choice)"', 'property="extendDataFormInfo.value(fd_choice)" id="fd_other"')],
    ["runtime multiple flag", text => text.replace('showPleaseSelect="true"', 'showPleaseSelect="true" multiple="true"')],
    ["unproved HTML property override", text => text.replace('showPleaseSelect="true"', 'showPleaseSelect="true" htmlElementProperties="multiple"')],
    ["custom inline handler", text => text.replace('showPleaseSelect="true"', 'showPleaseSelect="true" onchange="custom()"')],
    ["conflicting metadata options", text => text.replace('enumValues="Ready|READY;Other|OTHER"', 'enumValues="Changed|CHANGED;Other|OTHER"')],
    ["conflicting metadata default", text => text.replace('enumValues="Ready|READY;Other|OTHER"', 'defaultValue="READY" enumValues="Ready|READY;Other|OTHER"')]
  ]) it(`does not derive an empty choice from ${name}`, () => {
    const altered = fromXml(edit(xml));
    assert.equal(apply(altered).result.ok, false);
    assert.equal(checkTrust(altered, trusted(altered)).ok, false);
  });
  for (const type of ["radio", "checkbox", "multiSelect", "text"]) it(`rejects ${type} source type even if old select facts remain`, () => {
    const changed = structuredClone(source); changed.form.controls.find(field => field.id === "fd_choice").sourceType = type;
    assert.equal(apply(changed).result.ok, false);
  });
  for (const [name, change] of [
    ["same id in detail", form => form.detailTables.push({ id: "fd_detail", columns: [structuredClone(form.controls.find(field => field.id === "fd_choice"))] })],
    ["numeric option", form => form.controls.find(field => field.id === "fd_choice").options[0].value = 1],
    ["object option", form => form.controls.find(field => field.id === "fd_choice").options[0].value = { id: "READY" }]
  ]) it(`rejects ambiguous source domain: ${name}`, () => {
    const changed = structuredClone(source); change(changed.form);
    const draft = draftSourceDraft(source);
    const result = applyEvidenceBackedPatches(draft, patches(draft), { sourceDraft: changed, sourceRefs: collectSourceRefs(changed) });
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(item => item.code === "agent.patch.select_empty_event_unverified"));
  });
  it("rejects a substring domain whose scalar and single-item array predicates differ", () => {
    const altered = fromXml(xml.replaceAll("Ready|READY", "Ready|ALREADY").replace('value="READY"&gt;Ready', 'value="ALREADY"&gt;Ready'));
    const result = apply(altered, target).result;
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(item => item.details?.reason === "source_empty_domain_ambiguous"));
  });
  it("rejects target changes to options, defaults, required or fixed metadata", () => {
    for (const edit of [
      field => field.props.options[0].value = "CHANGED",
      field => delete field.props.defaultValue,
      field => delete field.props.required,
      field => { delete field.sourceProps.metadataId; delete field.sourceProps.metadataKind; delete field.sourceProps.metadataAttributes; },
      field => field.componentId = "xform-select~multi"
    ]) { const dsl = trusted(); edit(dsl.form.fields.find(field => field.id === "fd_choice")); assert.equal(checkTrust(source, dsl).ok, false); }
  });

  it("does not copy credential-bearing option text into runtime facts", () => {
    const altered = fromXml(xml.replace('value="READY"&gt;Ready', 'value="https://demo-user:demo-pass@example.invalid/"&gt;Ready'));
    const fact = altered.form.controls.find(field => field.id === "fd_choice").sourceProps.runtimeSelectEmpty;
    assert.equal(fact.status, "unsupported");
    assert.equal(JSON.stringify(fact).includes("demo-pass"), false);
    assert.equal(apply(altered).result.ok, false);
  });

  it("rebuilds fixed source proof in later review rounds and rejects bridge or action omission", () => {
    const first = apply().result;
    assert.equal(first.ok, true);
    const options = { sourceDraft: source, sourceRefs: collectSourceRefs(source) };
    assert.equal(applyEvidenceBackedPatches(first.dslDraft, [], options).ok, true);
    const common = patches(first.dslDraft)[0];
    assert.equal(applyEvidenceBackedPatches(first.dslDraft, [{ ...common, value: raw }], options).ok, false);
    assert.equal(applyEvidenceBackedPatches(first.dslDraft, [{ ...common, path: "/scripts/actions/0/translationStatus", value: "omitted" }], options).ok, false);
    const removed = structuredClone(first.dslDraft); removed.scripts.actions = [];
    assert.equal(applyEvidenceBackedPatches(removed, [], options).ok, false);
  });

  it("recovers the marker at native null and leaves non-null values unchanged", () => {
    const values = [], context = vm.createContext({ MKXFORM: { setValue: (id, value) => values.push([id, value]) } });
    vm.runInContext(`${target};`, context);
    for (const value of ["READY", null, "READY"]) context.onChange(value);
    assert.deepEqual(values, [["fd_marker", "active"], ["fd_marker", "inactive"], ["fd_marker", "active"]]);
    assert.throws(() => context.onChange(undefined), /indexOf/);
    assert.throws(() => context.onChange(0), /indexOf/);
    assert.throws(() => context.onChange(false), /indexOf/);
    const array = ["READY"]; context.onChange(array); assert.deepEqual(array, ["READY"]);
  });
  it("persists the original adapted function through the registered fake route", async () => {
    const result = await runRouteCase("native-select-empty-event-success");
    assert.equal(result.execution.ok, true); assert.equal(result.execution.readback.ok, true);
    assert.equal(result.dsl.scripts.actions[0].function, target);
  });
});

describe("native select source boundaries and immutable native effects", () => {
  it("retains a real select after raw script comparison and quote text", () => {
    const altered = fromXml(xml.replace('&lt;xform:select', '&lt;script&gt;if (left &lt; right) { var quote = "\'"; }&lt;/script&gt;&lt;xform:select'));
    assert.equal(altered.form.controls.find(field => field.id === "fd_choice").sourceProps.runtimeSelectEmpty.status, "proven");
  });
  for (const [name, edit] of [
    ["view-only control", text => text.replace('&lt;xform:select', '&lt;xform:viewShow&gt;&lt;xform:select').replace('&lt;/xform:select&gt;', '&lt;/xform:select&gt;&lt;/xform:viewShow&gt;')],
    ["unproven edit condition", text => text.replace('&lt;xform:select', '&lt;xform:editShow test="${flag}"&gt;&lt;xform:select').replace('&lt;/xform:select&gt;', '&lt;/xform:select&gt;&lt;/xform:editShow&gt;')],
    ["JSP tag case changed", text => text.replaceAll('xform:select', 'xform:Select')],
    ["JSP attribute case changed", text => text.replace('showPleaseSelect="true"', 'showpleaseselect="true"')],
    ["JSP datasource case changed", text => text.replaceAll('xform:simpleDataSource', 'xform:simpledatasource')]
  ]) it(`does not prove edit-time empty state from ${name}`, () => {
    const altered = fromXml(edit(xml));
    assert.equal(apply(altered).result.ok, false);
    assert.equal(checkTrust(altered, trusted(altered)).ok, false);
  });
  for (const [name, edit] of [
    ["deleted row rule", dsl => { dsl.formRules.linkage = []; }],
    ["deleted native coverage", dsl => { dsl.scripts.actions[0].coverage.nativeRules = []; }],
    ["omitted row rule", dsl => { dsl.formRules.linkage[0].translationStatus = "omitted"; }],
    ["changed row predicate", dsl => { dsl.formRules.linkage[0].when[0].value = "OTHER"; }],
    ["missing else effects", dsl => { dsl.formRules.linkage[0].else = []; }],
    ["changed row views", dsl => { dsl.formRules.linkage[0].meta.runWhen = ["view"]; }],
    ["duplicate rule", dsl => { dsl.formRules.linkage.push(structuredClone(dsl.formRules.linkage[0])); }]
  ]) it(`rejects ${name} at fixed-source trust and subsequent patch review`, () => {
    const { result } = apply(); assert.equal(result.ok, true);
    edit(result.dslDraft);
    const dsl = createTrustedMigrationDsl(source, result.dslDraft, { externalAgentReviewed: true });
    assert.equal(checkTrust(source, dsl).ok, false);
    assert.equal(applyEvidenceBackedPatches(result.dslDraft, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) }).ok, false);
  });
});

describe("native select JSP render scope", () => {
  const guard = '&lt;%if ("readOnly".equals(request.getAttribute("SysForm.base.showStatus"))) {%&gt;';
  it("does not apply a finished pure render guard to a later select", () => {
    const altered = fromXml(xml.replace('&lt;xform:select', guard + '&lt;span&gt;Readonly text&lt;/span&gt;&lt;%}%&gt;&lt;xform:select'));
    assert.equal(apply(altered).result.ok, true);
    assert.equal(checkTrust(altered, trusted(altered)).ok, true);
  });
  it("does not prove a select enclosed by the same render guard", () => {
    const altered = fromXml(xml.replace('&lt;xform:select', guard + '&lt;xform:select').replace('&lt;/xform:select&gt;', '&lt;/xform:select&gt;&lt;%}%&gt;'));
    assert.equal(apply(altered).result.ok, false);
    assert.equal(checkTrust(altered, trusted(altered)).ok, false);
  });
});

describe("HTML non-void raw-text boundaries", () => {
  for (const name of ["textarea", "script", "style", "pre", "code"]) {
    it(`does not treat ${name} slash syntax as a closed opaque container`, () => {
      const altered = fromXml(xml.replace('&lt;xform:select', `&lt;${name}/&gt;&lt;xform:select`).replace('&lt;/xform:select&gt;', `&lt;/xform:select&gt;&lt;/${name}&gt;`));
      assert.notEqual(altered.form.controls.find(field => field.id === "fd_choice").sourceProps.runtimeSelectEmpty.status, "proven");
      assert.equal(apply(altered).result.ok, false);
      assert.equal(checkTrust(altered, trusted(altered)).ok, false);
    });
    it(`retains the real select after the explicit closing ${name} tag`, () => {
      const altered = fromXml(xml.replace('&lt;xform:select', `&lt;${name}/&gt;opaque&lt;/${name}&gt;&lt;xform:select`));
      assert.equal(altered.form.controls.find(field => field.id === "fd_choice").sourceProps.runtimeSelectEmpty.status, "proven");
    });
  }
});
