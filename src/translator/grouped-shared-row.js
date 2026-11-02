import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {scanHtmlTags} from './designer-html-tokenizer.js';
import {attrValue} from './xml-utils.js';
import {sha256Digest} from '../agent-review/digest.js';
import {compileStaticRowEffect} from './inline-radio-row-effects.js';
import {inlineOnChangeSourceActionKey} from './source-action-key.js';

const BASIS='deterministic-grouped-shared-row';
const sha=text=>createHash('sha256').update(String(text||'')).digest('hex');
const js=text=>{try{return parse(String(text||''),{ecmaVersion:'latest'})}catch{return undefined}};
const compact=value=>JSON.stringify(value,(key,item)=>['start','end','raw'].includes(key)?undefined:item);
const value=node=>node?.type==='Literal'?node.value:undefined;
const call=(node,name)=>node?.type==='CallExpression'&&node.callee?.type==='Identifier'&&node.callee.name===name;
const same=(text,node)=>compact(js(text)?.body?.[0])===compact(node);

/** Closed recipe: three immutable code groups and the source's edit/view lifecycle. */
export function groupedSharedRowCandidates(source={}, form={}, scripts={}) {
  const all=scripts.sources||[];
  if(all.length!==3 || !all.every(x=>x?.javascript&&x?.sourceRef)) return [];
  const [helper,edit,view]=all;
  const domain=helper.semanticFacts?.groupedSharedSourceDomain;
  if(!domain||domain.version!==1||domain.scriptCount!==3||!Array.isArray(domain.sourceHashes)||compact(domain.sourceHashes)!==compact(all.map(x=>sha(x.javascript)))||! /^[a-f0-9]{64}$/.test(domain.runtimeSha256||''))return [];
  if(source!==edit && source!==view) return [];
  if(edit.displayGate!=='xform:editShow'||view.displayGate!=='xform:viewShow'||
    (edit.helperJavascript && compact(js(edit.helperJavascript))!==compact(js(helper.javascript)))||
    (view.helperJavascript && compact(js(view.helperJavascript))!==compact(js(helper.javascript))))return [];
  const program=js(helper.javascript);if(!program||program.body.length!==8)return [];
  const groups=[];
  for(let i=0;i<3;i++){
    const n=program.body[i],d=n?.declarations?.[0];
    if(n?.type!=='VariableDeclaration'||n.kind!=='var'||n.declarations.length!==1||d?.id?.name!==`type${i+1}Codes`||d.init?.type!=='ArrayExpression')return [];
    const codes=d.init.elements.map(value);if(!codes.length||codes.some(x=>typeof x!=='string'||!x)||new Set(codes).size!==codes.length)return [];groups.push({codes,rows:[]});
  }
  if(new Set(groups.flatMap(g=>g.codes)).size!==groups.flatMap(g=>g.codes).length)return [];
  const helperNames=['hideAll','showTypeOne','showTypeTwo','showTypeThree'];
  for(let i=0;i<4;i++){
    const f=program.body[3+i];if(f?.type!=='FunctionDeclaration'||f.id?.name!==helperNames[i]||f.async||f.generator||compact(f.params)!==compact(i?js('function f(editFlag){}').body[0].params:[]))return [];
    const rows=[];for(const n of f.body.body){const c=n?.expression;if(n.type!=='ExpressionStatement'||!call(c,'common_dom_row_set_show_required_reset')||c.arguments.length!==4||typeof value(c.arguments[0])!=='string'||value(c.arguments[1])!==Boolean(i)||value(c.arguments[3])!==false||!(i?c.arguments[2]?.type==='Identifier'&&c.arguments[2].name==='editFlag':value(c.arguments[2])===false))return [];rows.push(value(c.arguments[0]));}
    if(!rows.length||new Set(rows).size!==rows.length)return [];
    if(i===0)groups.hidden=rows;else groups[i-1].rows=rows;
  }
  if(compact(groups.hidden)!==compact(groups.flatMap(g=>g.rows)))return [];
  const expectedSet='function setEdit(editFlag,currentOption){if(type1Codes.indexOf(currentOption)!==-1){showTypeOne(editFlag)}else if(type2Codes.indexOf(currentOption)!==-1){showTypeTwo(editFlag)}else if(type3Codes.indexOf(currentOption)!==-1){showTypeThree(editFlag)}}';
  if(!same(expectedSet,program.body[7]))return [];
  const editProgram=js(edit.javascript),viewProgram=js(view.javascript);
  if(!editProgram||editProgram.body.length!==2||!viewProgram||viewProgram.body.length!==1)return [];
  const load=editProgram.body[0]?.expression,change=editProgram.body[1]?.expression;
  if(!call(change,'AttachXFormValueChangeEventById')||change.arguments.length!==2||typeof value(change.arguments[0])!=='string')return [];
  const trigger=value(change.arguments[0]),changeBody=change.arguments[1]?.body?.body,assignment=changeBody?.find(x=>x.type==='VariableDeclaration');
  const mirror=value(assignment?.declarations?.[0]?.init?.object?.arguments?.[0]);
  const log=value(changeBody?.[0]?.expression?.arguments?.[0]);
  if(typeof mirror!=='string'||typeof log!=='string')return [];
  const selector=`[name="extendDataFormInfo.value(${trigger})"]:checked`;
  const expectedLoad=`Com_AddEventListener(window,"load",function(){setTimeout(function(){hideAll();var current=$(${JSON.stringify(selector)}).val();setEdit(true,current)},510);});`;
  const expectedChange=`AttachXFormValueChangeEventById(${JSON.stringify(trigger)},function(value,domElement){console.log(${JSON.stringify(log)},value);hideAll();var isTypeC=GetXFormFieldById(${JSON.stringify(mirror)})[0];isTypeC.value=value;setEdit(true,value)});`;
  const expectedView=`window.addEventListener("load",function(){hideAll();setEdit(false,GetXFormFieldById(${JSON.stringify(mirror)})[0].value)});`;
  if(!same(expectedLoad,editProgram.body[0])||!same(expectedChange,editProgram.body[1])||!same(expectedView,viewProgram.body[0]))return [];
  const radio=(form.fields||[]).filter(f=>f.id===trigger&&f.componentId==='xform-radio'&&f.type==='radio');
  const hidden=(form.fields||[]).filter(f=>f.id===mirror&&f.componentId==='xform-hidden'&&f.sourceProps?.hardHidden===true&&f.sourceProps?.metadataAttributes?.type==='String');
  const radioDomain=helper.semanticFacts?.sourceFormRadioOrdinalDomain;
  const {digest:radioDigest,...radioBody}=radioDomain||{};
  const sourceGroups=(radioDomain?.groups||[]).filter(g=>g.fieldId===trigger);
  if(radio.length!==1||hidden.length!==1||radio[0].sourceProps?.metadataAttributes?.type!=='String'||
    radioDomain?.version!==1||radioDomain.status!=='verified'||radioDomain.domain!=='exported-form-radio-groups'||
    radioDomain.sourceHashes?.fdDisplayJsp!==`sha256:${domain.runtimeSha256}`||sha256Digest(radioBody)!==radioDigest||
    sourceGroups.length!==1||compact(sourceGroups[0].options)!==compact(radio[0].props?.options)||
    domain.hiddenRuntimeFields?.filter(id=>id===mirror).length!==1||
    groups.flatMap(g=>g.codes).some(code=>!(radio[0].props?.options||[]).some(o=>o.value===code)))return [];
  const hide=groups.hidden.flatMap(row=>compileStaticRowEffect({target:row,visible:false,required:false,reset:false},form,'  ')||[]);
  const editGroups=groups.map(g=>g.rows.flatMap(row=>compileStaticRowEffect({target:row,visible:true,required:true,reset:false},form,'    ')||[]));
  const viewGroups=groups.map(g=>g.rows.flatMap(row=>compileStaticRowEffect({target:row,visible:true,required:false,reset:false},form,'    ')||[]));
  if(hide.length!==groups.hidden.length*2||editGroups.some((g,i)=>g.length!==groups[i].rows.length*2)||viewGroups.some((g,i)=>g.length!==groups[i].rows.length*2))return [];
  const branches=rows=>groups.flatMap((g,i)=>[`${i?'  else ':'  '}if (${JSON.stringify(g.codes)}.indexOf(current) !== -1) {`,...rows[i],'  }']);
  const readRadio=`  var raw = MKXFORM.getValue(${JSON.stringify(trigger)});\n  var current = Array.isArray(raw) ? raw[0] : raw;`;
  const actions=source===edit ? [
    {event:'onLoad',scope:'global',index:load.start,function:['function onLoad() {','  setTimeout(function() {',...hide.map(x=>'  '+x),...readRadio.split('\n').map(x=>'  '+x),...branches(editGroups).map(x=>'  '+x),'  }, 510);','}'].join('\n')},
    {event:'onChange',scope:'control',controlId:trigger,index:change.start,sourceActionKey:inlineOnChangeSourceActionKey(source.sourceRef,change.start),function:['function onChange(value, rowNum, parentRowNum) {',...hide,`  MKXFORM.setValue(${JSON.stringify(mirror)}, value === null ? "" : String(value));`,'  var current = value;',...branches(editGroups),'}'].join('\n')}
  ] : [{event:'onLoad',scope:'global',index:viewProgram.body[0].start,function:['function onLoad() {',...hide,`  var current = MKXFORM.getValue(${JSON.stringify(mirror)});`,...branches(viewGroups),'}'].join('\n')}];
  return actions.map(a=>({...a,javascript:source.javascript,translationStatus:'mapped',coverage:{status:'translated',nativeRules:[],residuals:[]},
    functionMappings:[{source:'source-bound immutable groups, shared row helpers and edit/view callbacks',target:'typed row operations and source-order value sync',basis:BASIS,reviewRequired:false}],
    sourceRefs:[helper.sourceRef,source.sourceRef],semanticHints:{groupedSharedRows:{trigger,mirror,groups},coveredCalculationRanges:[
      {sourceRef:helper.sourceRef,name:'sharedRowHelpers',start:0,end:helper.javascript.length},
      {sourceRef:source.sourceRef,name:'groupedRowCallback',start:a.index,end:source.javascript.length}]}}));
}

/** Prove that the exported runtime has the same three callbacks and no extra executable DOM handlers. */
export function groupedSharedSourceDomain(template={}, scripts={}) {
  const sources=scripts.sources||[],html=String(template.fdDisplayJsp||'');
  if(sources.length!==3||!html||sources[1].displayGate!=='xform:editShow'||sources[2].displayGate!=='xform:viewShow')return undefined;
  const matches=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  if((html.match(/<script\b/gi)||[]).length!==matches.length||matches.some(m=>m[1].trim()))return undefined;
  const code=matches.filter(m=>!/^\s*Com_IncludeFile\(\s*(['"])standardtable\.css\1\s*,\s*(['"])<%=request\.getContextPath\(\)\s*%>\/sys\/xform\/designer\/standardtable\/tablestyle\/default\/\2\s*,\s*(['"])css\3\s*,\s*true\s*\)\s*;?\s*$/.test(m[2]));
  if(code.length!==3||code.some((m,i)=>!js(m[2])||compact(js(m[2]))!==compact(js(sources[i].javascript))))return undefined;
  const inGate=(match,tag)=>{const before=html.slice(0,match.index).toLowerCase(),open=before.lastIndexOf(`<xform:${tag}>`),close=before.lastIndexOf(`</xform:${tag}>`);return open>close;};
  if(inGate(code[0],'editshow')||inGate(code[0],'viewshow')||!inGate(code[1],'editshow')||inGate(code[1],'viewshow')||!inGate(code[2],'viewshow')||inGate(code[2],'editshow'))return undefined;
  let markup=html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,'');
  // The recognized attachment renderer is the only allowed dynamic import.
  markup=markup.replace(/<c:import\s+url="\/sys\/attachment\/sys_att_main\/sysAttMain_\$\{empty _xformRight \? \(\(_xformMainForm\.method_GET == 'add' \|\| _xformMainForm\.method_GET == 'edit'\) \? 'edit' : 'view'\) : \(_xformRight == 'edit' \? 'edit' : 'view'\)\}\.jsp"\s+charEncoding="UTF-8">([\s\S]*?)<\/c:import>/gi,(whole,body)=>safeAttachmentParameters(body)?'':whole);
  markup=markup.replace(/<%@\s*page\s+language="java"\s+contentType="text\/html;\s*charset=UTF-8"\s+pageEncoding="UTF-8"\s*%>/gi,'')
    .replace(/<%@\s*include\s+file="\/resource\/jsp\/common\.jsp"\s*%>/gi,'')
    .replace(/<%@\s*page\s+import="com\.landray\.kmss\.web\.taglib\.xform\.TagUtils"\s*%>/gi,'');
  if(/<%|<c:import\b|<jsp:include\b|<iframe\b|javascript\s*:|\$\{/i.test(markup))return undefined;
  const runtimeFields=[];
  for(const token of scanHtmlTags(markup)){
    if(token.closing)continue;
    const property=attrValue(token.attrs,'property'), match=/^extendDataFormInfo\.value\(([A-Za-z_][\w]*)\)$/.exec(property||'');
    if(match)runtimeFields.push({id:match[1],tag:token.name,status:attrValue(token.attrs,'showStatus')});const attrs=String(token.attrs||''),found=[...attrs.matchAll(/\b(on[a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)];
    if((attrs.match(/\bon[a-z]+\s*=/gi)||[]).length!==found.length||found.some(m=>m[1].toLowerCase()!=='onvaluechange'||(m[2]??m[3]??m[4])!=='__xformDispatch'))return undefined;
  }
  const hiddenRuntimeFields=runtimeFields.filter(f=>f.tag==='xform:xtext'&&f.status==='noShow'&&runtimeFields.filter(x=>x.id===f.id).length===1).map(f=>f.id);
  return {version:1,sourceHashes:[...sources].map(x=>sha(x.javascript)),runtimeSha256:sha(html),scriptCount:3,hiddenRuntimeFields};
}

function safeAttachmentParameters(body) {
  const expected=new Map([['fdAttType','byte'],['fdMulti','true'],['fdShowMsg','true'],['fdImgHtmlProperty',null],
    ['fdKey',null],['fdModelId','${_xformMainForm.fdId}'],['fdModelName','${_xformMainForm.modelClass.name}'],['formBeanName','_xformMainForm']]);
  const matches=[...String(body).matchAll(/<c:param\s+name="([A-Za-z]+)"(?:\s+value="([^"]*)")?\s*\/>/g)];
  if(matches.length!==expected.size||String(body).replace(/<c:param\s+name="([A-Za-z]+)"(?:\s+value="([^"]*)")?\s*\/>/g,'').trim())return false;
  const seen=new Set();for(const m of matches){if(!expected.has(m[1])||seen.has(m[1]))return false;seen.add(m[1]);
    if(m[1]==='fdKey'){if(!/^[A-Za-z_][\w]*$/.test(m[2]||''))return false;}
    else if((m[2]??null)!==expected.get(m[1]))return false;
  }return true;
}
