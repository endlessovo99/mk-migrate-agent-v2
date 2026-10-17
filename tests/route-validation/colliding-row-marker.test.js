import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { compileStaticRowEffect } from "../../src/translator/inline-radio-row-effects.js";
import { compileSetFieldAttrRowMarkerTargets, validateSetFieldAttrTargets } from "../../src/dsl/scripts.js";
import { resolveSourceRowEffectTarget } from "../../src/dsl/form-rules.js";
const fixture="tests/fixtures/route-validation/ordered-main-row-lifecycle/route-colliding-row-marker_SysFormTemplate.xml";
it("resolves one shared source marker across all named physical rows",()=>{
 const form={fields:[{id:"fd_caption",type:"description",componentId:"xform-description"},{id:"fd_text",type:"text",componentId:"xform-input"},{id:"fd_lines",type:"detailTable",columns:[{id:"fd_entry",type:"text",componentId:"xform-input"}]}],layout:{mkTree:[
  {id:"layout.caption",sourceRef:"source.row.caption",sourceMarkers:["fd_shared_row"],children:[{refIds:["fd_caption","fd_text"]}]},
  {id:"layout.detail",sourceRef:"source.row.detail",sourceMarkers:["fd_shared_row"],children:[{refIds:["fd_lines"]}]}
 ]}};
 const resolved=resolveSourceRowEffectTarget(form,"fd_shared_row");
 assert.deepEqual(resolved.marker.rowIds,["layout.caption","layout.detail"]);
 assert.deepEqual(resolved.targets.map(target=>target.id),["fd_caption","fd_text","fd_lines"]);
 const sourceFunction='function onLoad(){MKXFORM.setFieldAttr("fd_shared_row",4)}';
 assert.deepEqual(validateSetFieldAttrTargets(sourceFunction,form),[]);
 const compiled=compileSetFieldAttrRowMarkerTargets(sourceFunction,form);
 for(const id of ["fd_caption","fd_text","fd_lines"])assert.ok(compiled.includes(`setFieldAttr("${id}"`),compiled);
 const collision=structuredClone(form);collision.fields.push({id:"fd_shared_row",type:"text",componentId:"xform-hidden"});
 assert.equal(resolveSourceRowEffectTarget(collision,"fd_shared_row"),undefined);
});
it("separates a same-name row helper from the hidden main field",()=>{
 const dsl=draftSourceDraft(cleanSourceFile(fixture));
 const row=dsl.form.layout.mkTree.find(row=>row.sourceMarkers?.includes("fd_marker_row"));
 assert.ok(row);
 assert.ok(dsl.form.fields.find(field=>field.id==="fd_marker_row"));
 assert.ok(dsl.scripts.actions.every(action=>action.translationStatus==="mapped"),JSON.stringify(dsl.scripts.actions.map(a=>[a.id,a.translationStatus])));
 for(const action of dsl.scripts.actions){
  assert.ok(action.function.includes(`setFieldAttr("${row.id}"`),action.function);
  assert.deepEqual(validateSetFieldAttrTargets(action.function,dsl.form),[]);
  const compiled=compileSetFieldAttrRowMarkerTargets(action.function,dsl.form);
  assert.ok(compiled.includes('setFieldAttr("fd_value"'),compiled);
  assert.ok(compiled.includes('setFieldAttr("fd_lines"'),compiled);
  assert.ok(!compiled.includes(`setFieldAttr("${row.id}"`),compiled);
 }
 const direct='function onLoad(){ MKXFORM.setFieldAttr("fd_marker_row",4); MKXFORM.setValue("fd_marker_row","kept"); var value=MKXFORM.getValue("fd_marker_row"); }';
 assert.equal(compileSetFieldAttrRowMarkerTargets(direct,dsl.form),direct);
 assert.equal(compileStaticRowEffect({target:"fd_marker_row",visible:true,required:true,reset:true},dsl.form),undefined);
});
it("normalizes the source row marker through the review proof without changing same-name field semantics", async()=>{
 const {applyEvidenceBackedPatches,collectSourceRefs}=await import("../../src/agent-review/review-validation.js");
 const source=cleanSourceFile(fixture),draft=draftSourceDraft(source);
 const loadIndex=draft.scripts.actions.findIndex(action=>action.event==="onLoad"),mapped=draft.scripts.actions[loadIndex];
 const sourceText=source.scripts.sources[0].javascript.slice(source.scripts.sources[0].javascript.indexOf("Com_AddEventListener"));
 const pending=structuredClone(draft),action=pending.scripts.actions[loadIndex];
 action.function=`function onLoad(){\n// Source JSP JavaScript:\n${sourceText.split("\n").map(line=>`// ${line}`).join("\n")}\n}`;
 action.translationStatus="needs_review";delete action.deterministicBranchProof;
 const {buildScriptBranchProvenance}=await import("../../src/dsl/script-branch-provenance.js");
 const {textValueFieldIds}=await import("../../src/dsl/script-condition-provenance.js");
 action.branchProvenance=buildScriptBranchProvenance({event:"onLoad",source:sourceText,sourceRef:action.sourceRefs[0],textFieldIds:textValueFieldIds(draft.form)});
 action.functionMappings=[];action.coverage={status:"uncovered",nativeRules:[],residuals:[]};
 const values={function:mapped.function,translationStatus:"mapped",coverage:{status:"translated",nativeRules:[],residuals:[]},functionMappings:[{source:"ordered row visibility",target:"MKXFORM.setFieldAttr",basis:"semantic-translation",reviewRequired:false}]};
 const patches=Object.entries(values).map(([key,value])=>({op:"replace",path:`/scripts/actions/${loadIndex}/${key}`,value,sourceRefs:action.sourceRefs,evidence:["Retain the action-local row conditions and order."],rationale:"Use the distinct DSL row target for the source helper.",confidence:0.99}));
 const result=applyEvidenceBackedPatches(pending,patches,{sourceDraft:source,sourceRefs:collectSourceRefs(source)});
 assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
 const row=draft.form.layout.mkTree.find(row=>row.sourceMarkers?.includes("fd_marker_row"));
 const confused=patches.map(patch=>patch.path.endsWith("/function")?{...patch,value:patch.value.replaceAll(row.id,"fd_marker_row")}:patch);
 const rejected=applyEvidenceBackedPatches(pending,confused,{sourceDraft:source,sourceRefs:collectSourceRefs(source)});
 assert.equal(rejected.ok,false);
 assert.ok(rejected.diagnostics.some(diagnostic=>diagnostic.code==="agent.patch.row_marker_effect_incomplete"),JSON.stringify(rejected.diagnostics));
});
