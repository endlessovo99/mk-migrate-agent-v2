import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { validateRowMarkerBranchSemantics } from "../../src/agent-review/script-semantic-closure.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { checkExecute } from "../../src/dsl/checks.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { runRouteCase } from "./run-route-case.js";
import { reviewEventValueAssignment } from "./fake-review-scenarios/event-value-assignment.js";

const directory = "tests/fixtures/route-validation/row-marker-proof/";
const functions = JSON.parse(readFileSync(`${directory}reviewed-functions.json`, "utf8"));
const timedSource = cleanSourceFile(`${directory}timed-getter_SysFormTemplate.xml`);
const atomicSource = cleanSourceFile(`${directory}synchronous-existing-getter-contract_SysFormTemplate.xml`);
const sourceText = source => source.scripts.sources[0].javascript;
const sourceFunction = text => `function onLoad(){\n// Source JSP JavaScript:\n${text.split("\n").map(line => `// ${line}`).join("\n")}\n}`;
const timed = functions["timed-indexed-main-select"];
const atomic = functions["existing-atomic-if"];
const ternary = functions["existing-atomic-boolean-alias-ternary"];
const prelude = 'MKXFORM.setFieldAttr("fd_details_row",4);MKXFORM.setFieldAttr("fd_details_row",6);';

function prove(source, target, overrides = {}) {
  return validateRowMarkerBranchSemantics({
    sourceFunction: sourceFunction(sourceText(source)), reviewedFunction: target,
    resolvedMarkers: ["fd_details_row"], primaryMarkerByAlias: new Map(),
    sourceControls: source.form.controls, sourceForm: source.form,
    sourceScripts: source.scripts, sourceRefs: [source.scripts.sources[0].sourceRef],
    targetFields: draftSourceDraft(source).form.fields, ...overrides
  });
}
function changedSource(source, edit) {
  const result = structuredClone(source);
  result.scripts.sources[0].javascript = edit(sourceText(result));
  return result;
}
function apply(source, target) {
  const draft = draftSourceDraft(source);
  const action = draft.scripts.actions[0];
  const values = { function: target, translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{ source: "complete ordered source reads and effects", target: "MKXFORM row attributes", basis: "semantic-translation", reviewRequired: false }] };
  const patches = Object.entries(values).map(([key, value]) => ({ op: "replace", path: `/scripts/actions/0/${key}`, value,
    sourceRefs: action.sourceRefs, evidence: ["Preserve the original schedule, reads and every row effect in order."],
    rationale: "Fixture semantic review", confidence: 0.99 }));
  return { draft, result: applyEvidenceBackedPatches(draft, patches, { sourceDraft: source, sourceRefs: collectSourceRefs(source) }) };
}

const targetMutations = [
  ["value write", 'MKXFORM.setValue("fd_payload","unexpected");'],
  ["props value", 'MKXFORM.setProps("fd_payload",{value:"unexpected"});'],
  ["props readonly", 'MKXFORM.setProps("fd_payload",{readOnly:true});'],
  ["computed write", 'MKXFORM["setValue"]("fd_payload","unexpected");'],
  ["method alias", 'var write=MKXFORM.setValue;write("fd_payload","unexpected");'],
  ["other row", 'MKXFORM.setFieldAttr("fd_unrelated",4);'],
  ["clear", 'MKXFORM.clearValue("fd_payload");'],
  ["update", 'MKXFORM.updateControl("fd_payload",{});'],
  ["return", "return;"], ["throw", 'throw "unexpected";'], ["loop", "for(;;){}"]
];

describe("complete ordered row-marker proof Route-validation", () => {
  for (const [name, source, target] of [["typed timed select", timedSource, timed], ["atomic if", atomicSource, atomic]]) {
    it(`accepts ${name} through apply, trust, execute check and dry-run`, () => {
      const { result } = apply(source, target);
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      const trusted = createTrustedMigrationDsl(source, result.dslDraft, { externalAgentReviewed: true, decisions: [] });
      assert.equal(checkTrust(source, trusted).ok, true);
      assert.equal(checkExecute(trusted).ok, true);
      assert.equal(buildDryRunPlan(trusted).ok, true);
    });
  }
  for (const [label, prefix] of targetMutations) {
    it(`rejects atomic target ${label} through the public patch gate`, () => {
      const target = atomic.replace("function onLoad(){", `function onLoad(){${prefix}`);
      assert.equal(apply(atomicSource, target).result.ok, false);
    });
  }
  for (const [name, replacement] of [["async", "async function onLoad(){"], ["generator", "function* onLoad(){"]]) {
    it(`rejects atomic ${name}`, () => assert.equal(prove(atomicSource, atomic.replace("function onLoad(){", replacement)).ok, false));
  }
  for (const [label, prefix] of [["audit", "audit();"], ["global write", 'window.flag="changed";'], ["DOM write", 'document.body.textContent="changed";']]) {
    it(`rejects omitted source ${label}`, () => assert.equal(apply(changedSource(atomicSource, text => text.replace("function(){", `function(){${prefix}`)), atomic).result.ok, false));
  }
  it("rejects a ternary that omits the source prelude", () => assert.equal(apply(atomicSource, ternary).result.ok, false));
  it("accepts a ternary preserving the source prelude and read phase", () => assert.equal(apply(atomicSource, ternary.replace("function onLoad(){", `function onLoad(){${prelude}`)).result.ok, true));
  it("accepts a ternary when neither side has a prelude", () => {
    const source = changedSource(atomicSource, text => text.replace('common_dom_row_set_show_required_reset("fd_details_row",false,false,false);', ""));
    assert.equal(apply(source, ternary).result.ok, true);
  });
  for (const [label, edit] of [
    ["early read", text => text.replace('var current=MKXFORM.getValue("fd_choice");', "").replace("function onLoad(){", 'function onLoad(){var current=MKXFORM.getValue("fd_choice");')],
    ["duplicate effect", text => text.replace('MKXFORM.setFieldAttr("fd_details_row",5);', 'MKXFORM.setFieldAttr("fd_details_row",5);MKXFORM.setFieldAttr("fd_details_row",5);')],
    ["swapped effects", text => text.replace('MKXFORM.setFieldAttr("fd_details_row",5);MKXFORM.setFieldAttr("fd_details_row",3);', 'MKXFORM.setFieldAttr("fd_details_row",3);MKXFORM.setFieldAttr("fd_details_row",5);')]
  ]) it(`rejects ${label}`, () => { const target = edit(atomic); assert.notEqual(target, atomic); assert.equal(apply(atomicSource, target).result.ok, false); });

  for (const [label, edit] of [
    ["shadowed getter", text => text.replace("var current=", 'var GetXFormFieldValueById=function(){return ["YES"]};var current=')],
    ["dynamic id", text => text.replace('var current=GetXFormFieldValueById("fd_choice")', 'var id="fd_choice";var current=GetXFormFieldValueById(id)')],
    ["index one", text => text.replace("[0]", "[1]")],
    ["no index", text => text.replace("[0]", "")],
    ["detail id", text => text.replaceAll('"fd_choice"', '"detail.fd_choice"')],
    ["extra effect", text => text.replace("var current=", "audit();var current=")],
    ["reset", text => text.replace("false,false,false", "false,false,true")]
  ]) it(`rejects timed source ${label}`, () => assert.equal(apply(changedSource(timedSource, edit), timed).result.ok, false));
  for (const [label, edit] of [
    ["early read", text => text.replace("function onLoad(){", 'function onLoad(){var early=MKXFORM.getValue("fd_choice");')],
    ["changed delay", text => text.replace("},510);", "},0);")],
    ["extra effect", text => text.replace("setTimeout(function(){", 'setTimeout(function(){MKXFORM.setProps("fd_payload",{value:"changed"});')],
    ["target string index", text => text.replace('MKXFORM.getValue("fd_choice")', 'MKXFORM.getValue("fd_choice")[0]')]
  ]) it(`rejects timed target ${label}`, () => assert.equal(apply(timedSource, edit(timed)).result.ok, false));

  for (const kind of ["checkbox", "multiSelect", "text", "radio"]) it(`rejects getter[0] on ${kind}`, () => {
    const source = structuredClone(timedSource); source.form.controls[0].sourceType = kind;
    assert.equal(prove(source, timed).ok, false);
  });
  for (const [label, edit] of [
    ["duplicate source", form => form.controls.push(structuredClone(form.controls[0]))],
    ["missing source type", form => delete form.controls[0].sourceType],
    ["numeric options", form => form.controls[0].options = [{ label: "One", value: 1 }]],
    ["object options", form => form.controls[0].options = [{ label: "One", value: { id: 1 } }]],
    ["conflicting designer id", form => form.controls[0].sourceProps.designerId = "fd_other"],
    ["conflicting metadata id", form => form.controls[0].sourceProps.metadataId = "fd_other"],
    ["detail duplicate", form => form.detailTables.push({ id: "fd_detail", columns: [structuredClone(form.controls[0])] })],
    ["duplicate sourceRef", form => form.dataFields.push({ id: "fd_other", sourceRef: form.controls[0].sourceRef })]
  ]) it(`rejects timed ${label}`, () => { const source = structuredClone(timedSource); edit(source.form); assert.equal(prove(source, timed).ok, false); });
  it("does not let target type/options/sourceRef create source proof", () => {
    for (const edit of [fields => fields[0].type = "radio", fields => fields[0].props.options[0].value = "changed", fields => fields[0].sourceRef = "other"]) {
      const fields = draftSourceDraft(timedSource).form.fields; edit(fields);
      assert.equal(prove(timedSource, timed, { targetFields: fields }).ok, false);
    }
  });
  for (const [label, javascript] of [
    ["declaration", 'function GetXFormFieldValueById(){return ["NO"]}'],
    ["direct assignment", 'GetXFormFieldValueById=function(){return ["NO"]};'],
    ["global property", 'window.GetXFormFieldValueById=function(){return ["NO"]};'],
    ["global alias", 'var host;host=window;host.GetXFormFieldValueById=function(){return ["NO"]};'],
    ["assign", 'Object.assign(window,{GetXFormFieldValueById:function(){return ["NO"]}});'],
    ["defineProperty", 'Object.defineProperty(window,"GetXFormFieldValueById",{value:function(){return ["NO"]}});'],
    ["eval", 'eval("GetXFormFieldValueById=custom");']
  ]) it(`rejects sibling getter ${label} from fixed SourceDraft`, () => {
    const source = structuredClone(timedSource); source.scripts.sources.push({ sourceRef: "source.form.jsp.sibling", javascript });
    assert.equal(prove(source, timed).ok, false);
    assert.equal(apply(source, timed).result.ok, false);
  });
  it("keeps unrelated object properties and locally shadowed names outside the getter audit", () => {
    const source = structuredClone(timedSource);
    source.scripts.sources.push({ sourceRef: "source.form.jsp.sibling", javascript: 'var ordinary={};ordinary.GetXFormFieldValueById=1;function isolated(){var window={};window.GetXFormFieldValueById=2;}' });
    assert.equal(prove(source, timed).ok, true);
  });

  it("accepts complete Designer-only String select evidence through the XML and public gates", () => {
    const source = cleanSourceFile(`${directory}designer-only-getter_SysFormTemplate.xml`);
    assert.equal(source.form.controls[0].sourceProps.metadataId, undefined);
    const { result } = apply(source, timed);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(checkTrust(source, createTrustedMigrationDsl(source, result.dslDraft, { externalAgentReviewed: true })).ok, true);
  });
  for (const [name, metadata] of [
    ["id only", { metadataId: "fd_choice" }], ["kind only", { metadataKind: "simple" }],
    ["attributes only", { metadataAttributes: { name: "fd_choice", kind: "simple", type: "String" } }],
    ["null id", { metadataId: null }], ["empty attributes", { metadataAttributes: {} }],
    ["conflicting type", { metadataId: "fd_choice", metadataKind: "simple", metadataAttributes: { name: "fd_choice", kind: "simple", type: "Number" } }]
  ]) it(`rejects partial or conflicting fixed metadata: ${name}`, () => {
    const source = cleanSourceFile(`${directory}designer-only-getter_SysFormTemplate.xml`);
    Object.assign(source.form.controls[0].sourceProps, metadata);
    assert.equal(apply(source, timed).result.ok, false);
  });
  it("cannot repair a fixed metadata conflict by deleting the candidate metadata", () => {
    const source = structuredClone(timedSource);
    source.form.controls[0].sourceProps.metadataAttributes.type = "Number";
    const fields = draftSourceDraft(source).form.fields;
    for (const key of ["metadataId", "metadataKind", "metadataAttributes"]) delete fields[0].sourceProps[key];
    assert.equal(prove(source, timed, { targetFields: fields }).ok, false);
  });
  it("retains reads inside evidenced assignment effects and rejects an early cached replacement", () => {
    const source = changedSource(atomicSource, text => text.replace("var current=", 'var copy=GetXFormFieldById("fd_payload")[0];copy.value=GetXFormFieldById("fd_payload")[0].value;var current='));
    const write = 'MKXFORM.setValue("fd_payload",MKXFORM.getValue("fd_payload"));';
    const target = atomic.replace("var current=", `${write}var current=`);
    assert.equal(prove(source, target).ok, true);
    const early = target.replace("function onLoad(){", 'function onLoad(){var cached=MKXFORM.getValue("fd_payload");').replace(write, 'MKXFORM.setValue("fd_payload",cached);');
    assert.equal(prove(source, early).ok, false);
  });

  for (const [label, javascript] of [
    ["array container", 'var host=[window][0];host.GetXFormFieldValueById=function(){return ["NO"]};'],
    ["object container", 'var holder={host:window};holder.host.GetXFormFieldValueById=function(){return ["NO"]};'],
    ["destructure", 'var {host}={host:window};host.GetXFormFieldValueById=function(){return ["NO"]};'],
    ["Reflect apply", 'Reflect.apply(Object.defineProperty,Object,[window,"GetXFormFieldValueById",{value:function(){return ["NO"]}}]);']
  ]) it(`rejects unconsumed getter global escape through ${label}`, () => {
    const source = structuredClone(timedSource);
    source.scripts.sources.push({ sourceRef: "source.form.jsp.escape", javascript });
    assert.equal(apply(source, timed).result.ok, false);
  });
  it("allows ordinary containers and locally shadowed global names", () => {
    const source = structuredClone(timedSource);
    source.scripts.sources.push({ sourceRef: "source.form.jsp.ordinary", javascript: 'var ordinary={value:1};var holder={host:ordinary};var local=[ordinary];function isolated(){var window={value:1};return window.value;}' });
    assert.equal(apply(source, timed).result.ok, true);
  });

  const nullableSource = cleanSourceFile(`${directory}nullable-text_SysFormTemplate.xml`);
  const nullableTarget = atomic.replace('MKXFORM.getValue("fd_choice")', 'String(MKXFORM.getValue("fd_choice") ?? "")')
    .replace('current==="YES"', 'current.indexOf("YES")>=0');
  it("retains one nullable text read after the original prelude through public trust", () => {
    const { result } = apply(nullableSource, nullableTarget);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(checkTrust(nullableSource, createTrustedMigrationDsl(nullableSource, result.dslDraft, { externalAgentReviewed: true })).ok, true);
  });
  for (const [label, edit] of [
    ["dynamic fallback", text => text.replace('?? ""', '?? fallback')],
    ["second read", text => text.replace('?? ""', '?? MKXFORM.getValue("fd_payload")')],
    ["fallback write", text => text.replace('?? ""', '?? MKXFORM.setValue("fd_payload", "changed")')],
    ["nonempty fallback", text => text.replace('?? ""', '?? "YES"')],
    ["missing empty conversion", text => text.replace('String(MKXFORM.getValue("fd_choice") ?? "")', 'MKXFORM.getValue("fd_choice")')],
    ["early cached read", text => text.replace('function onLoad(){', 'function onLoad(){var cached=MKXFORM.getValue("fd_choice");').replace('String(MKXFORM.getValue("fd_choice") ?? "")', 'String(cached ?? "")')]
  ]) it(`rejects nullable ${label}`, () => assert.equal(apply(nullableSource, edit(nullableTarget)).result.ok, false));

  it("retains the proven paired checkbox clear as ordered effects beside OR", () => {
    const source = cleanSourceFile("tests/fixtures/route-validation/event-value-assignment/event-prefix_SysFormTemplate.xml");
    source.scripts.sources[0].javascript = source.scripts.sources[0].javascript.replace('value.indexOf("A")>=0', 'value.indexOf("A")>=0||value.indexOf("B")>=0');
    const draft = draftSourceDraft(source), response = reviewEventValueAssignment({ dslDraft: draft });
    const review = patches => applyEvidenceBackedPatches(draft, patches, { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
    assert.equal(review(response.patches).ok, true, JSON.stringify(review(response.patches).diagnostics));
    for (const replacement of ["", 'MKXFORM.setValue("fd_clear", "");', 'MKXFORM.setValue("fd_clear", []);MKXFORM.setValue("fd_clear", []);']) {
      const patches = response.patches.map(patch => patch.path.endsWith("/function") ? { ...patch, value: patch.value.replace('MKXFORM.setValue("fd_clear", []);', replacement) } : patch);
      assert.equal(review(patches).ok, false);
    }
  });

  for (const [label, javascript] of [
    ["arbitrary global member", 'var host=window.unlistedAlias;host.GetXFormFieldValueById=function(){return ["NO"]};'],
    ["computed global member", 'var host=window["arbitraryAlias"];host.GetXFormFieldValueById=function(){return ["NO"]};'],
    ["global member chain", 'var host=window.anything.deep;host.GetXFormFieldValueById=function(){return ["NO"]};'],
    ["platform wrapper result", 'var host=$(window)[0];host.GetXFormFieldValueById=function(){return ["NO"]};'],
    ["Object API return", 'var host=Object.assign(window,{});host.GetXFormFieldValueById=function(){return ["NO"]};'],
    ["descriptor API return", 'var host=Object.defineProperty(window,"ordinary",{value:1});host.GetXFormFieldValueById=function(){return ["NO"]};'],
    ["nested alias result", 'var host;var escaped=(host=window);escaped.GetXFormFieldValueById=function(){return ["NO"]};'],
    ["unknown parameter receiver", 'function mutate(host){host.GetXFormFieldValueById=function(){return ["NO"]};}'],
    ["shadowed unknown parameter", 'function isolated(window){window.GetXFormFieldValueById=function(){}}'],
    ["unknown callback call", 'Com_AddEventListener(window,"load",function(){unprovenWork();});'],
    ["callback global return", 'Com_AddEventListener(window,"load",function(){return window;});'],
    ["callback alias", 'var ready=function(){};Com_AddEventListener(window,"load",ready);'],
    ["registration callee alias", 'var register=Com_AddEventListener;register(window,"load",function(){});'],
    ["unknown this receiver", 'function mutate(){this.GetXFormFieldValueById=function(){return ["NO"]};}'],
    ["unknown call without global argument", 'unprovenWork();'],
    ["unknown returned receiver", 'var host=unprovenFactory();host.GetXFormFieldValueById=function(){return ["NO"]};'],
    ["accessor data", 'var ordinary={get value(){return 1;}};'],
    ["spread data", 'var ordinary={...{value:1}};'],
    ["dynamic construction", 'var ordinary=new UnknownType();'],
    ["field handle container", 'var field=GetXFormFieldById("fd_payload");var box=[field];'],
    ["field handle return", 'function expose(){return GetXFormFieldById("fd_payload");}'],
    ["field handle member chain", 'var field=GetXFormFieldById("fd_payload");field[0].ownerDocument.defaultView.GetXFormFieldValueById=function(){};'],
    ["sibling platform override", 'function Com_AddEventListener(){return window;}'],
    ["registration return", 'var result=Com_AddEventListener(window,"load",function(){});'],
    ["dynamic registration event", 'var event="load";Com_AddEventListener(window,event,function(){});']
  ]) it(`rejects unsupported source value flow: ${label}`, () => {
    const source = structuredClone(timedSource);
    source.scripts.sources.push({ sourceRef: "source.form.jsp.structural", javascript });
    assert.equal(apply(source, timed).result.ok, false);
  });
  for (const [label, javascript] of [
    ["direct global alias registration", 'var host=window;Com_AddEventListener(host,"load",function(){var ordinary={value:1};ordinary.value=2;});'],
    ["late global alias registration", 'var host;host=window;Com_AddEventListener(host,"load",function(){});'],
    ["fresh local shadow", 'function local(){var window={value:1};window.value=2;}'],
    ["ordinary local data", 'var ordinary={value:1,nested:["A","B"]};ordinary.value=2;']
  ]) it(`preserves proven source value flow: ${label}`, () => {
    const source = structuredClone(timedSource);
    source.scripts.sources.push({ sourceRef: "source.form.jsp.structural", javascript });
    assert.equal(apply(source, timed).result.ok, true);
  });
  it("rejects arbitrary self-reference properties independently of their spelling", () => {
    for (const property of ["window", "self", "unlistedAlias"]) {
      const javascript = `var host=window[${JSON.stringify(property)}];host.GetXFormFieldValueById=function(){return ["NO"]};`;
      const context = vm.createContext({});
      vm.runInContext(`var window=this;window[${JSON.stringify(property)}]=window;${javascript}`, context, { timeout: 100 });
      assert.equal(vm.runInContext('GetXFormFieldValueById()[0]', context), "NO");
      const source = structuredClone(timedSource);
      source.scripts.sources.push({ sourceRef: "source.form.jsp.self-reference", javascript });
      assert.equal(apply(source, timed).result.ok, false);
    }
  });

  for (const [label, scripts] of [
    ["reassigned ordinary", ['var host=window;host={};Com_AddEventListener(host,"load",function(){});']],
    ["reassigned global", ['var host=window;host=window;Com_AddEventListener(host,"load",function(){});']],
    ["duplicate definition", ['var host=window;var host=window;Com_AddEventListener(host,"load",function(){});']],
    ["use before initializer", ['Com_AddEventListener(host,"load",function(){});var host=window;']],
    ["use before assignment", ['var host;Com_AddEventListener(host,"load",function(){});host=window;']],
    ["conditional initialization", ['if(true){var host=window;}Com_AddEventListener(host,"load",function(){});']],
    ["conditional assignment", ['var host;if(true){host=window;}Com_AddEventListener(host,"load",function(){});']],
    ["foreign execution domain", ['var host;function initialize(){host=window;}Com_AddEventListener(host,"load",function(){});']],
    ["captured outer alias", ['var host=window;Com_AddEventListener(window,"load",function(){Com_AddEventListener(host,"load",function(){});});']],
    ["cross-script late assignment", ['var host;Com_AddEventListener(host,"load",function(){});','host=window;']],
    ["cross-script receiver", ['var host=window;','Com_AddEventListener(host,"load",function(){});']],
    ["cross-script conflicting assignment", ['var host=window;Com_AddEventListener(host,"load",function(){});','host={};']]
  ]) it(`does not authorize a platform sink from may-global alias: ${label}`, () => {
    const source = structuredClone(timedSource);
    scripts.forEach((javascript, index) => source.scripts.sources.push({ sourceRef: `source.form.jsp.alias-${index}`, javascript }));
    assert.equal(apply(source, timed).result.ok, false);
  });
  for (const [label, javascript] of [
    ["chained stable initializer", 'var first=window;var second=first;Com_AddEventListener(second,"load",function(){});'],
    ["same callback execution domain", 'Com_AddEventListener(window,"load",function(){var local=window;Com_AddEventListener(local,"load",function(){});});'],
    ["repeated safe consumer", 'var host=window;Com_AddEventListener(host,"load",function(){});Com_AddEventListener(host,"load",function(){});']
  ]) it(`accepts definite global alias with a proved local initialization: ${label}`, () => {
    const source = structuredClone(timedSource);
    source.scripts.sources.push({ sourceRef: "source.form.jsp.definite", javascript });
    assert.equal(apply(source, timed).result.ok, true);
  });

  it("preserves the timer's deferred read and multi-character scalar value", () => {
    let value = "NO"; const trace = [], queue = [];
    const context = vm.createContext({ setTimeout: (callback, delay) => { queue.push(callback); trace.push(["schedule", delay]); },
      MKXFORM: { getValue: id => { trace.push(["read", id, value]); return value; }, setFieldAttr: (id, attr) => trace.push(["attr", id, attr]) } });
    vm.runInContext(`${timed};onLoad();`, context, { timeout: 100 });
    assert.deepEqual(trace, [["schedule", 510]]); value = "是否"; queue[0]();
    assert.deepEqual(trace.slice(1), [["attr", "fd_details_row", 4], ["attr", "fd_details_row", 6], ["read", "fd_choice", "是否"], ["attr", "fd_details_row", 4], ["attr", "fd_details_row", 6]]);
  });
  for (const id of ["row-marker-timed-select-proof-success", "row-marker-atomic-proof-success"]) it(`persists ${id} through the registered fake route`, async () => {
    const result = await runRouteCase(id); assert.equal(result.execution.ok, true); assert.equal(result.execution.readback.ok, true);
  });
});
