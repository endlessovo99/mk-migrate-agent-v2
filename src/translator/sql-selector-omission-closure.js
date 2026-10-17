import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {remoteOmissionContractEligible} from '../dsl/remote-omission-contract.js';

const hash=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const identifier=value=>typeof value==='string'&&/^[A-Za-z_$][\w$]*$/.test(value);
const reservedFunctions=new Set(['Dialog_List','DocListFunc_GetParentByTagName','encodeURIComponent','JSON','Array','String','RegExp','Number','Object','document','window','globalThis','eval','alert','parseInt','Function']);
const normalize=value=>Array.isArray(value)?value.filter(v=>v?.type!=='EmptyStatement').map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!['start','end','raw'].includes(key)).map(([key,v])=>[key,normalize(v)])):value;
const ast=value=>normalize(parse(value,{ecmaVersion:'latest'}));
const quote=JSON.stringify;

/** Exact generated SQL picker boundary. This proves retirement, never SQL execution. */
export function sqlSelectorOmissionClosure({javascript,selector,dialog,contract}={}){
 try{
  if(typeof javascript!=='string'||contract?.kind!=='SQL'||!remoteOmissionContractEligible(contract)||
     contract.selection?.multiSelect!==false||contract.selection.readOnlyText!==true||contract.selection.tree!==false||
     typeof contract.selection.preload!=='boolean'||contract.inputMappings?.length!==0||
     Object.values(contract.callbacks||{}).some(c=>c.present))return;
  const tree=parse(javascript,{ecmaVersion:'latest'}),functions=tree.body.filter(n=>n.type==='FunctionDeclaration');
  if(functions.length!==3||functions.some(n=>!identifier(n.id?.name)||reservedFunctions.has(n.id.name))||new Set(functions.map(n=>n.id.name)).size!==3)return;
  const actual=functions.find(n=>n.start===selector?.start&&n.end===selector?.end);
  if(!actual||JSON.stringify(normalize(actual))!==JSON.stringify(normalize(selector)))return;
  const args=dialog?.arguments;
  const detail=!!contract.tableId;
  if(args?.length!==(detail?11:7)||args[5]?.type!=='Identifier')return;
  const callback=functions.find(n=>n.id.name===args[5].name);
  const declarations=actual.body.body.filter(n=>n.type==='VariableDeclaration').flatMap(n=>n.declarations);
  const sql=declarations.find(n=>n.id?.name==='sqlvalue')?.init?.arguments?.[0];
  const query=sql?.arguments?.[0]?.value,getter=functions.find(n=>n.id.name===sql?.callee?.name);
  if(!callback||!getter||typeof query!=='string'||![contract.requestResource.querySha256,contract.requestResource.exportedQuerySha256].includes(hash(query).slice(7)))return;
  const outputs=contract.outputMappings.filter(m=>m.enabled!==false);
  if(outputs.some(m=>m.private||!identifier(m.sourceColumn)||!Number.isInteger(m.index)||!(detail?m.targetField?.startsWith(contract.tableId+'.'):identifier(m.targetField))))return;
  const writes=empty=>outputs.map(m=>{
   const name='setValueObject'+m.index,from=`hashMapArray[i].${m.sourceColumn}`;
   const addressing=detail?`var controlId=${quote(m.targetField)};if(controlId.indexOf('.')!=-1){controlId=controlId.substring(0,controlId.indexOf('.')+1)+index+controlId.substring(controlId.indexOf('.'));}`:'';
   const address=detail?"'extendDataFormInfo.value('+controlId+')'":quote('extendDataFormInfo.value('+m.targetField+')');
   return `${addressing}var ${name}=document.getElementsByName(${address})[0];if(${name}){${name}.value=${empty?"''":from+"==null?'':"+from};}`;
  }).join('');
  const guard="if(rtnVal==null||rtnVal=='undefined'){return;}",values='var hashMapArray=rtnVal.GetHashMapArray();';
  const selected=`${guard}${values}for(var i=0;i<hashMapArray.length;i++){${writes(false)}}`;
  const prefix=detail?contract.tableId+'.!{indexFlag}.':'',resource=contract.businessDataSource.sourceId;
  const wire=args[4]?.left?.value,start=`SQLDialogXMLData&isLoadData=${contract.selection.preload}&orderby=`,end=`&sqlResource=${resource}&sqlValue=`;
  if(typeof wire!=='string'||!wire.startsWith(start)||!wire.endsWith(end))return;
  const order=wire.slice(start.length,-end.length);if(hash(order).slice(7)!==contract.requestResource.orderBySha256)return;
  const first=start+order+end;
  const search=`SQLDialogXMLData&keyword=!{keyword}&column=${contract.requestResource.declaredSearchColumns.join(',')}&orderby=${order}&sqlResource=${resource}&sqlValue=`;
  const expected=clear=>`String.prototype.replaceAll=function(s1,s2){return this.replace(new RegExp(s1,'gm'),s2);};
   function ${callback.id.name}(rtnVal${detail?',index':''}){${selected}${clear?guard+values+`if(hashMapArray.length==0){${writes(true)}}`:''}};
   function ${getter.id.name}(sql${detail?',index':''}){var targetSql=sql;return targetSql;};
   function ${actual.id.name}(){${detail?"var currentTR=DocListFunc_GetParentByTagName('TR');var index=currentTR.rowIndex-1;":''}
    var sqlvalue=encodeURIComponent(${getter.id.name}(${quote(query)}${detail?',index':''}));
    ${detail?`var idField=${quote('extendDataFormInfo.value('+prefix+contract.fieldId+')')};idField=idField.replaceAll('!{indexFlag}',index);var nameField=${quote('extendDataFormInfo.value('+prefix+contract.fieldId+'_name)')};nameField=nameField.replaceAll('!{indexFlag}',index);`:''}
    Dialog_List(false,${detail?'idField,nameField':quote('extendDataFormInfo.value('+contract.fieldId+')')+','+quote('extendDataFormInfo.value('+contract.fieldId+'_name)')},';',${quote(first)}+sqlvalue,${callback.id.name},${quote(search)}+sqlvalue${detail?',false,null,null,index':''});return false;};`;
  const normalized=JSON.stringify(orderedAst(javascript));let clear;
  for(const option of [false,true])if(JSON.stringify(orderedAst(expected(option)))===normalized)clear=option;
  if(clear===undefined)return;
  return {status:'verified',javascriptSha256:hash(javascript.trim()),javascriptLength:javascript.trim().length,soleSelector:true,grammar:'generated-sql-selector-omission-closed-v1',
   scope:{kind:'remote-selector-unit',method:'SQL',fieldId:contract.fieldId,...(detail?{tableId:contract.tableId}:{})},functionNames:functions.map(n=>n.id.name).sort(),
   dependencies:{selector:actual.id.name,getter:getter.id.name,callback:callback.id.name},prerequisiteFields:[],inputMappings:[],outputMappings:structuredClone(outputs),
   inputReadTiming:'selector-open',cancellation:'unchanged',emptyResult:clear?'clear-explicit-outputs':'unchanged',scaffolding:['generated-index-replaceAll-polyfill'],
   queryLiteral:{start:sql.arguments[0].start,end:sql.arguments[0].end,sha256:hash(query)}};
 }catch{return;}
}
function orderedAst(value){const tree=ast(value);tree.body.sort((a,b)=>a.type==='FunctionDeclaration'&&b.type==='FunctionDeclaration'?a.id.name.localeCompare(b.id.name):a.type==='FunctionDeclaration'?1:b.type==='FunctionDeclaration'?-1:0);return tree;}
