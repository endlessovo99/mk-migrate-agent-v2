import assert from 'node:assert/strict';
import {it} from 'node:test';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {draftSourceDraft,cleanSourceFile} from '../../src/translator/index.js';
import {applyFormPayload,buildGlobalDispatcher} from '../../src/executor/persistence/form-writer.js';
import {sampleBaseTemplate,xformConfig} from '../helpers/persistence.js';
import {prepareChoiceOtherRepair,CHOICE_OTHER_NATIVE_ORG_TYPES} from '../../src/executor/choice-other-repair-plan.js';

function setup(inputDsl){
 const dsl=inputDsl||draftSourceDraft(cleanSourceFile('tests/fixtures/route-validation/checkbox-other-compatible/compatible_SysFormTemplate.xml'));
 const priorDsl=structuredClone(dsl),caption=priorDsl.form.fields.find(f=>f.sourceProps?.choiceOtherToggle);
 Object.assign(caption,{type:'description',componentId:'xform-description',props:{content:'其他'},generated:false});delete caption.sourceProps.choiceOtherToggle;delete caption.reason;
 const template=applyFormPayload(sampleBaseTemplate(),priorDsl),workflow={...template.mechanisms.lbpmTemplate[0],fdName:template.fdName,fdEntityId:template.fdId,fdCategory:{fdFormCategoryId:'category-id'},fdFormCategory:{fdFormCategoryId:'category-id'},fdTemplateForms:[{fdFormKey:template.fdId,fdFormCode:template.fdId}],fdContent:'<process><node id="start"/></process>',fdEditors:[]};
 template.mechanisms.lbpmTemplate=[structuredClone(workflow)];template.fdAlter={fdId:'actor',fdName:'Actor'};template.fdAlterTime=100;
 template.mechanisms['sys-xform'].fdAlterTime=100;
 const config=xformConfig(template);config.dataModel[0].fdAlterTime=100;template.mechanisms['sys-xform'].fdConfig=JSON.stringify(config);
 return {dsl,priorDsl,before:{template,workflow},categoryId:'category-id',currentTargets:[]};
}
function configEdit(bundle,fn){const c=xformConfig(bundle.template);fn(c);bundle.template.mechanisms['sys-xform'].fdConfig=JSON.stringify(c);}
function nodes(value){return !value||typeof value!=='object'?[]:[value,...Object.values(value).flatMap(v=>Array.isArray(v)?v.flatMap(nodes):nodes(v))];}

it('plans only the native Other presentation patch while preserving original business values and the complete graph',()=>{
 const input=setup(),plan=prepareChoiceOtherRepair(input),before=xformConfig(input.before.template),after=xformConfig(plan.proposed.template);
 assert.equal(plan.verify(plan.proposed).ok,true);assert.equal(plan.verifyProtected(plan.proposed),true);
 for(const id of ['fd_choice','fd_other_text'])assert.deepEqual(after.dataModel[0].fdFields.find(f=>f.fdName===id),before.dataModel[0].fdFields.find(f=>f.fdName===id));
 const oldCaption=before.dataModel[0].fdFields.find(f=>f.fdName==='fd_other_caption'),caption=after.dataModel[0].fdFields.find(f=>f.fdName==='fd_other_caption');
 assert.equal(caption.fdType,'checkbox');for(const key of ['fdId','fdName','fdColumn','fdOrder','fdDataModel'])assert.deepEqual(caption[key],oldCaption[key]);
 assert.equal(plan.payload.mechanisms.lbpmTemplate[0].fdContent,input.before.workflow.fdContent);
 assert.deepEqual(plan.proposed.workflow,input.before.workflow);assert.equal(plan.summary.workflowWrites,0);assert.equal(plan.summary.recordWrites,0);
});

for(const [label,change]of [
 ['original choice encoding',b=>configEdit(b,c=>c.dataModel[0].fdFields.find(f=>f.fdName==='fd_choice').fdAttribute+=' ')],
 ['original explanation storage',b=>configEdit(b,c=>c.dataModel[0].fdFields.find(f=>f.fdName==='fd_other_text').fdIsStored=false)],
 ['unrelated field',b=>configEdit(b,c=>c.dataModel[0].fdFields.find(f=>f.fdName==='fd_plain').fdLabel='changed')],
 ['unrelated layout',b=>configEdit(b,c=>{const v=JSON.parse(c.viewModel[0].fdConfig);nodes(v).find(n=>n.controlProps?.style).controlProps.style.color='red';c.viewModel[0].fdConfig=JSON.stringify(v);})],
 ['original permissions',b=>configEdit(b,c=>c.auth[0].edit.mk_model_test.fields.fd_choice.editable=false)],
 ['template readers',b=>b.template.fdReaders=[{fdId:'injected'}]],
 ['bound graph',b=>b.template.mechanisms.lbpmTemplate[0].fdContent='<changed/>'],
 ['detail graph',b=>b.workflow.fdContent='<changed/>'],
 ['script body',b=>configEdit(b,c=>{const a=JSON.parse(c.attribute.formAttr);a.controlAction.global.onLoad[0].function+=' ';c.attribute.formAttr=JSON.stringify(a);})]
])it('rejects readback mutation outside the Other patch: '+label,()=>{
 const plan=prepareChoiceOtherRepair(setup()),after=structuredClone(plan.proposed);change(after);assert.equal(plan.verifyProtected(after),false);assert.equal(plan.verify(after).ok,false);
});

it('requires a named draft, exact category, consistent nonempty graph and a single native onLoad',()=>{
 for(const mutate of [i=>i.before.template.fdStatus=1,i=>i.before.template.fdName='ordinary',i=>i.categoryId='wrong',i=>i.before.workflow.fdContent='',i=>configEdit(i.before,c=>{const a=JSON.parse(c.attribute.formAttr);a.controlAction.global.onLoad=[{id:'a',name:'onLoad',function:'function onLoad(){}'},{id:'b',name:'onLoad',function:'function onLoad(){}'}];c.attribute.formAttr=JSON.stringify(a);})]){
  const input=setup();mutate(input);assert.throws(()=>prepareChoiceOtherRepair(input));
 }
});

it('rejects changes to source business defaults, options, required and readonly flags',()=>{
 for(const mutate of [i=>i.dsl.form.fields.find(f=>f.id==='fd_choice').props.options[0].value='different',i=>i.dsl.form.fields.find(f=>f.id==='fd_other_text').props.defaultValue.value='different',i=>i.dsl.form.fields.find(f=>f.id==='fd_choice').props.required=true,i=>i.dsl.form.fields.find(f=>f.id==='fd_other_text').props.readOnly=true]){
  const input=setup();mutate(input);assert.throws(()=>prepareChoiceOtherRepair(input));
 }
});

it('applies generically to a different source form and renamed source, caption, text, and template identifiers',()=>{
 const folder=mkdtempSync(join(tmpdir(),'choice-other-repair-'));
 try{
  let xml=readFileSync('tests/fixtures/route-validation/choice-other-companion-fidelity/main-checkbox_SysFormTemplate.xml','utf8');
  for(const [from,to]of [['fd_choice','fd_other_group_identifier'],['fd_other_caption','fd_other_group_caption'],['fd_other_text','fd_other_group_explanation'],['fidelity-main','independent-template']])xml=xml.replaceAll(from,to);
  const path=join(folder,'independent_SysFormTemplate.xml');writeFileSync(path,xml);const input=setup(draftSourceDraft(cleanSourceFile(path))),plan=prepareChoiceOtherRepair(input);
  assert.equal(plan.verify(plan.proposed).ok,true);assert.equal(plan.summary.bindings[0].choiceId,'fd_other_group_identifier');assert.equal(input.dsl.form.fields.find(field=>field.id===plan.summary.bindings[0].textId).sourceProps.originalId,'fd_other_group_explanation');
 }finally{rmSync(folder,{recursive:true,force:true});}
});

for(const [label,mutate]of [
 ['unrelated form field',i=>i.dsl.form.fields.find(f=>f.id==='fd_plain').props.required=true],
 ['unrelated form layout',i=>i.dsl.form.layout.mkTree[0].id+='-changed'],
 ['different prior caption source',i=>i.priorDsl.form.fields.find(f=>f.id==='fd_other_caption').sourceRef='source.form.control.unrelated'],
 ['unrelated prior companion marker',i=>i.priorDsl.form.fields.find(f=>f.id==='fd_choice').sourceProps.otherTextCompanion={id:'unrelated',captionId:'unrelated'}],
 ['prior toggle marker',i=>i.priorDsl.form.fields.find(f=>f.id==='fd_other_caption').sourceProps.choiceOtherToggle={version:1}],
 ['different prior source field',i=>i.priorDsl.form.fields.find(f=>f.id==='fd_choice').sourceRef='source.form.control.another']
])it('rejects a source/DSL pair outside the exact presentation relationship: '+label,()=>{
 const input=setup();mutate(input);assert.throws(()=>prepareChoiceOtherRepair(input));
});

it('copies current choice styles and intersects current choice/text authorization without widening either',()=>{
 const input=setup();configEdit(input.before,c=>{
  const v=JSON.parse(c.viewModel[0].fdConfig);v.controlStyle.fd_choice={desktop:{labelStyle:{fontSize:18}},mobile:{controlValueStyle:{color:'black'}}};v.controlStyle.fd_other_caption={desktop:{controlValueStyle:{color:'red'}}};c.viewModel[0].fdConfig=JSON.stringify(v);
  c.auth[0].edit.mk_model_test.fields.fd_other_text.editable=false;c.auth[0].view.mk_model_test.fields.fd_choice.visible=false;
 });
 const plan=prepareChoiceOtherRepair(input),c=xformConfig(plan.proposed.template),v=JSON.parse(c.viewModel[0].fdConfig);
 assert.deepEqual(v.controlStyle.fd_other_caption,v.controlStyle.fd_choice);
 assert.equal(c.auth[0].edit.mk_model_test.fields.fd_other_caption.editable,false);assert.equal(c.auth[0].edit.mk_model_test.fields.fd_other_caption.required,false);
 assert.equal(c.auth[0].view.mk_model_test.fields.fd_other_caption.visible,false);assert.equal(c.auth[0].view.mk_model_test.fields.fd_other_caption.hide,true);
});

it('preserves real singleton handler IDs, order, bodies and other control/global events',async()=>{
 const input=setup(),handlers=[{id:'original-one',name:'first',function:'function first(context) { context.trace.push("one"); }'},{id:'original-two',name:'second',function:'function second(context) { context.trace.push("two"); }'}];
 const sourceActions=[...handlers.map(action=>({...action,event:'onLoad',scope:'global',translationStatus:'mapped'})),{id:'submit',name:'onSubmit',event:'onSubmit',scope:'global',translationStatus:'mapped',function:'function onSubmit(){return true;}'},{id:'change',name:'change',event:'onChange',scope:'control',controlId:'fd_choice',translationStatus:'mapped',function:'function change(){}'}];
 input.priorDsl.scripts={actions:sourceActions};input.dsl.scripts=structuredClone(input.priorDsl.scripts);
 input.before.template=applyFormPayload(input.before.template,input.priorDsl);
 const plan=prepareChoiceOtherRepair(input),attr=JSON.parse(xformConfig(plan.proposed.template).attribute.formAttr),old=JSON.parse(xformConfig(input.before.template).attribute.formAttr);
 assert.deepEqual(attr.controlAction.control,old.controlAction.control);assert.deepEqual(attr.controlAction.global.onSubmit,old.controlAction.global.onSubmit);
 assert.deepEqual(attr.controlAction.global.onLoad[0].migrationActions.slice(0,2).map(a=>a.id),handlers.map(a=>a.id));
 const {runInNewContext}=await import('node:vm'),trace=[],values={'mk_model_test.fd_other_text':'kept'},MKXFORM={MKXFORM_DATA_CONTAINER:{},$$FORM:{current:{}},getValue:id=>values[id],setValue:(id,value)=>{values[id]=value;},onChange:()=>{}};
 runInNewContext('('+attr.controlAction.global.onLoad[0].function+')',{MKXFORM})({trace});assert.deepEqual(trace,['one','two']);assert.equal(values['mk_model_test.fd_other_text'],'kept');assert.deepEqual(Array.from(values['mk_model_test.fd_other_caption']),['selected']);
});

it('rejects forged singleton metadata, unknown wrapper behavior and duplicate helper identity',()=>{
 const entry=buildGlobalDispatcher('onLoad',[{id:'original',name:'first',function:'function first(context) { context.value=1; }'}]);
 for(const mutate of [a=>a.migrationActions[0].name='wrong',a=>a.function=a.function.replace('onLoad_1(context);','onLoad_1(context); context.extra=1;'),a=>a.id='forged',a=>a.migrationActions[0].id='mk-choice-other-init-v1']){
  const input=setup(),current=structuredClone(entry);mutate(current);configEdit(input.before,c=>{const attr=JSON.parse(c.attribute.formAttr);attr.controlAction.global.onLoad=[current];c.attribute.formAttr=JSON.stringify(attr);});assert.throws(()=>prepareChoiceOtherRepair(input));
 }
});

it('rejects a canonical-looking current handler that gained an executable caption reference outside the prior DSL',()=>{
 const input=setup();configEdit(input.before,c=>{
  const attr=JSON.parse(c.attribute.formAttr);
  attr.controlAction.global.onLoad=[buildGlobalDispatcher('onLoad',[{id:'native-before-custom',name:'sourceLoad',function:'function sourceLoad(context){MKXFORM.setFieldAttr("mk_model_test.fd_other_caption",1);}'}])];
  c.attribute.formAttr=JSON.stringify(attr);
 });
 assert.throws(()=>prepareChoiceOtherRepair(input),error=>error.code==='choice_other_repair.current_scripts_drifted');
});
for(const [label,change]of [
 ['extra global caption handler',a=>a.global.onSubmit=[{id:'custom-submit',name:'customSubmit',function:'function customSubmit(){MKXFORM.setFieldAttr("mk_model_test.fd_other_caption",1);}'}]],
 ['extra control caption handler',a=>a.control['mk_model_test.fd_other_text']={onChange:[{id:'custom-change',name:'customChange',function:'function customChange(){MKXFORM.setFieldAttr("mk_model_test.fd_other_caption",1);}'}]}],
 ['custom helper javascript',a=>a.javascript='MKXFORM.setFieldAttr("mk_model_test.fd_other_caption",1);']
])it('rejects current script drift even when the writer would inherit it: '+label,()=>{
 const input=setup();configEdit(input.before,c=>{const a=JSON.parse(c.attribute.formAttr);change(a.controlAction);c.attribute.formAttr=JSON.stringify(a);});
 assert.throws(()=>prepareChoiceOtherRepair(input),error=>error.code==='choice_other_repair.current_scripts_drifted');
});

function withDetail(){
 const input=setup();configEdit(input.before,c=>c.dataModel.push({fdId:'detail-model',fdTableName:'detail_table',fdType:'detail',fdFields:[{fdId:'original-detail-field',fdName:'fd_detail_value',fdType:'text',fdIsStored:true}]}));return input;
}
function advanceAudit(bundle){
 bundle.template.fdAlterTime=200;bundle.template.mechanisms['sys-xform'].fdAlterTime=210;
 configEdit(bundle,c=>{c.dataModel[0].fdAlterTime=205;Object.assign(c.dataModel[1],{fdAlter:structuredClone(bundle.template.fdAlter),fdAlterTime:205,fdDeletedFields:[]});});
}
it('permits only exact native audit initialization on unchanged detail model identities',()=>{
 const plan=prepareChoiceOtherRepair(withDetail()),after=structuredClone(plan.proposed);advanceAudit(after);assert.equal(plan.verifyProtected(after),true);assert.equal(plan.verify(after).ok,true);
});
for(const [label,mutate]of [
 ['actor substitution',b=>configEdit(b,c=>c.dataModel[1].fdAlter.fdId='other-actor')],
 ['time before root update',b=>configEdit(b,c=>c.dataModel[1].fdAlterTime=199)],
 ['time after XForm update',b=>configEdit(b,c=>c.dataModel[1].fdAlterTime=211)],
 ['invalid root timestamp',b=>b.template.fdAlterTime='200'],
 ['backward root timestamp',b=>b.template.fdAlterTime=99],
 ['schema change hidden among audit',b=>configEdit(b,c=>c.dataModel[1].fdFields[0].fdType='number')],
 ['nonempty deletion marker',b=>configEdit(b,c=>c.dataModel[1].fdDeletedFields=['original-detail-field'])],
 ['detail identity change',b=>configEdit(b,c=>c.dataModel[1].fdId='replacement')]
])it('rejects unproven native audit normalization: '+label,()=>{
 const plan=prepareChoiceOtherRepair(withDetail()),after=structuredClone(plan.proposed);advanceAudit(after);mutate(after);assert.equal(plan.verifyProtected(after),false);
});

it('allows editor name omission only with independent typed business person evidence',()=>{
 const input=setup();for(const w of [input.before.workflow,input.before.template.mechanisms.lbpmTemplate[0]])w.fdEditors=[{fdId:'editor-id',fdName:'Person'}];
 input.currentTargets=[{fdId:'editor-id',fdName:'Person',fdIsAvailable:true,fdIsBusiness:true,fdOrgType:8}];
 const plan=prepareChoiceOtherRepair(input),after=structuredClone(plan.proposed);for(const w of [after.workflow,after.template.mechanisms.lbpmTemplate[0]])delete w.fdEditors[0].fdName;
 assert.equal(plan.verifyProtected(after),true);
 for(const targets of [[],[{...input.currentTargets[0],fdOrgType:4}],[{...input.currentTargets[0],fdName:'Different'}]]){
  const another=prepareChoiceOtherRepair({...input,currentTargets:targets});assert.equal(another.verifyProtected(after),false);
 }
});

function readerInput(){
 const input=setup(),readers=[{fdId:'department-reader',fdName:'Department',fdOrgType:2,fdIsAvailable:true},{fdId:'person-reader',fdName:'Person',fdOrgType:8,fdIsAvailable:true,fdIsBusiness:true}];
 input.before.template.fdReaders=structuredClone(readers);
 for(const workflow of [input.before.workflow,input.before.template.mechanisms.lbpmTemplate[0]])workflow.fdReaders=structuredClone(readers);
 input.currentTargets=readers.map(reader=>({...reader,fdIsBusiness:true}));
 return input;
}
function omitWorkflowReaderNames(bundle){for(const workflow of [bundle.workflow,bundle.template.mechanisms.lbpmTemplate[0]])for(const reader of workflow.fdReaders)delete reader.fdName;}
it('permits only workflow reader display-name omission backed by unchanged root readers and independent typed evidence',()=>{
 const input=readerInput(),plan=prepareChoiceOtherRepair(input),after=structuredClone(plan.proposed);omitWorkflowReaderNames(after);
 assert.equal(plan.verifyProtected(after),true);assert.equal(plan.verify(after).ok,true);
 assert.deepEqual(after.template.fdReaders,input.before.template.fdReaders);
});
it('reuses the native catalog org enum and preserves ID-only reader reference shapes without inventing type metadata',()=>{
 assert.deepEqual(CHOICE_OTHER_NATIVE_ORG_TYPES,[1,2,4,8,16,128,256]);
 const input=readerInput();for(const owner of [input.before.template,input.before.workflow,input.before.template.mechanisms.lbpmTemplate[0]])owner.fdReaders=owner.fdReaders.map(({fdId,fdName})=>({fdId,fdName}));
 const plan=prepareChoiceOtherRepair(input),after=structuredClone(plan.proposed);omitWorkflowReaderNames(after);assert.equal(plan.verifyProtected(after),true);
 after.workflow.fdReaders[0].fdOrgType=2;assert.equal(plan.verifyProtected(after),false);
});
for(const [label,change]of [
 ['reader ID substitution',b=>b.workflow.fdReaders[0].fdId='another-reader'],
 ['reader clearing',b=>b.workflow.fdReaders=[]],
 ['reader removal',b=>b.workflow.fdReaders.pop()],
 ['reader addition',b=>b.workflow.fdReaders.push({fdId:'injected',fdName:'Injected'})],
 ['reader reordering',b=>b.workflow.fdReaders.reverse()],
 ['reader type rewrite',b=>b.workflow.fdReaders[0].fdOrgType=4],
 ['reader type deletion',b=>delete b.workflow.fdReaders[0].fdOrgType],
 ['reader availability rewrite',b=>b.workflow.fdReaders[0].fdIsAvailable=false],
 ['reader business rewrite',b=>b.workflow.fdReaders[1].fdIsBusiness=false],
 ['reader name rewrite',b=>b.workflow.fdReaders[0].fdName='Renamed'],
 ['root reader name omission',b=>delete b.template.fdReaders[0].fdName]
])it('rejects substantive reader changes during read-only normalization: '+label,()=>{
 const plan=prepareChoiceOtherRepair(readerInput()),after=structuredClone(plan.proposed);omitWorkflowReaderNames(after);change(after);assert.equal(plan.verifyProtected(after),false);
});
for(const [label,change]of [
 ['missing evidence',i=>i.currentTargets=[]],
 ['duplicate ID evidence',i=>i.currentTargets.push(structuredClone(i.currentTargets[0]))],
 ['unknown native org type',i=>i.currentTargets[0].fdOrgType=3],
 ['type absent from native catalog',i=>i.currentTargets[0].fdOrgType=32],
 ['untyped string org code',i=>i.currentTargets[0].fdOrgType='2'],
 ['mismatched current name',i=>i.currentTargets[0].fdName='Renamed'],
 ['mismatched current type',i=>i.currentTargets[0].fdOrgType=4],
 ['mismatched availability',i=>i.currentTargets[0].fdIsAvailable=false],
 ['missing availability',i=>delete i.currentTargets[0].fdIsAvailable],
 ['invalid availability',i=>i.currentTargets[0].fdIsAvailable='true'],
 ['mismatched business metadata',i=>i.currentTargets[1].fdIsBusiness=false],
 ['invalid business metadata',i=>i.currentTargets[0].fdIsBusiness='true']
])it('rejects unproven reader display-name normalization: '+label,()=>{
 const input=readerInput();change(input);const plan=prepareChoiceOtherRepair(input),after=structuredClone(plan.proposed);omitWorkflowReaderNames(after);assert.equal(plan.verifyProtected(after),false);
});
