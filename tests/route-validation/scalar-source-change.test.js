import { nativeMessageRuntime } from "../helpers/native-message-runtime.js";
import assert from 'node:assert/strict';
import {it} from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {translateSysFormTemplateXml} from '../../src/translator/sysform-template-adapter.js';
import {sourceDraftFromLegacyDsl} from '../../src/translator/source-draft.js';
import {scalarSourceChangeCandidates,SCALAR_SOURCE_CHANGE_BASIS} from '../../src/translator/scalar-source-change.js';
import {NATIVE_DATE_ONLY_TEXT_CONTRACT} from '../../src/translator/native-date-only-value.js';
import {runAgentReview} from '../../src/agent-review/index.js';
import {checkTrust} from '../../src/dsl/trust.js';
import {buildDryRunPlan} from '../../src/executor/dry-run.js';
import {executeDsl} from '../../src/executor/execute.js';
import {FakeNewoaAdapter} from './fake-newoa-adapter.js';
import {createFakeReviewProvider} from './fake-review-provider.js';
import {withNetworkGuard} from './network-guard.js';
const fixture='tests/fixtures/route-validation/scalar-source-change/route-scalar-source-change_SysFormTemplate.xml';
const input=()=>{const source=cleanSourceFile(fixture);return{source,draft:draftSourceDraft(source)}};
const get=(source,draft,index)=>scalarSourceChangeCandidates(source.scripts.sources[index],draft.form,source.scripts)[0];
it('compiles complete scalar/date callbacks with a bound calendar-text bridge and unchanged source Date/console branches',()=>{
 const {source,draft}=input(),before=JSON.stringify(source),candidates=source.scripts.sources.map((s,i)=>get(source,draft,i));
 assert.equal(candidates.length,3);assert.ok(candidates.every(c=>c?.translationStatus==='mapped'&&c.functionMappings[0].basis===SCALAR_SOURCE_CHANGE_BASIS));
 const proof=candidates[0].semanticHints.scalarSourceChange;assert.equal(proof.dateConstructors,2);assert.equal(proof.alertRanges.length,2);assert.equal(proof.consoleRanges.length,4);
 assert.equal(proof.eventValue,'native-date-display-text');assert.equal(proof.inputEmptyProjection,'native-date-display-text-nullish-only');assert.deepEqual(proof.nativeDateOnlyTextContract,NATIVE_DATE_ONLY_TEXT_CONTRACT);assert.deepEqual(proof.dateReadFieldIds,['fd_start']);assert.equal(proof.dateEventFieldId,'fd_end');
 assert.match(candidates[0].function,/const first = new Date\(start\)/);assert.match(candidates[0].function,/const last = new Date\(__sourceDateEvent\)/);assert.doesNotMatch(candidates[0].function,/String\(|setTimeout|new Date\(\)/);
 assert.match(candidates[0].function,/getValueText\("\$\{table:@main\}\.fd_start"\)/);assert.match(candidates[0].function,/getValueText\("\$\{table:@main\}\.fd_end"\)/);
 assert.equal(candidates[1].semanticHints.scalarSourceChange.eventValue,'unchanged');assert.match(candidates[1].function,/getValue\("fd_total"\) \?\? ""/);assert.equal(JSON.stringify(source),before);
});
it('matches source date traces for epoch zero, Date/string points, equal/reversed dates, clear and DST calendar text',()=>{
 const {source,draft}=input(),candidate=get(source,draft,0),startDate=new Date('2026-10-17T00:00:00Z');
 const cases=[['2026-10-17','2026-10-18'],['2026-10-18','2026-10-17'],['2026-10-17','2026-10-17'],['','2026-10-17'],[null,'2026-10-17'],[undefined,'2026-10-17'],['bad','also bad'],['2026-10-17',''],['2026-10-17',null],['2026-10-17',undefined],[0,0],[startDate,new Date('2026-10-16T00:00:00Z')],[1792195200000,1792281600000],['1792195200000','1792281600000',{fd_start:'2026-10-17',fd_end:'2026-10-18'}],[Date.UTC(2026,2,7,5),Date.UTC(2026,2,8,4),{fd_start:'2026-03-07',fd_end:'2026-03-08'}],[Date.UTC(2026,10,1,4),Date.UTC(2026,10,2,5),{fd_start:'2026-11-01',fd_end:'2026-11-02'}]];
 for(const [start,event,texts]of cases)assert.deepEqual(observe(candidate.function,{fd_start:start,fd_end:event},event,true,{texts}),observe(source.scripts.sources[0].javascript,{fd_start:start,fd_end:event},event,false,{texts}));
 const calls=[];observe(candidate.function,{fd_start:0,fd_end:undefined},undefined,true,{texts:{fd_start:'1970-01-01',fd_end:'-'},onTextRead:id=>calls.push(id)});assert.deepEqual(calls,['${table:@main}.fd_start']);
 const reverse=observe(candidate.function,{fd_start:'2026-10-18',fd_end:'2026-10-17'},'2026-10-17',true);assert.deepEqual(reverse.slice(-2),[['alert','Start must precede end'],['write','fd_end','']]);
 const script=source.scripts.sources[0];script.javascript=script.javascript.replace("current.val('');","current.val(''); console.log('after clear',value);");const afterClear=get(source,draft,0),textReads=[];
 assert.deepEqual(observe(afterClear.function,{fd_start:'2026-10-18',fd_end:'2026-10-17'},'2026-10-17',true,{onTextRead:id=>textReads.push(id)}),observe(script.javascript,{fd_start:'2026-10-18',fd_end:'2026-10-17'},'2026-10-17',false));assert.equal(textReads.filter(id=>id==='${table:@main}.fd_end').length,1);
});
it('fails closed for unavailable/wrong native date text, unsupported points, changed formats and event cache collisions',()=>{
 const {source,draft}=input(),candidate=get(source,draft,0);
 for(const [raw,text]of [[0,undefined],[0,null],[new Date(0),new Date(0)],[false,'1970-01-01'],[[], '1970-01-01']])assert.throws(()=>observe(candidate.function,{fd_start:0,fd_end:raw},raw,true,{texts:{fd_start:'1970-01-01',fd_end:text}}),/Native date|Unsupported native DatePoint/);
 for(const text of ['bad','-','1970/01/01','0'])assert.deepEqual(observe(candidate.function,{fd_start:0,fd_end:0},0,true,{texts:{fd_start:'1970-01-01',fd_end:text}}),observe(source.scripts.sources[0].javascript,{fd_start:0,fd_end:0},0,false,{texts:{fd_start:'1970-01-01',fd_end:text}}));
 const changed=structuredClone(draft);changed.form.fields.find(f=>f.id==='fd_end').props.displayPattern='yyyy-MM';assert.equal(get(source,changed,0),undefined);
 const script=source.scripts.sources[0];script.javascript=script.javascript.replace('var start=','var __sourceDateEvent=1; var start=');assert.equal(scalarSourceChangeCandidates(script,draft.form,source.scripts).length,0);
});
it('retains budget clear before else diagnostics and preserves Number coercions, invalids, zero and false',()=>{
 const {source,draft}=input(),candidate=get(source,draft,1);
 for(const [total,event]of [[10,0],[10,-1],[10,5],[10,10],[10,11],[0,false],[false,1],[null,1],[undefined,1],['',''],['bad','bad'],['1000','1e3'],[Infinity,1],[-Infinity,1]])assert.deepEqual(observe(candidate.function,{fd_total:total,fd_budget:event},event,true),observe(source.scripts.sources[1].javascript,{fd_total:total,fd_budget:event},event,false));
 assert.deepEqual(observe(candidate.function,{fd_total:10,fd_budget:-1},-1,true).slice(1),[['alert','Budget must be positive'],['write','fd_budget','']]);
});
it('retains aggregate comparison without adding a clear or swallowing zero/false',()=>{
 const {source,draft}=input(),candidate=get(source,draft,2);
 for(const [budget,event]of [[10,11],[10,10],[10,9],[0,1],[false,0],[null,1],[undefined,1],['bad',1],[1,'bad'],['',0]])assert.deepEqual(observe(candidate.function,{fd_budget:budget,fd_total:event},event,true),observe(source.scripts.sources[2].javascript,{fd_budget:budget,fd_total:event},event,false));
 assert.deepEqual(candidate.semanticHints.scalarSourceChange.writeFieldIds,[]);
});
it('rejects side effects, control flow, async kinds, parameter initializers, shadowed APIs and unrelated writes',()=>{
 const mutations=[s=>s.replace('var total=','audit(); var total='),s=>s.replace('var total=','return; var total='),s=>s.replace('var total=','throw "stop"; var total='),s=>s.replace('var total=','for(;;){} var total='),s=>s.replace('function(value, domElement)','async function(value, domElement)'),s=>s.replace('function(value, domElement)','function*(value, domElement)'),s=>s.replace('function(value, domElement)','function(value, domElement=unknown())'),s=>s.replace('function(value, domElement)','function(value, Number)'),s=>s.replace('GetXFormFieldById("fd_total")[0]','GetXFormFieldById("fd_total")[1]'),s=>s.replace("current.val('')","current.val(''); unknown()"),s=>s.replace('value <= 0','Number(value)<=0 || true'),s=>s.replace('value <= 0','Number(value)<=0 && unknown()'),s=>s.replace('fd_budget)\"]','fd_base)\"]'),s=>s.replace("console.log('total',total)","console.log('total',unknown(total))"),s=>s.replace('Number(value)','Reflect.apply(Number,null,[value])')];
 for(const mutate of mutations){const {source,draft}=input(),script=source.scripts.sources[1],original=script.javascript;script.javascript=mutate(original);assert.notEqual(script.javascript,original,'Negative mutation must change source');assert.equal(scalarSourceChangeCandidates(script,draft.form,source.scripts).length,0,script.javascript);}
 const {source,draft}=input();source.scripts.sources.push({sourceRef:'other',javascript:'Number=other;'});assert.equal(scalarSourceChangeCandidates(source.scripts.sources[1],draft.form,source.scripts).length,0);
});
it('requires one exact main designer/runtime/metadata input binding before scalar projection',()=>{
 for(const change of [d=>d.form.fields.find(f=>f.id==='fd_total').dataOnly=true,d=>d.form.fields.find(f=>f.id==='fd_total').sourceProps.metadataAttributes.type='String',d=>d.form.fields.find(f=>f.id==='fd_total').sourceProps.mainStringValueBindingFact.surfaces.display.logicalBindingCount=2,d=>d.form.fields.find(f=>f.id==='fd_budget').sourceProps.mainStringValueBindingFact.metadata.count=2]){const {source,draft}=input();change(draft);assert.equal(get(source,draft,1),undefined);}
 const xml=readFileSync(fixture,'utf8').replace('&lt;xform:xtext property="extendDataFormInfo.value(fd_total)" dataType="Double" /&gt;','&lt;xform:xtext property="extendDataFormInfo.value(fd_total)" dataType="Double" /&gt;&lt;xform:xtext property="extendDataFormInfo.value(fd_total)" dataType="Double" /&gt;');
 const source=sourceDraftFromLegacyDsl(translateSysFormTemplateXml(xml,{sourcePath:fixture})),draft=draftSourceDraft(source);assert.equal(get(source,draft,1),undefined);
});
it('passes ordinary fake review, trust, dry-run, persisted main-table date text binding, readback and transfer record',async()=>{
 await withNetworkGuard(async()=>{const {source,draft}=input();assert.equal(draft.scripts.actions.filter(a=>a.functionMappings.some(m=>m.basis===SCALAR_SOURCE_CHANGE_BASIS)).length,3);const reviewed=await runAgentReview(source,draft,{provider:createFakeReviewProvider('accept'),reviewedAt:'2026-10-17T00:00:00.000Z'});assert.equal(reviewed.ok,true,JSON.stringify(reviewed.report));assert.equal(checkTrust(source,reviewed.dsl).ok,true);assert.equal(buildDryRunPlan(reviewed.dsl).ok,true);const client=new FakeNewoaAdapter('persist'),executed=await executeDsl(reviewed.dsl,{client,credentials:{username:'fixture',encryptedPassword:'fixture'},confirmWrite:true,targetCategoryId:'route-category-id',now:new Date('2026-10-17T00:00:00Z'),transferRecordIdFactory:()=> 'route0000000000000000000000000000000'});assert.equal(executed.ok,true,JSON.stringify(executed.diagnostics));assert.equal(executed.readback.ok,true);assert.equal(client.transcript().at(-1).operation,'add-transfer-record');});
});
function observe(text,input,event,target,options={}){const values={...input},trace=[],listeners=[];const empty=value=>value===null||value===undefined?'':value;const serialize=value=>Object.prototype.toString.call(value)==='[object Date]'?{date:Number.isNaN(value.getTime())?'Invalid Date':value.getTime()}:value;const display=(raw,id)=>{if(options.texts&&Object.hasOwn(options.texts,id))return options.texts[id];if(typeof raw==='string')return raw;const date=new Date(raw);return Number.isNaN(date.getTime())?'Invalid Date':date.toISOString().slice(0,10)};const sourceValue=(raw,id)=>['fd_start','fd_end'].includes(id)?raw===null||raw===undefined||raw===''?'':display(raw,id):empty(raw);const dateEvent=Object.hasOwn(input,'fd_end');const context=vm.createContext({Date,Number,parseFloat,console:{log:(...args)=>trace.push(['console',...args.map(serialize)])},alert:message=>trace.push(['alert',message]),AttachXFormValueChangeEventById:(_id,fn)=>listeners.push(fn),GetXFormFieldById:id=>[{get value(){const value=sourceValue(values[id],id);trace.push(['read',id,serialize(value)]);return value}}],$:selector=>({val:value=>{const id=/value\(([^)]+)\)/.exec(selector)[1];values[id]=value;trace.push(['write',id,value])}}),MKXFORM:{getValue:id=>{trace.push(['read',id,serialize(sourceValue(values[id],id))]);return values[id]},getValueText:id=>{assert.match(id,/^\$\{table:@main\}\.fd_/);options.onTextRead?.(id);const field=id.slice('${table:@main}.'.length);return display(values[field],field)},setValue:(id,value)=>{values[id]=value;trace.push(['write',id,value])},...nativeMessageRuntime('desktop', message=>trace.push(['alert',message])).MKXFORM}});vm.runInContext(text,context,{timeout:1000});if(target)context.onChange(event);else listeners[0](dateEvent?sourceValue(event,'fd_end'):event);return trace;}
