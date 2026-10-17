import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe,it} from 'node:test';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {legacyDetailOrgEventDomain} from '../../src/translator/legacy-detail-org-domain.js';
import {parseRootHashMapStringPuts} from '../../src/translator/xml-utils.js';
import {legacyDetailOrgHydrationCandidates} from '../../src/translator/legacy-detail-org-hydration.js';
const fixture='tests/fixtures/route-validation/detail-org-hydration/route-detail-org_SysFormTemplate.xml';
const cleaned=cleanSourceFile(fixture), original=cleaned.scripts.sources[0];
const form=draftSourceDraft(cleaned).form;
const template=parseRootHashMapStringPuts(fs.readFileSync(fixture,'utf8'));
function sourceTemplateForText(text) {
  const escaped=('<script>'+text+'</script>').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  return {...template,fdDesignerHtml:template.fdDesignerHtml.replace(/value='[^']*'/g,()=>"value='"+escaped+"'")};
}
function sourceForText(text) {
  const source={...original,javascript:text,semanticFacts:{...original.semanticFacts}};
  source.semanticFacts.staticDetailOrgEventDomain=legacyDetailOrgEventDomain(sourceTemplateForText(text),[source]);return source;
}
function candidates(text=original.javascript, fields=form, sources=undefined) {
const source=sourceForText(text);return legacyDetailOrgHydrationCandidates(source,fields,{sources:sources||[source]});
}
function run(action,value,row,result,error=null,parent=undefined){const calls=[],writes=[];new Function('MKXFORM',action.function+';return onChange;')({callOrg(req,cb){calls.push(req);cb(error,result)},updateControl(...args){writes.push(args)}})(value,row,parent);return {calls,writes};}
describe('complete legacy detail organization hydration recipe',()=>{
it('queries the selected native person and writes only the triggering row, preserving empty properties',()=>{
const a=candidates()[0];assert.ok(a);const x=run(a,{fdId:'person-1'},3,{fdId:'person-1',fdLoginName:'101',fdName:'User'});
assert.deepEqual(x.calls,[{id:'sysorg.getPersonByPersonId',param:{fdPersonId:'person-1'}}]);assert.deepEqual(x.writes,[['${table:fd_3242f3c67e44fc}.fd_job_number',3,'101'],['${table:fd_3242f3c67e44fc}.fd_name',3,'User']]);
assert.equal(run(a,[{fdId:'person-1'}],0,{fdId:'person-1'}).writes.length,2);
assert.ok(run(a,{fdId:'person-1'},0,{fdId:'person-1'}).writes.every(write=>write[2]===''));
for(const bad of [null,{},'person-1',[]])assert.deepEqual(run(a,bad,0,{}).calls,[]);
for(const row of [undefined,-1,0.5,'0'])assert.deepEqual(run(a,{fdId:'p'},row,{}).calls,[]);
for(const result of [null,[],{}, {fdId:'other'}])assert.deepEqual(run(a,{fdId:'p'},0,result).writes,[]);
assert.deepEqual(run(a,{fdId:'p'},0,{fdId:'p'},new Error('lookup')).writes,[]);
assert.deepEqual(run(a,{fdId:'p'},0,{fdId:'p'},null,2).calls,[]);
});
it('uses the declared element query response array without inventing person-only properties',()=>{
const text=original.javascript.replace('Data_GetOrgPersonBeanNameByKey','Data_GetOrgElementBeanNameByKey').replace(/var toIDs=\[[\s\S]*?\];/, 'var toIDs=[{name:"fdName",id:"extendDataFormInfo.value(fd_3242f3c67e44fc.!{index}.fd_name)"}];');
const action=candidates(text)[0];assert.ok(action);
const out=run(action,{fdId:'dept-1'},4,[{fdId:'dept-1',fdName:'Department'}]);
assert.deepEqual(out.calls,[{id:'sysorg.getElementDatas',param:{address:[{fdId:'dept-1'}]}}]);
assert.deepEqual(out.writes,[['${table:fd_3242f3c67e44fc}.fd_name',4,'Department']]);
for(const response of [[],{},[{fdId:'dept-1'},{fdId:'dept-2'}]])assert.deepEqual(run(action,{fdId:'dept-1'},0,response).writes,[]);
});
it('rejects any additional source effect, changed row extraction, ambiguous trigger or positional response alias',()=>{
for(const text of [original.javascript.replace('var pId=value[0];','var pId=value[0]; unknownSideEffect();'),original.javascript.replace('s.split(".")[1]','s.split(".")[2]'),original.javascript.replace('data.length==1','data.length>=1'),original.javascript.replace('fdId:fdName:fdParentName:fdLoginName','fdId:fdName:fdLoginName:fdParentName'),original.javascript.replace('fdLoginName",id:','fdEmail",id:')]) assert.deepEqual(candidates(text),[]);
const collision=structuredClone(form);const table=collision.fields.find(f=>f.type==='detailTable');table.columns.push({...table.columns[0],id:'prefix_fd_xz_name'});assert.deepEqual(candidates(original.javascript,collision),[]);
const aliases=structuredClone(form);aliases.fields.find(f=>f.type==='detailTable').columns[0].sourceProps.designerId='fd_other_alias';assert.deepEqual(candidates(original.javascript,aliases),[]);
const otherTable=original.javascript.replaceAll('fd_3242f3c67e44fc.!{index}','fd_other.!{index}');assert.deepEqual(candidates(otherTable),[]);
});
it('closes an absent field predicate only against the complete fixed source control domain',()=>{
const branch=original.javascript.slice(original.javascript.indexOf('if(name.indexOf'),original.javascript.lastIndexOf('});'));
const absent=branch.replaceAll('fd_xz_name','fd_deleted_person');
const text=original.javascript.replace(/\n\}\);\s*$/, '\n'+absent+'\n});');const a=candidates(text);assert.equal(a.length,1);assert.equal(a[0].semanticHints.detailOrgHydration.absentBranches[0].controlId,'fd_deleted_person');
assert.deepEqual(candidates(text,form,[{...original,javascript:text},{id:'other',javascript:'function addDynamicControls(){}'}]),[]);
});
});

describe('captured native detail address event contract',()=>{
it('delivers value, row index and parent index unchanged through the actual native dispatcher',()=>{
const c=JSON.parse(fs.readFileSync('tests/fixtures/executor/persistence/detail-org-runtime/contract.json'));
const window={},seen=[];const {dispatch,runner}=new Function('window','S','O',`var du=${c.runner};return {dispatch:${c.dispatch},runner:du};`)(window,x=>x,(o,k,v)=>({...o,[k]:v}));
const indexes=new Function('a','s','return ({'+c.detailTable.rowProperties+'})')(7,2);assert.deepEqual(indexes,{rowIndex:7,parentRowIndex:2});
const value={fdId:'p'},actions={onChange:[{function(...args){seen.push(args)}}]};
new Function('r','p','P','N','M','t','L','C',c.address.dispatch)({actionFunsRunner:dispatch},'person-control','people','detail',actions,value,indexes.rowIndex,indexes.parentRowIndex);
assert.deepEqual(seen,[]);runner('detail','people',false);assert.deepEqual(seen,[[value,7,2]]);
assert.deepEqual(Object.keys(c.orgApis.find(api=>api.id==='sysorg.getPersonByPersonId').returnType.properties).sort(),['fdId','fdLoginName','fdName','fdOrgType']);
});
});

it('rejects unexplained raw display scripts, library includes, inline handlers and property names in a trigger-domain proof',()=>{
const source=sourceForText(original.javascript);
for(const display of ['<script>createUnknownDom()</script>','<script>Com_IncludeFile("custom.js")</script>','<script src="custom.js"/>','<script src=custom.js>'+original.javascript+'</script>','<script>String.prototype.someNewMethod=function(){}</script>','<input name="unproved" onchange="unknown()"/>']) {
assert.equal(legacyDetailOrgEventDomain({...template,fdDisplayJsp:display},[source]),undefined);
}
});

it('does not call a real Designer raw binding an absent organization trigger',()=>{
const branch=original.javascript.slice(original.javascript.indexOf('if(name.indexOf'),original.javascript.lastIndexOf('});'));
const text=original.javascript.replace(/\n\}\);\s*$/, '\n'+branch.replaceAll('fd_xz_name','fd_deleted_person')+'\n});');
const source=sourceForText(text);const html=sourceTemplateForText(text).fdDesignerHtml;
assert.ok(legacyDetailOrgEventDomain(sourceTemplateForText(text),[source]),'The unchanged fixture must prove its domain before raw binding injection.');
for(const key of ['name','property','propertyId','propertyName']){
const injected=html+`<input id='raw_control' ${key}='extendDataFormInfo.value(fd_3242f3c67e44fc.0.fd_deleted_person.id)' onvaluechange='__xformDispatch'/>`;
const domain=legacyDetailOrgEventDomain({...template,fdDesignerHtml:injected},[source]);
const candidate={...source,semanticFacts:{...source.semanticFacts,staticDetailOrgEventDomain:domain}};
assert.deepEqual(legacyDetailOrgHydrationCandidates(candidate,form,{sources:[candidate]}),[],`${key}: the declared raw field name must prevent absent-branch closure`);
assert.equal(domain,undefined);
}
});

it('refuses Designer dynamic inline actions and unknown script sources while ignoring code inside a carrier value',()=>{
const base=sourceTemplateForText(original.javascript),source=sourceForText(original.javascript);
assert.ok(legacyDetailOrgEventDomain(base,[source]));
for(const injection of [
`<input id="raw_dynamic" onclick="document.body.appendChild(document.createElement('input'))"/>`,
`<input id="raw_dynamic" onchange="this.name='fd_deleted_person.id'"/>`,
`<input id="raw_dynamic" onvaluechange="unknownDispatch()"/>`,
`<script src="https://example.invalid/unknown.js"></script>`,
`<script src=https://example.invalid/unknown.js/>`
])assert.equal(legacyDetailOrgEventDomain({...base,fdDesignerHtml:base.fdDesignerHtml+injection},[source]),undefined);
});

it('recognizes only the finite JSP authoring carrier event and keeps appended runtime effects blocked',()=>{
const source=sourceForText(original.javascript),base=sourceTemplateForText(original.javascript);
const markup=base.fdDesignerHtml.replace(/(<input type="hidden" value='[^']*'\/>)/, '<label ondblclick="Designer_Control_JSP_ShowEditFrame(event, this);" class="button_img" style="BACKGROUND-POSITION: center -480px; MARGIN: 2px 3px 3px 2px">$1</label>');
assert.notEqual(markup,base.fdDesignerHtml);assert.ok(legacyDetailOrgEventDomain({...base,fdDesignerHtml:markup},[source]));
assert.equal(legacyDetailOrgEventDomain({...base,fdDesignerHtml:markup.replace('ShowEditFrame(event, this);','ShowEditFrame(event, this);document.createElement(\'input\');')},[source]),undefined);
assert.equal(legacyDetailOrgEventDomain({...base,fdDesignerHtml:markup.replace('fd_type="jsp"','fd_type="inputText"')},[source]),undefined);
});
