import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { auditCaptionFolding, draftSourceDraft } from "../../src/translator/index.js";
import { translateSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { sourceDraftFromLegacyDsl } from "../../src/translator/source-draft.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { prepareSample } from "../helpers/persistence.js";
const fixture = "tests/fixtures/route-validation/native-caption-function-variants/variants_SysFormTemplate.xml";
function translate(script, input = fixture, change = () => {}) {
  const p = parseRootHashMapStringPuts(readFileSync(input, "utf8"));
  p.fdDisplayJsp += `<script>${script}</script>`;
  change(p);
  const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const xml = '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
    Object.entries(p).map(([key,value]) => `<void method="put"><string>${key}</string><string>${escape(value)}</string></void>`).join("") + '</object></java>';
  const source = sourceDraftFromLegacyDsl(translateSysFormTemplateXml(xml));
  return { source, draft: draftSourceDraft(source) };
}
it("inventories identical static native table metadata without dropping attributes",()=>{
  const {source,draft}=translate("",fixture,p=>{p.fdDisplayJsp+='<TABLE tableName="fd_table" tablename="fd_table" showIndex="true" showindex="true" showRow="1" showrow="1" showStatisticRow="false" showstatisticrow="false"><TR><TD></TD></TR></TABLE>';});
  assert.equal(source.form.controls.find(f=>f.id==="caption_fd_a").sourceProps.staticCaptionFact.domContext.inlineDomainComplete,true);
  assert.deepEqual(draft.form.fields.filter(f=>f.sourceProps?.foldedCaption).map(f=>f.id),["fd_a","fd_b","fd_c"]);
});
it("still inventories a runtime handler beside repeated native table metadata",()=>{
  const {source,draft}=translate("",fixture,p=>{p.fdDisplayJsp+='<TABLE tableName="fd_table" tablename="fd_table" onclick="changePresentation()"></TABLE>';});
  const context=source.form.controls.find(f=>f.id==="caption_fd_a").sourceProps.staticCaptionFact.domContext;
  assert.equal(context.inlineDomainComplete,true);
  assert.ok(context.inlineScripts.includes("changePresentation()"));
  assert.equal(draft.form.fields.filter(f=>f.sourceProps?.foldedCaption).length,0);
});
for(const [name,attrs,tag] of [
  ["dynamic metadata",'tableName="${table}" tablename="${table}"',"TABLE"],
  ["duplicate runtime handlers",'onclick="changePresentation()" onclick="changePresentation()"',"TABLE"],
  ["unknown duplicate boolean",'disabled disabled',"TABLE"]
])it(`does not normalize ${name} as static table metadata`,()=>{
  const {source,draft}=translate("",fixture,p=>{p.fdDisplayJsp+=`<${tag} ${attrs}></${tag}>`;});
  assert.equal(source.form.controls.find(f=>f.id==="caption_fd_a").sourceProps.staticCaptionFact.domContext.inlineDomainComplete,false);
  assert.equal(draft.form.fields.filter(f=>f.sourceProps?.foldedCaption).length,0);
});
const clearFixture = "tests/fixtures/route-validation/native-caption-function-variants/clear_SysFormTemplate.xml";
const clearPair = `$('input[name="extendDataFormInfo.value(fd_a)"]').val("");$('input[name="_extendDataFormInfo.value(fd_a)"]').prop("checked",false);`;
for(const script of ['(function(id){GetXFormFieldById(id)[0].value="x";})("fd_a");','((id)=>{GetXFormFieldById(id)[0].value="x";})("fd_a");'])
it("checks immediately invoked source functions instead of rejecting their wrapper",()=>{
  const {draft}=translate(script);
  assert.deepEqual(draft.form.fields.filter(f=>f.sourceProps?.foldedCaption).map(f=>f.id),["fd_a","fd_b","fd_c"]);
});
it("accepts an empty native Array constructor without accepting unknown sizes",()=>{
  assert.deepEqual(translate('var values=new Array();if(values.length===0){GetXFormFieldById("fd_a")[0].value="";}').draft.form.fields.filter(f=>f.sourceProps?.foldedCaption).map(f=>f.id),["fd_a","fd_b","fd_c"]);
  assert.equal(translate('var values=new Array(externalSize);').draft.form.fields.filter(f=>f.sourceProps?.foldedCaption).length,0);
});
it("keeps unknown effects inside an immediately invoked function opaque",()=>{
  assert.equal(translate('(function(){changePresentation();})();').draft.form.fields.filter(f=>f.sourceProps?.foldedCaption).length,0);
});
it("bounds the exact native checkbox clear pair to its known choice field", () => {
  const {source,draft}=translate(clearPair,clearFixture);
  assert.deepEqual(draft.form.fields.filter(f=>f.sourceProps?.foldedCaption).map(f=>f.id),["fd_a","fd_b","fd_c"]);
  assert.notEqual(draft.form.fields.find(f=>f.id==="fd_a").props.hiddenLabel,true);
  assert.equal(auditCaptionFolding(source,draft).ok,true);
});
for(const [name,script,input] of [
  ["ordinary input",clearPair,fixture],
  ["nonempty value",clearPair.replace('.val("")','.val("X")'),clearFixture],
  ["different fields",clearPair.replace('_extendDataFormInfo.value(fd_a)','_extendDataFormInfo.value(fd_c)'),clearFixture],
  ["checked true",clearPair.replace('"checked",false','"checked",true'),clearFixture],
  ["unknown following callback",clearPair+'changePresentation();',clearFixture],
  ["missing first clear",clearPair.slice(clearPair.indexOf(";")+1),clearFixture],
  ["extra argument",clearPair.replace('"checked",false','"checked",false,changePresentation()'),clearFixture]
])it(`does not generalize a choice clear pair with ${name}`,()=>{
  assert.equal(translate(script,input).draft.form.fields.filter(f=>f.sourceProps?.foldedCaption).length,0);
});
for (const [name, script] of [
  ["same-script declarations", 'function changeValue(){GetXFormFieldById("fd_a")[0].value="A";}function changeValue(){GetXFormFieldById("fd_c")[0].value="C";}changeValue();'],
  ["cross-script immediate and delayed calls", 'function changeValue(){GetXFormFieldById("fd_a")[0].value="A";}changeValue();Com_AddEventListener(window,"load",function(){changeValue();});</script><script>function changeValue(){GetXFormFieldById("fd_c")[0].value="C";}changeValue();'],
  ["event callback references", 'function changed(value){GetXFormFieldById("fd_a")[0].value=value;}AttachXFormValueChangeEventById("fd_a",changed);</script><script>function changed(value){GetXFormFieldById("fd_c")[0].value=value;}AttachXFormValueChangeEventById("fd_c",changed);'],
  ["returned DOM handles", 'function target(){return GetXFormFieldById("fd_a");}function target(){return GetXFormFieldById("fd_c");}target()[0].value="x";']
]) it(`retains all possible global data effects with native titles for ${name}`, () => {
  const {source,draft}=translate(script);
  assert.deepEqual(draft.form.fields.filter(f=>f.sourceProps?.foldedCaption).map(f=>f.id), ["fd_a","fd_b","fd_c"]);
  assert.equal(draft.form.fields.find(f=>f.id==="fd_d").props.hiddenLabel,true);
  for(const id of ["fd_a","fd_c"])assert.notEqual(draft.form.fields.find(f=>f.id===id).props.hiddenLabel,true);
  assert.equal(auditCaptionFolding(source,draft).ok,true);
  const projection=structuredClone(draft);projection.scripts={actions:[]};projection.formRules={linkage:[]};
  const native=prepareSample(projection);assert.equal(native.verify(native.update).ok,true);
});
for (const [name, script] of [
  ["one unknown implementation", 'function changed(){GetXFormFieldById("fd_a")[0].value="A";}function changed(){changePresentation();}changed();'],
  ["one unknown target", 'function changed(){GetXFormFieldById("fd_a")[0].value="A";}function changed(){GetXFormFieldById(externalId)[0].value="C";}changed();'],
  ["overwritten binding", 'function changed(){GetXFormFieldById("fd_a")[0].value="A";}var changed=externalCallback;changed();'],
  ["mutable global capture", 'var target="fd_a";function changed(){GetXFormFieldById(target)[0].value="A";}function changed(){GetXFormFieldById("fd_c")[0].value="C";}changed();'],
  ["unbound definitions", 'function changed(){GetXFormFieldById("fd_a")[0].value="A";}function changed(){GetXFormFieldById("fd_c")[0].value="C";}'],
  ["builtin override", 'function SetXFormFieldValueById(){}function SetXFormFieldValueById(){changePresentation();}SetXFormFieldValueById();'],
  ["ambiguous returned identity", 'function identity(){return "fd_a";}function identity(){return "fd_c";}GetXFormFieldById(identity())[0].value="x";'],
  ["nested lexical redeclaration", 'function changed(){GetXFormFieldById("fd_a")[0].value="A";}function wrapper(){function changed(){GetXFormFieldById("fd_c")[0].value="C";}changed();}wrapper();changed();']
]) it(`retains titles when function variants contain ${name}`, () => {
  const {draft}=translate(script);assert.equal(draft.form.fields.filter(f=>f.sourceProps?.foldedCaption).length,0);
});
