import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {buildJavaScriptBindingModel} from '../dsl/javascript-binding-provenance.js';
import {compileStaticRowEffect} from './inline-radio-row-effects.js';

export const EMPTY_ROW_VIEW_KIND='unbound-empty-row-view';
const hash=s=>'sha256:'+createHash('sha256').update(String(s)).digest('hex');
const compact=o=>JSON.stringify(o,(key,v)=>['start','end','raw'].includes(key)?undefined:v);
const text=v=>typeof v==='string'&&v.length>0&&v.trim()===v&&!/[\r\n]/.test(v);
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const fail=message=>{throw Object.assign(new Error(message),{code:'policy.empty_row_view_unproven'})};
export function validateEmptyRowViewDecisions(decisions=[]) {
 const diagnostics=[],seen=new Set();for(const d of decisions){
  if(!exact(d,['kind','sourceRef','sourceJavascriptSha256','actionId','fieldId','matchingCode','firstRow','secondRow'])||d.kind!==EMPTY_ROW_VIEW_KIND||
    ![d.sourceRef,d.actionId,d.fieldId,d.matchingCode,d.firstRow,d.secondRow].every(text)||
    !/^sha256:[a-f0-9]{64}$/.test(d.sourceJavascriptSha256||'')||d.firstRow===d.secondRow||seen.has(d.actionId))
   diagnostics.push({level:'error',code:'policy.empty_row_view_invalid',message:'The exact source, view action, field, rows and branch decision are required.'});
  seen.add(d?.actionId);
 }return {ok:diagnostics.length===0,diagnostics};
}
export function applyEmptyRowViewPolicies(sourceDraft,draft,decisions=[]) {
 if(!validateEmptyRowViewDecisions(decisions).ok)fail('Invalid empty row view decision.');
 const result=structuredClone(draft),audits=[],changedActionIds=[];
 for(const d of decisions){
  const sources=(sourceDraft.scripts?.sources||[]).filter(s=>s.sourceRef===d.sourceRef),source=sources[0];
  if(sources.length!==1||hash(source.javascript)!==d.sourceJavascriptSha256||source.displayGate!=='xform:viewShow')fail('Original view source does not match the approved decision.');
  const actions=(result.scripts?.actions||[]).filter(a=>a.id===d.actionId),action=actions[0];
  if(actions.length!==1||action.event!=='onLoad'||action.scope!=='global'||action.sourceRefs?.length!==1||action.sourceRefs[0]!==d.sourceRef)fail('Original view action is not uniquely bound.');
  const expected=`Com_AddEventListener(window,"load",function(){var isHtz=GetXFormFieldById(${JSON.stringify(d.fieldId)})[0];if(isHtz.value.indexOf(${JSON.stringify(d.matchingCode)})>=0){common_dom_row_set_show_required_reset(${JSON.stringify(d.firstRow)},true,false,false);common_dom_row_set_show_required_reset(${JSON.stringify(d.secondRow)},true,false,false)}else if(!value){common_dom_row_set_show_required_reset(${JSON.stringify(d.firstRow)},false,false,false);common_dom_row_set_show_required_reset(${JSON.stringify(d.secondRow)},true,false,false)}});`;
  let ast,expectedAst;try{ast=parse(source.javascript,{ecmaVersion:'latest'});expectedAst=parse(expected,{ecmaVersion:'latest'})}catch{fail('Original view source is not parseable.');}
  if(compact(ast)!==compact(expectedAst))fail('Original view source contains unsupported effects or changed conditions.');
  const bindings=buildJavaScriptBindingModel(source.javascript),elseValue=ast.body[0].expression.arguments[2].body.body[1].alternate.test.argument;
  if(!bindings.ok||elseValue.name!=='value'||!bindings.isUnshadowedGlobal('value',elseValue.start)||
    !['window','Com_AddEventListener','GetXFormFieldById','common_dom_row_set_show_required_reset'].every(name=>bindings.isUnshadowedGlobal(name,ast.body[0].start)))fail('Original view references are shadowed or bound differently.');
  for(const entry of sourceDraft.scripts.sources){if(!stableProtectedGlobals(entry.javascript))fail('A sibling source mutates a protected platform function.');}
  const fields=(result.form?.fields||[]).filter(f=>f.id===d.fieldId&&f.componentId==='xform-hidden'&&f.sourceProps?.hardHidden===true&&f.sourceProps?.metadataAttributes?.type==='String');
  if(fields.length!==1)fail('The source mirror must be one hidden String field.');
  const show1=compileStaticRowEffect({target:d.firstRow,visible:true,required:false,reset:false},result.form,'    '),show2=compileStaticRowEffect({target:d.secondRow,visible:true,required:false,reset:false},result.form,'    '),hide1=compileStaticRowEffect({target:d.firstRow,visible:false,required:false,reset:false},result.form,'    ');
  if(!show1||!show2||!hide1)fail('Source row groups cannot be resolved.');
  action.function=['function onLoad() {',`  var current = String(MKXFORM.getValue(${JSON.stringify(d.fieldId)}) ?? "");`,`  if (current.indexOf(${JSON.stringify(d.matchingCode)}) >= 0) {`,...show1,...show2,'  } else if (!current) {',...hide1,...show2,'  }','}'].join('\n');
  action.translationStatus='mapped';audits.push({kind:EMPTY_ROW_VIEW_KIND,sourceRef:d.sourceRef,actionId:d.actionId,sourceJavascriptSha256:d.sourceJavascriptSha256,fieldId:d.fieldId,matchingCode:d.matchingCode,firstRow:d.firstRow,secondRow:d.secondRow,decision:'unbound value interpreted as current hidden field empty'});changedActionIds.push(action.id);
 }
 return {draft:result,audits,changedActionIds};
}
function stableProtectedGlobals(text){let ast;try{ast=parse(String(text||''),{ecmaVersion:'latest'})}catch{return false}let valid=true;const names=new Set(['GetXFormFieldById','Com_AddEventListener','common_dom_row_set_show_required_reset','window','value']);
 function walk(n,p){if(!n||typeof n!=='object')return;if((n.type==='VariableDeclarator'||n.type==='FunctionDeclaration')&&names.has(n.id?.name))valid=false;
  if(['AssignmentExpression','UpdateExpression'].includes(n.type)){let x=n.left||n.argument;if(x?.type==='Identifier'&&names.has(x.name))valid=false;while(x?.type==='MemberExpression')x=x.object;if(['window','globalThis','self','Object','Reflect'].includes(x?.name))valid=false;}
  if(['WithStatement','ImportExpression','NewExpression','ThisExpression'].includes(n.type))valid=false;
  if(n.type==='Identifier'&&['eval','Function','Reflect','Object','globalThis','self'].includes(n.name)&&!(p?.type==='MemberExpression'&&p.property===n&&!p.computed))valid=false;
  if(n.type==='Identifier'&&n.name==='window'&&!(p?.type==='CallExpression'&&p.callee?.type==='Identifier'&&p.callee.name==='Com_AddEventListener'&&p.arguments[0]===n))valid=false;
  for(const v of Object.values(n))if(v&&typeof v==='object')Array.isArray(v)?v.forEach(c=>walk(c,n)):walk(v,n);
 }walk(ast);return valid;}
