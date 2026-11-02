import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { cleanSourceFile, draftSourceDraft } from '../../src/translator/index.js';
import { checkTrust, createTrustedMigrationDsl } from '../../src/dsl/trust.js';
import { checkDraft } from '../../src/dsl/checks.js';
import { runRouteCase } from './run-route-case.js';
import { prepareSample, xformConfig } from '../helpers/persistence.js';
const fixture='tests/fixtures/route-validation/checkbox-other-compatible/compatible_SysFormTemplate.xml';
const nativeFixture='tests/fixtures/route-validation/native-checkbox-other/native-checkbox-other_SysFormTemplate.xml';
const legacyDraft=()=>JSON.parse(readFileSync('tests/fixtures/route-validation/checkbox-other-compatible/retained-legacy-draft.json','utf8'));
it('renders a native Other checkbox beside the original explanation without changing business fields or codes',()=>{
 const source=cleanSourceFile(fixture),dsl=legacyDraft(),fields=dsl.form.fields;
 const original=source.form.controls.find(f=>f.id==='fd_choice');
 const choice=fields.find(f=>f.id==='fd_choice'),note=fields.find(f=>f.id==='fd_other_text');
 assert.deepEqual(choice.props.options,original.options);
 assert.equal(note.props.defaultValue.value,'seed_under_score');
 const toggle=fields.find(f=>f.generated&&f.sourceProps?.choiceOtherToggle);
 assert.ok(toggle,'Other caption must become a real native checkbox without adding a synthetic code to fd_choice');
 assert.deepEqual(toggle.props.options,[{label:'其他',value:'selected'}]);
 const prepared=prepareSample(dsl),native=xformConfig(prepared.update).dataModel.flatMap(m=>m.fdFields||[]);
 assert.equal(native.find(f=>f.fdName===toggle.id).fdType,'checkbox');
 assert.equal(native.find(f=>f.fdName==='fd_other_text').fdDisplay,true);
 assert.equal(native.find(f=>f.fdName==='fd_choice').fdIsStored,true);
 assert.equal(prepared.verify(prepared.update).ok,true);
});

it('retains fixed-source trust through the guarded native migration route',async()=>{
 const source=cleanSourceFile(nativeFixture),draft=draftSourceDraft(source);
 assert.equal(checkDraft(draft).ok,true);
 assert.equal(checkTrust(source,createTrustedMigrationDsl(source,draft,{externalAgentReviewed:true})).ok,true);
 const result=await runRouteCase('native-checkbox-other-success');
 assert.equal(result.execution.ok,true);
 assert.equal(result.execution.transferRecord.status,'recorded');
 assert.equal(result.execution.readback.partitions.form,'verified');
});
it('rejects loss of either original business storage or auxiliary selection storage',()=>{
 const dsl=legacyDraft(),prepared=prepareSample(dsl);
 for(const id of ['fd_choice','fd_other_text','fd_other_caption']){
  const changed=structuredClone(prepared.update),config=xformConfig(changed);
  config.dataModel.flatMap(m=>m.fdFields||[]).find(f=>f.fdName===id).fdIsStored=false;
  changed.mechanisms['sys-xform'].fdConfig=JSON.stringify(config);
  assert.equal(prepared.verify(changed).ok,false,'readback must detect lost storage for '+id);
 }
});
function nativeNodes(value){
 if(!value||typeof value!=='object')return [];
 return [value,...Object.values(value).flatMap(child=>Array.isArray(child)?child.flatMap(nativeNodes):nativeNodes(child))];
}
it('keeps native checkbox items together and reserves remaining width for the original text on both platforms',()=>{
 const dsl=legacyDraft(),prepared=prepareSample(dsl);
 const view=JSON.parse(xformConfig(prepared.update).viewModel[0].fdConfig);
 for(const platform of ['desktop','mobile']){
  const nodes=nativeNodes(view.view.render[platform]);
  for(const id of ['fd_choice','fd_other_caption']){
   const wrapper=nodes.find(n=>n.type==='div'&&n.children?.some(c=>c.key===id));
   assert.equal(wrapper.controlProps.style.flex,'0 1 auto',id+' must use the checkbox intrinsic width');
  }
  const note=nodes.find(n=>n.type==='div'&&n.children?.some(c=>c.key==='fd_other_text'));
  assert.equal(note.controlProps.style.flex,'1 1 0');
 }
});
it('executes the persisted native initializer after existing load handlers and preserves original values',async()=>{
 const {runInNewContext}=await import('node:vm');
 const dsl=legacyDraft();
 dsl.scripts={actions:[{id:'source-load',name:'onLoad',event:'onLoad',scope:'global',translationStatus:'mapped',function:'function onLoad(context){MKXFORM.setValue("mk_model_test.fd_other_text", "  loaded_under_score  ");}',functionMappings:[{source:'synthetic native dispatcher composition',target:'unchanged original field write',basis:'semantic-translation'}],coverage:{status:'translated',nativeRules:[],residuals:[]}}]};
 const prepared=prepareSample(dsl),config=xformConfig(prepared.update),attr=JSON.parse(config.attribute.formAttr);
 assert.equal(attr.controlAction.global.onLoad.length,1,'native singleton dispatcher must include both original and presentation handlers');
 const values={'mk_model_test.fd_choice':['A'],'mk_model_test.fd_other_text':'default'},writes=[],subscriptions=[];
 let getter=()=>({...values});const nativeForm={};Object.defineProperty(nativeForm,'getFieldsValue',{configurable:true,get(){return getter;},set(value){getter=value;}});
 const MKXFORM={MKXFORM_DATA_CONTAINER:{},$$FORM:{current:nativeForm},getValue:id=>values[id],setValue(id,value){writes.push(id);values[id]=structuredClone(value);for(const s of subscriptions)if(s.id===id)s.callback(value);},onChange:(id,callback)=>subscriptions.push({id,callback}),beforeSubmit() {}};
 const initialize=runInNewContext('('+attr.controlAction.global.onLoad[0].function+')',{MKXFORM});
 initialize({});
 assert.equal(values['mk_model_test.fd_other_text'],'  loaded_under_score  ');
 assert.deepEqual(values['mk_model_test.fd_other_caption'],['selected']);
 assert.deepEqual(values['mk_model_test.fd_choice'],['A']);
 assert.deepEqual(writes,['mk_model_test.fd_other_text','mk_model_test.fd_other_caption']);
 assert.equal(subscriptions.length,1);
 assert.equal(subscriptions[0].id,'mk_model_test.fd_other_text');
 assert.equal(prepared.verify(prepared.update).ok,true);
});
it('rejects lost or altered persisted initialization even when migration summary metadata is retained',()=>{
 const prepared=prepareSample(legacyDraft());
 for(const alter of [load=>[],load=>[{...load[0],function:load[0].function.replace('fd_other_text','fd_plain')}]] ){
  const changed=structuredClone(prepared.update),config=xformConfig(changed),attr=JSON.parse(config.attribute.formAttr);
  attr.controlAction.global.onLoad=alter(attr.controlAction.global.onLoad);
  config.attribute.formAttr=JSON.stringify(attr);changed.mechanisms['sys-xform'].fdConfig=JSON.stringify(config);
  assert.equal(prepared.verify(changed).ok,false);
 }
});
async function fromXml(xml){
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'checkbox-other-compatible-'));
 try{const input=join(dir,'compatible_SysFormTemplate.xml');writeFileSync(input,xml);const source=cleanSourceFile(input);return {source,dsl:draftSourceDraft(source)};}
 finally{rmSync(dir,{recursive:true,force:true});}
}
it('maps a source Other default to the MK native representation',async()=>{
 const xml=readFileSync('tests/fixtures/route-validation/choice-other-companion-fidelity/main-checkbox-existing_SysFormTemplate.xml','utf8');
 const {dsl}=await fromXml(xml);
 assert.equal(checkDraft(dsl).ok,true);
 assert.equal(dsl.form.fields.find(f=>f.id==='fd_choice').props.defaultValue.value,'other_seed_under_score');
 assert.equal(dsl.form.fields.find(f=>f.id==='fd_choice').props.options.at(-1).type,'other');
});
it('maps a renamed source relationship with long identifiers',async()=>{
 let xml=readFileSync(nativeFixture,'utf8');
 for(const [from,to] of [['fd_choice','fd_completely_renamed_choice_identifier'],['fd_other_caption','fd_completely_renamed_caption_identifier'],['fd_other_text','fd_completely_renamed_text_identifier']]) xml=xml.replaceAll(from,to);
 const {source,dsl}=await fromXml(xml),choice=dsl.form.fields.find(f=>f.nativeOther);
 assert.ok(choice);assert.ok(choice.id.length<=25);assert.ok(choice.sourceProps.originalId);
 assert.equal(checkTrust(source,createTrustedMigrationDsl(source,dsl,{externalAgentReviewed:true})).ok,true);
 const prepared=prepareSample(dsl);assert.equal(prepared.verify(prepared.update).ok,true);
});
it('keeps ordinary Other choices without an explanation companion unchanged',async()=>{
 const {readFileSync}=await import('node:fs');const {source,dsl}=await fromXml(readFileSync(fixture,'utf8').replaceAll('Two|Q','其他|Q'));
 const plain=dsl.form.fields.find(f=>f.id==='fd_plain');
 assert.equal(plain.sourceProps.otherTextCompanion,undefined);
 assert.deepEqual(plain.props.options,source.form.controls.find(f=>f.id==='fd_plain').options);
 assert.deepEqual(plain.props.options,[{label:'One',value:'P'},{label:'其他',value:'Q'}]);
});
it('does not reinterpret unrelated or competing Other captions as a source relationship',async()=>{
 const {readFileSync}=await import('node:fs');const xml=readFileSync(fixture,'utf8');
 for(const changed of [xml.replaceAll('其他','备注'),xml.replaceAll('Standard|A','其他|A').replaceAll('Alternative|B','其他附件|B')]){
  const {dsl}=await fromXml(changed);
  assert.ok(dsl.form.fields.every(f=>!f.sourceProps?.choiceOtherToggle));
  assert.equal(dsl.form.fields.find(f=>f.id==='fd_other_caption').componentId,'xform-description');
 }
});
it('retains a caption with executable source references instead of changing the meaning of source scripts',()=>{
 const source=cleanSourceFile(fixture);
 source.scripts={fragments:[{id:'caption-use',sourceRef:'source.jsp.caption-use',content:'document.getElementById("fd_other_caption").innerHTML="动态说明";'}]};
 const dsl=draftSourceDraft(source);
 assert.equal(dsl.form.fields.find(f=>f.id==='fd_other_caption').componentId,'xform-description');
 assert.ok(dsl.form.fields.every(f=>!f.sourceProps?.choiceOtherToggle));
});
for(const [name,change]of [
 ['replaced normal code',dsl=>dsl.form.fields.find(f=>f.id==='fd_choice').props.options[0].value='changed'],
 ['unhidden explanation',dsl=>dsl.form.fields.find(f=>f.id==='fd_other_text').dataOnly=false],
 ['changed native option',dsl=>dsl.form.fields.find(f=>f.id==='fd_choice').props.options.at(-1).value='changed'],
 ['redirected explanation',dsl=>dsl.form.fields.find(f=>f.id==='fd_choice').nativeOther.textSourceRef='source.form.control.fd_plain']
])it('rejects incompatible candidate edits: '+name,()=>{
 const source=cleanSourceFile(nativeFixture),dsl=draftSourceDraft(source);change(dsl);
 assert.equal(checkTrust(source,createTrustedMigrationDsl(source,dsl,{externalAgentReviewed:true})).ok,false);
});
it('does not create a rendered Other control for a source group hidden by source permissions',()=>{
 for(const id of ['fd_choice','fd_other_text','fd_other_caption']){
  const source=cleanSourceFile(fixture);
  source.form.controls.find(f=>f.id===id).sourceProps.hardHidden=true;
  const dsl=draftSourceDraft(source);
  assert.ok(dsl.form.fields.every(f=>!f.sourceProps?.choiceOtherToggle),id);
 }
});
it('keeps whitespace-only explanation defaults as literal text',async()=>{
 const {readFileSync}=await import('node:fs');const {dsl}=await fromXml(readFileSync(fixture,'utf8').replaceAll('seed_under_score','   '));
 assert.deepEqual(dsl.form.fields.find(f=>f.id==='fd_other_text').props.defaultValue,{kind:'literal',value:'   '});
 const prepared=prepareSample(dsl);assert.equal(prepared.verify(prepared.update).ok,true);
});
for(const javascript of [
 'document.getElementById("fd_other_caption").innerHTML="动态说明";',
 String.raw`document.getElementById("\x66d_other_caption").innerHTML="动态说明";`,
 'document.getElementById("fd_other_"+"caption").innerHTML="动态说明";',
 'Com_AddEventListener(window,"load",function(){$("input[name=\\\'extendDataFormInfo.value(fd_other_caption)\\\']").prop("disabled",true);});',
 'document.querySelector(window.dynamicSelector).textContent="动态说明";'
])for(const carrier of ['javascript','helperJavascript'])it('preserves executable caption meaning in actual '+carrier+' source carriers: '+javascript.slice(0,45),()=>{
 const source=cleanSourceFile(fixture);
 source.scripts={fragments:[],sources:[{id:'display-jsp-1',sourceRef:'source.fdDisplayJsp.script.0',sourceType:'display-jsp',[carrier]:javascript}]};
 const dsl=draftSourceDraft(source);
 assert.equal(dsl.form.fields.find(f=>f.id==='fd_other_caption').componentId,'xform-description');
 assert.ok(dsl.form.fields.every(f=>!f.sourceProps?.choiceOtherToggle));
});
it('does not turn an originally inert input selector into an executable readonly mutation after XML intake',async()=>{
 const {readFileSync}=await import('node:fs');
 const javascript='Com_AddEventListener(window,"load",function(){$("input[name=\\\'extendDataFormInfo.value(fd_other_caption)\\\']").prop("disabled",true);});';
 const encoded=javascript.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 const xml=readFileSync(fixture,'utf8').replace('</string></void></object></java>','&lt;script&gt;'+encoded+'&lt;/script&gt;</string></void></object></java>');
 const {source,dsl}=await fromXml(xml);
 assert.ok(source.scripts.sources.some(s=>s.javascript?.includes('fd_other_caption')));
 assert.equal(dsl.form.fields.find(f=>f.id==='fd_other_caption').componentId,'xform-description');
 assert.ok(!dsl.scripts.actions.some(a=>a.translationStatus==='mapped'&&a.function?.includes('MKXFORM.setFieldAttr("fd_other_caption", 1)')));
});
for(const javascript of ['$("input").val("changed");','$(":checkbox").prop("checked",false);'])it('keeps the original caption when a wide input selector could gain a new target: '+javascript,()=>{
 const source=cleanSourceFile(fixture);
 source.scripts={sources:[{id:'wide-selector',sourceRef:'source.fdDisplayJsp.script.0',javascript}]};
 const dsl=draftSourceDraft(source);
 assert.equal(dsl.form.fields.find(f=>f.id==='fd_other_caption').componentId,'xform-description');
});
