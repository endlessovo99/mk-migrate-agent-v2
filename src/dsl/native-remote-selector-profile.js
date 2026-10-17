import {validateRemoteSelectorDecisions} from "./remote-selector-contract.js";
import {hasVerifiedDeterministicScriptBranchProof} from "./deterministic-script-translations.js";
import {parse} from "acorn";
import {canonicalJson,sha256Digest} from "../agent-review/digest.js";
import {createHash} from "node:crypto";

export function nativeRemoteSelectorFunction(spec) {
  const nativeTable = id => id ? "${table:" + id + "}" : undefined;
  spec = { ...spec, tableId: nativeTable(spec.tableId), inputMappings: spec.inputMappings.map(mapping => ({ ...mapping, tableId: nativeTable(mapping.tableId) })), outputMappings: spec.outputMappings.map(mapping => ({ ...mapping, tableId: nativeTable(mapping.tableId) })) };
  return `function onClick(event, rowNum, parentRowNum) {
  var spec = ${canonicalJson(spec)};
  var React = window.react;
  var UI = window["@lui/core"];
  if (!React || !UI || !UI.Search || !UI.Table || !UI.Button || !MKXFORM.tableModal || !MKXFORM.callTic) return;
  if (parentRowNum !== undefined && parentRowNum !== null) return;
  var rowsAtOpen = spec.tableId ? MKXFORM.getValue(spec.tableId) : null;
  var rowAtOpen = spec.tableId && Array.isArray(rowsAtOpen) ? rowsAtOpen[rowNum] : null;
  var stableKey = rowAtOpen && rowAtOpen.key;
  if (spec.tableId && (stableKey === undefined || stableKey === null || stableKey === "")) return;
  var closed = false, sequence = 0, selected = null, records = [], failure = "请先查询";
  var modal, inputParameters = {};
  function currentRow() {
    if (!spec.tableId) return -1;
    var current = MKXFORM.getValue(spec.tableId);
    if (!Array.isArray(current)) return -2;
    var index = -2;
    for (var i = 0; i < current.length; i += 1) if (current[i] && current[i].key === stableKey) { if (index !== -2) return -2; index = i; }
    return index;
  }
  function sourceValue(mapping, index) {
    return mapping.tableId ? MKXFORM.getControlValue(mapping.tableId + "." + mapping.fieldId, index) : MKXFORM.getValue(mapping.fieldId);
  }
  function tableProps() {
    return { rowKey: "__lookupKey", dataSource: records, pagination: false,
      columns: spec.response.columns.map(function(column) { return { title: column.title, dataIndex: column.name, key: column.name }; }),
      locale: { emptyText: failure },
      title: function() { return React.createElement(UI.Search, { placeholder: "请输入查询条件", onSearch: query }); },
      rowSelection: { type: "radio", selectedRowKeys: selected ? [selected.__lookupKey] : [], onChange: function(keys, chosen) { selected = chosen.length === 1 && records.indexOf(chosen[0]) >= 0 ? chosen[0] : null; refresh(); } },
      onRow: function(record) { return { onDoubleClick: function() { selected = records.indexOf(record) >= 0 ? record : null; refresh(); } }; }
    };
  }
  function refresh() {
    if (closed || !modal) return;
    modal.update({ okButtonProps: { disabled: !selected }, content: React.createElement("div", { style: { width: "100%" } }, React.createElement(UI.Table, tableProps())) });
  }
  function query(keyword) {
    if (closed) return;
    var index = currentRow();
    if (spec.tableId && index < 0) { failure = "原明细行已不存在或身份不唯一"; selected = null; records = []; refresh(); return; }
    var parameters = Object.assign({}, inputParameters);
    parameters[spec.request.searchParameter] = String(keyword == null ? "" : keyword);
    var ticket = ++sequence, completed = false;
    selected = null; records = []; failure = "正在查询"; refresh();
    function failed() { if (closed || ticket !== sequence) return; selected = null; records = []; failure = "查询失败或返回格式不符合已核验合同"; refresh(); }
    try {
      var request = MKXFORM.callTic({ interfaceCode: spec.server.code, param: parameters }, function(error, payload) {
        completed = true;
        if (closed || ticket !== sequence) return;
        if (error) { failed(); return; }
        var value = payload;
        for (var p = 0; p < spec.response.rowsPath.length; p += 1) { if (!value || typeof value !== "object") { failed(); return; } value = value[spec.response.rowsPath[p]]; }
        if (!Array.isArray(value)) { failed(); return; }
        var accepted = [];
        for (var r = 0; r < value.length; r += 1) {
          var item = value[r];
          if (!item || typeof item !== "object" || Array.isArray(item)) { failed(); return; }
          var clean = { __lookupKey: String(r) };
          for (var c = 0; c < spec.response.columns.length; c += 1) {
            var column = spec.response.columns[c];
            if (!Object.prototype.hasOwnProperty.call(item, column.name)) { failed(); return; }
            var data = item[column.name];
            if (data !== null && data !== undefined && typeof data !== "string" && typeof data !== "number" && typeof data !== "boolean") { failed(); return; }
            if ((column.type === "String" || column.type === "Date") && data !== null && data !== undefined && typeof data !== "string") { failed(); return; }
            if (typeof data === "number" && !Number.isFinite(data)) { failed(); return; }
            if (column.type === "Number" && data !== null && data !== undefined && data !== "" && (typeof data !== "number" || !Number.isFinite(data)) || column.type === "Boolean" && data !== null && data !== undefined && typeof data !== "boolean") { failed(); return; }
            clean[column.name] = data == null ? "" : String(data);
          }
          if (clean[spec.response.valueColumn] === "") { failed(); return; }
          accepted.push(clean);
        }
        records = accepted; failure = records.length ? "" : "无匹配记录"; refresh();
      });
      if (request && typeof request.then === "function") request.then(function() { if (!completed) failed(); }, failed);
    } catch (error) { failed(); }
  }
  function commit() {
    if (closed || !selected || records.indexOf(selected) < 0) return;
    var index = currentRow();
    if (spec.tableId && index < 0) { selected = null; records = []; failure = "原明细行已不存在或身份不唯一"; refresh(); return; }
    var patch = {};
    for (var i = 0; i < spec.outputMappings.length; i += 1) { var mapping = spec.outputMappings[i]; if (mapping.tableId) patch[mapping.fieldId] = selected[mapping.sourceColumn]; }
    if (spec.tableId && Object.keys(patch).length) MKXFORM.updateRow(spec.tableId, index, patch);
    for (var j = 0; j < spec.outputMappings.length; j += 1) { var output = spec.outputMappings[j]; if (!output.tableId) MKXFORM.setValue(output.fieldId, selected[output.sourceColumn]); }
    closed = true; sequence += 1;
  }
  for (var inputIndex = 0; inputIndex < spec.inputMappings.length; inputIndex += 1) {
    var mappingAtOpen = spec.inputMappings[inputIndex];
    var valueAtOpen = sourceValue(mappingAtOpen, rowNum);
    if (valueAtOpen !== null && valueAtOpen !== undefined && typeof valueAtOpen !== "string" && typeof valueAtOpen !== "number" && typeof valueAtOpen !== "boolean") return;
    inputParameters[mappingAtOpen.parameterName] = valueAtOpen == null ? "" : String(valueAtOpen);
  }
  function clearSelection() {
    if (closed) return;
    var index = currentRow();
    if (spec.tableId && index < 0) return;
    var patch = {};
    for (var i = 0; i < spec.outputMappings.length; i += 1) { var output = spec.outputMappings[i]; if (output.tableId) patch[output.fieldId] = ""; }
    if (spec.tableId && Object.keys(patch).length) MKXFORM.updateRow(spec.tableId, index, patch);
    for (var j = 0; j < spec.outputMappings.length; j += 1) { var output = spec.outputMappings[j]; if (!output.tableId) MKXFORM.setValue(output.fieldId, ""); }
    closed = true; sequence += 1;
    if (modal && modal.destroy) modal.destroy();
  }
  modal = MKXFORM.tableModal({ table: tableProps(), modal: { title: "选择" + spec.title, okText: "确定", cancelText: "取消", okCancel: true,
    footer: [React.createElement(UI.Button, { key: "clear", onClick: clearSelection }, "清空选择"), React.createElement(UI.Button, { key: "cancel", onClick: function() { closed = true; sequence += 1; if (modal && modal.destroy) modal.destroy(); } }, "取消"), React.createElement(UI.Button, { key: "confirm", onClick: function() { commit(); if (closed && modal && modal.destroy) modal.destroy(); } }, "确定")], okButtonProps: { disabled: true }, onOk: commit, onCancel: function() { closed = true; sequence += 1; } } });
}`;
}

const word=value=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,24}$/.test(value)&&!['__proto__','prototype','constructor','__lookupKey'].includes(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const hash=/^sha256:[a-f0-9]{64}$/;
const tableId=value=>value===undefined?undefined:/^\$\{table:([A-Za-z_][A-Za-z0-9_]{0,24})\}$/.exec(value)?.[1];

/** Admit only the complete fixed native implementation; no broad JS/API whitelist changes. */
export function inspectNativeRemoteSelectorFunction(source) {
 if(typeof source!=='string'||!source.startsWith('function onClick(event, rowNum, parentRowNum) {\n  var spec = '))return;
 try{
  const ast=parse(source,{ecmaVersion:'latest'}),fn=ast.body[0],decl=fn?.body?.body?.[0]?.declarations?.[0];
  if(ast.body.length!==1||fn?.type!=='FunctionDeclaration'||fn.id?.name!=='onClick'||decl?.id?.name!=='spec')return;
  const spec=JSON.parse(source.slice(decl.init.start,decl.init.end));
  if(!exact(spec,['title','sourceRef','server','response','request','wireEvidenceSha256','inputMappings','outputMappings',...(spec.tableId===undefined?[]:['tableId'])])||typeof spec.title!=='string'||!spec.title||typeof spec.sourceRef!=='string'||!hash.test(spec.wireEvidenceSha256))return;
  const dummy={id:'profile',kind:'native-tic-rest-selector',sourceRef:spec.sourceRef,contractDigest:'sha256:'+'0'.repeat(64),runtimeFactDigest:'sha256:'+'0'.repeat(64),scopeOrigin:'https://profile.example.invalid',server:spec.server,response:spec.response,request:spec.request,wireEvidenceSha256:spec.wireEvidenceSha256};
  if(!validateRemoteSelectorDecisions([dummy]).ok)return;
  const normalized=structuredClone(spec);if(spec.tableId!==undefined){normalized.tableId=tableId(spec.tableId);if(!word(normalized.tableId))return;}
  for(const [key,type]of [['inputMappings','parameterName'],['outputMappings','sourceColumn']]){
   if(!Array.isArray(spec[key])||spec[key].length>128||key==='outputMappings'&&spec[key].length<2)return;
   normalized[key]=spec[key].map(mapping=>{if(!exact(mapping,[type,'fieldId',...(mapping.tableId===undefined?[]:['tableId'])])||typeof mapping[type]!=='string'||!word(mapping.fieldId))throw Error();const result={...mapping};if(mapping.tableId!==undefined){result.tableId=tableId(mapping.tableId);if(!word(result.tableId)||result.tableId!==normalized.tableId)throw Error();}return result;});
  }
  const targets=spec.request.inputParameters.map(mapping=>mapping.targetParameter);
  if(canonicalJson([...targets].sort())!==canonicalJson(spec.inputMappings.map(mapping=>mapping.parameterName).sort())||spec.outputMappings.some(mapping=>!spec.response.columns.some(column=>column.name===mapping.sourceColumn)))return;
  if(nativeRemoteSelectorFunction(normalized)!==source)return;
  return {profile:'native-tic-rest-selector-v1',spec:normalized};
 }catch{return;}
}

export function remoteSelectorBinding(dsl,field){
 try{
  const decisions=(dsl?.migrationPolicies?.decisions||[]).filter(decision=>decision?.kind==='native-tic-rest-selector'&&decision.sourceRef===field.sourceRef);
  if(decisions.length!==1||!validateRemoteSelectorDecisions(decisions).ok)return;
  const decision=decisions[0],contract=field.sourceProps?.remoteSelectorSourceContract,fact=field.sourceProps?.approvedRemoteSelectorSourceFact;
  if(contract?.kind!=='REST'||contract.status!=='static'||contract.requestResource?.method!=='GET'||contract.fieldId!==field.id||fact?.fieldId!==field.id||sha256Digest(contract)!==decision.contractDigest||fact?.status!=='verified'||fact.digest!==decision.runtimeFactDigest||sha256Digest(Object.fromEntries(Object.entries(fact).filter(([key])=>key!=='digest')))!==fact.digest)return;
  const audits=(dsl.migrationPolicyAudit?.audits||[]).filter(audit=>audit.kind===decision.kind&&audit.decisionId===decision.id&&audit.sourceRef===decision.sourceRef);
  if(audits.length!==1)return;const audit=audits[0],actions=(dsl.scripts?.actions||[]).filter(action=>action.id===audit.actionId);
  if(actions.length!==1)return;const action=actions[0],profile=inspectNativeRemoteSelectorFunction(action.function),spec=profile?.spec;
  if(!spec||!hasVerifiedDeterministicScriptBranchProof(action)||spec.sourceRef!==field.sourceRef||spec.tableId!==contract.tableId||spec.tableId!==fact.tableId||action.scope!=='control'||action.event!=='onClick'||action.tableId!==spec.tableId||canonicalJson(action.runWhen?.viewStatusIn)!==canonicalJson(['add','edit'])||decision.scopeOrigin!==dsl.migrationPolicies.scope?.baseUrl||canonicalJson(spec.server)!==canonicalJson(decision.server)||canonicalJson(spec.response)!==canonicalJson(decision.response)||canonicalJson(spec.request)!==canonicalJson(decision.request)||spec.wireEvidenceSha256!==decision.wireEvidenceSha256||canonicalJson(spec.inputMappings)!==canonicalJson(audit.inputMappings)||canonicalJson(spec.outputMappings)!==canonicalJson(audit.outputMappings)||audit.primaryFieldId!==field.id||audit.runtimeFactDigest!==fact.digest||audit.contractDigest!==decision.contractDigest||audit.wireEvidenceSha256!==decision.wireEvidenceSha256)return;
  const table=spec.tableId?(dsl.form?.fields||[]).filter(candidate=>candidate.id===spec.tableId&&candidate.type==='detailTable'):[];
  if(spec.tableId&&table.length!==1)return;const fields=spec.tableId?table[0].columns:dsl.form?.fields||[],display=fields.filter(candidate=>candidate.id===audit.displayFieldId),button=fields.filter(candidate=>candidate.id===action.controlId);
  if(display.length!==1||button.length!==1||button[0].type!=='button'||button[0].componentId!=='xform-button'||field.dataOnly!==true||field.props?.readOnly!==true||display[0].props?.readOnly!==true||display[0].dataOnly!==false||audit.addedField?.fieldId!==button[0].id||spec.outputMappings[0]?.fieldId!==field.id||spec.outputMappings[1]?.fieldId!==display[0].id||spec.outputMappings[0]?.sourceColumn!==decision.response.valueColumn||spec.outputMappings[1]?.sourceColumn!==decision.response.labelColumn)return;
  const expectedDisplayId = !spec.tableId && fact.displayFieldId.length > 25
    ? 'fd_disp_' + rawFunctionDigest(fact.displayFieldId).slice(7,23) : fact.displayFieldId;
  if(display[0].id!==expectedDisplayId || display[0].sourceProps?.metadataId!==fact.displayFieldId)return;
  const expectedMappings = sourceMappings(dsl, contract, decision, field.id, display[0].id);
  if(!expectedMappings || canonicalJson(spec.inputMappings)!==canonicalJson(expectedMappings.inputMappings) ||
      canonicalJson(spec.outputMappings)!==canonicalJson(expectedMappings.outputMappings))return;
  if(audit.functionSha256!==rawFunctionDigest(action.function))return;
  return {decision,audit,action,profile};
 }catch{return;}
}
const rawFunctionDigest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');

// Rebuild the complete mapping independently of the editable runtime audit.
// A sealed function/audit pair alone cannot establish main/current-row scope.
function sourceMappings(dsl, contract, decision, primaryId, displayId) {
 try {
  const all=(dsl.form?.fields||[]).flatMap(field=>field.type==='detailTable'
    ? (field.columns||[]).map(column=>({field:column,tableId:field.id})) : [{field}]);
  const resolve=identity=>{
   const parts=identity.split('.');
   if(parts.length<1||parts.length>2)throw Error();
   const table=parts.length===2?parts[0]:undefined,id=parts.at(-1);
   if(table && table!==contract.tableId)throw Error();
   const matches=all.filter(item=>item.tableId===table&&item.field.id===id);
   if(matches.length!==1||!['text','longText'].includes(matches[0].field.type)||matches[0].field.sourceProps?.metadataAttributes?.type!=='String')throw Error();
   return {tableId:table,fieldId:id};
  };
  const inputs=contract.inputMappings,outputs=contract.outputMappings.filter(mapping=>mapping.enabled!==false);
  if(inputs.some(mapping=>mapping.private)||outputs.some(mapping=>mapping.private)||decision.request.inputParameters.length!==inputs.length||
      outputs.length && all.find(item=>item.tableId===contract.tableId&&item.field.id===primaryId)?.field.sourceProps?.approvedRemoteSelectorSourceFact?.script?.emptyResult!=='clear-explicit-outputs')return;
  const inputMappings=inputs.map(mapping=>{
   const wire=decision.request.inputParameters.filter(item=>item.sourceParameter===mapping.parameterName);
   if(wire.length!==1)throw Error();
   return {parameterName:wire[0].targetParameter,...resolve(mapping.sourceField)};
  });
  const outputMappings=[
   {sourceColumn:decision.response.valueColumn,tableId:contract.tableId,fieldId:primaryId},
   {sourceColumn:decision.response.labelColumn,tableId:contract.tableId,fieldId:displayId},
   ...outputs.map(mapping=>({sourceColumn:mapping.sourceColumn,...resolve(mapping.targetField)}))
  ];
  return {inputMappings,outputMappings};
 }catch{return;}
}

export function nativeRemoteSelectorDslDiagnostics(dsl){
 const diagnostics=[],fail=action=>diagnostics.push({level:'error',code:'dsl.native_remote_selector_profile_invalid',path:'/scripts/actions',message:'Native remote selectors require exact source policy, wire contract, implementation and field bindings.',details:{actionId:action?.id}});
 const all=(dsl?.form?.fields||[]).flatMap(field=>field.type==='detailTable'?field.columns||[]:[field]);
 for(const action of dsl?.scripts?.actions||[]){if(!action?.semanticHints?.approvedNativeLookup&&!inspectNativeRemoteSelectorFunction(action?.function))continue;const fields=all.filter(field=>field.sourceRef&&field.sourceRef===action.semanticHints?.approvedNativeLookup?.sourceRef);const matched=fields.length===1?remoteSelectorBinding(dsl,fields[0]):undefined;if(!matched||matched.action!==action)fail(action);}
 return diagnostics;
}
