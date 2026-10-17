import assert from 'node:assert/strict';
import vm from 'node:vm';
import {it} from 'node:test';
import {mainTableReadReferenceDiagnostics,renderMainTableReferences,MAIN_TABLE_PLACEHOLDER} from '../../src/dsl/native-main-table-reference.js';
import {nativeDateOnlyValueExpression} from '../../src/translator/native-date-only-value.js';

const form={fields:[{id:'fd_day',type:'dateTime',componentId:'xform-datetime'},{id:'main',type:'detailTable',columns:[{id:'fd_day',type:'dateTime'},{id:'fd_detail_only',type:'text'}]}]};
it('resolves only the real main model and one defined main read despite a detail table named main',()=>{
 const source='function onLoad(){return MKXFORM.getValueText('+JSON.stringify(MAIN_TABLE_PLACEHOLDER+'.fd_day')+');}';
 assert.deepEqual(mainTableReadReferenceDiagnostics(source,form),[]);
 assert.equal(renderMainTableReferences(source,'fd_native_main',form),'function onLoad(){return MKXFORM.getValueText("fd_native_main.fd_day");}');
 for(const model of [undefined,'','bad.name','bad-name'])assert.throws(()=>renderMainTableReferences(source,model,form));
 for(const suffix of ['fd_unknown','fd_detail_only','fd_day.extra','', 'main.fd_day']){
  const changed=source.replace('.fd_day',suffix?'.'+suffix:'');assert.ok(mainTableReadReferenceDiagnostics(changed,form).length);assert.throws(()=>renderMainTableReferences(changed,'fd_native_main',form));
 }
 for(const changed of [source.replace('getValueText','setValue'),source.replace('MKXFORM.getValueText','other'),source.replace('("','(prefix+"')])assert.ok(mainTableReadReferenceDiagnostics(changed,form).length);
 for(const changed of ['function onLoad(){/* '+MAIN_TABLE_PLACEHOLDER+' */ return 1;}','function onLoad(){return /'+MAIN_TABLE_PLACEHOLDER+'/;}','function onLoad(){return MKXFORM.getValueText(\u0060\\'+MAIN_TABLE_PLACEHOLDER+'.fd_day\u0060);}']){
  assert.ok(mainTableReadReferenceDiagnostics(changed,form).length);assert.throws(()=>renderMainTableReferences(changed,'fd_native_main',form));
 }
 const duplicate=structuredClone(form);duplicate.fields.push({...form.fields[0]});assert.ok(mainTableReadReferenceDiagnostics(source,duplicate).length);
});
it('native date text projection treats epoch zero as nonempty and accepts Date/string representations only with exact display text',()=>{
 const expression=nativeDateOnlyValueExpression('fd_day','input');
 for(const raw of [0,Date.UTC(2024,0,1),new Date(Date.UTC(2024,0,1)),'2024-01-01']){
  const reads=[],input=raw,dateText=raw===0?'1970-01-01':'2024-01-01',runtime={Date,input,MKXFORM:{getValueText:key=>(reads.push(key),dateText)}};
  assert.equal(vm.runInNewContext(expression,runtime),dateText);assert.deepEqual(reads,[MAIN_TABLE_PLACEHOLDER+'.fd_day']);
 }
 for(const input of [undefined,null,'']){
  let read=false;assert.equal(vm.runInNewContext(expression,{input,MKXFORM:{getValueText(){read=true;throw Error('Must not look up empty display.');}}}),"");assert.equal(read,false);
 }
 for(const [input,text]of [[0,undefined],[0,null],[false,'1970-01-01'],[{},'1970-01-01'],[new Date(0),new Date(0)]]){
  assert.throws(()=>vm.runInNewContext(expression,{Date,input,MKXFORM:{getValueText:()=>text}}));
 }
 for(const text of ['-','','0','01/01/1970','malformed-date','1700000000000'])assert.equal(vm.runInNewContext(expression,{Date,input:0,MKXFORM:{getValueText:()=>text}}),text);
 assert.equal(vm.runInNewContext(expression,{Date,input:'not-a-date',MKXFORM:{getValueText:()=> 'not-a-date'}}),'not-a-date');
});
it('the same native display calendar text keeps epoch zero and DST calculations on the unchanged source Date algorithm',()=>{
 const oldTZ=process.env.TZ;
 try{
  for(const zone of ['UTC','Asia/Shanghai','America/New_York']){
   process.env.TZ=zone;
   for(const dates of [['1970-01-01','1970-01-02'],['2024-03-09','2024-03-11'],['2024-11-02','2024-11-04']]){
    const points=dates.map(date=>new Date(date+'T00:00:00').getTime());
    const expressions=dates.map((text,index)=>nativeDateOnlyValueExpression('fd_day','points['+index+']'));
    const runtime={Date,points,MKXFORM:{getValueText(){return dates[runtime.call++];}},call:0};
    const values=expressions.map(expression=>vm.runInNewContext(expression,runtime));
    assert.deepEqual(values,dates);
    const overlap=(new Date(values[1]).getTime()-new Date(values[0]).getTime())/(24*60*60*1000)+1;
    const original=(new Date(dates[1]).getTime()-new Date(dates[0]).getTime())/(24*60*60*1000)+1;
    assert.equal(overlap,original);
   }
  }
 }finally{if(oldTZ===undefined)delete process.env.TZ;else process.env.TZ=oldTZ;}
});
