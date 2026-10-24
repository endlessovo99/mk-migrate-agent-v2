import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { applyApprovedImportPolicies, approvedImportSourceJavascriptDigest, approvedNativeImportSourceWitness } from "../../src/translator/approved-import-policies.js";
import { nativeImportFormData } from "../../src/translator/native-detail-import-runtime.js";
import { attachMigrationPolicies, migrationPolicySourceDigest } from "../../src/translator/approved-migration-policies.js";
import { canonicalJson } from "../../src/agent-review/digest.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { xformConfig } from "../helpers/persistence.js";
import { checkTrust } from "../../src/dsl/trust.js";
import { executeDsl } from "../../src/executor/execute.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";
const file="tests/fixtures/route-validation/native-detail-import/route-native-detail-import_SysFormTemplate.xml";
const nativeButton=JSON.parse(fs.readFileSync('tests/fixtures/executor/remote-selector-native/contract.json'));
const nativeFlush=JSON.parse(fs.readFileSync('tests/fixtures/route-validation/native-detail-import/native-action-flush.json'));
function input(){const source=cleanSourceFile(file),draft=draftSourceDraft(source),action=draft.scripts.actions.find(a=>a.semanticHints?.legacyExcelImport),script=source.scripts.sources.find(s=>action.sourceRefs.includes(s.sourceRef));
const decision={id:"native-import-fixture",kind:"native-detail-import-replace",tableId:"detailList",sourceActionId:action.id,sourceRef:script.sourceRef,sourceDeclarationSha256:approvedImportSourceJavascriptDigest(script),newTemplateOnly:true,legacyFiles:"reject",mode:"replace",retiredUnboundSlots:[{fieldId:"fd_missing",sourceSlot:2}],downloadFieldSourceRef:"source.form.control.fd_download"};
return {source,draft,action,script,decision};}
function authorized(source,decision){return attachMigrationPolicies(source,{version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope:{baseUrl:"https://qas.example.invalid",targetCategoryId:"route-category-id"},authorization:{actor:"fixture-explicit-user",evidenceSha256:"sha256:"+"1".repeat(64)},decisions:[decision]});}
function compiled(){const x=input(),source=authorized(x.source,x.decision),result=applyApprovedImportPolicies(source,x.draft,[x.decision]);return {...x,authorizedSource:source,result,action:result.draft.scripts.actions.find(a=>a.id===x.action.id)};}

it("rebinds one actual source click to a native combined import/download entrance and retains all original source evidence",()=>{
const {source,draft,decision}=input(),raw=fs.readFileSync(file),before=JSON.stringify(source),oldDraft=JSON.stringify(draft),scoped=authorized(source,decision),result=applyApprovedImportPolicies(scoped,draft,[decision]);
assert.equal(JSON.stringify(source),before);assert.equal(JSON.stringify(draft),oldDraft);assert.deepEqual(fs.readFileSync(file),raw);assert.equal(result.audits[0].status,"applied");
assert.equal(result.changedActionIds.length,1);const action=result.draft.scripts.actions.find(a=>a.id===decision.sourceActionId);
assert.equal(action.event,"onClick");assert.equal(action.controlId,"fd_download");assert.deepEqual(action.sourceRefs,[decision.sourceRef]);assert.equal(result.draft.scripts.actions.length,draft.scripts.actions.length);
assert.equal(result.draft.form.fields.find(f=>f.id==='fd_download').sourceRef,"source.form.control.fd_download");assert.equal(result.draft.form.fields.find(f=>f.id==='fd_download').componentId,"xform-button");
assert.deepEqual(result.audits[0].nativeImport.importFieldIds,['fd_job','fd_name','fd_org.name','fd_date','fd_flag']);assert.equal(result.audits[0].nativeImport.originalSourceFormatConverted,false);assert.equal(result.audits[0].nativeImport.allLegacyFilesRejectionProven,false);
assert.ok(approvedNativeImportSourceWitness(source,decision));assert.match(action.function,/\$\{xform:id\}/);assert.match(action.function,/asyncImportDetailData/);assert.equal(action.function.includes('old.xlsx'),false);
});

it("keeps policy witnesses and generated functions stable after JSONB-style semantic key normalization",()=>{
 const {source,draft,decision}=input(),scoped=authorized(source,decision);
 const original=applyApprovedImportPolicies(scoped,draft,[decision]);
 const normalized=applyApprovedImportPolicies(JSON.parse(canonicalJson(scoped)),JSON.parse(canonicalJson(draft)),[JSON.parse(canonicalJson(decision))]);
 assert.equal(canonicalJson(normalized.audits),canonicalJson(original.audits));
 assert.equal(normalized.draft.scripts.actions.find(a=>a.id===decision.sourceActionId).function,original.draft.scripts.actions.find(a=>a.id===decision.sourceActionId).function);
});

it("rejects changed source click/body, missing/ambiguous link, mapped org-identity slots, native formulas and absent policy scope",()=>{
const {source,draft,decision}=input();assert.equal(applyApprovedImportPolicies(source,draft,[decision]).changedActionIds.length,0);
for(const mutation of [
 s=>{s.scripts.fragments[0].content=s.scripts.fragments[0].content.replace('importExcel()','otherCall()');},
 s=>{s.scripts.fragments[0].content=s.scripts.fragments[0].content.replace('</div>','</div><div onclick="importExcel()">duplicate</div>');},
 s=>{s.scripts.sources[0].javascript+='unknownEffect();';},
 s=>{s.form.controls=s.form.controls.filter(f=>f.sourceRef!==decision.downloadFieldSourceRef);}
]){const changed=structuredClone(source);mutation(changed);const selected={...decision,sourceDeclarationSha256:approvedImportSourceJavascriptDigest(changed.scripts.sources[0])};const scoped=authorized(changed,selected);assert.equal(applyApprovedImportPolicies(scoped,draft,[selected]).changedActionIds.length,0);}
for(const mutate of [d=>{d.form.fields.find(f=>f.type==='detailTable').columns[0].props.formula={expression:'value*2'};},d=>{d.form.fields.find(f=>f.type==='detailTable').columns[0].componentId='xform-address';},d=>{d.form.fields.push(structuredClone(d.form.fields.find(f=>f.id==='fd_download')));}]){let changed=structuredClone(draft);mutate(changed);assert.equal(applyApprovedImportPolicies(authorized(source,decision),changed,[decision]).changedActionIds.length,0);}
});

it("projects public native form context with stale base override, detail values, hidden current values, dotted singles and reserved-name refusal",()=>{
const api={getFormValues:()=>({_dynamicProps:{mechanisms:{'sys-xform':{dynamicProps:{fd_value:'stale',untouched:'keep'}}}}}),getFormConfigs:()=>({forms:[{items:[
{key:'main.fd_value',kind:'control',controlProps:{$$tableType:'main',name:'fd_value',value:0}},
{key:'main.fd_hidden',kind:'control',hiddenInvalid:true,isInvalid:true,controlProps:{$$tableType:'main',name:'fd_hidden',value:false}},
{key:'single.fd_value',kind:'control',controlProps:{$$tableType:'single',$$tableName:'single',name:'fd_value',value:'single'}},
{key:'rows',kind:'control',controlProps:{$$tableType:'detail',$$tableName:'rows',value:{values:[{code:'current'}],deleteState:['old']}}}]}]})};
assert.deepEqual(nativeImportFormData(api,['fd_id']),{fd_value:0,untouched:'keep',fd_hidden:false,'single.fd_value':'single',rows:[{code:'current'}]});assert.throws(()=>nativeImportFormData(api,['mechanisms']));assert.throws(()=>nativeImportFormData({...api,getFormConfigs:()=>({forms:[{items:[{kind:'control',key:'x',childrenGroup:[],controlProps:{}}]}]})},['fd_id']));
});

it("opens one native import dialog through the real button dispatcher when the base exists only in the public module cache",()=>{
 const h=harness(compiled().action,{nativeDispatch:true,baseMode:'amd'});
 assert.equal(h.opened(),true);assert.equal(h.modalCount(),1);assert.equal(h.callbackCount(),1);
 assert.deepEqual(h.moduleLookups,['@elem/xform-base']);
 assert.deepEqual(h.requests,[]);assert.deepEqual(h.writes,[]);
});

it("keeps a usable global base ahead of the module cache and dispatches the native click once",async()=>{
 const h=harness(compiled().action,{nativeDispatch:true,baseMode:'global',loaderThrows:true});
 assert.equal(h.opened(),true);assert.equal(h.modalCount(),1);assert.equal(h.callbackCount(),1);
 assert.equal(h.loaderReads(),0);assert.deepEqual(h.moduleLookups,[]);assert.deepEqual(h.notices,[]);
 assert.deepEqual(h.requests,[]);assert.deepEqual(h.writes,[]);
 h.file();await h.reply(0,{success:true,data:{fdAttachFileId:'global-attach'}});await h.reply(1,{success:true,data:{id:'global-job'}});
 const row={fd_job:'GLOBAL-J1',fd_name:'Name','fd_org.name':'text only',fd_date:'2026-10-24',fd_flag:'yes'};
 await h.reply(2,{success:true,data:{percent:1,success:true,data:[row]}});assert.deepEqual(h.writes,[]);h.confirm();h.confirm();
 assert.deepEqual(h.writes,[{table:'native_table',rows:[row]}]);assert.equal(h.loaderReads(),0);
});

it("reports unavailable native dependencies before opening, reading rows or sending requests",()=>{
 for(const baseMode of ['missing-loader','missing-module','throw','wrong-namespace','missing-post']){
  const h=harness(compiled().action,{nativeDispatch:true,baseMode});
  assert.equal(h.opened(),false,baseMode);assert.equal(h.modalCount(),0,baseMode);assert.equal(h.callbackCount(),1,baseMode);assert.equal(h.contextReads(),0,baseMode);
  assert.deepEqual(h.notices,['导入组件暂不可用，请刷新页面后重试；原明细保持不变。'],baseMode);
  assert.deepEqual(h.requests,[],baseMode);assert.deepEqual(h.writes,[],baseMode);
 }
});

it("uses exact native upload/parse DTO, preserves ambient context, previews then replaces once on confirmation, including independent .name strings",async()=>{
const h=harness(compiled().action);assert.equal(h.requests.length,0);h.file();assert.equal(h.requests.length,1);assert.equal(h.requests[0].url,'https://qas.example.invalid/data/sys-attach/upload');assert.equal(h.requests[0].dto.fields[0][0],'fdFile');
await h.reply(0,{success:true,data:{fdAttachFileId:'attach-fixture'}});assert.equal(h.requests[1].dto.xformId,'FAKE_NEW_XFORM_ID');assert.equal(h.requests[1].dto.tableName,'native_table');assert.deepEqual(h.requests[1].dto.formData.native_table,[{fd_job:'old'}]);assert.equal(h.requests[1].dto.formData.fd_current,0);assert.equal(h.requests[1].dto.formData.unrendered,'keep');
await h.reply(1,{success:true,data:{id:'job-fixture'}});assert.ok(h.requests[2].url.endsWith('/sysXFormDataTransport/process'));const row={fd_job:'J1',fd_name:'Name','fd_org.name':'text only',fd_date:'2026-10-17',fd_flag:'yes'};
await h.reply(2,{success:true,data:{percent:1,success:true,data:[row]}});assert.deepEqual(h.writes,[]);h.confirm();assert.deepEqual(h.writes,[{table:'native_table',rows:[row]}]);h.confirm();assert.equal(h.writes.length,1);
});

it("projects confirmed rows to approved source slots and discards all external system identities and non-import field values",async()=>{
 const {source,draft,decision}=input();
 draft.form.fields.find(field=>field.type==='detailTable').columns.push({id:'fd_extra',title:'Outside source slots',type:'text',componentId:'xform-input',props:{}});
 const result=applyApprovedImportPolicies(authorized(source,decision),draft,[decision]);
 const h=harness(result.draft.scripts.actions.find(action=>action.id===decision.sourceActionId));h.file();
 await h.reply(0,{success:true,data:{fdAttachFileId:'attach'}});await h.reply(1,{success:true,data:{id:'job'}});
 await h.reply(2,{success:true,data:{percent:1,success:true,data:[{fd_job:0,fd_name:false,'fd_org.name':'',fd_date:null,fd_extra:'must not write',key:'old-row-key',fd_id:'old-business-id',fd_main_id:'other-document'}]}});h.confirm();
 assert.deepEqual(h.writes,[{table:'native_table',rows:[{fd_job:0,fd_name:false,'fd_org.name':'',fd_date:null}]}]);
});

it("cancellation, parse errors, invalid rows, context failure and bounded polling leave old rows untouched; confirmed empty rows clear",async()=>{
for(const scenario of ['cancel-upload','cancel-ready','parse-error','invalid','timeout','empty']){const h=harness(compiled().action,{maxPolls:2});h.file();if(scenario==='cancel-upload')h.cancel();await h.reply(0,{success:true,data:{fdAttachFileId:'attach'}});if(scenario==='cancel-upload'){assert.equal(h.requests.length,1);h.confirm();assert.deepEqual(h.writes,[]);continue;}
if(scenario==='parse-error'){await h.reject(1);h.confirm();assert.deepEqual(h.writes,[]);continue;}
await h.reply(1,{success:true,data:{id:'job'}});
if(scenario==='timeout'){await h.reply(2,{success:true,data:{percent:0.1}});h.tick();await h.reply(3,{success:true,data:{percent:0.2}});h.tick();assert.equal(h.requests.length,4);h.confirm();assert.deepEqual(h.writes,[]);continue;}
const rows=scenario==='empty'?[]:scenario==='invalid'?[{unknownField:'value'}]:[{fd_job:'new'}];await h.reply(2,{success:true,data:{percent:1,success:true,data:rows}});if(scenario==='cancel-ready')h.cancel();h.confirm();assert.equal(h.writes.length,scenario==='empty'?1:0);if(scenario==='empty')assert.deepEqual(h.writes[0].rows,[]);}
const context=harness(compiled().action,{badContext:true});assert.equal(context.opened(),false);assert.equal(context.requests.length,0);assert.deepEqual(context.writes,[]);
});

it("downloads only the approved native new template columns with the exact new form ID, never calls the old file URL or row setter",async()=>{
const h=harness(compiled().action);h.download();assert.equal(h.requests.length,1);assert.ok(h.requests[0].url.endsWith('/sysXFormDataTransport/exportDetailTemplate'));assert.equal(h.requests[0].dto.xformId,'FAKE_NEW_XFORM_ID');assert.deepEqual(h.requests[0].dto.sortedFieldList,['fd_job','fd_name','fd_org.name','fd_date','fd_flag']);assert.deepEqual(h.requests[0].dto.transportFields,h.requests[0].dto.sortedFieldList);assert.equal(h.requests[0].dto.personMatchType,'');assert.equal(h.requests[0].dto.deptMatchType,'');await h.reply(0,'synthetic workbook bytes');assert.equal(h.downloads.length,1);assert.deepEqual(h.writes,[]);
});

it("the approved public route passes review, fake persistence, exact form-ID materialization, API readback and transfer record",async()=>withNetworkGuard(async()=>{
 const {source,decision}=input(),scoped=authorized(source,decision),draft=draftSourceDraft(scoped);
 const reviewed=await runAgentReview(scoped,draft,{provider:createFakeReviewProvider('accept')});assert.equal(reviewed.ok,true,JSON.stringify(reviewed.diagnostics));assert.equal(checkTrust(scoped,reviewed.dsl).ok,true);
 const client=new FakeNewoaAdapter('persist');const result=await executeDsl(reviewed.dsl,{client,baseUrl:'https://qas.example.invalid',confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'fixture',encryptedPassword:'fixture'},transferRecordIdFactory:()=> 'nativeimport000000000000000000001'});
 assert.equal(result.ok,true,JSON.stringify(result.diagnostics));assert.equal(result.readback.ok,true);assert.equal(result.transferRecord.status,'recorded');
 const persisted=xformConfig(client.template),formId=client.template.mechanisms['sys-xform'].fdId,formAttr=JSON.parse(persisted.attribute.formAttr);
 const functions=[];function inspect(node){if(!node||typeof node!=='object')return;if(typeof node.function==='string')functions.push(node.function);for(const v of Object.values(node))Array.isArray(v)?v.forEach(inspect):inspect(v);}inspect(formAttr.controlAction);
 const imports=functions.filter(code=>code.includes('asyncImportDetailData'));assert.ok(imports.length>0);for(const code of imports){assert.ok(code.includes('"xformId":'+JSON.stringify(formId)));assert.equal(code.includes('${xform:id}'),false);assert.equal(code.includes('${table:detailList}'),false);}
 const native=harness({function:imports[0]},{nativeDispatch:true,baseMode:'amd'});assert.equal(native.opened(),true);assert.equal(native.modalCount(),1);assert.equal(native.callbackCount(),1);assert.deepEqual(native.requests,[]);assert.deepEqual(native.writes,[]);native.cancel();
 const altered=structuredClone(reviewed.dsl);altered.scripts.actions[0].function=altered.scripts.actions[0].function.replace('MKXFORM.setDetailValues(spec.tableId, rows);','MKXFORM.setDetailValues(spec.tableId, []);');assert.equal(checkTrust(scoped,altered).ok,false);const rejected=new FakeNewoaAdapter('persist');assert.equal((await executeDsl(altered,{client:rejected,baseUrl:'https://qas.example.invalid',confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'fixture',encryptedPassword:'fixture'}})).ok,false);assert.deepEqual(rejected.transcript(),[]);
 const stripped=structuredClone(reviewed.dsl);delete stripped.migrationPolicies;delete stripped.migrationPolicyAudit;assert.equal(checkTrust(scoped,stripped).ok,false);const bare=new FakeNewoaAdapter('persist');assert.equal((await executeDsl(stripped,{client:bare,baseUrl:'https://qas.example.invalid',confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'fixture',encryptedPassword:'fixture'}})).ok,false);assert.deepEqual(bare.transcript(),[]);
}));

it("refuses a readback system field that shadows mechanisms and never records the affected migration",async()=>withNetworkGuard(async()=>{
 const {source,decision}=input(),scoped=authorized(source,decision),reviewed=await runAgentReview(scoped,draftSourceDraft(scoped),{provider:createFakeReviewProvider('accept')});assert.equal(reviewed.ok,true,JSON.stringify(reviewed.diagnostics));
 class CorruptSystemAdapter extends FakeNewoaAdapter{async getTemplate(id){const template=await super.getTemplate(id);if(this.updated){const config=xformConfig(template),models=typeof config.dataModel==='string'?JSON.parse(config.dataModel):config.dataModel,main=models.find(model=>model.fdType==='main');main.fdFields.push({...main.fdFields[0],fdId:'reserved-fixture',fdName:'mechanisms',fdIsSystem:true});config.dataModel=models;template.mechanisms['sys-xform'].fdConfig=JSON.stringify(config);}return template;}}
 const client=new CorruptSystemAdapter('persist'),result=await executeDsl(reviewed.dsl,{client,baseUrl:'https://qas.example.invalid',confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'fixture',encryptedPassword:'fixture'}});assert.equal(result.ok,false);assert.equal(result.readback?.ok,false,JSON.stringify({keys:Object.keys(result),diagnostics:result.diagnostics,stage:result.stage}));assert.ok(JSON.stringify(result).includes('readback.form.system_reserved_context_collision'),JSON.stringify(result.readback));assert.equal(client.transcript().some(item=>item.operation==='add-transfer-record'),false);
}));

it("the no-policy public route remains blocked before any fake target call",async()=>withNetworkGuard(async()=>{const {draft}=input(),client=new FakeNewoaAdapter('persist');const r=await executeDsl(draft,{client,confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'fixture',encryptedPassword:'fixture'}});assert.equal(r.ok,false);assert.deepEqual(client.transcript(),[]);}));

function harness(action,options={}){
const requests=[],writes=[],downloads=[],timers=[],moduleLookups=[],notices=[];let modal,serial=0,modalCount=0,callbackCount=0,contextReads=0,loaderReads=0;const UI={Upload:'NativeUpload',Button:'NativeButton',Table:'NativeTable'},React={createElement(type,props,...children){return{type,props:{...props,children}}}};
class FormData{constructor(){this.fields=[];}append(k,v){this.fields.push([k,v]);}}class Blob{constructor(parts){this.parts=parts;}}
const transport={post(url,dto,config){return new Promise((resolve,reject)=>requests.push({url,dto:dto instanceof FormData?{fields:dto.fields}:JSON.parse(JSON.stringify(dto)),config,resolve,reject}));}};
const MKXFORM={viewStatus:'add',message:{error(text){notices.push(text);}},getFormValues(){contextReads++;return options.badContext?{}:{_dynamicProps:{mechanisms:{'sys-xform':{dynamicProps:{unrendered:'keep',fd_current:'stale'}}}}};},getFormConfigs(){contextReads++;return{forms:[{items:[{key:'main.fd_current',kind:'control',controlProps:{$$tableType:'main',name:'fd_current',value:0}},{key:'native_table',kind:'control',controlProps:{$$tableType:'detail',$$tableName:'native_table',name:'native_table',value:{values:[{fd_job:'old'}]}}}]}]};},tableModal(e){modalCount++;modal=e.modal;return{update(p){Object.assign(modal,p);}}},setDetailValues(table,rows){writes.push({table,rows:JSON.parse(JSON.stringify(rows))});}};
const body={appendChild(){},removeChild(){}};const document={body,createElement(){return{style:{},click(){downloads.push(this.download);}}}};
let javascript=action.function.replaceAll('${table:detailList}','native_table').replaceAll('${xform:id}','FAKE_NEW_XFORM_ID');if(options.maxPolls)javascript=javascript.replace('"maxPolls":300','"maxPolls":'+options.maxPolls);
const base={innerHttp:transport},window={react:React,'@lui/core':UI,URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL(){}}};
const baseMode=options.baseMode||'amd',loader=function(){throw Error('Module lookup must not load resources');};
loader.getModule=function(name){assert.equal(this,loader);moduleLookups.push(name);if(baseMode==='throw')throw Error('synthetic module-cache error');if(baseMode==='missing-module')return undefined;if(baseMode==='wrong-namespace')return{default:base};if(baseMode==='missing-post')return{innerHttp:{}};return base;};
if(baseMode==='global')window['@elem/xform-base']=base;
if(baseMode!=='missing-loader')Object.defineProperty(window,'@ekp-infra/requirejs',{get(){loaderReads++;if(options.loaderThrows)throw Error('Global base must not consult loader');return loader;}});
const context=vm.createContext({window,MKXFORM,FormData,Blob,document,setTimeout(fn){const id=++serial;timers.push({id,fn});return id;},clearTimeout(id){const i=timers.findIndex(t=>t.id===id);if(i>=0)timers.splice(i,1);}});
vm.runInContext(javascript,context);
if(options.nativeDispatch){
 const hash=value=>createHash('sha256').update(value).digest('hex');
 assert.equal(hash(nativeButton.buttonCallback),nativeButton.buttonCallbackSha256);assert.equal(hash(nativeButton.dispatcher),nativeButton.dispatcherSha256);assert.equal(hash(nativeFlush.flush),nativeFlush.flushSha256);
 context.t=base;context.O=(_object,key,value)=>({[key]:value});context.S=values=>Array.from(values);
 vm.runInContext('var du=('+nativeFlush.flush+');'+nativeButton.dispatcher,context);
 const callback=context.onClick;context.f={type:'js'};context.r=base;context.m={onClick:[{name:'onClick',function(...args){callbackCount++;return callback(...args);}}]};context.b='fixture_button';context.x='fixture_main';context.w=undefined;context.A=undefined;context._='';
 vm.runInContext('('+nativeButton.buttonCallback+')({synthetic:true});',context);while(timers.length)timers.shift().fn();
}else context.onClick();
function find(type,node=modal?.content){if(!node||typeof node!=='object')return;if(node.type===type)return node;for(const child of node.props?.children||[]){const found=find(type,child);if(found)return found;}}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
return{requests,writes,downloads,moduleLookups,notices,opened:()=>Boolean(modal),modalCount:()=>modalCount,callbackCount:()=>callbackCount,contextReads:()=>contextReads,loaderReads:()=>loaderReads,file(){find(UI.Upload).props.customRequest({file:{synthetic:true},onSuccess(){},onError(){}});},confirm(){modal?.onOk();},cancel(){modal?.onCancel();},tick(){timers.shift()?.fn();},async reply(index,data){requests[index].resolve({data});await flush();},async reject(index){requests[index].reject(new Error('synthetic parser error'));await flush();},download(){find(UI.Button).props.onClick();}};
}
