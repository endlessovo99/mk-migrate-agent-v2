import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {buildJavaScriptBindingModel} from '../dsl/javascript-binding-provenance.js';
import {resolveControlEventSupport,resolveScriptControlTarget} from '../dsl/scripts.js';
import {inlineOnChangeSourceActionKey} from './source-action-key.js';
import {jqueryReadyInitializationCandidates} from './jquery-ready-initialization.js';
import {dateOverlapSourceProfile} from './date-overlap-source-profile.js';
import {dateOnlyInputContract,nativeDateOnlyValueExpression,NATIVE_DATE_ONLY_TEXT_CONTRACT} from './native-date-only-value.js';

export const DATE_OVERLAP_LIFECYCLE_BASIS='deterministic-date-overlap-lifecycle';
const sha=value=>'sha256:'+createHash('sha256').update(String(value)).digest('hex');
const globals=new Set(['Date','String','isNaN','Math','parseFloat','console','setTimeout','AttachXFormValueChangeEventById','$','MKXFORM']);
const ref=source=>source.sourceRef||source.id;
const fieldId=value=>typeof value==='string'&&/^fd_[A-Za-z0-9_]+$/.test(value);
const identifier=value=>typeof value==='string'&&/^[A-Za-z_$][\w$]*$/.test(value);
const significant=values=>values.filter(value=>value.type!=='EmptyStatement');
const one=(values,predicate)=>{const found=values.filter(predicate);return found.length===1?found[0]:undefined;};
const literal=node=>node?.type==='Literal'?node.value:undefined;
const direct=(node,name)=>node?.type==='CallExpression'&&!node.optional&&node.callee?.type==='Identifier'&&node.callee.name===name;
const member=(node,name)=>node?.type==='MemberExpression'&&!node.computed&&!node.optional&&node.property?.name===name;
const propertyIdentifier=(node,parent)=>parent?.type==='MemberExpression'&&parent.property===node&&!parent.computed||parent?.type==='Property'&&parent.key===node&&!parent.computed&&!parent.shorthand;

/** Complete source grammar; no arbitrary helper or document-ready code is accepted. */
export function dateOverlapLifecycleCandidates(source={},form={},sourceScripts={}){
 try{
  const model=inspectDateOverlapLifecycle(source,form,sourceScripts);
  if(!model)return [];
  const {functions,ready,bindings,reads,write}=model,sourceRef=ref(source);
  const shared=functions.slice(0,3).map(node=>({sourceRef,name:node.id.name,start:node.start,end:node.end}));
  let exec=source.javascript.slice(functions[2].start,functions[2].end);
  const patches=reads.map((read,index)=>({start:read.node.start,end:read.node.end,text:index<4?nativeDateOnlyValueExpression(read.fieldId):'MKXFORM.getValue('+JSON.stringify(read.fieldId)+')'}));
  patches.push({start:write.node.start,end:write.node.end,text:'MKXFORM.setValue('+JSON.stringify(write.fieldId)+','+source.javascript.slice(write.node.arguments[0].start,write.node.arguments[0].end)+')'});
  for(const patch of patches.sort((a,b)=>b.start-a.start))exec=exec.slice(0,patch.start-functions[2].start)+patch.text+exec.slice(patch.end-functions[2].start);
  const definitions=[...functions.slice(0,2).map(node=>source.javascript.slice(node.start,node.end)),exec].join('\n');
  const closure={version:1,grammar:'source-date-overlap-lifecycle-closed-v1',sourceRef,sourceJavascriptSha256:sha(source.javascript),
   inputFieldIds:reads.map(read=>read.fieldId),outputFieldId:write.fieldId,delays:bindings.map(binding=>binding.delay),
   functionRanges:functions.map(node=>({start:node.start,end:node.end,sha256:sha(source.javascript.slice(node.start,node.end))})),
   readyRange:{start:ready.index,end:ready.index+ready.javascript.length},consoleCalls:15,nativeDateContract:NATIVE_DATE_ONLY_TEXT_CONTRACT,registrationProjection:'six native control actions before initial onLoad calculation'};
  const sourceClosureDigest=sha(JSON.stringify(closure));
  const change=bindings.map((binding,index)=>({
   id:(source.id||'script')+'.event.'+(index+1),index:binding.call.start,sourceActionKey:inlineOnChangeSourceActionKey(sourceRef,binding.call.start),
   event:'onChange',scope:'control',controlId:binding.fieldId,javascript:source.javascript,source,sourceRefs:[sourceRef],
   function:'function onChange(value,rowNum,parentRowNum){\n'+definitions+'\n'+source.javascript.slice(binding.timerStatement.start,binding.timerStatement.end)+'\n}',
   translationStatus:'mapped',coverage:{status:'translated',nativeRules:[],residuals:[]},
   functionMappings:[{source:'Complete source date-overlap calculation and scheduled native field binding',target:'Original standard JavaScript with six MKXFORM reads, one write and original timer',basis:DATE_OVERLAP_LIFECYCLE_BASIS,reviewRequired:false}],
   semanticHints:{coveredLegacyFunctions:(source.functionAudit?.violations||[]).map(value=>value.name),coveredCalculationRanges:[...shared,{sourceRef,name:'dateOverlapChangeBinding',start:binding.call.start,end:binding.call.end}],
    dateOverlapLifecycle:{...closure,sourceClosureDigest,role:'change',ordinal:index+1}}
  }));
  const load={...ready,source,sourceRefs:[sourceRef],function:'function onLoad(context){\n'+definitions+'\n'+functions[2].id.name+'();\n}',
   translationStatus:'mapped',coverage:{status:'translated',nativeRules:[],residuals:[]},
   functionMappings:[{source:'Complete ready registration followed by immediate initial date-overlap calculation',target:'Six native control actions and immediate onLoad calculation',basis:DATE_OVERLAP_LIFECYCLE_BASIS,reviewRequired:false}],
   semanticHints:{...ready.semanticHints,coveredLegacyFunctions:(source.functionAudit?.violations||[]).map(value=>value.name),coveredCalculationRanges:[...shared,{sourceRef,name:'dateOverlapRegistration',start:functions[3].start,end:functions[3].end},
    {sourceRef,name:'dateOverlapReadyInitialCalculation',start:ready.index,end:ready.index+ready.javascript.length}],
    dateOverlapLifecycle:{...closure,sourceClosureDigest,role:'load',ordinal:7}}
  };
  return [...change,load];
 }catch{return [];}
}

export function inspectDateOverlapLifecycle(source={},form={},sourceScripts={}){
 const javascript=String(source.javascript||''),program=parse(javascript,{ecmaVersion:'latest'}),root=significant(program.body);
 if(root.length!==5||root.slice(0,4).some(node=>node.type!=='FunctionDeclaration'||node.async||node.generator||!identifier(node.id?.name))||root[4].type!=='ExpressionStatement')return;
 const functions=root.slice(0,4),names=functions.map(node=>node.id.name);
 if(new Set(names).size!==4||names.some(name=>globals.has(name)||['onLoad','onChange'].includes(name))||functions.some((fn,index)=>fn.params.length!==[1,4,0,0][index]||fn.params.some(param=>param.type!=='Identifier')))return;
 const model=buildJavaScriptBindingModel(javascript);
 if(!model.ok)return;
 let reserved=false;walk(program,(node,parent)=>{if(node.type==='Identifier'&&node.name==='MKXFORM'&&!propertyIdentifier(node,parent))reserved=true;});
 if(reserved)return;
 const body=significant(functions[2].body.body);
 if(body.length!==17)return;
 const reads=[0,1,2,3,5,6].map(index=>{
  const declaration=body[index]?.declarations?.[0],node=declaration?.init;
  return declaration&&body[index].declarations.length===1&&declaration.id.type==='Identifier'&&selector(node,0)?{node,fieldId:selector(node,0)}:undefined;
 });
 const writeNode=body.at(-1)?.expression,writeField=selector(writeNode,1);
 if(reads.some(read=>!read)||!writeField)return;
 const fields=reads.map(read=>read.fieldId),allIds=[...fields,writeField];
 if(new Set(allIds).size!==7||allIds.some(id=>!fieldId(id)))return;
 const bindings=significant(functions[3].body.body).map(statement=>{
  const call=statement.expression,callback=call?.arguments?.[1],timerStatement=callback?.body?.body?.[0],timer=timerStatement?.expression;
  return direct(call,'AttachXFormValueChangeEventById')&&call.arguments.length===2&&callback?.type==='FunctionExpression'&&!callback.async&&!callback.generator&&!callback.id&&callback.params.length===0&&significant(callback.body.body).length===1&&direct(timer,'setTimeout')&&timer.arguments.length===2&&timer.arguments[0]?.type==='Identifier'&&timer.arguments[0].name===names[2]&&Number.isInteger(literal(timer.arguments[1]))&&literal(timer.arguments[1])>=0&&literal(timer.arguments[1])<=2147483647?
   {call,fieldId:literal(call.arguments[0]),timerStatement,delay:literal(timer.arguments[1])}:undefined;
 });
 if(bindings.length!==6||bindings.some((binding,index)=>!binding||binding.fieldId!==fields[index]))return;
 const expected=dateOverlapSourceProfile(fields,writeField,bindings.map(binding=>binding.delay));
 if(canonical(program,javascript)!==canonical(parse(expected,{ecmaVersion:'latest'}),expected))return;
 const sources=sourceScripts.sources?.length?sourceScripts.sources:[source];
 if(!globalsStable(sources)||sources.some(entry=>ref(entry)!==ref(source)&&externalHelperReference(entry,names)))return;
 const readyCandidates=jqueryReadyInitializationCandidates(source),ready=readyCandidates.length===1?readyCandidates[0]:undefined;
 if(!ready||ready.semanticHints?.jqueryReadyInitialization?.bindingStatus!=='source-declared')return;
 const supported=fields.every((id,index)=>uniqueField(form,id,index<4?'date':'scalar')&&resolveControlEventSupport(resolveScriptControlTarget(form,{controlId:id}),'onChange',{controlId:id}).status==='supported');
 const output=uniqueField(form,writeField,'output');
 if(!supported||!output||output.props?.calculation)return;
 return {functions,ready,bindings,reads,write:{node:writeNode,fieldId:writeField}};
}

/** Only a current authoritative model can discharge a generic ready residual. */
export function verifiedDateOverlapReadyAction(sourceDraft,form,action){
 try{
  const sources=(sourceDraft?.scripts?.sources||[]).filter(source=>action?.sourceRefs?.includes(ref(source)));
  if(sources.length!==1)return false;
  const expected=dateOverlapLifecycleCandidates(sources[0],form,sourceDraft.scripts).find(candidate=>candidate.event==='onLoad');
  return Boolean(expected&&action.event==='onLoad'&&action.scope==='global'&&action.id===expected.id&&action.sourceActionKey===expected.sourceActionKey&&
   action.function===expected.function&&action.translationStatus==='mapped'&&action.coverage?.status==='translated'&&action.coverage.residuals?.length===0&&
   action.functionMappings?.every(mapping=>mapping.basis===DATE_OVERLAP_LIFECYCLE_BASIS)&&
   action.semanticHints?.dateOverlapLifecycle?.sourceClosureDigest===expected.semanticHints.dateOverlapLifecycle.sourceClosureDigest);
 }catch{return false;}
}

function uniqueField(form,id,role){
 const field=one(form.fields||[],field=>field.id===id);
 if(!field||field.dataOnly===true||(form.fields||[]).some(table=>table.type==='detailTable'&&table.columns?.some(column=>column.id===id))||field.sourceProps?.metadataAttributes?.name!==id)return;
 const meta=field.sourceProps.metadataAttributes.type;
 if(role==='date')return dateOnlyInputContract(field)?field:undefined;
 if(role==='output')return field.type==='number'&&field.componentId==='xform-number'&&['Double','Float','Long','Integer','BigDecimal','Number'].includes(meta)?field:undefined;
 return field.type==='number'&&['xform-number','xform-calculate'].includes(field.componentId)&&['Double','Float','Long','Integer','BigDecimal','Number'].includes(meta)||field.type==='text'&&field.componentId==='xform-input'&&meta==='String'?field:undefined;
}
function selector(node,arity){
 if(node?.type!=='CallExpression'||node.optional||!member(node.callee,'val')||node.arguments.length!==arity)return;
 const jquery=node.callee.object;
 if(!direct(jquery,'$')||jquery.arguments.length!==1||typeof literal(jquery.arguments[0])!=='string')return;
 return /^input\[name=(["'])extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)\1\]$/.exec(literal(jquery.arguments[0]))?.[2];
}
function canonical(program,javascript){
 const bindings=buildJavaScriptBindingModel(javascript),names=new Map(),parents=new WeakMap();let valid=bindings.ok;
 walk(program,(node,parent)=>{if(parent)parents.set(node,parent);});
 const convert=value=>{
  if(Array.isArray(value))return value.filter(node=>node?.type!=='EmptyStatement').map(convert);
  if(!value||typeof value!=='object')return value;
  const result={};for(const [key,item]of Object.entries(value))if(!['start','end','raw'].includes(key))result[key]=convert(item);
  const parent=parents.get(value);
  if(value.type==='Identifier'&&!propertyIdentifier(value,parent)){
   const binding=bindings.bindingAtUse(value.name,value.start);
   if(binding){if(binding.ambiguous)valid=false;if(!names.has(binding))names.set(binding,'__binding_'+names.size);result.name=names.get(binding);}
  }
  if(value.type==='Literal'&&typeof value.value==='string'&&parent?.type==='CallExpression'&&member(parent.callee,'log')&&parent.callee.object?.name==='console')result.value='__source_diagnostic_literal__';
  return result;
 };
 const result=JSON.stringify(convert(program));return valid?result:undefined;
}
function externalHelperReference(source,names){let found=false;walk(parse(String(source.javascript||''),{ecmaVersion:'latest'}),(node,parent)=>{if(node.type==='Identifier'&&names.includes(node.name)&&!propertyIdentifier(node,parent))found=true;});return found;}
function globalsStable(sources){return sources.every(source=>{
 const javascript=String(source.javascript||''),model=buildJavaScriptBindingModel(javascript),parents=new WeakMap();let stable=model.ok;
 walk(parse(javascript,{ecmaVersion:'latest'}),(node,parent)=>{
  if(parent)parents.set(node,parent);
  if(['WithStatement','ImportExpression'].includes(node.type))stable=false;
  if(node.type==='Identifier'&&!propertyIdentifier(node,parent)&&['eval','Function'].includes(node.name)&&model.isUnshadowedGlobal(node.name,node.start))stable=false;
  if(node.type==='Identifier'&&globals.has(node.name)&&!propertyIdentifier(node,parent)){
   const binding=model.bindingAtUse(node.name,node.start);if(binding?.scope?.kind==='program')stable=false;
   if(!binding){
    const owner=parents.get(parent);
    const directUse=(parent?.type==='CallExpression'||parent?.type==='NewExpression')&&parent.callee===node;
    const memberUse=parent?.type==='MemberExpression'&&parent.object===node&&!parent.computed&&owner?.type==='CallExpression'&&owner.callee===parent;
    if(!directUse&&!memberUse)stable=false;
   }
  }
  if(['AssignmentExpression','UpdateExpression'].includes(node.type)||node.type==='UnaryExpression'&&node.operator==='delete'){
   let target=node.left||node.argument;while(target?.type==='MemberExpression')target=target.object;
   if(target?.type==='Identifier'&&(globals.has(target.name)||['window','globalThis','self'].includes(target.name)))stable=false;
  }
  if(node.type==='CallExpression'&&node.callee?.type==='MemberExpression'&&['Object','Reflect'].includes(node.callee.object?.name)&&['assign','defineProperty','defineProperties','set'].includes(node.callee.property?.name)&&['window','globalThis','self',...globals].includes(node.arguments[0]?.name))stable=false;
 });return stable;
});}
function walk(node,visit,parent){if(!node||typeof node!=='object')return;visit(node,parent);for(const value of Object.values(node))if(value&&typeof value==='object')Array.isArray(value)?value.forEach(child=>walk(child,visit,node)):walk(value,visit,node);}
