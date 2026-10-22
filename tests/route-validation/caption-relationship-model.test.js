import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseRootHashMapXmlStringPuts } from "../../src/translator/xml-utils.js";
import { sourceCaptionRelations } from "../../src/translator/source-caption-relations.js";
import { captionBehaviorContract } from "../../src/translator/caption-behavior-contract.js";
import { buildDeterministicScriptBranchProof } from "../../src/dsl/deterministic-script-translations.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";
import { mapCaptionAuthorities } from "../../src/translator/native-caption-fold.js";
import { auditCaptionAcceptance } from "../../scripts/lib/caption-acceptance.js";
import { resolveRowMarkerControlIds } from "../../src/dsl/form-rules.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";
import { buildAgentReviewPrompt } from "../../src/agent-review/prompt.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";

const fixture = "tests/fixtures/route-validation/caption-relationship-model/ordinary_SysFormTemplate.xml";
const pairs = [["fd_3c6687b7d57610", "fd_3c6687b047e8c6", "申请人"],
  ["fd_3c6687bb93f482", "fd_3c6687b195039e", "工号"], ["fd_3c6687b9a7ba5a", "fd_3c6687b2c4ecac", "申请部门"]];
const id = pairs[0][0], captionId = pairs[0][1];
const expectations = { inputs: [], relations: pairs.map(([fieldId, captionId, title]) => ({
  fieldId, captionIds: [captionId], title, sourceRef: `source.form.control.${fieldId}`, expectation: "merge",
  basis: "reviewed exact first row of fixed-asset source export" })) };
function variant(change = () => {}, filePath = fixture) {
  const props = parseRootHashMapXmlStringPuts(readFileSync(filePath, "utf8"));
  change(props);
  const directory = mkdtempSync(join(tmpdir(), "caption-relationship-"));
  const encode = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  try {
    const file = join(directory, "variant_SysFormTemplate.xml");
    writeFileSync(file, '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
      Object.entries(props).map(([key, value]) => `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`).join("") + "</object></java>");
    const source = cleanSourceFile(file); return { source, draft: draftSourceDraft(source) };
  } finally { rmSync(directory, { force: true, recursive: true }); }
}
const folded = draft => draft.form.fields.filter(field => field.sourceProps?.foldedCaption).map(field => field.id);

it("maps a real centered row, including its false-bound address title, through review and fake execution", async () => {
  const result = await runRouteCase("caption-relationship-model-success");
  assert.equal(result.execution.ok, true);
  assert.deepEqual(folded(result.dsl), pairs.map(pair => pair[0]));
});

it("merges the exported calculation editor's title through the fake route while preserving its formula and readonly value", async () => {
  const result = await runRouteCase("caption-calculation-model-with-retained-compound-caption");
  assert.equal(result.execution.ok, true);
  assert.equal(result.review.status, "needs_manual");
  assert.ok(result.review.diagnostics.some(issue => issue.code === "source.sysform.label_visibility_unverified"));
  const field = result.dsl.form.fields.find(field => field.id === "fd_3667dc48907b50");
  assert.equal(field.sourceProps.foldedCaption.id, "fd_3667db68852cc4");
  assert.equal(field.title, "剩余金额");
  assert.equal(field.props.readOnly, true);
  assert.equal(field.props.calculation.expression, "$fd_34a8a306143324$ - $fd_3667db7964b7a4$");
  assert.deepEqual(field.props.calculation.fieldIds, ["fd_34a8a306143324", "fd_3667db7964b7a4"]);
  assert.equal(result.dsl.form.fields.some(field => field.id === "fd_3667db68852cc4"), false);
});

it("still protects a calculation title when the actual renderer belongs to another editor kind", () => {
  const { draft } = variant(props => {
    const before = props.fdDisplayJsp;
    props.fdDisplayJsp = before.replace('<xform:xtext property="extendDataFormInfo.value(fd_3667dc48907b50)"',
      '<xform:datetime property="extendDataFormInfo.value(fd_3667dc48907b50)"');
    assert.notEqual(props.fdDisplayJsp, before);
  }, "tests/fixtures/route-validation/caption-relationship-model/calculation_SysFormTemplate.xml");
  assert.equal(folded(draft).includes("fd_3667dc48907b50"), false);
  assert.ok(draft.form.fields.some(field => field.id === "fd_3667db68852cc4"));
});

it("establishes source-only ownership before target mapping and replays one native title on both scenes", () => {
  const { source, draft } = variant();
  assert.equal(source.form.controls.find(field => field.id === id).sourceProps.designerValues._label_bind, "false");
  assert.ok(source.form.captionRelations.every(relation => relation.disposition === "field-caption"));
  assert.equal(JSON.stringify(source.form.captionRelations).includes("xform-input"), false);
  const prepared = prepareSample(draft), native = xformConfig(prepared.update);
  assert.equal(prepared.verify(prepared.update).ok, true);
  const audit = auditCaptionAcceptance(expectations, draft, native, []);
  assert.equal(audit.status, "complete", JSON.stringify(audit.issues));
  assert.equal(audit.actual, 3);
  assert.deepEqual(draft.form.fields[0].sourceProps.foldedCaption.referenceMap,
    { sourceLabelId: captionId, fieldId: id, part: "title", formerControlId: captionId, sourceRowRef: source.form.layout.rows[0].sourceRef });
  const prompt = buildAgentReviewPrompt(source, draft);
  assert.deepEqual(prompt.context.sourceDraft.form.captionRelations, source.form.captionRelations);
  assert.equal(prompt.context.dslDraft.form.fields[0].sourceProps.foldedCaption.referenceMap.part, "title");
});

it("maps proven source bindings without a legacy caption marker or hidden native title", () => {
  const { source } = variant();
  for (const [fieldId] of pairs) delete source.form.controls.find(field => field.id === fieldId).sourceProps.layoutCell;
  source.form.captionRelations = sourceCaptionRelations(source.form);
  const retained = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
  assert.ok(retained.form.fields.filter(field => pairs.some(pair => pair[0] === field.id)).every(field => field.props.hiddenLabel === true));
  assert.ok(pairs.every(([, caption]) => retained.form.fields.some(field => field.id === caption)));
  const draft = draftSourceDraft(source);
  assert.deepEqual(folded(draft), pairs.map(pair => pair[0]));
  const prepared = prepareSample(draft);
  assert.equal(prepared.verify(prepared.update).ok, true);
  assert.equal(auditCaptionAcceptance(expectations, draft, xformConfig(prepared.update), []).status, "complete");
});

it("keeps long business-field collision allocation independent of caption consumption", () => {
  const longId = "fd_long_business_identity_".repeat(3);
  const occupied = `fd_${createHash("sha256").update(longId).digest("hex").slice(0, 22)}`;
  const { source, draft } = variant(props => {
    for (const key of ["fdDesignerHtml", "fdDisplayJsp", "fdMetadataXml"]) props[key] = props[key].replaceAll(id, longId).replaceAll(captionId, occupied);
  });
  const retained = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
  const target = draft.form.fields.find(field => field.sourceProps?.originalId === longId);
  const before = retained.form.fields.find(field => field.sourceProps?.originalId === longId);
  assert.equal(target.id, before.id); assert.notEqual(target.id, occupied);
  assert.equal(target.sourceProps.foldedCaption.referenceMap.fieldId, target.id);
  const prepared = prepareSample(draft); assert.equal(prepared.verify(prepared.update).ok, true);
});

it("preserves trailing-cell source proof when the consumed label itself has a long ID", () => {
  const longCaptionId = "caption_" + "source_label_".repeat(7);
  const { source, draft } = variant(props => {
    for (const key of ["fdDesignerHtml", "fdDisplayJsp", "fdMetadataXml"]) if (props[key]) props[key] = props[key].replaceAll("caption_choice", longCaptionId);
  }, "tests/fixtures/route-validation/mobile-caption-trailing-empty/trailing-empty_SysFormTemplate.xml");
  const field = draft.form.fields.find(field => field.id === "fd_choice");
  assert.equal(field.sourceProps.foldedCaption.id, longCaptionId);
  assert.notEqual(field.sourceProps.foldedCaption.referenceMap.formerControlId, longCaptionId);
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  assert.equal(checkTrust(source, trusted).ok, true, JSON.stringify(checkTrust(source, trusted).diagnostics));
  const prepared = prepareSample(trusted); assert.equal(prepared.verify(prepared.update).ok, true);
});

it("retains field value reads, writes and event identity while merging their ordinary native titles", () => {
  const { source, draft } = variant(props => {
    props.fdDisplayJsp += `<script>var x=GetXFormFieldValueById("${id}");var y=GetXFormFieldById("${pairs[1][0]}");y[0].value=x;</script>`;
  });
  assert.deepEqual(folded(draft), pairs.map(pair => pair[0]));
  const baseline = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
  assert.deepEqual(draft.scripts, baseline.scripts);
  assert.deepEqual(draft.form.fields.map(field => field.id), baseline.form.fields.filter(field => field.type !== "description").map(field => field.id));
  const impact = draft.form.fields[0].sourceProps.foldedCaption.behavior.residualImpact;
  assert.deepEqual(impact.presentationTargets, []);
  assert.ok(impact.dataTargets.includes(id)); assert.ok(impact.dataTargets.includes(pairs[1][0]));
});

it("protects direct conditional field visibility emitted by an existing deterministic mapper", () => {
  const { source, draft } = variant();
  const text = `SetXFormFieldValueById("${id}","A");`, ref = "source.form.jsp.visibility";
  source.scripts = { sources: [{ id: "visibility", sourceRef: ref, javascript: text }] };
  const action = { id: "visibility", event: "onLoad", scope: "global", translationStatus: "mapped",
    function: `function onLoad(){var active=true;MKXFORM.setFieldAttr("${id}",active ? 5 : 4);}`,
    sourceRefs: [ref], coverage: { status: "translated", residuals: [] },
    functionMappings: [{ source: "source visibility", target: "MKXFORM.setFieldAttr", reviewRequired: false,
      basis: "deterministic-radio-checked-onclick-lifecycle" }],
    semanticHints: { coveredCalculationRanges: [{ sourceRef: ref, name: "source-visibility", start: 0, end: text.length }] } };
  // The conditional code shape is emitted by radio-checked-onclick-lifecycle.js;
  // this isolates the coverage consumer from that already-tested mapper.
  action.deterministicBranchProof = buildDeterministicScriptBranchProof(action);
  assert.ok(action.deterministicBranchProof);
  const originalForm = draftSourceDraft(withoutCaptionRelations(structuredClone(source))).form;
  const contract = captionBehaviorContract(source, originalForm, { actions: [action] });
  const context = source.form.controls.find(field => field.id === captionId).sourceProps.captionStructure.domContext;
  assert.equal(contract.forPair(id, captionId, context).ok, false);
  assert.equal(contract.forPair(id, captionId, context).issue.reason, "independent_presentation_effect");
});

it("requires the actual rendered editor to agree even when the binding flag is true", () => {
  const { draft } = variant(props => {
    props.fdDisplayJsp = props.fdDisplayJsp.replace('xform:xtext property="extendDataFormInfo.value(fd_3c6687bb93f482)"',
      'xform:datetime property="extendDataFormInfo.value(fd_3c6687bb93f482)"');
  });
  assert.equal(folded(draft).includes(pairs[1][0]), false);
  assert.ok(draft.form.fields.some(field => field.id === pairs[1][1]));
});

it("accepts a common permission wrapper and preserves the field's source permission identity", () => {
  const { source, draft } = variant(props => {
    props.fdDesignerHtml = '<DIV fd_type="right" fd_values=\'{id:"right_shared"}\'>' + props.fdDesignerHtml + "</DIV>";
    props.fdDisplayJsp = '<xform:right mode_N1="view">' + props.fdDisplayJsp + "</xform:right>";
  });
  assert.deepEqual(folded(draft), pairs.map(pair => pair[0]));
  assert.equal(source.form.controls.find(field => field.id === id).sourceProps.rightContainer.id, "right_shared");
  assert.equal(draft.form.fields.find(field => field.id === id).sourceProps.rightContainer.id, "right_shared");
});

it("rejects an independent runtime permission even when the designer has no such wrapper", () => {
  const { draft } = variant(props => {
    props.fdDisplayJsp = props.fdDisplayJsp.replace(/(<xform:address\b[^>]*\/\s*>)/, '<xform:right mode_N1="hidden">$1</xform:right>');
  });
  assert.equal(folded(draft).includes(id), false);
  assert.ok(draft.form.fields.some(field => field.id === captionId));
});

it("maps equal title permissions to the surviving field without retargeting workflow conditions", () => {
  const { source, draft } = variant();
  const authority = { visible: true, editable: false, required: false, sourceMode: "view" };
  const workflow = { nodes: [{ id: "N1", dataAuthority: { enabled: true, fields: {
    [id]: { ...authority, sourceRef: "field-right" }, [captionId]: { ...authority, sourceRef: "title-right" }
  } } }], branches: [{ condition: { left: id, right: "申请人姓名" } }] };
  const relations = sourceCaptionRelations({ ...source.form, workflow });
  assert.equal(relations[0].disposition, "field-caption");
  const mapped = mapCaptionAuthorities(workflow, draft.form);
  assert.deepEqual(mapped.nodes[0].dataAuthority.fields, { [id]: workflow.nodes[0].dataAuthority.fields[id] });
  assert.deepEqual(mapped.branches, workflow.branches);
  workflow.nodes[0].dataAuthority.fields[captionId].visible = false;
  assert.equal(sourceCaptionRelations({ ...source.form, workflow })[0].reason, "independent_permission");
});

it("keeps a local unreviewed field effect bounded while unrelated ordinary titles still merge", () => {
  const { draft } = variant(props => {
    props.fdDisplayJsp += `<script>$("#${id}").hide();</script>`;
  });
  assert.equal(folded(draft).includes(id), false);
  assert.deepEqual(folded(draft), pairs.slice(1).map(pair => pair[0]));
});

it("bounds an effect on a known local editor shell using the new source relationship domain", () => {
  const { draft } = variant(props => {
    for (const key of ["fdDesignerHtml", "fdDisplayJsp"]) {
      const before = props[key];
      props[key] = props[key].replace(/(<TD\b[^>]*\bcolumn="1"[^>]*>)([\s\S]*?)(<\/TD>)/,
        '$1<DIV id="local_editor_shell">$2</DIV>$3');
      assert.notEqual(props[key], before);
    }
    props.fdDisplayJsp += '<script>$("#local_editor_shell").hide();</script>';
  });
  assert.deepEqual(folded(draft), pairs.slice(1).map(pair => pair[0]));
  const blocked = draft.review.captionFolding.decisions.find(decision => decision.fieldId === id);
  assert.equal(blocked.status, "preserved"); assert.equal(blocked.evidence.impact, "fixed-source-region");
});

for (const [name, change] of [
  ["unknown attachment JSP", text => text.replace(/(<c:import\s+url=")[^"]+("\s+charEncoding)/,
    '$1/sys/attachment/sys_att_main/sysAttMain_unknown_custom.jsp$2')],
  ["conflicting attachment key", text => text.replace(/(<c:param\s+name="fdKey"\s+value="[^"]+"\s*\/>)/,
    '$1<c:param name="fdKey" value="fd_other"/>')]
]) it(`keeps the impact unbounded for ${name}`, () => {
  const { draft } = variant(props => {
    const before = props.fdDisplayJsp; props.fdDisplayJsp = change(before); assert.notEqual(props.fdDisplayJsp, before);
  }, "tests/fixtures/route-validation/native-caption-scoped-scripts/seal_SysFormTemplate.xml");
  assert.equal(folded(draft).length, 0);
  assert.ok(draft.review.captionFolding.decisions.some(decision => decision.evidence?.reason === "runtime_attributes_unproven"));
});

it("reuses complete row translations so a label and editor keep one region operation after merging", () => {
  const { draft } = variant(props => {
    const callbacks = ["fd_a", "fd_c"].map(fieldId => `AttachXFormValueChangeEventById("${fieldId}",function(value,domElement){
      if(value.indexOf("A")>=0){common_dom_row_set_show_required_reset("affected_row",true,true,false);}
      else{common_dom_row_set_show_required_reset("affected_row",false,false,false);}});`).join("\n");
    props.fdDisplayJsp = props.fdDisplayJsp.replace(/<script>[\s\S]*?<\/script>/, `<script>${callbacks}</script>`);
  }, "tests/fixtures/route-validation/native-caption-scoped-scripts/scoped_SysFormTemplate.xml");
  assert.deepEqual(folded(draft), ["fd_a", "fd_b", "fd_c"]);
  assert.deepEqual(resolveRowMarkerControlIds(draft.form, "affected_row"), ["fd_a", "fd_b"]);
  assert.ok(draft.scripts.actions.every(action => action.translationStatus === "mapped"));
  const evidence = draft.form.fields.find(field => field.id === "fd_a").sourceProps.foldedCaption.behavior;
  assert.ok(evidence.coveredSourceStatements.length >= 2);
  assert.ok(evidence.regionMappings.some(region => region.target === "affected_row"));
  const prepared = prepareSample(draft);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("keeps all affected pairs unfinished for an unbounded effect and retains the complete source script", () => {
  const code = "unknownPresentationPlugin();";
  const { source, draft } = variant(props => { props.fdDisplayJsp += `<script>${code}</script>`; });
  assert.equal(folded(draft).length, 0);
  assert.ok(source.scripts.sources.some(script => script.javascript.includes(code)));
  assert.ok(draft.review.captionFolding.decisions.every(decision => decision.evidence?.impact === "unbounded-form"));
  const prepared = prepareSample(draft), audit = auditCaptionAcceptance(expectations, draft, xformConfig(prepared.update), []);
  assert.equal(audit.status, "incomplete");
  assert.equal(audit.required, 3); assert.equal(audit.actual, 0); assert.equal(audit.remaining, 3);
});

it("does not turn a shared title or an independent label event into a hidden duplicate", () => {
  for (const mutate of [
    props => { props.fdDesignerHtml = props.fdDesignerHtml.replace(`_label_bind_id:"${pairs[1][1]}"`, `_label_bind_id:"${captionId}"`); },
    props => { props.fdDesignerHtml = props.fdDesignerHtml.replace(/(<LABEL\b[^>]*fd_3c6687b047e8c6[^>]*)(>)/, '$1 onclick="captionHelp()"$2'); }
  ]) {
    const { draft } = variant(mutate);
    assert.equal(folded(draft).includes(id), false);
    const caption = draft.form.fields.find(field => field.id === captionId);
    assert.equal(caption.componentId, "xform-description"); assert.notEqual(caption.dataOnly, true);
  }
});

it("detects a resurrected label, a hidden title and a forged expectation inventory independently", () => {
  const { draft } = variant(), prepared = prepareSample(draft), native = xformConfig(prepared.update);
  const hidden = structuredClone(native);
  const field = hidden.dataModel.flatMap(model => model.fdFields).find(field => field.fdName === id);
  const attribute = JSON.parse(field.fdAttribute); attribute.config.labelProps.mobile.hiddenLabel = true; field.fdAttribute = JSON.stringify(attribute);
  assert.equal(auditCaptionAcceptance(expectations, draft, hidden, []).status, "failed");
  const wrongTitle = structuredClone(native);
  const wrongField = wrongTitle.dataModel.flatMap(model => model.fdFields).find(field => field.fdName === id);
  const wrongAttribute = JSON.parse(wrongField.fdAttribute); wrongAttribute.config.labelProps.title += "错误";
  wrongField.fdAttribute = JSON.stringify(wrongAttribute);
  assert.ok(auditCaptionAcceptance(expectations, draft, wrongTitle, []).issues.some(issue => issue.reason.endsWith("title_not_rendered")));
  const duplicate = structuredClone(draft); duplicate.form.fields.push({ id: captionId, componentId: "xform-description" });
  assert.ok(auditCaptionAcceptance(expectations, duplicate, native, []).issues.some(issue => issue.reason === "source_label_not_removed"));
  assert.equal(auditCaptionAcceptance({ ...expectations, relations: expectations.relations.slice(1) }, draft, native, []).status, "failed");
  assert.equal(auditCaptionAcceptance(undefined).status, "not-assessed");
  const malformed = structuredClone(expectations); malformed.relations[0].expectation = "merg";
  assert.throws(() => auditCaptionAcceptance(malformed, draft, native, []), /Invalid reviewed caption expectation/);
});
