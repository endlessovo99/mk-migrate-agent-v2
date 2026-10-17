import {parse} from 'acorn';

export const MAIN_TABLE_PLACEHOLDER='${table:@main}';
export function mainTableReadReferenceDiagnostics(javascript,form={}){
 if(!String(javascript||'').includes(MAIN_TABLE_PLACEHOLDER))return [];
 const diagnostics=[],ranges=[],fail=reason=>diagnostics.push({reason});
 let tree;try{tree=parse(String(javascript),{ecmaVersion:'latest'});}catch{fail('unparseable-main-table-reference');return diagnostics;}
 walk(tree,(node,parent)=>{
  if(node.type!=='Literal'||typeof node.value!=='string'||!node.value.includes(MAIN_TABLE_PLACEHOLDER))return;
  const suffix=node.value.startsWith(MAIN_TABLE_PLACEHOLDER+'.')?node.value.slice(MAIN_TABLE_PLACEHOLDER.length+1):undefined;
  const fields=(form.fields||[]).filter(field=>field.id===suffix&&field.type!=='detailTable'&&field.dataOnly!==true);
  if(!suffix||!/^[A-Za-z_][\w-]*$/.test(suffix)||fields.length!==1||parent?.type!=='CallExpression'||parent.optional||parent.arguments[0]!==node||parent.arguments.length!==1||
   parent.callee?.type!=='MemberExpression'||parent.callee.computed||parent.callee.object?.name!=='MKXFORM'||!['getValue','getValueText'].includes(parent.callee.property?.name))fail('main-table-placeholder-requires-one-existing-main-field-read');
  else ranges.push({start:node.start,end:node.end});
 });
 for(let offset=String(javascript).indexOf(MAIN_TABLE_PLACEHOLDER);offset!==-1;offset=String(javascript).indexOf(MAIN_TABLE_PLACEHOLDER,offset+MAIN_TABLE_PLACEHOLDER.length)){
  if(ranges.filter(range=>range.start<=offset&&offset+MAIN_TABLE_PLACEHOLDER.length<=range.end).length!==1)fail('main-table-marker-outside-an-authorized-string-literal-read');
 }
 return diagnostics;
}
export function renderMainTableReferences(javascript,mainTableName,form={}){
 if(!String(javascript||'').includes(MAIN_TABLE_PLACEHOLDER))return String(javascript||'');
 if(!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(String(mainTableName||'')))throw new Error('Native main table identity is required for the main-table placeholder.');
 if(mainTableReadReferenceDiagnostics(javascript,form).length)throw new Error('Main-table placeholder is not bound to one defined main field read.');
 return String(javascript).replaceAll(MAIN_TABLE_PLACEHOLDER,mainTableName);
}
function walk(node,visit,parent){if(!node||typeof node!=='object')return;visit(node,parent);for(const value of Object.values(node))if(value&&typeof value==='object')Array.isArray(value)?value.forEach(child=>walk(child,visit,node)):walk(value,visit,node);}
