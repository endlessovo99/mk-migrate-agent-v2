import {parse} from "acorn";
import {canonicalJson,sha256Digest} from "../agent-review/digest.js";
import {buildFormRuleRefIndex,resolveEffectTarget} from "../dsl/form-rules.js";

const helper="common_dom_row_set_show_required_reset";
const fail=message=>{throw Object.assign(new Error(message),{code:"policy.detail_view.source_unproved"});};
const requireProof=(value,message)=>{if(!value)fail(message);};
const id=(node,name)=>node?.type==="Identifier"&&(!name||node.name===name);
const call=(node,name)=>node?.type==="CallExpression"&&id(node.callee,name);
const literal=node=>node?.type==="Literal"?node.value:undefined;

/** A source-bound slice of main-radio visibility. Legacy detail-row restoration remains excluded. */
export function buildSupportedDetailViewPlan(sourceDraft,baseDraft,actions){
 const candidates=[];
 for(const source of sourceDraft.scripts?.sources||[]){
  if(source.displayGate&&source.displayGate!=="xform:viewShow")continue;
  const ast=parse(source.javascript,{ecmaVersion:"latest"});
  walk(ast,node=>{
   if(node.type==="FunctionDeclaration"&&[helper,"GetXFormFieldById"].includes(node.id?.name)||
      node.type==="VariableDeclarator"&&[helper,"GetXFormFieldById"].includes(node.id?.name)||
      node.type==="AssignmentExpression"&&id(node.left)&&[helper,"GetXFormFieldById"].includes(node.left.name))fail("View helpers must retain their source builtin identity.");
  });
  const loads=ast.body.filter(node=>call(node.expression,"Com_AddEventListener")).map(node=>node.expression)
   .filter(node=>id(node.arguments[0],"window")&&literal(node.arguments[1])==="load"&&node.arguments[2]?.type==="FunctionExpression");
  for(const load of loads){
   const callback=load.arguments[2],sourceRef=source.sourceRef||source.id;
   const owners=actions.filter(action=>action.event==="onLoad"&&action.scope==="global"&&action.sourceRefs?.length===1&&action.sourceRefs[0]===sourceRef);
   if(!owners.length)continue;
   requireProof(loads.length===1&&owners.length===1,"One source window-load action must own the view slice.");
   candidates.push(compilePlan(source,callback,owners[0],baseDraft));
  }
 }
 requireProof(candidates.length===1,"One unambiguous source main-visibility load slice is required.");
 return candidates[0];
}

export function supportedDetailViewDecision(plan){
 return {version:1,mode:"native-main-visibility-view-v1",actionId:plan.actionId,sourceRef:plan.sourceRef,planSha256:sha256Digest(plan)};
}

export function renderSupportedDetailView(plan){
 const lines=["function onLoad() {","  /* Source-bound main visibility only; legacy row lifecycle remains excluded. */","  /* mk-migrate:view-status=view */",'  if (MKXFORM.viewStatus !== "view") return;'];
 plan.bindings.forEach(({fieldId},i)=>{
  lines.push(`  var selected${i} = MKXFORM.getValue(${JSON.stringify(fieldId)});`,
   `  selected${i} = Array.isArray(selected${i}) ? selected${i}[0] : selected${i};`,
   `  selected${i} = selected${i} == null ? "" : String(selected${i});`);
 });
 function predicate(p){return p.op==="eq"?`selected${p.binding} === ${JSON.stringify(p.value)}`:`(${predicate(p.left)}) ${p.op==="and"?"&&":"||"} (${predicate(p.right)})`;}
 function render(statements,indent){for(const s of statements){
  if(s.kind==="visible")lines.push(`${indent}MKXFORM.setFieldAttr(${JSON.stringify(s.target)}, ${s.value?5:4});`);
  else{lines.push(`${indent}if (${predicate(s.test)}) {`);render(s.when,indent+"  ");if(s.else.length){lines.push(`${indent}} else {`);render(s.else,indent+"  ");}lines.push(`${indent}}`);}
 }}
 render(plan.statements,"  ");lines.push("}");return lines.join("\n");
}

function compilePlan(source,callback,action,baseDraft){
 const bindings=[],byName=new Map(),allowedWrites=new Set(),body=callback.body.body;
 for(let i=0;i<body.length-2;i++){
  const assignment=body[i].expression,decl=body[i+1];
  if(assignment?.type!=="AssignmentExpression"||assignment.operator!=="="||!id(assignment.left)||!call(assignment.right,"GetXFormFieldById"))continue;
  const fieldId=literal(assignment.right.arguments[0]);
  requireProof(assignment.right.arguments.length===1&&typeof fieldId==="string","Main view selection must use a static source field.");
  requireProof(decl.type==="VariableDeclaration"&&decl.declarations.length===1&&id(decl.declarations[0].id)&&literal(decl.declarations[0].init)===null,"Main view selection requires the source null-initialized alias.");
  const name=decl.declarations[0].id.name,loop=body[i+2],index=loop?.init?.declarations?.[0]?.id?.name,collection=assignment.left.name;
  requireProof(id(loop?.init?.declarations?.[0]?.id),"Main view selection requires a lexical numeric loop.");
  const expected=parse(`for(var ${index}=0;${index}<${collection}.length;${index}++){if(${collection}[${index}].checked){${name}=${collection}[${index}].value;break;}}`,{ecmaVersion:"latest"}).body[0];
  requireProof(canonicalJson(shape(loop))===canonicalJson(shape(expected)),"Main view selection must use the same checked source row and value.");
  const fields=baseDraft.form.fields.filter(field=>field.id===fieldId&&field.type==="radio"&&field.componentId==="xform-radio");
  requireProof(fields.length===1&&!byName.has(name)&&!bindings.some(binding=>binding.fieldId===fieldId),"Main view selection must bind one unique native main radio.");
  const options=fields[0].props?.options;
  requireProof(Array.isArray(options)&&options.length>0&&options.every(option=>typeof option.value==="string")&&new Set(options.map(option=>option.value)).size===options.length,"Main view options must be closed unique source strings.");
  byName.set(name,bindings.length);bindings.push({fieldId,values:options.map(option=>option.value)});
  walk(loop,node=>{if(node.type==="AssignmentExpression"&&id(node.left,name))allowedWrites.add(node);});
 }
 requireProof(bindings.length>0&&bindings.length<=4,"A bounded source main-radio selection is required.");
 const declarations=new Map();
 walk(callback,node=>{
  if(node.type==="AssignmentExpression"&&byName.has(node.left?.name)&&!allowedWrites.has(node)||node.type==="UpdateExpression"&&byName.has(node.argument?.name))fail("The source selection alias changes outside its proven checked loop.");
  if(/Function/.test(node.type)&&node!==callback&&node.params?.some(param=>byName.has(param.name)))fail("A main selection alias is shadowed.");
  if(node.type==="VariableDeclarator"&&byName.has(node.id?.name))declarations.set(node.id.name,(declarations.get(node.id.name)||0)+1);
 });
 requireProof([...byName.keys()].every(name=>declarations.get(name)===1),"Main selection aliases must not be redeclared or shadowed.");
 const refs=buildFormRuleRefIndex(baseDraft.form),targets=new Set(),fallbacks=new Map();
 function selectedEquality(test){
  if(test?.type!=="BinaryExpression"||!["==","==="].includes(test.operator))return undefined;
  const binding=byName.get(test.left?.name),value=literal(test.right);
  if(binding===undefined||typeof value!=="string"||!bindings[binding].values.includes(value))return undefined;
  return {op:"eq",binding,value};
 }
 function predicate(test){
  const equality=selectedEquality(test);if(equality)return equality;
  if(test?.type==="LogicalExpression"&&test.operator==="||"){
   const selected=selectedEquality(test.left),fallback=test.right;
   if(selected&&fallback?.type==="BinaryExpression"&&["==","==="].includes(fallback.operator)&&id(fallback.left)&&!byName.has(fallback.left.name)){
    const ordinal=bindings[selected.binding].values.indexOf(selected.value)+1;
    requireProof(literal(fallback.right)===ordinal,"Source checked-attribute fallback ordinal differs from native option order.");
    const prior=fallbacks.get(fallback.left.name);requireProof(prior===undefined||prior===selected.binding,"Source fallback is shared across different main radios.");
    fallbacks.set(fallback.left.name,selected.binding);return selected;
   }
  }
  if(test?.type==="LogicalExpression"&&["&&","||"].includes(test.operator))return {op:test.operator==="&&"?"and":"or",left:predicate(test.left),right:predicate(test.right)};
  fail("Main visibility has an unproved source condition.");
 }
 function hasEffect(node){let yes=false;walk(node,n=>{if(call(n,helper))yes=true;});return yes;}
 function compile(node){
  if(!node||!hasEffect(node))return [];
  if(node.type==="BlockStatement")return node.body.flatMap(compile);
  if(node.type==="IfStatement")return [{kind:"if",test:predicate(node.test),when:compile(node.consequent),else:compile(node.alternate)}];
  const effect=node.expression;
  requireProof(call(effect,helper)&&effect.arguments.length===4&&typeof literal(effect.arguments[0])==="string"&&typeof literal(effect.arguments[1])==="boolean"&&typeof literal(effect.arguments[2])==="boolean"&&literal(effect.arguments[3])===false,"Only static non-reset source row visibility is eligible.");
  const target=literal(effect.arguments[0]),resolved=resolveEffectTarget(refs,target);
  requireProof(resolved?.source==="rowMarker"&&resolved.targets?.length&&!resolved.unresolved?.length,"View row target must resolve completely to the existing form.");
  targets.add(target);return [{kind:"visible",target,value:literal(effect.arguments[1])}];
 }
 const statements=body.flatMap(compile);
 requireProof(targets.size>0&&targets.size<=16,"A bounded set of existing view regions is required.");
 for(const[name,binding]of fallbacks){
  let declared=false,assignments=0;
  walk(callback,node=>{
   if(node.type==="VariableDeclarator"&&id(node.id,name)){declared=true;requireProof(Number.isInteger(literal(node.init)),"Source checked fallback must be locally initialized.");}
   if(node.type==="AssignmentExpression"&&id(node.left,name)||node.type==="VariableDeclarator"&&id(node.id,name)){
    const value=literal(node.right||node.init);requireProof(Number.isInteger(value)&&value>=1&&value<=bindings[binding].values.length,"Source checked fallback contains a non-ordinal write.");assignments++;
   }
  });
  requireProof(declared&&assignments>0,"Source checked fallback must retain its local ordinal evidence.");
 }
 const linked=new Set((baseDraft.formRules?.linkage||[]).filter(rule=>rule.translationStatus==="executable")
  .flatMap(rule=>[...(rule.effects||[]),...(rule.else||[])])
  .filter(effect=>effect.type==="visible").map(effect=>effect.target));
 requireProof([...targets].every(target=>linked.has(target)),"View regions must already be source-backed native linkage targets.");
 return {version:1,actionId:action.id,sourceRef:source.sourceRef||source.id,bindings,statements,targets:[...targets]};
}
function shape(value){if(Array.isArray(value))return value.map(shape);if(!value||typeof value!=="object")return value;return Object.fromEntries(Object.entries(value).filter(([key])=>!["start","end","raw"].includes(key)).map(([key,value])=>[key,shape(value)]));}
function walk(node,visit){if(!node||typeof node!=="object")return;if(node.type)visit(node);for(const value of Object.values(node))if(Array.isArray(value))value.forEach(child=>walk(child,visit));else if(value&&typeof value==="object")walk(value,visit);}
