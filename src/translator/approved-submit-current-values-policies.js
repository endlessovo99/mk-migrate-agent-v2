import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {canonicalJson} from '../agent-review/digest.js';
import {buildJavaScriptBindingModel} from '../dsl/javascript-binding-provenance.js';
import {synchronousSubmitValidationCandidate,synchronousOnChangeAlertCandidate} from './sysform-submit-validation.js';

export const SUBMIT_CURRENT_VALUES_KIND='submit-validation-current-values';
export const OMIT_UNBOUND_DIAGNOSTIC_KIND='omit-unbound-console-diagnostic';
const hash=value=>'sha256:'+createHash('sha256').update(String(value)).digest('hex');
const sha=value=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);
const id=value=>typeof value==='string'&&/^fd_[A-Za-z0-9_]+$/.test(value);
const text=value=>typeof value==='string'&&value.length>0&&value.trim()===value&&!/[\r\n]/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const range=value=>Number.isInteger(value?.start)&&Number.isInteger(value?.end)&&value.start>=0&&value.end>value.start&&sha(value.sha256);
const protectedApis=new Set(['$','Number','String','parseFloat','isNaN','alert','console','Com_Parameter','MKXFORM','Array']);
const reservedLocals=new Set([...protectedApis,'undefined','NaN','Infinity','arguments','globalThis','window','self','document','eval','Function']);
const sourceRef=source=>source.sourceRef||source.id;
function requireProof(condition,message){if(!condition)throw Object.assign(new Error(message),{code:'policy.submit_current_values_source_not_matched'});}

export function validateApprovedSubmitCurrentValueDecisions(decisions){
 const diagnostics=[],actions=new Set(),sources=new Set();
 const invalid=()=>diagnostics.push({level:'error',code:'policy.submit_current_values_invalid',message:'An exact source/action/callback digest, ordered numeric sum and explicit read replacement ranges are required.'});
 if(!Array.isArray(decisions))invalid();
 else for(const decision of decisions){
  const aggregate=decision?.aggregate,replacements=decision?.readReplacements;
  if(!exact(decision,['kind','sourceRef','sourceJavascriptSha256','actionId','callback','aggregate','readReplacements'])||decision.kind!==SUBMIT_CURRENT_VALUES_KIND||
    !text(decision.sourceRef)||!text(decision.actionId)||!sha(decision.sourceJavascriptSha256)||!exact(decision.callback,['start','end','sha256'])||!range(decision.callback)||
    !exact(aggregate,['start','end','sha256','sourceFieldIds','fieldId'])||!range(aggregate)||!id(aggregate.fieldId)||!Array.isArray(aggregate.sourceFieldIds)||aggregate.sourceFieldIds.length<2||!aggregate.sourceFieldIds.every(id)||new Set(aggregate.sourceFieldIds).size!==aggregate.sourceFieldIds.length||aggregate.sourceFieldIds.includes(aggregate.fieldId)||
    !Array.isArray(replacements)||!replacements.length||replacements.some(value=>!exact(value,['start','end','sha256','sourceFieldId','fieldId'])||!range(value)||!id(value.sourceFieldId)||!id(value.fieldId)||value.sourceFieldId===value.fieldId||!aggregate.sourceFieldIds.includes(value.sourceFieldId))||
    new Set(replacements?.map(value=>value.sourceFieldId)).size!==replacements?.length||actions.has(decision.actionId)||sources.has(decision.sourceRef))invalid();
  if(decision?.callback&&aggregate&&[aggregate,...(Array.isArray(replacements)?replacements:[])].some(value=>value.start<decision.callback.start||value.end>decision.callback.end))invalid();
  actions.add(decision?.actionId);sources.add(decision?.sourceRef);
 }
 return {ok:diagnostics.length===0,diagnostics};
}

/** Explicit business replacement of values; never an inferred old/new field alias. */
export function applyApprovedSubmitCurrentValuePolicies(sourceDraft,draft,decisions=[]){
 requireProof(validateApprovedSubmitCurrentValueDecisions(decisions).ok,'Invalid submit current-value decisions.');
 const result=structuredClone(draft),audits=[];
 for(const decision of decisions){
  const sources=sourceDraft.scripts?.sources||[],source=one(sources,value=>sourceRef(value)===decision.sourceRef);
  requireProof(source&&hash(source.javascript)===decision.sourceJavascriptSha256,'The complete original submit source hash does not match.');
  requireProof(stableApis(sources),'A source-owned global or dynamic API invalidates the submit projection.');
  const action=one(result.scripts?.actions||[],value=>value.id===decision.actionId);
  requireProof(action?.event==='onBeforeSubmit'&&action.scope==='global'&&action.sourceRefs?.length===1&&action.sourceRefs[0]===decision.sourceRef&&
   (result.scripts?.actions||[]).filter(value=>value.sourceRefs?.includes(decision.sourceRef)).length===1,'One complete original submit action must own this source.');
  const javascript=source.javascript,program=parse(javascript,{ecmaVersion:'latest'}),statements=program.body.filter(value=>value.type!=='EmptyStatement');
  const call=statements[0]?.expression,callback=call?.arguments?.[0];
  requireProof(statements.length===1&&statements[0].type==='ExpressionStatement'&&call?.type==='CallExpression'&&!call.optional&&call.arguments.length===1&&
   same(call.callee,'Com_Parameter.event.submit.push')&&callback?.type==='FunctionExpression'&&!callback.id&&!callback.async&&!callback.generator&&callback.params.length===0&&matches(javascript,call,decision.callback),'The full ordinary zero-argument submit callback is not the approved range.');
  const bindings=buildJavaScriptBindingModel(javascript);requireProof(bindings.ok,'The original source binding model is invalid.');
  const declarations=callback.body.body.filter(value=>value.type==='VariableDeclaration');
  requireProof(declarations.every(value=>value.kind==='var'&&value.declarations.length===1&&value.declarations[0].id.type==='Identifier'&&!reservedLocals.has(value.declarations[0].id.name)),'Only distinct ordinary local declarations may be projected.');
  const variables=declarations.map(statement=>({statement,node:statement.declarations[0]}));
  requireProof(new Set(variables.map(value=>value.node.id.name)).size===variables.length,'Original submit local bindings must be unique.');
  const aggregate=one(variables,value=>matches(javascript,value.node.init,decision.aggregate));
  requireProof(aggregate,'The exact approved numeric sum initializer is missing.');
  const terms=sumTerms(aggregate.node.init);requireProof(terms&&terms.length===decision.aggregate.sourceFieldIds.length,'The approved expression must be a complete ordered Number(field) sum.');
  const reads=variables.flatMap(value=>{const field=selectorRead(value.node.init);return field?[{...value,field}]:[];});
  let declarationCount=0;walk(callback.body,node=>{if(node.type==='VariableDeclaration')declarationCount++;});
  requireProof(variables.length===reads.length+1&&declarationCount===declarations.length,'All original local initializers must be exact scalar reads or the approved complete sum.');
  const inputs=terms.map(name=>one(reads,value=>value.node.id.name===name));
  requireProof(inputs.every(Boolean)&&new Set(terms).size===terms.length&&canonicalJson(inputs.map(value=>value.field))===canonicalJson(decision.aggregate.sourceFieldIds)&&
   inputs.every(value=>value.statement.end<=aggregate.statement.start),'The complete numeric sum must use the exact approved ordered earlier scalar field reads.');
  const replacements=decision.readReplacements.map(value=>{
   const read=one(reads,item=>item.field===value.sourceFieldId&&matches(javascript,item.node.init,value));
   requireProof(read,'An approved original scalar read range does not match.');return {...value,read};
  });
  const targets=[decision.aggregate.fieldId,...replacements.map(value=>value.fieldId)];
  for(const fieldId of new Set(targets))requireProof(nativeNumericField(sourceDraft,result.form,fieldId),'Approved replacements require unique existing native numeric fields and original numeric metadata.');
  const declared=declaredIds(sourceDraft);
  requireProof(replacements.every(value=>!declared.has(value.sourceFieldId)),'This scoped recovery replaces only explicitly missing original read fields.');
  const patches=[{start:aggregate.node.init.start,end:aggregate.node.init.end,replacement:readExpression(decision.aggregate.fieldId),reason:'approved-current-aggregate-value'}];
  const removed=[];
  for(const input of inputs){
   const otherUses=[];walk(callback.body,(node,parent)=>{
    if(node.type==='Identifier'&&node.name===input.node.id.name&&node!==input.node.id&&!propertyIdentifier(node,parent)&&!(aggregate.node.init.start<=node.start&&node.end<=aggregate.node.init.end))otherUses.push(node);
   });
   if(!otherUses.length){patches.push({start:input.statement.start,end:input.statement.end,replacement:';',reason:'unused-pure-input-of-approved-replaced-sum'});removed.push(input.field);}
  }
  for(const replacement of replacements){
   requireProof(!removed.includes(replacement.sourceFieldId),'Every approved read replacement must retain an independent validation use.');
   patches.push({start:replacement.start,end:replacement.end,replacement:readExpression(replacement.fieldId),reason:'approved-current-validation-read'});
  }
  const expectedReads=reads.filter(value=>!removed.includes(value.field)).map(value=>replacements.find(replacement=>replacement.start===value.node.init.start)?.fieldId||value.field);
  requireProof(expectedReads.every(fieldId=>nativeNumericField(sourceDraft,result.form,fieldId)),'Every retained submit read must use one original native numeric field.');
  const ordered=patches.sort((left,right)=>left.start-right.start);
  requireProof(ordered.every((value,index)=>!index||ordered[index-1].end<=value.start),'Approved callback rewrites overlap.');
  const projected=[...ordered].reverse().reduce((value,patch)=>value.slice(0,patch.start)+patch.replacement+value.slice(patch.end),javascript);
  const candidate=synchronousSubmitValidationCandidate({...source,javascript:projected},result.form);
  requireProof(candidate?.translationStatus==='mapped'&&candidate.coverage?.status==='translated'&&candidate.coverage.residuals.length===0,'The existing submit compiler must close every original ordered condition and effect.');
  const audit={kind:decision.kind,status:'applied',sourceRef:decision.sourceRef,actionId:action.id,sourceJavascriptSha256:decision.sourceJavascriptSha256,
   callback:decision.callback,aggregate:decision.aggregate,readReplacements:decision.readReplacements,removedUnusedInputFieldIds:removed,projectedJavascriptSha256:hash(projected),
   targetNumericFieldEvidence:[...new Set(targets)].map(fieldId=>{const field=one(result.form.fields,value=>value.id===fieldId);return {fieldId,sourceRef:field.sourceRef,sourcePropsSha256:hash(canonicalJson(field.sourceProps))};}),
   rewrites:ordered.map(value=>({start:value.start,end:value.end,reason:value.reason,originalSha256:hash(javascript.slice(value.start,value.end)),replacementSha256:hash(value.replacement)})),
   approvedDifference:'Use explicitly approved existing current numeric values for the complete former sum and missing validation read; this is a business decision, not old/new field identity recovery.',
   preserved:['original ordered alerts and blocking returns','draft guard','unrelated form fields and rules','workflow routes and permissions'],workflowBefore:hash(canonicalJson(result.workflow||null)),originalSourcePreserved:true};
  action.function=candidate.function;action.translationStatus='mapped';action.coverage=candidate.coverage;action.unmappedFunctions=[];
  action.functionMappings=candidate.functionMappings;action.semanticHints={...action.semanticHints,...candidate.semanticHints,
   coveredCalculationRanges:[{sourceRef:decision.sourceRef,name:'approved-current-values-submit',start:call.start,end:call.end}],approvedSubmitCurrentValues:{decision,audit}};
  delete action.branchProvenance;delete action.deterministicBranchProof;audits.push(audit);
 }
 return {draft:result,audits,changedActionIds:audits.map(value=>value.actionId)};
}

export function validateApprovedUnboundDiagnosticDecisions(decisions){
 const diagnostics=[],actions=new Set(),sources=new Set();
 const invalid=()=>diagnostics.push({level:'error',code:'policy.unbound_diagnostic_invalid',message:'An exact source/action/callback and trailing unbound console.log statement range are required.'});
 if(!Array.isArray(decisions))invalid();
 else for(const decision of decisions){
  if(!exact(decision,['kind','sourceRef','sourceJavascriptSha256','actionId','callback','diagnostic'])||decision.kind!==OMIT_UNBOUND_DIAGNOSTIC_KIND||
   !text(decision.sourceRef)||!text(decision.actionId)||!sha(decision.sourceJavascriptSha256)||!exact(decision.callback,['start','end','sha256'])||!range(decision.callback)||
   !exact(decision.diagnostic,['start','end','sha256','identifier'])||!range(decision.diagnostic)||!identifier(decision.diagnostic.identifier)||reservedLocals.has(decision.diagnostic.identifier)||
   decision.diagnostic.start<=decision.callback.start||decision.diagnostic.end>=decision.callback.end||actions.has(decision.actionId)||sources.has(decision.sourceRef))invalid();
  actions.add(decision?.actionId);sources.add(decision?.sourceRef);
 }
 return {ok:diagnostics.length===0,diagnostics};
}

/** Retire only an explicitly approved diagnostic, including its possible ambient read failure. */
export function applyApprovedUnboundDiagnosticPolicies(sourceDraft,draft,decisions=[]){
 requireProof(validateApprovedUnboundDiagnosticDecisions(decisions).ok,'Invalid unbound diagnostic omission decisions.');
 const result=structuredClone(draft),audits=[];
 for(const decision of decisions){
  const sources=sourceDraft.scripts?.sources||[],source=one(sources,value=>sourceRef(value)===decision.sourceRef);
  requireProof(source&&hash(source.javascript)===decision.sourceJavascriptSha256,'The complete original diagnostic source hash does not match.');
  requireProof(stableApis(sources)&&noSourceGlobalBinding(sources,'AttachXFormValueChangeEventById'),'A source-owned platform API invalidates the diagnostic projection.');
  const javascript=source.javascript,statements=parse(javascript,{ecmaVersion:'latest'}).body.filter(value=>value.type!=='EmptyStatement');
  const call=statements[0]?.expression,callback=call?.arguments?.[1];
  const bindings=buildJavaScriptBindingModel(javascript);
  requireProof(bindings.ok&&statements.length===1&&statements[0].type==='ExpressionStatement'&&call?.type==='CallExpression'&&!call.optional&&call.callee?.type==='Identifier'&&call.callee.name==='AttachXFormValueChangeEventById'&&call.arguments.length===2&&call.arguments[0].type==='Literal'&&id(call.arguments[0].value)&&
   callback?.type==='FunctionExpression'&&!callback.id&&!callback.async&&!callback.generator&&callback.params.length===2&&callback.params.every(value=>value.type==='Identifier'&&!reservedLocals.has(value.name))&&callback.params[0].name!==callback.params[1].name&&matches(javascript,call,decision.callback),'The exact ordinary value-change callback is not the approved source range.');
  const action=one(result.scripts?.actions||[],value=>value.id===decision.actionId),fieldId=call.arguments[0].value;
  requireProof(action?.event==='onChange'&&action.scope==='control'&&action.controlId===fieldId&&action.sourceRefs?.length===1&&action.sourceRefs[0]===decision.sourceRef&&
   (result.scripts?.actions||[]).filter(value=>value.sourceRefs?.includes(decision.sourceRef)).length===1&&nativeNumericField(sourceDraft,result.form,fieldId),'One original numeric value-change action must uniquely own this source.');
  const body=callback.body.body.filter(value=>value.type!=='EmptyStatement'),statement=body.at(-1),expression=statement?.expression;
  requireProof(matches(javascript,statement,decision.diagnostic)&&statement.type==='ExpressionStatement'&&expression?.type==='CallExpression'&&!expression.optional&&same(expression.callee,'console.log')&&expression.arguments.length===1&&expression.arguments[0].type==='Identifier'&&expression.arguments[0].name===decision.diagnostic.identifier,'Only the exact final direct console.log(freeIdentifier) statement may be retired.');
  const identifierNode=expression.arguments[0];
  requireProof(bindings.isUnshadowedGlobal(identifierNode.name,identifierNode.start)&&noSourceGlobalBinding(sources,identifierNode.name)&&!declaredIds(sourceDraft).has(identifierNode.name),'The approved identifier has a source-owned binding and cannot be treated as an unbound diagnostic.');
  let uses=0;walk(callback.body,(node,parent)=>{if(node.type==='Identifier'&&node.name===identifierNode.name&&!propertyIdentifier(node,parent))uses++;});
  requireProof(uses===1,'The diagnostic identifier also participates in retained behavior.');
  const projected=javascript.slice(0,statement.start)+';'+javascript.slice(statement.end);
  const candidate=synchronousOnChangeAlertCandidate({...source,javascript:projected},result.form);
  requireProof(candidate?.translationStatus==='mapped'&&candidate.event==='onChange'&&candidate.controlId===fieldId&&candidate.coverage?.status==='translated'&&candidate.coverage.residuals.length===0,'The existing complete alert-only callback compiler must preserve every remaining original effect.');
  const audit={kind:decision.kind,status:'applied',sourceRef:decision.sourceRef,actionId:action.id,sourceJavascriptSha256:decision.sourceJavascriptSha256,callback:decision.callback,
   retiredDiagnostic:decision.diagnostic,projectedJavascriptSha256:hash(projected),workflowBefore:hash(canonicalJson(result.workflow??null)),originalSourcePreserved:true,
   approvedDifference:'Caller explicitly retires this diagnostic statement, its ambient identifier read and possible exception. No source equivalence, global value, field alias or default is inferred.',
   preserved:['original negative-value alert','all other original callback effects','field identities, required checks and formulas','workflow routes and permissions'],upstreamCalls:0};
  action.function=candidate.function;action.translationStatus='mapped';action.coverage=candidate.coverage;action.unmappedFunctions=[];action.functionMappings=candidate.functionMappings;
  action.semanticHints={...action.semanticHints,...candidate.semanticHints,coveredCalculationRanges:[{sourceRef:decision.sourceRef,name:'approved-unbound-diagnostic-omission',start:call.start,end:call.end}],approvedUnboundDiagnostic:{decision,audit}};
  delete action.branchProvenance;delete action.deterministicBranchProof;audits.push(audit);
 }
 return {draft:result,audits,changedActionIds:audits.map(value=>value.actionId)};
}

function nativeNumericField(source,form,fieldId){
 const original=one([...(source.form?.controls||[]),...(source.form?.dataFields||[])],value=>value.id===fieldId);
 const field=one(form?.fields||[],value=>value.id===fieldId),fact=original?.sourceProps?.mainStringValueBindingFact;
 return Boolean(original&&field&&original.sourceType==='number'&&field.type==='number'&&['xform-number','xform-calculate'].includes(field.componentId)&&field.dataOnly!==true&&
  !form.fields.some(value=>value.type==='detailTable'&&value.columns?.some(column=>column.id===fieldId))&&field.sourceRef===original.sourceRef&&
  ['Double','Float','Integer','Long','BigDecimal','Number'].includes(original.sourceProps?.metadataAttributes?.type)&&original.sourceProps.metadataAttributes.name===fieldId&&
  fact?.fieldId===fieldId&&fact.metadata?.count===1&&fact.metadata.type===original.sourceProps.metadataAttributes.type&&fact.metadata.declarations?.length===1&&
  canonicalJson(field.sourceProps?.mainStringValueBindingFact)===canonicalJson(fact)&&
  canonicalJson(field.sourceProps?.metadataAttributes)===canonicalJson(original.sourceProps.metadataAttributes)&&canonicalJson(field.sourceProps?.designerValues)===canonicalJson(original.sourceProps?.designerValues));
}
function selectorRead(node){
 if(node?.type!=='CallExpression'||node.optional||node.arguments.length||node.callee?.type!=='MemberExpression'||node.callee.computed||node.callee.property.name!=='val')return;
 const jquery=node.callee.object;if(jquery?.type!=='CallExpression'||jquery.optional||jquery.callee?.name!=='$'||jquery.arguments.length!==1||jquery.arguments[0].type!=='Literal')return;
 return /^\[name=(["'])extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)\1\]$/.exec(jquery.arguments[0].value)?.[2];
}
function readExpression(fieldId){return '$('+JSON.stringify('[name="extendDataFormInfo.value('+fieldId+')"]')+').val()';}
function sumTerms(node){
 if(node?.type==='BinaryExpression'&&node.operator==='+'){const left=sumTerms(node.left),right=sumTerms(node.right);return left&&right?[...left,...right]:undefined;}
 if(node?.type==='CallExpression'&&!node.optional&&node.callee?.type==='Identifier'&&node.callee.name==='Number'&&node.arguments.length===1&&node.arguments[0].type==='Identifier')return [node.arguments[0].name];
}
function stableApis(sources){return sources.every(source=>{const javascript=String(source.javascript||''),bindings=buildJavaScriptBindingModel(javascript);let stable=bindings.ok;
 walk(parse(javascript,{ecmaVersion:'latest'}),(node,parent)=>{
  if(node.type==='Identifier'&&protectedApis.has(node.name)&&!propertyIdentifier(node,parent)&&!bindings.isUnshadowedGlobal(node.name,node.start))stable=false;
  if((node.type==='CallExpression'||node.type==='NewExpression')&&['eval','Function'].includes(node.callee?.name))stable=false;
  if(['AssignmentExpression','UpdateExpression'].includes(node.type)||node.type==='UnaryExpression'&&node.operator==='delete'){
   let target=node.left||node.argument;const property=target?.type==='MemberExpression'?(target.computed?target.property?.value:target.property?.name):undefined;
   if(protectedApis.has(property))stable=false;
   while(target?.type==='MemberExpression')target=target.object;
   if(target?.type==='Identifier'&&(protectedApis.has(target.name)||['window','globalThis','self'].includes(target.name)))stable=false;
  }
 });return stable;
});}
function declaredIds(source){const ids=new Set();walk(source.form,node=>{if(node.id)ids.add(node.id);for(const key of ['designerId','metadataId','originalId'])if(node[key])ids.add(node[key]);});return ids;}
function identifier(value){return typeof value==='string'&&/^[A-Za-z_$][\w$]*$/.test(value);}
function noSourceGlobalBinding(sources,name){return sources.every(source=>{const javascript=String(source.javascript||''),model=buildJavaScriptBindingModel(javascript);let valid=model.ok;
 walk(parse(javascript,{ecmaVersion:'latest'}),(node,parent)=>{
  if(node.type==='Identifier'&&node.name===name&&!propertyIdentifier(node,parent)&&model.bindingAtUse(name,node.start)?.scope?.kind==='program')valid=false;
  if(['AssignmentExpression','UpdateExpression'].includes(node.type)||node.type==='UnaryExpression'&&node.operator==='delete'){
   const target=node.left||node.argument;if(target?.type==='Identifier'&&target.name===name||target?.type==='MemberExpression'&&(target.computed?target.property?.value:target.property?.name)===name)valid=false;
  }
 });return valid;
});}
function one(values,predicate){const found=values.filter(predicate);return found.length===1?found[0]:undefined;}
function same(node,expression){const normalize=value=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!['start','end','raw'].includes(key)).map(([key,item])=>[key,normalize(item)])):value;return canonicalJson(normalize(node))===canonicalJson(normalize(parse(expression,{ecmaVersion:'latest'}).body[0].expression));}
function matches(text,node,range){return node&&node.start===range.start&&node.end===range.end&&hash(text.slice(node.start,node.end))===range.sha256;}
function propertyIdentifier(node,parent){return parent?.type==='MemberExpression'&&parent.property===node&&!parent.computed||parent?.type==='Property'&&parent.key===node&&!parent.computed&&!parent.shorthand;}
function walk(node,visit,parent){if(!node||typeof node!=='object')return;visit(node,parent);for(const value of Object.values(node))if(value&&typeof value==='object')Array.isArray(value)?value.forEach(child=>walk(child,visit,node)):walk(value,visit,node);}
