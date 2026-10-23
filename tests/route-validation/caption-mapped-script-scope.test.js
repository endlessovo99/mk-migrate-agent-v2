import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";
import { captionBehaviorContract } from "../../src/translator/caption-behavior-contract.js";
import { buildDeterministicScriptBranchProof } from "../../src/dsl/deterministic-script-translations.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { renderNativeCaption } from "../helpers/native-caption-renderer.js";
import { runRouteCase } from "./run-route-case.js";
import { readFileSync } from "node:fs";
import { parseRootHashMapXmlStringPuts } from "../../src/translator/xml-utils.js";
import { parse } from "acorn";
import { translateSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { sourceDraftFromLegacyDsl } from "../../src/translator/source-draft.js";
import { nativeValidationMessage } from "../../src/translator/native-validation-message.js";

const fixture = name => `tests/fixtures/route-validation/caption-mapped-script-scope/${name}_SysFormTemplate.xml`;

for (const name of ["detail-validation", "detail-value"]) it(`passes the mapped ${name} caption route with fake persistence`, async () => {
  const result = await runRouteCase(`caption-mapped-${name}-success`);
  assert.equal(result.execution.ok, true);
  assert.equal(result.dsl.form.fields.some(field => field.id === "caption_note"), false);
});

for (const name of ["detail-validation", "detail-value", "hoisted-reader"]) it(`uses complete mapped ${name} coverage without changing the script`, () => {
  const source = cleanSourceFile(fixture(name)), draft = draftSourceDraft(source);
  assert.equal(draft.form.fields.some(f => f.id === "caption_note"), false);
  const retained = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
  assert.deepEqual(draft.scripts, retained.scripts);
  assert.deepEqual(draft.form.layout.sourceGrid, retained.form.layout.sourceGrid);
  const projection = structuredClone(draft);
  projection.scripts = { actions: [] };
  const prepared = prepareSample(projection), config = xformConfig(prepared.update);
  const attribute = JSON.parse(config.dataModel.flatMap(m => m.fdFields || []).find(f => f.fdName === "fd_note").fdAttribute);
  for (const scene of ["desktop", "mobile"]) assert.deepEqual(renderNativeCaption(attribute, scene).labels, ["Note"]);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

function contractFor(functionText, { changeProof = false, select = false } = {}) {
  const source = cleanSourceFile(fixture("detail-validation"));
  const form = draftSourceDraft(withoutCaptionRelations(structuredClone(source))).form;
  if (select) form.fields.push({ id: "fd_choices", type: "select", componentId: "xform-select" });
  const script = source.scripts.sources[0];
  const action = {
    id: "mapped", event: "onBeforeSubmit", scope: "global", translationStatus: "mapped",
    function: functionText, coverage: { status: "translated", residuals: [] }, sourceRefs: [script.sourceRef],
    functionMappings: [{ source: "complete test-owned effect", target: "MKXFORM", basis: "deterministic-procurement-payment-department-consistency", reviewRequired: false }],
    semanticHints: { coveredCalculationRanges: [{ sourceRef: script.sourceRef, name: "whole-source", start: 0, end: script.javascript.length }] }
  };
  action.deterministicBranchProof = buildDeterministicScriptBranchProof(action);
  if (changeProof) action.function += " ";
  return captionBehaviorContract(source, form, { actions: [action] });
}

it("reuses a fixed native toast while preserving the evidence boundary", () => {
  assert.equal(contractFor('function onBeforeSubmit(){MKXFORM.toast("Mismatch");return false;}').summary.residualScope.ok, true);
});

it("keeps cross-platform native messages inside the existing bounded caption proof", () => {
  for (const expression of ['"Mismatch"', '"Rows " + positions.join(",") + " are invalid"']) {
    const body = 'var positions=[];for(var i=0;i<2;i++){positions.push(i+1);}' + nativeValidationMessage(expression);
    assert.equal(contractFor(`function onBeforeSubmit(){${body}return false;}`).summary.residualScope.ok, true);
  }
});

for (const body of [
  'MKXFORM.toast({content: externalMessage, icon:"fail"});',
  'MKXFORM.toast({content:"Mismatch", icon:externalIcon});',
  'MKXFORM.toast({content:"Mismatch", icon:"fail", onClose:callback});',
  'MKXFORM.toast({get content(){return externalMessage}, icon:"fail"});',
  'MKXFORM.toast({content:"Mismatch", ...extra});',
  'MKXFORM.toast({content:"Mismatch", content:"Other"});',
  'MKXFORM.message.error(externalMessage);',
  'MKXFORM.message.error("Mismatch", externalEffect());',
  'MKXFORM.message[method]("Mismatch");',
  'MKXFORM["message"].error("Mismatch");'
]) it(`rejects unbounded notification options: ${body}`, () => {
  assert.equal(contractFor(`function onBeforeSubmit(){${body}}`).summary.residualScope.ok, false);
});

it("reuses closed options-only native select updates", () => {
  assert.equal(contractFor('function onBeforeSubmit(){MKXFORM.setProps("fd_choices",{options:[]});return true;}', { select: true }).summary.residualScope.ok, true);
});

it("reuses complete native detail replacement while protecting the replaced table", () => {
  const contract = contractFor('function onBeforeSubmit(){MKXFORM.setDetailValues("${table:fd_lines}",[{}]);return true;}');
  assert.equal(contract.summary.residualScope.ok, true);
  assert.equal(contract.forPair("fd_lines", "caption_lines", { version: 1 }).ok, false);
  assert.equal(contract.forPair("fd_note", "caption_note", { version: 1 }).ok, true);
});

it("consumes the existing complete cost-center option mapper coverage", () => {
  const source = cleanSourceFile("tests/fixtures/route-validation/travel-reimbursement-lifecycle/route-travel-reimbursement-lifecycle_SysFormTemplate.xml");
  const draft = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
  const script = source.scripts.sources.find(script => script.javascript.includes("function changeBsegValue"));
  const declaration = parse(script.javascript, { ecmaVersion: "latest" }).body.find(node => node.id?.name === "changeBsegValue");
  assert.ok(declaration);
  const contract = captionBehaviorContract(source, draft.form, draft.scripts);
  assert.ok(contract.summary.coveredSourceStatements.some(range => range.start === declaration.start && range.end === declaration.end && range.sourceRefs.includes(script.sourceRef)));
});

it("reuses local numeric position lists in native validation messages", () => {
  const body = 'var positions=[];for(var i=0;i<2;i++){positions.push(i+1);}MKXFORM.toast("Rows "+positions.join(",")+" are invalid");return false;';
  assert.equal(contractFor(`function onBeforeSubmit(){${body}}`).summary.residualScope.ok, true);
  for (const mutated of [
    body.replace("positions.push(i+1)", "positions.push(externalValue)"),
    body.replace("positions.push(i+1)", "positions.push(externalEffect())"),
    body.replace('MKXFORM.toast(', 'leak(positions);MKXFORM.toast('),
    body.replace('MKXFORM.toast(', 'var alias=positions;alias.push(externalValue);MKXFORM.toast('),
    body.replace("i++", "i=externalCounter"),
    body.replace('positions.push(i+1)', '[i]=externalValues;positions.push(i+1)'),
    body.replace('positions=[]', 'positions=externalArray')
  ]) assert.equal(contractFor(`function onBeforeSubmit(){${mutated}}`).summary.residualScope.ok, false);
});

it("consumes the complete existing submit mapper rather than leaving its constant pool unresolved", () => {
  const source = cleanSourceFile("tests/fixtures/route-validation/travel-reimbursement-lifecycle/route-travel-reimbursement-lifecycle_SysFormTemplate.xml");
  const draft = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
  const action = draft.scripts.actions.find(action => action.deterministicBranchProof?.basis === "deterministic-travel-reimbursement-submit-calculation");
  assert.ok(action);
  const contract = captionBehaviorContract(source, draft.form, draft.scripts);
  const range = action.semanticHints.coveredCalculationRanges.find(range => range.name.includes("submit"));
  assert.ok(range);
  assert.ok(contract.summary.coveredSourceStatements.some(covered => covered.sourceRefs.includes(range.sourceRef) && covered.start <= range.start && covered.end >= range.end));
});

for (const [name, body, options] of [
  ["unverified action", 'MKXFORM.toast("Mismatch");', { changeProof: true }],
  ["dynamic toast content", 'MKXFORM.toast(externalMessage);'],
  ["unknown target method", 'MKXFORM.unknownMethod("fd_note");'],
  ["options for an unresolved select", 'MKXFORM.setProps("missing",{options:[]});', { select: true }],
  ["options for a non-select", 'MKXFORM.setProps("fd_note",{options:[]});'],
  ["independent title properties", 'MKXFORM.setProps("fd_choices",{options:[],hiddenLabel:true});', { select: true }],
  ["dynamic property object", 'MKXFORM.setProps("fd_choices",externalProps);', { select: true }],
  ["an unresolved replacement table", 'MKXFORM.setDetailValues("${table:missing}",[{}]);'],
  ["a column passed as a replacement table", 'MKXFORM.setDetailValues("${table:fd_lines}.code",[{}]);'],
  ["an unresolved detail column", 'MKXFORM.updateControl("${table:fd_lines}.missing",0,"value");'],
  ["a main field passed as a detail control", 'MKXFORM.updateControl("fd_note",0,"value");'],
  ["an unresolved detail presentation target", 'MKXFORM.setDetailFieldItemAttr("${table:fd_lines}",4,0,"${table:other}.code");']
]) it(`does not consume source coverage for ${name}`, () => {
  assert.equal(contractFor(`function onBeforeSubmit(){${body}}`, options).summary.residualScope.ok, false);
});

for (const [name, change] of [
  ["a later uncovered definition", text => text.replace('</script>', 'function getFormFieldValue(id){changePresentation();}</script>')],
  ["definitions split across script programs", text => text.replace('return getFormFieldValue(id,"",0);}', 'return getFormFieldValue(id,"",0);}</script><script>')]
]) it(`does not choose a helper winner for ${name}`, () => {
  const props = parseRootHashMapXmlStringPuts(readFileSync(fixture("hoisted-reader"), "utf8"));
  const next = change(props.fdDisplayJsp); assert.notEqual(next, props.fdDisplayJsp); props.fdDisplayJsp = next;
  const encode = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const xml = '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
    Object.entries(props).map(([key, value]) => `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`).join("") + '</object></java>';
  const draft = draftSourceDraft(sourceDraftFromLegacyDsl(translateSysFormTemplateXml(xml)));
  assert.ok(draft.form.fields.some(field => field.id === "caption_note"));
});
