import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { auditCaptionFolding, draftSourceDraft } from "../../src/translator/index.js";
import { translateSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { sourceDraftFromLegacyDsl } from "../../src/translator/source-draft.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { prepareSample } from "../helpers/persistence.js";

const fixture = "tests/fixtures/route-validation/native-caption-data-programs/data_SysFormTemplate.xml";
function translate(script, change = () => {}, input = fixture) {
  const props = parseRootHashMapStringPuts(readFileSync(input, "utf8"));
  props.fdDisplayJsp += `<script>${script}</script>`;
  change(props);
  const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const xml = '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
    Object.entries(props).map(([key, value]) => `<void method="put"><string>${key}</string><string>${escape(value)}</string></void>`).join("") + '</object></java>';
  const source = sourceDraftFromLegacyDsl(translateSysFormTemplateXml(xml));
  return { source, draft: draftSourceDraft(source) };
}
const currency = 'function convertCurrency(money){var digits=new Array("零","壹","贰");var result="";for(var i=0;i<money.length;i++){result=result+digits[0];}return result;}';
for (const [name, script] of [
  ["primitive array membership", 'AttachXFormValueChangeEventById("fd_a",function(value){var companies=["1516","1522","1606"];if(companies.indexOf(value)>=0){SetXFormFieldValueById("fd_a","A",false);}});'],
  ["existing pure local currency contract", currency + 'AttachXFormValueChangeEventById("fd_a",function(value){GetXFormFieldById("fd_a")[0].value=convertCurrency(value);});'],
  ["function-root constants and primitive Date comparisons", 'AttachXFormValueChangeEventById("fd_a",function(value){const first=new Date(value);const second=new Date(GetXFormFieldValueById("fd_b"));if(first>second){SetXFormFieldValueById("fd_a","",false);}});'],
  ["native submit date validation", 'Com_Parameter.event.submit.push(function(){const first=new Date(GetXFormFieldValueById("fd_a"));const second=new Date(GetXFormFieldValueById("fd_b"));if(first>second){alert("日期不正确");return false;}return true;});'],
  ["date arrays, checked callbacks and formatting", 'AttachXFormValueChangeEventById("fd_a",function(value){const first=new Date(value);const dates=[first,new Date(GetXFormFieldValueById("fd_b"))];if(dates.some(item=>isNaN(item.getTime()))){return false;}const days=Math.floor((dates[0].getTime()-dates[1].getTime())/86400000);const year=first.getFullYear();const month=String(first.getMonth()+1).padStart(2,"0");const formatted=`${year}-${month}`;SetXFormFieldValueById("fd_a",formatted+days,false);});']
]) it(`folds unrelated real-export-shaped titles for ${name}`, () => {
  const { source, draft } = translate(script);
  assert.deepEqual(draft.form.fields.filter(f => f.sourceProps?.foldedCaption).map(f => f.id), ["fd_c"]);
  for (const id of ["fd_a", "fd_b", "fd_d"]) assert.equal(draft.form.fields.find(f => f.id === id).props.hiddenLabel, true);
  assert.equal(auditCaptionFolding(source, draft).ok, true);
  const projection = structuredClone(draft);
  projection.scripts = { actions: [] }; projection.formRules = { linkage: [] };
  const native = prepareSample(projection);
  assert.equal(native.verify(native.update).ok, true);
});

const dropdownFixture = "tests/fixtures/route-validation/native-caption-data-programs/dropdown_SysFormTemplate.xml";
const dictionary = 'AttachXFormValueChangeEventById("fd_a",function(value){var map={HIGH:"48h",LOW:"1月"};$("#fd_b").val(map[value]);});';
it("bounds a primitive dictionary lookup by the unchanged native dropdown domain", () => {
  const { source, draft } = translate(dictionary, () => {}, dropdownFixture);
  assert.equal(source.form.controls.find(f => f.id === "fd_a").sourceProps.runtimeSelectEmpty.status, "proven");
  assert.deepEqual(draft.form.fields.filter(f => f.sourceProps?.foldedCaption).map(f => f.id), ["fd_c"]);
  assert.equal(auditCaptionFolding(source, draft).ok, true);
});

for (const [name, script] of [
  ["unknown key domain", 'var map={HIGH:"48h"};var key=GetXFormFieldValueById("fd_a");GetXFormFieldById("fd_b").val(map[key]);'],
  ["trigger value written elsewhere", dictionary + 'SetXFormFieldValueById("fd_a","constructor",false);'],
  ["trigger value written through a handle", dictionary + 'GetXFormFieldById("fd_a")[0].value="constructor";'],
  ["trigger value written by jQuery", dictionary + '$("#fd_a").val("constructor");'],
  ["getter in the lookup record", dictionary.replace('HIGH:"48h"', 'get HIGH(){return changePresentation();}')],
  ["callable lookup value", dictionary.replace('HIGH:"48h"', 'HIGH:changePresentation')],
  ["prototype key in the record", dictionary.replace('HIGH:"48h"', '__proto__:"48h"')],
  ["record mutation", dictionary.replace('$("#fd_b")', 'map.HIGH="x";$("#fd_b")')],
  ["callback also called outside the native event domain", 'function changed(value){var map={HIGH:"48h",LOW:"1月"};GetXFormFieldById("fd_b").val(map[value]);}AttachXFormValueChangeEventById("fd_a",changed);changed(GetXFormFieldValueById("fd_b"));']
]) it(`does not trust a dictionary with ${name}`, () => {
  const { draft } = translate(script, () => {}, dropdownFixture);
  assert.equal(draft.form.fields.filter(f => f.sourceProps?.foldedCaption).length, 0);
});

it("bounds native attachment-list length reads to the exact attachment field", () => {
  const { draft } = translate('Com_Parameter.event.submit.push(function(){var item=Attachment_ObjectInfo["fd_a"];if(item.fileList.length==0){alert("请上传附件");return false;}return true;});', props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace('fd_type="inputText"', 'fd_type="attachment"');
  });
  assert.deepEqual(draft.form.fields.filter(f => f.sourceProps?.foldedCaption).map(f => f.id), ["fd_c"]);
});

it("keeps workflow field-alias recovery independent of folded display titles", () => {
  const { source } = translate('var values=["A","B"];values.indexOf("A");', props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace('content:"C"', 'content:"部门"').replace('>C</LABEL>', '>部门</LABEL>')
      .replace('id:"fd_c",label:"fd_c"', 'id:"fd_c",label:"申请人部门"');
    props.fdDisplayJsp = props.fdDisplayJsp.replace('>C</LABEL>', '>部门</LABEL>');
    props.fdMetadataXml = props.fdMetadataXml.replace('name="fd_c" label="fd_c"', 'name="fd_c" label="申请人部门"');
  });
  source.workflow = { nodes: [], edges: [{ id: "edge", source: "start", target: "end",
    condition: "$fdDepartment$ == 'A'", displayCondition: "$部门$ == 'A'" }] };
  const retained = structuredClone(source);
  source.form.controls.find(f => f.id === "fd_c").title = "申请人部门";
  retained.form.controls.find(f => f.id === "fd_c").title = "申请人部门";
  for (const field of retained.form.controls) delete field.sourceProps.staticCaptionFact;
  const before = draftSourceDraft(retained), after = draftSourceDraft(source);
  assert.equal(before.form.fields.find(f => f.id === "fd_c").title, "申请人部门");
  assert.equal(after.form.fields.find(f => f.id === "fd_c").title, "部门");
  assert.ok(after.form.fields.find(f => f.id === "fd_c").sourceProps.foldedCaption);
  assert.deepEqual(after.workflow, before.workflow);
});

for (const [name, script] of [
  ["array containing unknown objects", 'var a=[externalValue];Number(a[0]);'],
  ["array containing a callable", 'var a=[function(){changePresentation();}];a[0]();'],
  ["array mutation or escape", 'var a=["x"];a.push(externalValue);'],
  ["currency helper with external effect", currency.replace('return result;', 'changePresentation();return result;') + 'convertCurrency("1");'],
  ["currency helper with builtin shadow", currency.replace('var digits=', 'var Array=externalArray;var digits=') + 'convertCurrency("1");'],
  ["currency helper with global iteration write", currency.replace('return result;', 'for(Number of digits){}return result;') + 'convertCurrency("1");'],
  ["currency helper with mutated builtin", currency.replace('return result;', 'Number=money;return result;') + 'convertCurrency("1");'],
  ["currency helper with a tagged constructor escape", 'function convertCurrency(money){money.constructor.constructor`document.getElementById("fd_c").hidden=true;```;return "";}convertCurrency("1");'],
  ["currency helper with a prototype deletion", 'function convertCurrency(money){delete money.constructor.prototype.toString;return money;}convertCurrency("1");'],
  ["uninvoked source helper", currency],
  ["shadowed Date constructor", 'var Date=externalDate;new Date("2020");'],
  ["unknown Date input coercion", 'new Date(externalValue);'],
  ["Date object escape", 'AttachXFormValueChangeEventById("fd_a",function(value){const d=new Date(value);externalConsumer(d);});'],
  ["block-scoped constant shadow", 'var id="fd_c";{const id="fd_a";}document.getElementById(id).value="x";'],
  ["branch-scoped constant shadow", 'var id="fd_c";if(1){const id="fd_a";}else{const id="fd_b";}document.getElementById(id).value="x";'],
  ["conflicting global declarations across script bodies", 'var id="fd_c";</script><script>const id="fd_a";</script><script>document.getElementById(id).value="x";'],
  ["unknown submit effect", 'Com_Parameter.event.submit.push(function(){changePresentation();});'],
  ["other platform event", 'Com_Parameter.event.afterSubmit.push(function(){});'],
  ["shadowed submit registry", 'var Com_Parameter=externalRegistry;Com_Parameter.event.submit.push(function(){});'],
  ["unbounded event traversal", 'Com_Parameter.event.submit.push(function(){window.event.target.parentNode.hidden=true;});'],
  ["unbounded event text source", 'Com_Parameter.event.submit.push(function(){var text=window.event.target.innerText;SetXFormFieldValueById("fd_a",text,false);});'],
  ["attachment lookup for an ordinary field", 'var item=Attachment_ObjectInfo["fd_c"];item.fileList.length;'],
  ["dynamic attachment lookup", 'var item=Attachment_ObjectInfo[externalId];item.fileList.length;'],
  ["attachment list mutation", 'Attachment_ObjectInfo["fd_a"].fileList.push(externalFile);'],
  ["date callback with unknown effects", 'var dates=[new Date()];dates.some(item=>changePresentation());'],
  ["Date prototype mutation", 'Date.prototype.getTime=externalGetter;'],
  ["template expression with unknown coercion", 'var text=`${externalValue}`;'],
  ["overwritten Math builtin", 'Math.floor=externalFloor;Math.floor(1);']
]) it(`retains titles for ${name}`, () => {
  const { draft } = translate(script);
  assert.equal(draft.form.fields.filter(f => f.sourceProps?.foldedCaption).length, 0);
});
