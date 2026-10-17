import assert from 'node:assert/strict';
import {it} from 'node:test';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
const fixture='tests/fixtures/route-validation/timed-main-row-lifecycle/route-timed-main-row_SysFormTemplate.xml';
it('preserves timer scheduling and its ordered main-row initialization alongside change effects',()=>{
const d=draftSourceDraft(cleanSourceFile(fixture));
assert.equal(d.scripts.actions.length,2);assert.ok(d.scripts.actions.every(a=>a.translationStatus==='mapped'),'Complete timer and change callbacks must both be source-bound mapped actions');
assert.match(d.scripts.actions.find(a=>a.event==='onLoad').function,/setTimeout\(function\(\) \{/);
});

import {inlineRadioRowEffectCandidates} from '../../src/translator/inline-radio-row-effects.js';
import {createTrustedMigrationDsl} from '../../src/dsl/trust.js';
import {buildDryRunPlan} from '../../src/executor/dry-run.js';
import {executeDsl} from '../../src/executor/execute.js';
import {FakeNewoaAdapter} from './fake-newoa-adapter.js';
import {withNetworkGuard} from './network-guard.js';
const original=cleanSourceFile(fixture);
const initialDraft=draftSourceDraft(original);
const sourceScript=original.scripts.sources[0];
const actions=text=>inlineRadioRowEffectCandidates({...sourceScript,javascript:text},initialDraft.form,initialDraft.formRules);

it('matches source effects before and after the scheduled deadline and reads at callback time',()=>{
const mapped=initialDraft.scripts.actions;
for(const value of ['A','B','',undefined]) {
const old=observe(sourceScript.javascript,false,{fd_mode:value}),next=observe(mapped.map(a=>a.function).join('\n'),true,{fd_mode:value});
old.load();next.load();assert.deepEqual(old.trace,next.trace);assert.deepEqual(old.trace,[['schedule',510]]);
old.advance(509);next.advance(509);assert.deepEqual(old.trace,next.trace);
old.values.fd_mode='B';next.values.fd_mode='B';old.advance(510);next.advance(510);assert.deepEqual(old.trace,next.trace);assert.deepEqual(old.values,next.values);
assert.ok(next.trace.findIndex(e=>e[0]==='attr')<next.trace.findIndex(e=>e[0]==='read'&&e[1]==='fd_mode'));
}
for(const value of ['A','B','']) {
const old=observe(sourceScript.javascript,false,{fd_mode:'A',fd_reset:['Y'],fd_mirror:'old'}),next=observe(mapped.map(a=>a.function).join('\n'),true,{fd_mode:'A',fd_reset:['Y'],fd_mirror:'old'});
old.change(value);next.change(value);assert.deepEqual(old.trace,next.trace);assert.deepEqual(old.values,next.values);
}
});

it('keeps a different literal delay and refuses shadowing, cancellation, extra effects and incomplete choice clears',()=>{
assert.equal(actions(sourceScript.javascript.replace('},510);','},777);')).find(a=>a.event==='onLoad').semanticHints.sourceTimerDelay,777);
for(const text of [
sourceScript.javascript.replace('function(){setTimeout','function(setTimeout){setTimeout'),
sourceScript.javascript.replace('setTimeout(function(){','var timer=setTimeout(function(){').replace('},510);','},510);clearTimeout(timer);'),
sourceScript.javascript.replace('setTimeout(function(){','setTimeout(async function(){'),
sourceScript.javascript.replace('setTimeout(function(){','setTimeout(function(named){'),
sourceScript.javascript.replace('setTimeout(function(){','setTimeout(function(){unknownEffect();'),
sourceScript.javascript.replace('510);','waitTime);'),
sourceScript.javascript.replace(']:checked', ']:checked:first')
]) {
if(text===sourceScript.javascript)continue;
assert.equal(actions(text).some(a=>a.event==='onLoad'&&a.translationStatus==='mapped'),false,text);
}
for(const text of [
sourceScript.javascript.replace("$('input[name=\"_extendDataFormInfo.value(fd_reset)\"]').prop(\"checked\",false);",''),
sourceScript.javascript.replace('_extendDataFormInfo.value(fd_reset)','_extendDataFormInfo.value(fd_mode)'),
sourceScript.javascript.replace("$('input[name=\"_extendDataFormInfo.value(fd_reset)\"]').prop", "unknownEffect();$('input[name=\"_extendDataFormInfo.value(fd_reset)\"]').prop")
])assert.equal(actions(text).some(a=>a.event==='onChange'&&a.translationStatus==='mapped'),false);
});

it('retains a supported timer and an explicit unsupported sibling instead of dropping either callback',()=>{
const changed=sourceScript.javascript.replace('console.log("changed",value);','console.log("changed",value);unknownEffect();');
const result=actions(changed);assert.equal(result.length,2);assert.equal(result.find(a=>a.event==='onLoad').translationStatus,'mapped');
assert.equal(result.find(a=>a.event==='onChange').translationStatus,'needs_review');
assert.match(result.find(a=>a.event==='onChange').javascript,/unknownEffect/);
});

it('proves existing field-container truthiness and value.indexOf without treating scalar values as containers',()=>{
for(const condition of ['state && state.value=="A"','state.value.indexOf("B")>=0']) {
const text='Com_AddEventListener(window,"load",function(){var state=GetXFormFieldById("fd_mirror")[0];if('+condition+'){common_dom_row_set_show_required_reset("fd_a_row",true,false,false);}else{common_dom_row_set_show_required_reset("fd_a_row",false,false,false);}});';
const mapped=actions(text);assert.equal(mapped.length,1);assert.equal(mapped[0].translationStatus,'mapped');
for(const value of ['A','B','']){const old=observe(text,false,{fd_mirror:value}),next=observe(mapped[0].function,true,{fd_mirror:value});old.load();next.load();assert.deepEqual(old.trace,next.trace);}
const scalar=text.replace('GetXFormFieldById("fd_mirror")[0];','GetXFormFieldById("fd_mirror")[0].value;');
if(condition.includes('state &&'))assert.equal(actions(scalar).some(a=>a.translationStatus==='mapped'),false);
const diagnostic=actions(text.replace('if('+condition+')','console.log(state);if('+condition+')'));
// A pre-existing recipe may omit an inert DOM diagnostic; it must never emit
// the compiler's scalar snapshot as though it were the source DOM object.
for(const candidate of diagnostic.filter(action=>action.translationStatus==='mapped'))assert.doesNotMatch(candidate.function,/console\.log/);
assert.equal(actions(text.replaceAll('fd_mirror','fd_missing')).some(a=>a.translationStatus==='mapped'),false);
}
});

it('trusts and persists the exact scheduled action through fake NewOA readback and a migration receipt',async()=>withNetworkGuard(async()=>{
const dsl=createTrustedMigrationDsl(original,initialDraft,{externalAgentReviewed:true,reviewerName:'timer-route',checkedAt:'2026-10-17T00:00:00.000Z'});
assert.equal(buildDryRunPlan(dsl).ok,true);
const result=await executeDsl(dsl,{client:new FakeNewoaAdapter('persist'),confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'route-user',encryptedPassword:'route-password'},baseUrl:'https://p-sit.onewo.com',now:new Date('2026-10-17T00:00:00.000Z'),transferRecordIdFactory:()=> 'route0000000000000000000000000000000'});
assert.equal(result.ok,true,JSON.stringify(result.diagnostics));assert.equal(result.readback.status,'verified');assert.equal(result.transferRecord.status,'recorded');assert.equal(result.readback.form.scripts.actionCount,2);
}));

function observe(text,target,initial={}) {
const values={...initial},trace=[],timers=[];let load,change;
const row=(id,visible,required,reset)=>{trace.push(['attr',id,visible?5:4],['attr',id,required?3:6]);if(reset){for(const field of ({fd_a_row:['fd_payload_a'],fd_b_row:['fd_payload_b','fd_reset']}[id]||[]))recordSet(field,'');}};
const recordSet=(id,value)=>{values[id]=value;trace.push(['set',id,value]);};
const api={getValue(id){if(id==='fd_mode')trace.push(['read',id,values[id]]);return values[id];},setValue:recordSet,setFieldAttr(id,flag){trace.push(['attr',id,flag]);}};
const dom=id=>Object.defineProperty({},'value',{get(){return values[id]??''},set(value){recordSet(id,value)}});
const jquery=selector=>{const id=selector.match(/value\((fd_[\w]+)\)/)?.[1];return {val(...args){if(!args.length){trace.push(['read',id,values[id]]);return values[id];}values[id]=args[0];},prop(key,value){assert.equal(key,'checked');assert.equal(value,false);recordSet(id,[]);}};};
const timer=(fn,delay)=>{trace.push(['schedule',delay]);timers.push({fn,delay});};
const logger={log(...args){trace.push(['log',...args]);},debug(...args){trace.push(['debug',...args]);},info(...args){trace.push(['info',...args]);}};
if(target){const handlers=new Function('MKXFORM','setTimeout','console',text+';return {load:typeof onLoad==="function"?onLoad:undefined,change:typeof onChange==="function"?onChange:undefined};')(api,timer,logger);load=handlers.load;change=handlers.change;}
else new Function('Com_AddEventListener','AttachXFormValueChangeEventById','GetXFormFieldById','common_dom_row_set_show_required_reset','$','setTimeout','console','window',text)((_window,_event,fn)=>{load=fn},(_id,fn)=>{change=fn},id=>[dom(id)],row,jquery,timer,logger,{});
return {trace,values,load:()=>load?.(),change:value=>change?.(value,[]),advance(now){for(const entry of timers)if(!entry.done&&entry.delay<=now){entry.done=true;entry.fn();}}};
}

for (const [label, prelude, fieldId] of [
['another handle writes the same field', 'var first=GetXFormFieldById("fd_mirror")[0];var second=GetXFormFieldById("fd_mirror")[0];second.value="";', 'fd_mirror'],
['a row reset clears the handled field', 'var first=GetXFormFieldById("fd_payload_a")[0];common_dom_row_set_show_required_reset("fd_a_row",false,false,true);', 'fd_payload_a']
]) it('keeps a live DOM handle pending when '+label,()=>{
const text='Com_AddEventListener(window,"load",function(){setTimeout(function(){'+prelude+'if(first.value.indexOf("A")>=0){common_dom_row_set_show_required_reset("fd_b_row",true,false,false);}else{common_dom_row_set_show_required_reset("fd_b_row",false,false,false);}},510);});';
const source=observe(text,false,{[fieldId]:'A'});source.load();source.advance(510);
assert.deepEqual(source.trace.filter(entry=>entry[0]==='attr'&&entry[1]==='fd_b_row').map(entry=>entry[2]),[4,6]);
const [action]=actions(text);assert.ok(action);
if(action.translationStatus==='mapped'){
const target=observe(action.function,true,{[fieldId]:'A'});target.load();target.advance(510);
assert.deepEqual(target.trace,source.trace,'A DOM handle must observe later writes to its field, including writes through another alias or a row reset.');
}
assert.equal(action.translationStatus,'needs_review');
});

it('preserves an explicit scalar snapshot captured before a same-field handle write',()=>{
const text='Com_AddEventListener(window,"load",function(){setTimeout(function(){var first=GetXFormFieldById("fd_mirror")[0].value;var second=GetXFormFieldById("fd_mirror")[0];second.value="";if(first=="A"){common_dom_row_set_show_required_reset("fd_b_row",true,false,false);}else{common_dom_row_set_show_required_reset("fd_b_row",false,false,false);}},510);});';
const [action]=actions(text);assert.equal(action.translationStatus,'mapped');
const source=observe(text,false,{fd_mirror:'A'}),target=observe(action.function,true,{fd_mirror:'A'});source.load();target.load();source.advance(510);target.advance(510);assert.deepEqual(target.trace,source.trace);
});

it('defers an unsupported strict attempt to the established dynamic hyperlink recipe',()=>{
const source=cleanSourceFile('tests/fixtures/route-validation/dynamic-hyperlink-target/route-hyperlink-target_SysFormTemplate.xml');
const draft=draftSourceDraft(source),script=source.scripts.sources[0];
assert.deepEqual(inlineRadioRowEffectCandidates(script,draft.form,draft.formRules),[]);
assert.ok(draft.scripts.actions.some(action=>action.translationStatus==='mapped'&&action.semanticHints?.dynamicHyperlink));
});

it('keeps established diagnostic-alert qualification and bridged native visibility',()=>{
const resetSource=cleanSourceFile('tests/fixtures/route-validation/main-row-reset-lifecycle/route-main-row-reset-lifecycle_SysFormTemplate.xml');
const resetDraft=draftSourceDraft(resetSource);
assert.ok(resetDraft.scripts.actions.some(action=>action.semanticHints?.omittedDiagnosticAlerts?.count===3));
const load=resetSource.scripts.sources.find(script=>script.javascript.includes('Com_AddEventListener'));
const altered={...load,javascript:load.javascript.replace('alert(isGzSubtype.value);','alert("Keep this message");')};
assert.deepEqual(inlineRadioRowEffectCandidates(altered,resetDraft.form,resetDraft.formRules),[]);
const bridge=draftSourceDraft(cleanSourceFile('tests/fixtures/source/1670297c984b45009eb5b1e444d9957d'));
const action=bridge.scripts.actions.find(action=>action.id==='fd_3e502424ad4b9e.script.2.event.1');
assert.equal(action.translationStatus,'mapped');assert.ok(action.coverage.nativeRules.length>0);
assert.doesNotMatch(action.function,/MKXFORM\.setFieldAttr\("aqxy_row", [45]\)/);
});

it('does not let legacy fallback re-enable an invalidated immediate DOM handle',()=>{
const text='Com_AddEventListener(window,"load",function(){var first=GetXFormFieldById("fd_mirror")[0];var second=GetXFormFieldById("fd_mirror")[0];second.value="";if(first.value.indexOf("A")>=0){common_dom_row_set_show_required_reset("fd_a_row",true,false,false);}else{common_dom_row_set_show_required_reset("fd_a_row",false,false,false);}});';
const source=observe(text,false,{fd_mirror:'A'});source.load();assert.deepEqual(source.trace.filter(entry=>entry[0]==='attr').map(entry=>entry[2]),[4,6]);
const [candidate]=actions(text);assert.equal(candidate.translationStatus,'needs_review');assert.match(candidate.javascript,/second\.value/);
});
