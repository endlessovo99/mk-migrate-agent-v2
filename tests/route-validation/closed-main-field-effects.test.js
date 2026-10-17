import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {describe,it} from 'node:test';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {translateSysFormTemplateXml} from '../../src/translator/sysform-template-adapter.js';
import {sourceDraftFromLegacyDsl} from '../../src/translator/source-draft.js';
import {closedMainFieldEffectCandidates} from '../../src/translator/closed-main-field-effects.js';
import {attachMigrationPolicies,migrationPolicySourceDigest} from '../../src/translator/approved-migration-policies.js';
import {applyApprovedRadioOrdinalPolicies,validateApprovedRadioOrdinalDecisions} from '../../src/translator/approved-radio-ordinal-policy.js';
import {sha256Digest} from '../../src/agent-review/digest.js';
import {checkTrust} from '../../src/dsl/trust.js';
import {runAgentReview} from '../../src/agent-review/index.js';
import {buildDryRunPlan} from '../../src/executor/dry-run.js';
import {executeDsl} from '../../src/executor/execute.js';
import {FakeNewoaAdapter} from './fake-newoa-adapter.js';
import {createFakeReviewProvider} from './fake-review-provider.js';
import {withNetworkGuard} from './network-guard.js';

const plain='tests/fixtures/route-validation/closed-main-field-effects/route-closed-main-field-effects_SysFormTemplate.xml';
const ordinal='tests/fixtures/route-validation/approved-radio-ordinal-load/route-approved-radio-ordinal-load_SysFormTemplate.xml';
const hash=text=>'sha256:'+createHash('sha256').update(text).digest('hex');
const stage=path=>{const source=cleanSourceFile(path);return{source,draft:draftSourceDraft(source)}};
function decisionFor(source){const script=source.scripts.sources.find(s=>s.id==='fd_ordinal.script.1'),fact=script.semanticFacts.sourceFormRadioOrdinalDomain;return{kind:'source-form-radio-ordinal-load',sourceRef:script.sourceRef,sourceJavascriptSha256:hash(script.javascript),actionId:script.id+'.event.1',radioFieldIds:fact.groups.map(g=>g.fieldId),sourceDomainDigest:fact.digest};}
function authorize(source,decision=decisionFor(source)){return attachMigrationPolicies(source,{version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope:{baseUrl:'https://p-sit.onewo.com',targetCategoryId:'route-category-id'},authorization:{actor:'fixture-human',evidenceSha256:sha256Digest('Explicit fixture approval: source-form radio order replaces global renderer inputs; preserve ordinal branches and clears.')},decisions:[decision]});}

describe('closed main-field effects and explicit source-form radio ordinal Route-validation',()=>{
 it('retains original sources, imports the independent currency runtime, closes only proven absent pure/guarded effects, and preserves final placeholders',()=>{
  const {source,draft}=stage(plain),before=JSON.stringify(source);
  assert.ok(draft.scripts.actions.every(a=>a.translationStatus==='mapped'));
  const currency=draft.scripts.actions.filter(a=>a.functionMappings.some(m=>m.basis==='deterministic-china-value-runtime'));
  assert.deepEqual(currency.map(a=>a.event),['onChange','onLoad']);
  assert.equal(draft.form.fields.find(f=>f.id==='fd_upper').props.readOnly,true);
  assert.equal(draft.form.fields.find(f=>f.id==='fd_a').props.placeholder,'final hint');
  assert.equal(draft.scripts.actions.find(a=>a.id==='fd_behavior.script.1.event.1').semanticHints.closedMainFieldEffects.closures[0].kind,'absent-pure-currency-target');
  assert.equal(draft.scripts.actions.find(a=>a.event==='onLoad'&&a.id.startsWith('fd_behavior')).semanticHints.closedMainFieldEffects.closures[0].kind,'absent-guarded-placeholder');
  assert.equal(JSON.stringify(source),before);
  const values={fd_amount:1.01};Function('MKXFORM',currency[0].function+';return onChange;')({getValue:id=>values[id],setValue:(id,v)=>values[id]=v})();assert.equal(values.fd_upper,'壹元零壹分');
 });
 it('preserves literal resets and source option order for joined approval helper values',()=>{
  const {source,draft}=stage(plain);
  const choice=draft.scripts.actions.find(a=>a.controlId==='fd_choice'),join=draft.scripts.actions.find(a=>a.controlId==='fd_checks');
  for(const selected of ['A','B','']){const values={fd_a:'keep A',fd_b:'keep B'},writes=[];Function('MKXFORM',choice.function+';return onChange;')({getValue:id=>values[id],setValue:(id,v)=>{values[id]=v;writes.push(id)},setFieldAttr(){}})(selected);assert.deepEqual(writes,selected==='A'?['fd_b']:selected==='B'?['fd_a']:[]);}
  for(const selected of [[],['Y'],['Y','X'],['X','Y']]){let result;Function('MKXFORM',join.function+';return onChange;')({getValue:()=>selected,setValue:(id,v)=>{assert.equal(id,'fd_mirror');result=v}})();assert.equal(result,['X','Y'].filter(v=>selected.includes(v)).join('-'));}
  assert.ok(source.scripts.sources[0].javascript.includes('mirror.value = joined'));
 });
 it('does not promote live targets, missing runtime conversion, shadowed APIs, or stale negative source evidence',()=>{
  const changed=readFileSync(plain,'utf8').replace('&lt;script&gt;Com_IncludeFile','&lt;input id="fd_retired_upper" /&gt;&lt;script&gt;Com_IncludeFile');
  const withRuntimeControl=sourceDraftFromLegacyDsl(translateSysFormTemplateXml(changed,{sourcePath:plain}));
  assert.equal(draftSourceDraft(withRuntimeControl).scripts.actions.find(a=>a.id==='fd_behavior.script.1.event.1').translationStatus,'needs_review');
  for(const mutate of [
   s=>{s.scripts.sources[0].javascript+='\nGetXFormFieldById("fd_retired_upper")[0].value="new";';},
   s=>{s.scripts.sources=s.scripts.sources.filter(x=>!x.javascript.includes('Com_IncludeFile'));},
   s=>{s.scripts.sources[0].javascript=s.scripts.sources[0].javascript.replace('function(value, domElement)','function(value, GetXFormFieldById)');}
  ]){const {source,draft}=stage(plain);mutate(source);const candidate=closedMainFieldEffectCandidates(source.scripts.sources[0],draft.form,source.scripts).find(c=>c.controlId==='fd_amount');assert.equal(candidate,undefined);}
  const {source,draft}=stage(plain);draft.form.fields.push({id:'fd_retired_upper',type:'text',componentId:'xform-input',props:{}});assert.equal(closedMainFieldEffectCandidates(source.scripts.sources[0],draft.form,source.scripts).some(c=>c.controlId==='fd_amount'),false);
 });
 it('requires the exact explicit policy and seals source group order, options, callback, and implementation',()=>{
  const {source,draft}=stage(ordinal),decision=decisionFor(source);
  assert.equal(draft.scripts.actions.find(a=>a.id===decision.actionId).translationStatus,'needs_review');
  assert.throws(()=>applyApprovedRadioOrdinalPolicies(source,draft,[decision]),/authorized manifest/);
  for(const changed of [{...decision,extra:true},{...decision,radioFieldIds:[...decision.radioFieldIds,decision.radioFieldIds[0]]}])assert.equal(validateApprovedRadioOrdinalDecisions([changed]).ok,false);
  for(const change of [d=>({...d,radioFieldIds:[...d.radioFieldIds].reverse()}),d=>({...d,sourceDomainDigest:'sha256:'+'1'.repeat(64)}),d=>({...d,sourceJavascriptSha256:'sha256:'+'2'.repeat(64)})]){const bad=change(decision),authorized=authorize(source,bad);assert.throws(()=>draftSourceDraft(authorized));}
  const approved=authorize(source),compiled=draftSourceDraft(approved),action=compiled.scripts.actions.find(a=>a.id===decision.actionId),audit=compiled.migrationPolicyAudit.audits[0];
  assert.equal(action.translationStatus,'mapped');assert.equal(audit.radioScans,1);assert.equal(audit.fieldWrites,1);assert.equal(audit.rowEffects,6);assert.equal(compiled.form.fields.find(f=>f.id==='fd_a').props.placeholder,'final hint');assert.doesNotMatch(action.function,/document\.|parentNode|innerHTML|GetXFormFieldById/);
 });
 it('preserves the source ordinal algorithm including empty earlier groups, OR priority and amount clearing under the approved form-domain interpretation',()=>{
  const {source}=stage(ordinal),approved=authorize(source),draft=draftSourceDraft(approved),decision=decisionFor(source),script=source.scripts.sources.find(s=>s.sourceRef===decision.sourceRef),generated=draft.scripts.actions.find(a=>a.id===decision.actionId).function,groups=script.semanticFacts.sourceFormRadioOrdinalDomain.groups;
  for(const values of [
   {fd_choice:'A',fd_middle1:'m1',fd_middle2:'n1',fd_contract:'y',fd_extra1:'e1',fd_extra2:'z1'},
   {fd_choice:'B',fd_middle1:'m1',fd_middle2:'n1',fd_contract:'n',fd_extra1:'e1',fd_extra2:'z1'},
   {fd_choice:'',fd_middle1:'m1',fd_middle2:'n1',fd_contract:'y',fd_extra1:'e1',fd_extra2:'z1'},
   {fd_choice:'A',fd_middle1:'',fd_middle2:'',fd_contract:'y',fd_extra1:'e1',fd_extra2:'z1'},
   {fd_choice:'',fd_middle1:'',fd_middle2:'',fd_contract:'',fd_extra1:'',fd_extra2:''}
  ])assert.deepEqual(observe(generated,values,groups,true),observe(script.javascript,values,groups,false));
 });
 it('crosses normal fake review, trust, dry-run, draft writes, readback and transfer record with networking prohibited',async()=>{
  await withNetworkGuard(async()=>{for(const path of [plain,ordinal]){const original=cleanSourceFile(path),source=path===ordinal?authorize(original):original,draft=draftSourceDraft(source),reviewed=await runAgentReview(source,draft,{provider:createFakeReviewProvider('accept'),reviewedAt:'2026-10-17T00:00:00.000Z'});assert.equal(reviewed.ok,true,JSON.stringify(reviewed.report?.diagnostics));assert.equal(checkTrust(source,reviewed.dsl).ok,true);assert.equal(buildDryRunPlan(reviewed.dsl).ok,true);const client=new FakeNewoaAdapter('persist'),executed=await executeDsl(reviewed.dsl,{client,credentials:{username:'fixture',encryptedPassword:'fixture-password'},confirmWrite:true,targetCategoryId:'route-category-id',now:new Date('2026-10-17T00:00:00.000Z'),transferRecordIdFactory:()=> 'route0000000000000000000000000000000'});assert.equal(executed.ok,true,JSON.stringify(executed.diagnostics));assert.equal(executed.readback.ok,true);assert.equal(client.transcript().at(-1).operation,'add-transfer-record');}});
 });
});
function observe(javascript,input,groups,target){const values={fd_a:'a',fd_b:'b',fd_amount:123,...input},rows={},writes=[];const row=(id,visible,required)=>rows[id]={visible,required};const MKXFORM={getValue:id=>values[id],setValue:(id,v)=>{values[id]=v;writes.push([id,v])},setFieldAttr:(id,flag)=>{const state=rows[id]||(rows[id]={});if(flag===4)state.visible=false;if(flag===5)state.visible=true;if(flag===3)state.required=true;if(flag===6)state.required=false;}};const inventory=()=>groups.flatMap(g=>g.options.map(o=>({value:o.value,checked:values[g.fieldId]===o.value,parentNode:{innerHTML:o.label},getAttribute:name=>name==='type'?'radio':values[g.fieldId]===o.value?'':null})));if(target)Function('MKXFORM',javascript+';return onLoad;')(MKXFORM)();else Function('window','Com_AddEventListener','GetXFormFieldById','common_dom_row_set_show_required_reset','document',javascript)({},(_w,_event,fn)=>fn(),id=>{const group=groups.find(g=>g.fieldId===id);if(group)return inventory().slice(groups.slice(0,groups.indexOf(group)).reduce((n,g)=>n+g.options.length,0)).slice(0,group.options.length);if(id==='fd_retired_hint')return[];return[{get value(){return values[id]},set value(v){values[id]=v;writes.push([id,v])},setAttribute(){}}]},row,{getElementsByTagName:inventory});return{values:{fd_a:values.fd_a,fd_b:values.fd_b,fd_amount:values.fd_amount},rows,writes};}
