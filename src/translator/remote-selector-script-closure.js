import {sqlSelectorOmissionClosure} from "./sql-selector-omission-closure.js";
import { createHash } from "node:crypto";
import { parse } from "acorn";

const digest = value => "sha256:" + createHash("sha256").update(value).digest("hex");
const identifier = value => typeof value === "string" && /^[A-Za-z_$][\w$]*$/.test(value);
const reserved = new Set(["Dialog_List", "DocListFunc_GetParentByTagName", "encodeURIComponent", "JSON", "Array", "String", "RegExp", "document", "eval", "alert", "parseInt", "restApiPath", "idField", "nameField", "inputParamValues", "currentTR"]);
const fieldId = value => typeof value === "string" && /^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)?$/.test(value);
const quote = JSON.stringify;
const body = source => parse(source, { ecmaVersion: "latest", allowReturnOutsideFunction: true }).body;
const normalize = value => {
  if (Array.isArray(value)) return value.filter(item => item?.type !== "EmptyStatement").map(normalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["start", "end", "raw"].includes(key)).map(([key, item]) => [key, normalize(item)]));
};
const equal = (left, right) => JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
const oneOf = (node, candidates) => candidates.some(source => equal(node, body(source)[0]));
const declaration = (name, init) => `var ${name}=${init};`;
const literal = node => node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
const call = (node, name) => node?.type === "CallExpression" && !node.optional && node.callee?.type === "Identifier" && node.callee.name === name;
const generatedPolyfill = 'String.prototype.replaceAll=function(s1,s2){return this.replace(new RegExp(s1,"gm"),s2);};';

/**
 * Recognize a closed, exported EKP REST selector dependency unit statically.
 * This is an exact AST grammar, not execution or general JavaScript analysis.
 * Unrecognized callbacks, getters, prerequisite statements and side effects
 * deliberately produce no proof. No source locator or JavaScript is returned.
 */
export function remoteSelectorScriptClosure({ javascript, selector, dialog, contract } = {}) {
  try { return verify(javascript, selector, dialog, contract); } catch { return undefined; }
}

/** The omission profile proves only the feature boundary, never a target lookup. */
export function remoteSelectorOmissionScriptClosure({ javascript, selector, dialog, contract } = {}) {
  try { return contract?.kind === "SQL" ? sqlSelectorOmissionClosure({javascript,selector,dialog,contract}) : verify(javascript, selector, dialog, contract, { omission: true }); } catch { return undefined; }
}

function verify(javascript, selector, dialog, contract, { omission = false } = {}) {
  if (typeof javascript !== "string" || contract?.status !== "static" || contract.kind !== "REST" || !(omission ? ["GET", "POST"] : ["GET"]).includes(contract.requestResource?.method) ||
      contract.selection?.multiSelect !== false || contract.selection.readOnlyText !== true || contract.selection.preload !== false || contract.selection.tree !== false ||
      Object.values(contract.callbacks || {}).some(callback => callback.present) || !Array.isArray(contract.inputMappings) || !Array.isArray(contract.outputMappings)) return;
  const ast = parse(javascript, { ecmaVersion: "latest" }), statements = ast.body.filter(item => item.type !== "EmptyStatement");
  // A caller cannot lend nodes parsed from different text to this proof.
  const functions = statements.filter(item => item.type === "FunctionDeclaration"), actualSelector = functions.find(item => item.start === selector?.start && item.end === selector?.end);
  if (!actualSelector || !equal(actualSelector, selector) || !identifier(selector.id?.name) || selector.async || selector.generator || selector.params.length !== (contract.tableId ? 1 : 0) ||
      selector.params.some(param => param.type !== "Identifier") || new Set(functions.map(item => item.id?.name)).size !== functions.length || functions.some(item => !identifier(item.id?.name) || reserved.has(item.id.name))) return;
  const index = selector.params[0]?.name;
  if (index && (reserved.has(index) || ["rtnVal", "hashMapArray", "inputParameterValues", "controlId", "i"].includes(index))) return;
  const inputs = contract.inputMappings, outputs = contract.outputMappings.filter(item => item.enabled !== false);
  if (inputs.some(item => item.private || !fieldId(item.sourceField) || !identifier(item.parameterName)) || outputs.some(item => item.private || !fieldId(item.targetField) || !identifier(item.sourceColumn)) ||
      !identifier(contract.searchKey) || !fieldId(contract.fieldId) || contract.tableId && !fieldId(contract.tableId)) return;
  if (inputs.some(item => item.sourceField.includes(".") && item.sourceField.split(".")[0] !== contract.tableId) || outputs.some(item => item.targetField.includes(".") && item.targetField.split(".")[0] !== contract.tableId)) return;
  const observedDialogs = [];
  walk(selector.body, node => { if (call(node, "Dialog_List")) observedDialogs.push(node); });
  if (observedDialogs.length !== 1 || !equal(observedDialogs[0], dialog)) return;
  const args = dialog.arguments;
  if (![7, 10, 11].includes(args.length) || args[0]?.value !== false || args[3]?.value !== ";" ||
      (contract.tableId ? args.length !== 11 || args[10]?.type !== "Identifier" || args[10].name !== index : args.length === 11) ||
      args.length >= 10 && ![false, null, null].every((value, offset) => args[offset + 7]?.type === "Literal" && args[offset + 7].value === value)) return;
  const prefix = contract.tableId ? `${contract.tableId}.!{indexFlag}.` : "";
  const primary = `extendDataFormInfo.value(${prefix}${contract.fieldId})`, display = `extendDataFormInfo.value(${prefix}${contract.fieldId}_name)`;
  const roles = [[args[1], primary], [args[2], display]], roleDeclarations = new Map();
  for (const [argument, value] of roles) {
    if (literal(argument) === value && !contract.tableId) continue;
    if (argument?.type !== "Identifier" || roleDeclarations.has(argument.name) || (reserved.has(argument.name) && !["idField", "nameField"].includes(argument.name)) || argument.name === index) return;
    roleDeclarations.set(argument.name, value);
  }
  const fullSourceStatements = selector.body.body.filter(item => item.type !== "EmptyStatement");
  const prerequisites = omission ? extractGeneratedPrerequisites(fullSourceStatements, inputs, index) : { statements: fullSourceStatements, facts: [] };
  if (!prerequisites) return;
  const sourceStatements = prerequisites.statements;
  const variables = sourceStatements.filter(item => item.type === "VariableDeclaration").flatMap(item => item.declarations);
  if (variables.some(item => item.id.type !== "Identifier") || new Set(variables.map(item => item.id.name)).size !== variables.length) return;
  const locator = variables.filter(item => item.id.name === "restApiPath");
  if (locator.length !== 1 || literal(locator[0].init) === undefined) return;
  const inputValue = variables.find(item => item.id.name === "inputParamValues"), helperCall = inputValue?.init?.arguments?.[0]?.arguments?.[0];
  let getter;
  if (inputValue) {
    if (!call(helperCall, helperCall?.callee?.name) || !identifier(helperCall.callee.name) || helperCall.callee.name === selector.id.name ||
        helperCall.arguments.length !== selector.params.length || helperCall.arguments.some((arg, i) => !equal(arg, selector.params[i]))) return;
    const expected = `encodeURIComponent(JSON.stringify(${helperCall.callee.name}(${index || ""})))`;
    if (!equal(inputValue.init, body(`(${expected});`)[0].expression)) return;
    getter = functions.find(item => item.id?.name === helperCall.callee.name);
    if (!getter || !verifyGetter(getter, inputs, index)) return;
  } else if (inputs.length) return;
  const callback = args[5]?.type === "Identifier" ? functions.find(item => item.id?.name === args[5].name) : undefined;
  let emptyResult = "unchanged";
  if (outputs.length) {
    if (!callback) return;
    emptyResult = verifyCallback(callback, outputs, index);
    if (!emptyResult) return;
  } else if (args[5]?.type !== "Literal" || args[5].value !== null) return;
  const consumed = new Set([actualSelector, ...(getter ? [getter] : []), ...(callback ? [callback] : [])]);
  const scaffolding = [];
  for (const statement of statements) {
    if (consumed.has(statement)) continue;
    // Only this exact generated runtime compatibility definition is recognized;
    // altered/global business code remains unproved and is never translated.
    if (equal(statement, body(generatedPolyfill)[0]) && !scaffolding.length) scaffolding.push("generated-index-replaceAll-polyfill");
    else return;
  }
  const expectedVariables = new Map([["restApiPath", quote(locator[0].init.value)], ...[...roleDeclarations].map(([name, value]) => [name, quote(value)])]);
  if (inputValue) expectedVariables.set("inputParamValues", `encodeURIComponent(JSON.stringify(${getter.id.name}(${index || ""})))`);
  const currentTR = variables.find(item => item.id.name === "currentTR");
  if (currentTR) {
    if (!contract.tableId) return;
    expectedVariables.set("currentTR", 'DocListFunc_GetParentByTagName("TR")');
  }
  if (variables.length !== expectedVariables.size) return;
  const seenVariables = new Set(), rowReplacements = new Set();
  let seenDialog = false, seenReturn = false;
  for (const statement of sourceStatements) {
    if (seenReturn) return;
    if (statement.type === "VariableDeclaration") {
      if (statement.kind !== "var" || seenDialog) return;
      for (const item of statement.declarations) {
        const name = item.id.name;
        if (!expectedVariables.has(name) || seenVariables.has(name) || !equal(item.init, body(`(${expectedVariables.get(name)});`)[0].expression)) return;
        // The serialized getter must run only after a declared locator, as in
        // the exported skeleton. Field reads themselves are proved above.
        seenVariables.add(name);
      }
    } else if (statement.type === "ExpressionStatement" && equal(statement.expression, dialog)) {
      if (seenDialog || seenVariables.size !== expectedVariables.size || contract.tableId && rowReplacements.size !== roleDeclarations.size) return;
      seenDialog = true;
    } else if (statement.type === "ExpressionStatement" && contract.tableId) {
      const name = statement.expression?.left?.name;
      if (seenDialog || !roleDeclarations.has(name) || !seenVariables.has(name) || rowReplacements.has(name) ||
          !oneOf(statement, [`${name}=${name}.replaceAll("!{indexFlag}",${index});`])) return;
      rowReplacements.add(name);
    } else if (statement.type === "ReturnStatement" && statement.argument?.type === "Literal" && statement.argument.value === false && seenDialog) seenReturn = true;
    else return;
  }
  if (!seenReturn) return;
  if (inputValue) {
    const first = `restDialogXMLData&searchKey=${contract.searchKey}&isLoadData=false&isEnableSecret=false&secretKey=&secret=&requestMethod=${contract.requestResource.method}&inputParams=`;
    const search = `restDialogXMLData&keyword=!{keyword}&searchKey=${contract.searchKey}&isEnableSecret=false&secretKey=&secret=&requestMethod=${contract.requestResource.method}&inputParams=`;
    for (const [argument, start] of [[args[4], first], [args[6], search]]) {
      const expression = body(`(${quote(start)}+inputParamValues+"&restApiPath="+restApiPath);`)[0].expression;
      if (!equal(argument, expression)) return;
    }
  } else if (inputs.length || outputs.length || args[4]?.value !== "restDialogXMLData" || args[6]?.value !== "restDialogXMLData") return;
  const omissionFacts = omission ? {
    javascriptLength: javascript.trim().length,
    scope: { kind: "remote-selector-unit", method: contract.requestResource.method, fieldId: contract.fieldId, ...(contract.tableId ? { tableId: contract.tableId } : {}) },
    functionNames: functions.map(node => node.id.name).sort(),
    dependencies: { selector: selector.id.name, ...(getter ? { getter: getter.id.name } : {}), ...(callback ? { callback: callback.id.name } : {}) },
    prerequisiteFields: prerequisites.facts
  } : {};
  return { status: "verified", javascriptSha256: digest(javascript.trim()), soleSelector: true, grammar: omission ? "generated-rest-selector-omission-closed-v1" : "generated-rest-selector-closed-v1",
    ...omissionFacts,
    inputMappings: structuredClone(inputs), outputMappings: structuredClone(outputs), inputReadTiming: "selector-open", cancellation: "unchanged", emptyResult,
    ...(scaffolding.length ? { scaffolding } : {}) };
}

// The generated prerequisite belongs to opening a dependent picker, rather
// than to ordinary form validation. Its exact read and alert-only early return
// can be retired with that picker; other prerequisite effects stay unproved.
function extractGeneratedPrerequisites(statements, inputs, index) {
  const kept = [], facts = [], seen = new Set();
  let locatorSeen = false;
  for (let offset = 0; offset < statements.length; offset += 1) {
    const statement = statements[offset];
    if (statement.type === "VariableDeclaration" && statement.declarations.some(item => item.id?.name === "restApiPath")) locatorSeen = true;
    const control = statement.type === "VariableDeclaration" && statement.kind === "var" && statement.declarations.length === 1 ? statement.declarations[0] : undefined;
    const sourceField = control?.id?.name === "controlId" ? literal(control.init) : undefined;
    if (!sourceField) { kept.push(statement); continue; }
    if (locatorSeen || !index || !inputs.some(mapping => mapping.sourceField === sourceField) || seen.has(sourceField)) return;
    const addressing = statements[offset + 1], read = statements[offset + 2], guard = statements[offset + 3];
    const insert = `if(controlId.indexOf(".")!=-1){controlId=controlId.substring(0,controlId.indexOf(".")+1)+${index}+controlId.substring(controlId.indexOf("."));}`;
    const value = read?.type === "VariableDeclaration" && read.kind === "var" && read.declarations.length === 1 ? read.declarations[0]?.id?.name : undefined;
    if (!/^value[0-9]+$/.test(value || "") || !oneOf(addressing, [insert]) ||
        !oneOf(read, [`var ${value}=document.getElementsByName("extendDataFormInfo.value("+controlId+")")[0].value;`])) return;
    const alerts = [];
    walk(guard, node => { if (call(node, "alert")) alerts.push(node); });
    if (alerts.length !== 2 || alerts.some(node => node.arguments.length !== 1)) return;
    const mainMessage = literal(alerts[1].arguments[0]), label = /^请先填写 '(.+)'！$/.exec(mainMessage || "")?.[1];
    if (!label || /[\r\n]/.test(label)) return;
    const expected = `if(${value}==""||${value}==null){if(controlId.indexOf(".")!=-1){alert("请先填写第 "+(parseInt(${index})+1)+${quote(` 行的 '${label}'！`)});}else{alert(${quote(mainMessage)});}return false;}`;
    if (!oneOf(guard, [expected])) return;
    seen.add(sourceField); facts.push({ sourceField, condition: "empty-or-null", effect: "picker-only-alert-and-return", alertSha256: digest(JSON.stringify(alerts.map(node => normalize(node.arguments[0])))) });
    offset += 3;
  }
  return { statements: kept, facts };
}

function verifyGetter(node, inputs, index) {
  if (node.async || node.generator || node.params.length !== (index ? 1 : 0) || index && node.params[0]?.name !== index) return false;
  const statements = node.body.body.filter(item => item.type !== "EmptyStatement");
  if (statements.length !== inputs.length + 2 || !oneOf(statements[0], ['var inputParameterValues=new Array();', 'var inputParameterValues=[];']) ||
      !oneOf(statements.at(-1), ['return inputParameterValues;'])) return false;
  for (let i = 0; i < inputs.length; i += 1) {
    const mapping = inputs[i], parts = mapping.sourceField.split("."), dynamic = parts.length === 2;
    const address = dynamic ? `${quote(`extendDataFormInfo.value(${parts[0]}.`)}+${index}+${quote(`.${parts[1]})`)}` : quote(`extendDataFormInfo.value(${mapping.sourceField})`);
    const direct = key => `inputParameterValues.push({${key}:document.getElementsByName(${address})[0].value});`;
    // The legacy eval carrier is matched as a literal AST, never evaluated.
    const legacy = dynamic ? `${quote(`fieldName='extendDataFormInfo.value(${parts[0]}.`)}+${index}+${quote(`.${parts[1]})';document.getElementsByName(fieldName)[0].value;`)}` : quote(`fieldName='extendDataFormInfo.value(${mapping.sourceField})';document.getElementsByName(fieldName)[0].value;`);
    const candidates = [quote(mapping.parameterName), mapping.parameterName].flatMap(key => [direct(key), `inputParameterValues.push({${key}:eval(${legacy})});`]);
    if (!oneOf(statements[i + 1], candidates)) return false;
  }
  return true;
}

function verifyCallback(node, outputs, index) {
  if (node.async || node.generator || node.params.length !== (index ? 2 : 1) || node.params[0]?.name !== "rtnVal" || index && node.params[1]?.name !== index) return;
  const guard = "if(rtnVal==null||rtnVal=='undefined'){return;}", values = "var hashMapArray=rtnVal.GetHashMapArray();";
  const writes = empty => outputs.map((mapping, i) => {
    let address = quote(`extendDataFormInfo.value(${mapping.targetField})`), prefix = "";
    if (index) {
      prefix = `var controlId=${quote(mapping.targetField)};if(controlId.indexOf(".")!=-1){controlId=controlId.substring(0,controlId.indexOf(".")+1)+${index}+controlId.substring(controlId.indexOf("."));}`;
      address = '"extendDataFormInfo.value("+controlId+")"';
    }
    const source = `hashMapArray[i].${mapping.sourceColumn}`, value = empty ? '""' : `${source}==null?"":${source}`;
    return `${prefix}var setValueObject${i}=document.getElementsByName(${address})[0];if(setValueObject${i}){setValueObject${i}.value=${value};}`;
  }).join("");
  const selected = `${guard}${values}for(var i=0;i<hashMapArray.length;i++){${writes(false)}}`;
  const options = [["unchanged", selected], ["clear-explicit-outputs", `${selected}${guard}${values}if(hashMapArray.length==0){${writes(true)}}`]];
  for (const [meaning, expected] of options) if (equal(node.body, body(`function f(){${expected}}`)[0].body)) return meaning;
}
function walk(node, callback) {
  if (!node || typeof node !== "object") return;
  callback(node);
  for (const value of Object.values(node)) Array.isArray(value) ? value.forEach(child => walk(child, callback)) : walk(value, callback);
}
