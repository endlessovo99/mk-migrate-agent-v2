import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { cleanSourceFile, draftSourceDraft } from '../../src/translator/index.js';
import { withDetailEventReadBridge } from '../../src/executor/persistence/detail-event-read-bridge.js';
import { prepareSample, formAttr } from '../helpers/persistence.js';
const dsl=draftSourceDraft(cleanSourceFile('tests/fixtures/route-validation/allowance-row-lifecycle/route-allowance-row-lifecycle_SysFormTemplate.xml'));
const sourceBefore=JSON.stringify(dsl);
const writer=JSON.parse(fs.readFileSync(new URL('../fixtures/route-validation/detail-event-value-commit/native-contract.json',import.meta.url)));
const lifecycle=JSON.parse(fs.readFileSync(new URL('../fixtures/route-validation/allowance-row-lifecycle/native-contract.json',import.meta.url)));
const readAbi=JSON.parse(fs.readFileSync(new URL('../fixtures/route-validation/detail-event-live-table-read/native-contract.json',import.meta.url)));
const prepared=prepareSample(dsl),nativeActions=formAttr(prepared.update).controlAction.control;
const table='fd_receipts',column='fd_receipt_value',physical=table+'.'+column,clone=value=>structuredClone(value);
function runtime(options={}){
 const {multiple=false,tamper,first=1.23,next=4.56,mode=0}=options,oldSecond=Object.hasOwn(options,'oldSecond')?options.oldSecond:2.34;
 const sourceAction=nativeActions[table+'.'+column].onChange[0];
 const afterDel=nativeActions[table+'.'+table].onAfterDel[0];
 const state={fd_trip_mode:mode,fd_trip_start:'2026-10-22 08:00:00',fd_trip_end:'2026-10-22 18:00:00',fd_people:1,fd_package_mode:'0'},writes=[],commits=[];
 let rendered=[{key:11,[physical]:first,fd_note:'keep-first'},{key:22,[physical]:oldSecond,fd_note:'keep-second'}];
 if(oldSecond===undefined)delete rendered[1][physical];
 const initial=clone(rendered),ko={current:clone(rendered)},published={values:[]},dataState={keep:'audit'},deleteState=[{key:'old-delete',fd_id:'retained-id'}];
 const formatRows=Function('c','r','u','T',`return (${readAbi.functions.formatRows.text});`)(undefined,table,{},Array.from);
 const format=rows=>({values:formatRows(rows),dataState,deleteState});
 const window={MXFORM_ACTIONS:{}},meta={kind:'control',name:table,isInvalid:false,props:{showStatus:'add',columns:[{kind:'control',controlProps:{name:column,showStatus:'add'},labelProps:{}}]}},hidden={};
 const api={viewStatus:'add',$$FORM:{current:{$:key=>key===table?{_CURRENT_FIBRE:meta}:null}},getValue:key=>key===table?published:state[key],setValue(key,value){writes.push({key,value});state[key]=value;}};
 const context=vm.createContext({MKXFORM:api,window});
 const compile=source=>vm.runInContext('('+source.replaceAll('${table:'+table+'}',table)+')',context);
 const entry={id:sourceAction.id,function:compile(sourceAction.function)},deleteEntry={id:afterDel.id,function:compile(afterDel.function)};
 const handle={getTableName:()=>table,getLatestValue:()=>format(ko.current),getCurrentValues:()=>Function('fo','Wr','Dr','q',`return (${writer.functions.currentRows.text})();`)(rendered,meta.props.columns,hidden,table),getHiddenData:()=>hidden,updateRowValue(request){commits.push(clone(request));const merge=Function('In',`return (${writer.functions.mergeRow.text});`)((name,table)=>table+'.'+name);const bindings={T:Array.from,ko,Zr:({source})=>clone(source||{}),q:table,to:v=>v,io(){assert.fail('nested rows out of scope');},jn:merge,fo:clone(rendered),no:undefined,qo:format,De(data){published.values=clone(data.values);},po(rows){rendered=clone(rows);ko.current=rows;},Do:{current:deleteState},ao:{}};Function(...Object.keys(bindings),`return (${writer.functions.updateRowValue.text});`)(...Object.values(bindings))(request);}};
 api.$$DETAILFORMS={current:{[table]:{current:handle}}};
 function register(index,value){ko.current[index][physical]=value;const key=table+'.'+column+'~'+ko.current[index].key;window.MXFORM_ACTIONS[key]={actionTableType:'detail',actionTableName:table,actionFuns:{onChange:[entry]},actionParams:{onChange:[value,index]}};}
 register(1,next);if(multiple)register(0,9.87);
 tamper?.({api,meta,hidden,ko,window,handle,rendered,entry});
 entry.function.call(entry,multiple?9.87:next,multiple?0:1);
 const afterEdit={total:state.fd_receipt_result,rendered:clone(rendered),latest:clone(ko.current),commits:clone(commits)};
 function remove(keys){const host={o:rendered,d:table,N:keys,m:{[table+'.'+table]:{onAfterDel:[deleteEntry]}},n:{actionFunsRunner(target,byEvent,event,data){assert.equal(event,'onAfterDel');deleteEntry.function.call(deleteEntry,data);}},s(){},D(){},u(rows){rendered=clone(rows);ko.current=rows;}};Function(...Object.keys(host),`return (${lifecycle.functions.deleteHook.text})();`)(...Object.values(host));}
 remove([11]);
 return{state,writes,commits,afterEdit,rendered,initial,dataState,deleteState,editRemaining(value){register(0,value);entry.function.call(entry,value,0);},remove,get rows(){return rendered;}};
}
test('the captured native writer and delete hook preserve stale/missing values and reject uncertain publication contexts',()=>{
const results=[];
for(const oldSecond of[2.34,undefined]){const h=runtime({oldSecond});results.push({name:oldSecond===undefined?'missing-native-button-value':'stale-native-button-value',actual:h.state.fd_receipt_result,expected:4.56,commits:h.commits});assert.equal(h.afterEdit.total,5.79);assert.equal(h.state.fd_receipt_result,4.56,'source native deletion must retain current amount and stable row identity');assert.equal(h.rendered[0].key,22);assert.equal(h.rendered[0][physical],4.56);assert.equal(h.rendered[0].fd_note,'keep-second');assert.deepEqual(h.dataState,{keep:'audit'});assert.deepEqual(h.deleteState,[{key:'old-delete',fd_id:'retained-id'}]);assert.deepEqual(Object.keys(h.commits[0].value[0]),[column]);}
const multi=runtime({multiple:true});assert.equal(multi.afterEdit.total,14.43);assert.equal(multi.state.fd_receipt_result,4.56);results.push({name:'two-owned-pending-rows',actual:multi.state.fd_receipt_result,expected:4.56});
for(const [name,tamper]of[
 ['foreign-other-field',({ko})=>{ko.current[0].fd_note='unproved-change';}],
 ['invalid-native-table',({meta})=>{meta.isInvalid=true;}],
 ['hidden-native-column',({meta})=>{meta.props.columns[0].labelProps.hidden=true;}],
 ['readonly-native-column',({meta})=>{meta.props.columns[0].controlProps.showStatus='view';}],
 ['missing-native-column',({meta})=>{meta.props.columns=[];}],
 ['hidden-current-cell',({hidden})=>{hidden[22]=[physical];}],
 ['wrong-field-queue',({window})=>{const k=Object.keys(window.MXFORM_ACTIONS)[0];window.MXFORM_ACTIONS[k].actionTableName='other';}],
 ['missing-native-writer',({handle})=>{delete handle.updateRowValue;}],
 ['duplicate-key',({ko})=>{ko.current[0].key=22;}],
]){const h=runtime({tamper});assert.equal(h.commits.length,0,name);results.push({name,commits:0});}
assert.equal(JSON.stringify(dsl),sourceBefore);
});

test('remaining row edit follows stable identity after reindex; deleting the last row clears the total',()=>{
 const h=runtime();h.editRemaining(7.89);assert.equal(h.state.fd_receipt_result,7.89);assert.equal(h.rows[0].key,22);assert.equal(h.rows[0][physical],7.89);assert.equal(h.commits.at(-1).rowKey,22);h.remove([22]);assert.equal(h.rows.length,0);assert.equal(h.state.fd_receipt_result,0);
});
test('zero publishes as a number while the original domestic cap remains enforced',()=>{
 const zero=runtime({next:0});assert.equal(zero.afterEdit.total,1.23);assert.equal(zero.state.fd_receipt_result,0);assert.equal(zero.commits[0].value[0][column],0);
 const cap=runtime({oldSecond:75,first:150,next:350,mode:1});assert.equal(cap.afterEdit.total,100);assert.equal(cap.state.fd_receipt_result,100);
});
test('only a complete source-proved receipt lifecycle with safe defaults qualifies',()=>{
 for(const change of[
  d=>{d.scripts.actions=d.scripts.actions.filter(a=>a.event!=='onAfterDel');},
  d=>{d.scripts.actions.find(a=>a.event==='onAfterAdd').sourceRefs=[];},
  d=>{d.scripts.actions.find(a=>a.event==='onAfterDel').function+=' ';},
  d=>{d.form.fields.find(f=>f.id===table).columns[0].props.defaultValue={kind:'context',source:'creator'};},
  d=>{d.scripts.actions.push({id:'reactive-table',scope:'control',tableId:table,controlId:table,event:'onDetailChange',translationStatus:'mapped'});},
  d=>{d.scripts.actions.push({id:'reactive-form',scope:'global',event:'onChange',translationStatus:'mapped'});},
 ]){const copy=structuredClone(dsl);change(copy);assert.ok(!withDetailEventReadBridge(copy.scripts,copy.form).actions.some(a=>a.function?.includes('function __mkDetailReadCommit')));}
});
test('persisted readback verifies and protects the private native publication adapter',()=>{
 assert.equal(prepared.verify(prepared.update).ok,true);const changed=structuredClone(prepared.update),config=JSON.parse(changed.mechanisms['sys-xform'].fdConfig),attr=JSON.parse(config.attribute.formAttr);const a=attr.controlAction.control[table+'.'+column].onChange[0];a.function=a.function.replace('__mkDetailReadCommit(handle, rows, current, column, table);','');config.attribute.formAttr=JSON.stringify(attr);changed.mechanisms['sys-xform'].fdConfig=JSON.stringify(config);assert.equal(prepared.verify(changed).ok,false);
});
test('captured native writer, formatter and row reader retain their original bytes',()=>{
 for(const fn of Object.values(writer.functions)){assert.equal(fn.end-fn.start,fn.text.length);assert.equal(createHash('sha256').update(fn.text).digest('hex'),fn.sha256);}
});
