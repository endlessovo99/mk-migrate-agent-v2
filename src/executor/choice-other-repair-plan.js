import {parse} from 'acorn';
import {sha256Digest} from '../agent-review/digest.js';
import {choiceOtherToggleBindings,withChoiceOtherRuntime} from '../dsl/choice-other-runtime.js';
import {MK_JS_SNIPPETS_CATALOG} from '../dsl/catalogs.js';
import {applyFormPayload,buildGlobalDispatcher} from './persistence/form-writer.js';
import {markedDispatcherActionFunction} from './persistence/script-dispatcher-contract.js';
import {withoutMechanismTokens} from './published-form-patch.js';

const clone=value=>structuredClone(value);
const same=(a,b)=>sha256Digest(a??null)===sha256Digest(b??null);
const need=(condition,reason)=>{if(!condition)throw Object.assign(new Error(reason),{code:'choice_other_repair.'+reason});};
const json=value=>{need(typeof value==='string','json_string_required');const result=JSON.parse(value);need(result&&typeof result==='object'&&!Array.isArray(result),'json_object_required');return result;};
const mutableFieldKeys=['fdType','fdDataType','fdDictType','fdLength','fdIsStored','fdDisplay','fdAttribute','fdFontExtendData'];
// Native domain evidence: mk-js-snippets.v1.json, promise_获取流程基础信息,
// response schema properties.creator.properties.orgType.description.
export const CHOICE_OTHER_NATIVE_ORG_TYPES=Object.freeze(nativeOrgTypes());

/** A pure, snapshot-bound plan. It has no client, write, record or retry capability. */
export function prepareChoiceOtherRepair({priorDsl,dsl,before,categoryId,currentTargets=[]}){
 const original=clone(before);validateEnvelope(original,categoryId);
 const bindings=choiceOtherToggleBindings(dsl.form);need(bindings.length>0,'no_choice_other_relationship');
 const ids=bindings.flatMap(b=>Object.values(b));need(new Set(ids).size===ids.length,'overlapping_relationships');
 validateFormDelta(priorDsl.form,dsl.form,bindings);
 const oldConfig=json(original.template.mechanisms['sys-xform'].fdConfig);
 validateCurrentScripts(original.template,priorDsl,oldConfig);
 const main=mainModel(oldConfig,original.template),table=main.fdTableName;
 const canonical=applyFormPayload(original.template,dsl),canonicalConfig=json(canonical.mechanisms['sys-xform'].fdConfig),canonicalMain=mainModel(canonicalConfig,original.template);
 const proposed=clone(original),config=json(proposed.template.mechanisms['sys-xform'].fdConfig),model=mainModel(config,proposed.template);
 const changedPaths=[];
 for(const binding of bindings){
  const {toggleId,choiceId,textId}=binding;
  for(const id of [choiceId,textId]){
   const prior=uniqueField(priorDsl.form.fields,id),next=uniqueField(dsl.form.fields,id);
   need(same(businessField(prior),businessField(next)),'source_business_field_changed');
   need(prior.dataOnly!==true&&next.dataOnly!==true,'source_business_field_not_rendered');
   const persisted=uniqueField(model.fdFields,id,'fdName');
   need(persisted.fdIsStored===true&&persisted.fdDisplay===true,'original_business_storage_missing');
   need(persisted.fdType===(id===choiceId?'checkbox':'text'),'original_business_component_mismatch');
  }
  const priorCaption=uniqueField(priorDsl.form.fields,toggleId),caption=uniqueField(model.fdFields,toggleId,'fdName');
  need(priorCaption.componentId==='xform-description'&&caption.fdType==='desc'&&caption.fdIsStored===false&&caption.fdDisplay===true,'caption_not_original_description');
  need(typeof priorCaption.sourceRef==='string'&&same(priorCaption.sourceRef,uniqueField(dsl.form.fields,toggleId).sourceRef),'caption_source_identity_changed');
  const projected=uniqueField(canonicalMain.fdFields,toggleId,'fdName');
  need(projected.fdType==='checkbox'&&projected.fdIsStored===true,'canonical_toggle_not_stored');
  for(const key of mutableFieldKeys){need(Object.hasOwn(projected,key),'canonical_field_property_missing');caption[key]=clone(projected[key]);}
  changedPaths.push(`/dataModel/${config.dataModel.indexOf(model)}/fdFields/${model.fdFields.indexOf(caption)}`);
  patchAuthorization(config,table,binding);
 }
 patchViews(config,canonicalConfig,bindings);
 const attr=json(config.attribute.formAttr),actions=withChoiceOtherRuntime({actions:[]},dsl.form,table).actions;
 need(actions.length===1,'runtime_helper_not_unique');
 attr.controlAction=attr.controlAction||{};attr.controlAction.global=attr.controlAction.global||{};
 const current=attr.controlAction.global.onLoad||[];need(Array.isArray(current)&&current.length<=1,'onload_not_singleton');
 const retained=current.length?retainedLoadActions(current[0]):[];
 need(!retained.some(action=>action.id===actions[0].id),'runtime_already_present');
 attr.controlAction.global.onLoad=[buildGlobalDispatcher('onLoad',[...retained,...actions])];
 config.attribute.formAttr=JSON.stringify(attr);
 proposed.template.mechanisms['sys-xform'].fdConfig=JSON.stringify(config);
 need(!same(original,proposed),'no_change');
 const expected=clone(proposed),evidence=clone(currentTargets);
 const verifyProtected=after=>protectedSnapshot(expected,after,evidence);
 const verify=after=>{
  const ok=verifyProtected(after);
  return {ok,partitions:Object.fromEntries(['envelope','form','rules','scripts','workflow'].map(key=>[key,ok?'verified':'mismatch'])),numberRule:{status:ok?'verified':'mismatch'},diagnostics:ok?[]:[{level:'error',code:'choice_other_repair.protected_state_mismatch',message:'Native readback differs from the exact scoped Other proposal.'}]};
 };
 const payload=clone(proposed.template);
 need(payload.mechanisms.lbpmTemplate[0].fdContent===original.workflow.fdContent,'graph_transport_mismatch');
 return {payload,proposed,verify,verifyProtected,summary:{mode:'choice_other_draft_repair',bindings:clone(bindings),changedPaths:[...changedPaths,'/auth/*/caption','/viewModel/*/controlStyle/caption','/viewModel/*/render/{desktop,mobile}/*/choice-or-caption/style/flex','/attribute/formAttr/controlAction/global/onLoad'],retainedActionIds:retained.map(action=>action.id),appendedActionId:actions[0].id,workflowWrites:0,recordWrites:0,unchangedGraphTransport:true,graphDigest:sha256Digest(original.workflow.fdContent)}};
}

function validateEnvelope({template:t,workflow:w},categoryId){
 need(t&&w&&typeof t.fdId==='string'&&t.fdId&&typeof categoryId==='string'&&categoryId,'snapshot_identity_required');
 need(t.fdName?.startsWith('MK_TEST_')&&t.fdStatus===0&&t.fdCategory?.fdId===categoryId,'draft_scope_mismatch');
 const x=t.mechanisms?.['sys-xform'],bound=t.mechanisms?.lbpmTemplate;
 need(x?.fdId===t.fdId&&x.fdName===t.fdName&&x.fdStatus==='draft'&&!x.fdVersionId&&x.fdTableName===t.fdTableName,'xform_scope_mismatch');
 need(Array.isArray(bound)&&bound.length===1&&bound[0].fdId===w.fdId&&w.fdId,'workflow_binding_mismatch');
 for(const workflow of [bound[0],w]){
  need(workflow.fdStatus==='draft'&&workflow.isDraft===true&&typeof workflow.fdContent==='string'&&workflow.fdContent.length>0,'workflow_not_complete_draft');
  need(workflow.fdName===t.fdName&&workflow.fdEntityId===t.fdId&&workflow.fdCategory?.fdFormCategoryId===categoryId&&workflow.fdFormCategory?.fdFormCategoryId===categoryId,'workflow_template_scope_mismatch');
  const forms=workflow.fdTemplateForms;
  need(Array.isArray(forms)&&forms.length===1&&forms[0].fdFormKey===t.fdId&&forms[0].fdFormCode===t.fdId,'workflow_form_binding_mismatch');
 }
 need(bound[0].fdContent===w.fdContent,'workflow_graph_mismatch');
}
function mainModel(config,template){
 const matches=(config.dataModel||[]).filter(model=>model.fdType==='main'&&model.fdId===template.fdId&&model.fdTableName===template.fdTableName);
 need(matches.length===1&&(config.dataModel||[]).filter(model=>model.fdType==='main').length===1,'main_model_identity_unproven');
 return matches[0];
}
function uniqueField(fields,id,key='id'){const matches=(fields||[]).filter(field=>field?.[key]===id);need(matches.length===1,'field_identity_ambiguous');return matches[0];}
function businessField(field){
 const result=clone(field);delete result.sourceProps?.otherTextCompanion;
 return result;
}
function validateCurrentScripts(template,priorDsl,currentConfig){
 const base=clone(template),config=clone(currentConfig),attr=json(config.attribute.formAttr);
 const current=attr.controlAction;
 // Projection must not inherit unknown current handlers from the native snapshot.
 attr.controlAction={control:{},global:{}};config.attribute.formAttr=JSON.stringify(attr);
 base.mechanisms['sys-xform'].fdConfig=JSON.stringify(config);
 const projected=json(applyFormPayload(base,priorDsl).mechanisms['sys-xform'].fdConfig);
 need(same(current,json(projected.attribute.formAttr).controlAction),'current_scripts_drifted');
}
function validateFormDelta(prior,next,bindings){
 need(Array.isArray(prior?.fields)&&Array.isArray(next?.fields)&&prior.fields.length===next.fields.length,'source_form_field_collection_changed');
 const expected=clone(next),toggles=new Set(bindings.map(binding=>binding.toggleId));
 for(let index=0;index<prior.fields.length;index++){
  const old=prior.fields[index],field=expected.fields[index];need(old.id===field.id,'source_form_field_order_changed');
  if(toggles.has(field.id)){
   need(!old.sourceProps?.choiceOtherToggle&&field.sourceProps?.choiceOtherToggle,'prior_caption_marker_mismatch');
   for(const key of ['type','componentId','props','generated','reason']){
    if(Object.hasOwn(old,key))field[key]=clone(old[key]);else delete field[key];
   }
   delete field.sourceProps.choiceOtherToggle;
  }
  const binding=bindings.find(binding=>binding.choiceId===field.id);
  if(binding&&!old.sourceProps?.otherTextCompanion)delete field.sourceProps?.otherTextCompanion;
 }
 need(same(prior,expected),'source_form_delta_outside_scope');
}
function patchAuthorization(config,table,{toggleId,choiceId,textId}){
 need(Array.isArray(config.auth)&&config.auth.length>0,'native_authorization_missing');
 for(const auth of config.auth)for(const mode of ['add','edit','view']){
  const fields=auth[mode]?.[table]?.fields;need(fields&&fields[toggleId]&&fields[choiceId]&&fields[textId],'native_field_authorization_missing');
  const caption=fields[toggleId],choice=fields[choiceId],text=fields[textId];
  need([choice,text].every(entry=>typeof entry.visible==='boolean'&&(entry.hide===undefined||typeof entry.hide==='boolean')),'native_field_visibility_unproven');
  caption.visible=choice.visible&&text.visible&&!choice.hide&&!text.hide;
  caption.hide=!caption.visible;
  if(mode!=='view'){
   need([choice,text].every(entry=>typeof entry.editable==='boolean'),'native_field_editability_unproven');
   caption.editable=choice.editable&&text.editable;caption.required=false;
  }else if(Object.hasOwn(caption,'required'))caption.required=false;
 }
}
function patchViews(config,canonicalConfig,bindings){
 need(Array.isArray(config.viewModel)&&config.viewModel.length===1&&canonicalConfig.viewModel.length===1,'view_model_ambiguous');
 const view=json(config.viewModel[0].fdConfig),generated=json(canonicalConfig.viewModel[0].fdConfig);
 for(const {toggleId,choiceId} of bindings){
  need(view.controlStyle&&typeof view.controlStyle==='object','control_style_missing');
  if(Object.hasOwn(view.controlStyle,choiceId))view.controlStyle[toggleId]=clone(view.controlStyle[choiceId]);
  else delete view.controlStyle[toggleId];
  for(const platform of ['desktop','mobile'])for(const id of [toggleId,choiceId]){
   const old=fieldWrapper(view.view?.render?.[platform],id),next=fieldWrapper(generated.view?.render?.[platform],id);
   need(old.controlProps?.style&&next.controlProps?.style&&next.controlProps.style.flex==='0 1 auto','intrinsic_layout_unproven');
   old.controlProps.style.flex=next.controlProps.style.flex;
  }
 }
 config.viewModel[0].fdConfig=JSON.stringify(view);
}
function fieldWrapper(value,id){
 const matches=[];
 const visit=node=>{if(!node||typeof node!=='object')return;if(node.type==='div'&&node.children?.length===1&&node.children[0]?.key===id)matches.push(node);for(const child of Object.values(node))if(Array.isArray(child))child.forEach(visit);else visit(child);};
 visit(value);need(matches.length===1,'layout_field_wrapper_ambiguous');return matches[0];
}
function retainedLoadActions(action){
 need(action.name==='onLoad'&&typeof action.function==='string'&&typeof action.id==='string'&&action.id,'onload_shape_invalid');
 const ast=parse(action.function,{ecmaVersion:2020});need(ast.body.length===1&&ast.body[0].type==='FunctionDeclaration'&&ast.body[0].id.name==='onLoad','onload_declaration_invalid');
 if(!Object.hasOwn(action,'migrationActions')){
  need(Object.keys(action).every(key=>['id','name','function','migrationRunWhen'].includes(key)),'onload_metadata_unknown');
  return [clone(action)];
 }
 need(Array.isArray(action.migrationActions)&&action.migrationActions.length>0,'dispatcher_metadata_invalid');
 const actions=action.migrationActions.map((metadata,index)=>{
  need(metadata.name===`onLoad_${index+1}`&&typeof metadata.id==='string'&&metadata.id&&Object.keys(metadata).every(key=>['id','name','migrationRunWhen'].includes(key)),'dispatcher_metadata_invalid');
  const body=markedDispatcherActionFunction(action.function,metadata.name);need(body,'dispatcher_handler_missing');
  const deindented=body.split('\n').map((line,index)=>index>0&&line.startsWith('  ')?line.slice(2):line).join('\n');
  return {...clone(metadata),function:deindented};
 });
 need(new Set(actions.map(action=>action.id)).size===actions.length,'dispatcher_action_identity_ambiguous');
 need(same(buildGlobalDispatcher('onLoad',actions),action),'dispatcher_metadata_function_mismatch');
 return actions;
}

/** Compare the entire expected bundle, allowing only demonstrated typed audit normalization. */
export function protectedSnapshot(expected,after,targets){
 try{
  const left=withoutMechanismTokens(clone(expected)),right=withoutMechanismTokens(clone(after));
  validateEnvelope(right,left.template.fdCategory.fdId);
  normalizeTime(left.template,right.template,'fdAlterTime');
  const lx=left.template.mechanisms['sys-xform'],rx=right.template.mechanisms['sys-xform'];normalizeTime(lx,rx,'fdAlterTime');
  const lc=json(lx.fdConfig),rc=json(rx.fdConfig),lm=mainModel(lc,left.template),rm=mainModel(rc,right.template);normalizeTime(lm,rm,'fdAlterTime');
  need(lc.dataModel.length===rc.dataModel.length,'model_collection_changed');
  const identities=lc.dataModel.map(model=>model.fdId+'#'+model.fdTableName);need(new Set(identities).size===identities.length,'model_identity_ambiguous');
  for(let i=0;i<lc.dataModel.length;i++)if(lc.dataModel[i]!==lm)normalizeDetailAudit(lc.dataModel[i],rc.dataModel[i],expected,after);
  // Only the configuration envelope is parsed; original field, script and graph strings stay exact.
  lx.fdConfig=lc;rx.fdConfig=rc;
  need(same(left.template.fdReaders,right.template.fdReaders),'root_readers_changed');
  for(const [a,b]of [[left.template.mechanisms.lbpmTemplate[0],right.template.mechanisms.lbpmTemplate[0]],[left.workflow,right.workflow]]){
   normalizeEditorReferences(a,b,targets);
   normalizeReaderReferences(a,b,targets,left.template.fdReaders);
  }
  return same(left,right);
 }catch{return false;}
}
function validTime(value){return Number.isSafeInteger(value)&&value>=0&&new Date(value).getTime()===value;}
function normalizeTime(left,right,key){
 if(same(left[key],right[key]))return;
 need(validTime(left[key])&&validTime(right[key])&&right[key]>=left[key],'native_audit_invalid');delete left[key];delete right[key];
}
function normalizeDetailAudit(left,right,before,after){
 if(same(left,right))return;
 need(left.fdType==='detail'&&right?.fdType==='detail'&&left.fdId&&left.fdTableName&&right.fdId===left.fdId&&right.fdTableName===left.fdTableName,'detail_identity_changed');
 const actor=after.template.fdAlter,from=after.template.fdAlterTime,to=after.template.mechanisms['sys-xform'].fdAlterTime;
 for(const key of ['fdAlter','fdAlterTime','fdDeletedFields']){
  if(same(left[key],right[key]))continue;
  if(key==='fdAlter')need(!Object.hasOwn(left,key)&&actor?.fdId&&same(right[key],actor)&&same(before.template.fdAlter,actor),'detail_audit_actor_unproven');
  if(key==='fdAlterTime')need(validTime(from)&&validTime(to)&&validTime(right[key])&&right[key]>=from&&right[key]<=to&&(!Object.hasOwn(left,key)||validTime(left[key])&&right[key]>=left[key]),'detail_audit_time_invalid');
  if(key==='fdDeletedFields')need(!Object.hasOwn(left,key)&&Array.isArray(right[key])&&right[key].length===0,'detail_deleted_fields_changed');
  delete left[key];delete right[key];
 }
}
function normalizeEditorReferences(left,right,targets){
 if(same(left.fdEditors,right.fdEditors))return;
 need(Array.isArray(left.fdEditors)&&Array.isArray(right.fdEditors)&&left.fdEditors.length===right.fdEditors.length,'workflow_editors_changed');
 for(let i=0;i<left.fdEditors.length;i++){
  const a=left.fdEditors[i],b=right.fdEditors[i],matches=targets.filter(target=>target.fdId===a.fdId),target=matches[0];
  need(a.fdId===b.fdId&&matches.length===1&&typeof target.fdIsAvailable==='boolean'&&target.fdIsBusiness===true&&Number(target.fdOrgType)===8,'editor_reference_unverified');
  for(const member of [a,b])need(Object.keys(member).every(key=>['fdId','fdName','fdOrgType'].includes(key))&&(member.fdOrgType===undefined||Number(member.fdOrgType)===8),'editor_reference_shape_invalid');
  need(a.fdName===target.fdName&&(b.fdName===undefined||b.fdName===a.fdName),'editor_display_identity_changed');
  delete a.fdName;delete b.fdName;delete a.fdOrgType;delete b.fdOrgType;
 }
}
function nativeOrgTypes(){
 const entry=MK_JS_SNIPPETS_CATALOG.categories.flatMap(category=>category.functions||[]).find(fn=>fn.name==='promise_获取流程基础信息');
 const line=entry?.insertedCode?.split('\n').find(line=>line.startsWith('* {'));need(line,'native_org_type_catalog_missing');
 const description=JSON.parse(line.slice(2)).properties?.creator?.properties?.orgType?.description;
 need(typeof description==='string','native_org_type_domain_missing');
 const types=[...description.matchAll(/\b(\d+):/g)].map(match=>Number(match[1]));
 need(types.length>0&&new Set(types).size===types.length&&types.every(type=>Number.isSafeInteger(type)&&type>0),'native_org_type_domain_invalid');return types;
}
function normalizeReaderReferences(left,right,targets,rootReaders){
 if(same(left.fdReaders,right.fdReaders))return;
 need(Array.isArray(left.fdReaders)&&Array.isArray(right.fdReaders)&&Array.isArray(rootReaders)&&left.fdReaders.length===right.fdReaders.length&&left.fdReaders.length===rootReaders.length,'workflow_readers_changed');
 need(new Set(rootReaders.map(reader=>reader.fdId)).size===rootReaders.length,'root_reader_identity_ambiguous');
 for(let i=0;i<left.fdReaders.length;i++){
  const a=left.fdReaders[i],b=right.fdReaders[i],root=rootReaders[i],matches=targets.filter(target=>target.fdId===a.fdId),target=matches[0];
  need(a.fdId===b.fdId&&a.fdId===root.fdId&&a.fdName===root.fdName&&matches.length===1,'reader_reference_identity_unverified');
  need(Number.isInteger(target.fdOrgType)&&CHOICE_OTHER_NATIVE_ORG_TYPES.includes(target.fdOrgType)&&typeof target.fdIsAvailable==='boolean'&&target.fdIsBusiness===true,'reader_reference_type_unverified');
  need(typeof a.fdName==='string'&&a.fdName&&a.fdName===target.fdName&&(b.fdName===undefined||b.fdName===a.fdName),'reader_display_identity_changed');
  for(const key of ['fdOrgType','fdIsAvailable','fdIsBusiness'])if(Object.hasOwn(a,key))need(key==='fdOrgType'?Number(a[key])===target[key]:a[key]===target[key],'reader_reference_metadata_mismatch');
  // IDs, order, types and every other metadata key remain byte-for-byte protected.
  delete a.fdName;delete b.fdName;
 }
}
