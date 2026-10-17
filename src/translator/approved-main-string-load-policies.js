import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {buildJavaScriptBindingModel} from '../dsl/javascript-binding-provenance.js';
import {inlineRadioRowEffectCandidates} from './inline-radio-row-effects.js';
import {canonicalJson} from '../agent-review/digest.js';

export const MAIN_STRING_CURRENT_LOAD_KIND='main-string-current-value-load';
const hash=value=>'sha256:'+createHash('sha256').update(String(value)).digest('hex');
const digest=/^sha256:[a-f0-9]{64}$/;
const apis=new Set(['window','Com_AddEventListener','GetXFormFieldValueById','GetXFormFieldById','common_dom_row_set_show_required_reset']);
const reservedAliases=new Set(['MKXFORM','Array','String','Object','JSON','Boolean','Number','RegExp','Function','undefined','NaN','Infinity','arguments','globalThis','window','document','eval']);
const ref=source=>source.sourceRef||source.id;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function fail(message){throw Object.assign(new Error(message),{code:'policy.current_main_string_source_not_matched'});}
function requireMatch(condition,message){if(!condition)fail(message);}
function rangeValid(value){return exact(value,['start','end','sha256'])&&Number.isInteger(value.start)&&Number.isInteger(value.end)&&value.start>=0&&value.end>value.start&&digest.test(value.sha256);}
export function validateApprovedMainStringLoadDecisions(decisions=[]){
 const diagnostics=[],seen=new Set(),error=message=>diagnostics.push({level:'error',code:'policy.current_main_string_invalid',message});
 if(!Array.isArray(decisions))error('Expected a decision array.');
 else for(const decision of decisions){
  if(!exact(decision,['kind','sourceRef','sourceJavascriptSha256','actionId','fieldId','callback','getter'])||decision.kind!==MAIN_STRING_CURRENT_LOAD_KIND||
    ![decision.sourceRef,decision.actionId,decision.fieldId].every(value=>typeof value==='string'&&value.trim()===value&&value.length>0&&!/[\r\n]/.test(value))||
    !digest.test(decision.sourceJavascriptSha256||'')||!rangeValid(decision.callback)||!rangeValid(decision.getter)||decision.getter.start<decision.callback.start||decision.getter.end>decision.callback.end)error('The exact typed source/action/hash/callback/getter schema is required.');
  if(seen.has(decision?.actionId))error('Each action may be changed by only one decision.');seen.add(decision?.actionId);
 }
 return {ok:diagnostics.length===0,diagnostics};
}
export function applyApprovedMainStringLoadPolicies(sourceDraft,draft,decisions=[]){
 requireMatch(validateApprovedMainStringLoadDecisions(decisions).ok,'Invalid current main String load decisions.');
 const result=structuredClone(draft),audits=[];
 for(const decision of decisions){
  const sources=sourceDraft.scripts?.sources||[],source=one(sources,s=>ref(s)===decision.sourceRef);
  requireMatch(source&&hash(source.javascript)===decision.sourceJavascriptSha256,'Original source JavaScript does not match the scoped hash.');
  const action=one(result.scripts?.actions||[],a=>a.id===decision.actionId);
  requireMatch(action?.event==='onLoad'&&action.scope==='global'&&action.sourceRefs?.length===1&&action.sourceRefs[0]===decision.sourceRef,'The original global load action is not uniquely bound.');
  for(const entry of sources)requireMatch(stableGlobals(entry.javascript),'A source-owned API declaration or reassignment invalidates projection.');
  const program=parse(source.javascript,{ecmaVersion:'latest'}),bindings=buildJavaScriptBindingModel(source.javascript);
  requireMatch(bindings.ok,'Original source binding model is invalid.');
  let ordinal=0,callback;
  for(const statement of program.body){
   const call=statement.expression;if(call?.type!=='CallExpression'||call.callee?.type!=='Identifier'||!['AttachXFormValueChangeEventById','Com_AddEventListener'].includes(call.callee.name))continue;
   ordinal++;
   if(source.id+'.event.'+ordinal!==action.id)continue;
   requireMatch(call.callee.name==='Com_AddEventListener'&&call.arguments.length===3&&call.arguments[0]?.name==='window'&&call.arguments[1]?.value==='load'&&bindings.isUnshadowedGlobal('Com_AddEventListener',call.start)&&bindings.isUnshadowedGlobal('window',call.start),'Only an original unshadowed window load callback is supported.');
   const fn=call.arguments[2];requireMatch(fn?.type==='FunctionExpression'&&!fn.async&&!fn.generator&&!fn.id&&fn.params.length===0,'Only a zero-argument ordinary load callback is supported.');callback={call,fn};
  }
  requireMatch(callback&&matches(source.javascript,callback.call,decision.callback),'The complete original load range/hash does not match.');
  const getters=[];walk(callback.fn.body,(node,parent)=>{if(node.type==='CallExpression'&&node.callee?.name==='GetXFormFieldValueById')getters.push({node,parent});});
  requireMatch(getters.length===1,'Exactly one original list getter is allowed.');
  const {node:getter,parent}=getters[0];
  requireMatch(matches(source.javascript,getter,decision.getter)&&getter.arguments.length===1&&getter.arguments[0]?.type==='Literal'&&getter.arguments[0].value===decision.fieldId&&parent?.type==='VariableDeclarator'&&parent.init===getter&&parent.id.type==='Identifier','The exact getter call must initialize one local value alias.');
  requireMatch(['GetXFormFieldValueById','GetXFormFieldById'].every(name=>bindings.isUnshadowedGlobal(name,getter.start)),'A getter is shadowed by original source.');
  requireMatch(aliasComparisonsOnly(callback.fn.body,parent.id.name,parent.id),'Only nonempty loose String comparisons may observe the local list alias.');
  requireMatch(!reservedAliases.has(parent.id.name),'A reserved target runtime name cannot be used as the local alias.');
  const field=one(result.form?.fields||[],field=>field.id===decision.fieldId),sourceProps=field?.sourceProps||{},fact=sourceProps.mainStringValueBindingFact;
  const sourceField=one([...(sourceDraft.form?.controls||[]),...(sourceDraft.form?.dataFields||[])],field=>field.id===decision.fieldId);
  requireMatch(sourceField&&canonicalJson(sourceField.sourceProps?.mainStringValueBindingFact)===canonicalJson(fact),'The native field must retain the original source-bound metadata fact without promotion.');
  requireMatch(field&&['text','longText'].includes(field.type)&&field.componentId==='xform-hidden'&&!field.columns&&field.dataOnly!==true&&field.props?.multiple!==true&&!["multiple","tags"].includes(field.props?.mode)&&
   !result.form.fields.some(table=>table.type==='detailTable'&&table.columns?.some(column=>column.id===decision.fieldId))&&
   fact?.version===1&&fact.fieldId===decision.fieldId&&fact.metadata?.count===1&&fact.metadata.type==='String'&&fact.metadata.declarations?.length===1&&fact.metadata.declarations[0].kind==='extendsimpleproperty'&&fact.metadata.declarations[0].type==='String'&&
   ['fdDesignerHtml','fdDisplayJsp','fdMetadataXml'].every(key=>/^[a-f0-9]{64}$/.test(fact.sourceHashes?.[key]||''))&&
   [undefined,decision.fieldId].includes(sourceProps.metadataId)&&[undefined,'simple'].includes(sourceProps.metadataKind)&&[undefined,'String'].includes(sourceProps.metadataAttributes?.type)&&
   [undefined,decision.fieldId].includes(sourceProps.designerId)&&[undefined,'','String'].includes(sourceProps.designerValues?.dataType),'One actual hidden native field and unique main String metadata are required.');
  const projected=source.javascript.slice(callback.call.start,getter.start)+'GetXFormFieldById('+JSON.stringify(decision.fieldId)+')[0].value'+source.javascript.slice(getter.end,callback.call.end);
  const compiled=inlineRadioRowEffectCandidates({...source,javascript:projected},result.form,{});
  const candidate=one(compiled,c=>c.event==='onLoad'&&c.index===0&&c.translationStatus==='mapped');
  requireMatch(candidate&&compiled.length===1,'The existing scalar compiler did not close every original ordered row effect.');
  let fn=candidate.function;const target=parse('('+fn+')',{ecmaVersion:'latest'}),reads=[];
  walk(target,node=>{if(node.type==='CallExpression'&&node.callee?.type==='MemberExpression'&&node.callee.object?.name==='MKXFORM'&&node.callee.property?.name==='getValue')reads.push(node);});
  requireMatch(reads.length===1&&reads[0].arguments[0]?.value===decision.fieldId,'Scalar compilation must read only the scoped main field once.');
  const read=reads[0],normalizer='(function(__policyValue){if(__policyValue===undefined||__policyValue===null)return "";if(typeof __policyValue!=="string")throw "Expected one current main String value.";return __policyValue;})(MKXFORM.getValue('+JSON.stringify(decision.fieldId)+'))';
  // The parsed expression has a leading parenthesis absent from function text.
  fn=fn.slice(0,read.start-1)+normalizer+fn.slice(read.end-1);
  const audit={kind:decision.kind,actionId:action.id,sourceRef:decision.sourceRef,sourceJavascriptSha256:decision.sourceJavascriptSha256,fieldId:decision.fieldId,
   coveredRanges:[{sourceRef:decision.sourceRef,start:callback.call.start,end:callback.call.end,name:'approvedCurrentMainStringLoad'}],getterRange:decision.getter,
   sourceBindingFactStatus:fact.status,targetComponentId:field.componentId,approvedDifference:'Replace legacy list loose-comparison input with the current metadata-backed native main String; duplicate/injected legacy bindings are not reproduced.',projection:'GetXFormFieldById(literal)[0].value compile-only projection; immutable source unchanged.'};
  action.function=fn;action.translationStatus='mapped';action.coverage={status:'translated',nativeRules:[],residuals:[]};
  action.functionMappings=[{source:decision.kind,target:'Current main String and original ordered row effects',basis:'approved-runtime-policy',reviewRequired:false}];
  action.semanticHints={...action.semanticHints,coveredCalculationRanges:audit.coveredRanges,approvedCurrentMainString:{decision,audit}};audits.push(audit);
 }
 return {draft:result,audits,changedActionIds:audits.map(a=>a.actionId)};
}
function one(values,predicate){const found=values.filter(predicate);return found.length===1?found[0]:undefined;}
function matches(text,node,range){return node.start===range.start&&node.end===range.end&&hash(text.slice(node.start,node.end))===range.sha256;}
function aliasComparisonsOnly(body,name,declaration){let valid=true,count=0,declarations=0;walk(body,(node,parent)=>{
 if(node.type==='VariableDeclarator'&&node.id?.name===name)declarations++;
 if(node.type!=='Identifier'||node.name!==name||node===declaration)return;
 const other=parent?.left===node?parent.right:parent?.right===node?parent.left:undefined;
 if(parent?.type!=='BinaryExpression'||!['==','!='].includes(parent.operator)||other?.type!=='Literal'||typeof other.value!=='string'||other.value.length===0)valid=false;else count++;
 });return valid&&count>0&&declarations===1;}
function stableGlobals(text){let valid=true;walk(parse(text,{ecmaVersion:'latest'}),node=>{
 if(node.type==='VariableDeclarator'&&apis.has(node.id?.name)||node.type==='FunctionDeclaration'&&apis.has(node.id?.name))valid=false;
 if(['FunctionExpression','FunctionDeclaration','ArrowFunctionExpression'].includes(node.type)&&node.params.some(p=>p.type!=='Identifier'||apis.has(p.name)||p.name==='window'))valid=false;
 if(node.type==='AssignmentExpression'||node.type==='UpdateExpression'){let target=node.left||node.argument;if(target.type==='Identifier'&&apis.has(target.name))valid=false;if(target.type==='MemberExpression'&&['window','globalThis','self'].includes(target.object?.name)&&(target.computed?target.property.type!=='Literal'||apis.has(target.property.value):apis.has(target.property.name)))valid=false;}
 });return valid;}
function walk(node,visit,parent){if(!node||typeof node!=='object')return;visit(node,parent);for(const value of Object.values(node))if(value&&typeof value==='object')Array.isArray(value)?value.forEach(child=>walk(child,visit,node)):walk(value,visit,node);}
