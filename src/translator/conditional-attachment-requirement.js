import { parse } from "acorn";
import { nativeValidationMessage } from "./native-validation-message.js";
import { createHash } from "node:crypto";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";
import { isUnconditionalAttachmentRequirement } from "./attachment-non-empty.js";

export function analyzeConditionalAttachmentRequirement(source = {}, form = {}) {
  if (source.displayGate && source.displayGate !== "xform:editShow") return undefined;
  const text = String(source.javascript || "");
  let program;
  try { program = parse(text, { ecmaVersion: "latest" }); }
  catch { return undefined; }
  const statements = significant(program.body);
  if (statements.length !== 2) return undefined;
  const [helper, registration] = statements;
  if (helper.type !== "FunctionDeclaration" || !helper.id || helper.params.length !== 2 ||
    ["alert", "$", "Com_Parameter", "Attachment_ObjectInfo"].includes(helper.id.name) ||
    helper.params.some(node => node.type !== "Identifier") || helper.params[0].name === helper.params[1].name) return undefined;
  const helperLoop = significant(helper.body?.body)[0];
  const index = singleVariable(helperLoop?.init)?.id.name;
  if (!index || helper.params.some(node => node.name === index)) return undefined;
  const call = registration.type === "ExpressionStatement" ? registration.expression : undefined;
  if (call?.type !== "CallExpression" || !memberPath(call.callee, ["Com_Parameter", "event", "submit", "push"]) || call.arguments.length !== 1) return undefined;
  const callback = call.arguments[0];
  if (callback.type !== "FunctionExpression" || callback.id || callback.async || callback.generator || callback.params.length) return undefined;
  const body = significant(callback.body?.body);
  if (body.length !== 6 || body[3].type !== "ExpressionStatement" || body[4].type !== "IfStatement" || body[4].alternate || body[5].type !== "ReturnStatement") return undefined;
  const conditionVariable = singleVariable(body[0]);
  const attachmentVariable = singleVariable(body[1]);
  const activeVariable = singleVariable(body[2]);
  if (!conditionVariable || !attachmentVariable || !activeVariable) return undefined;
  const localNames = [conditionVariable.id.name, attachmentVariable.id.name, activeVariable.id.name];
  if (new Set(localNames).size !== 3 || localNames.some(name => [helper.id.name, "alert", "$", "Attachment_ObjectInfo", "Com_Parameter"].includes(name))) return undefined;
  const conditionFieldId = checkedRadioField(conditionVariable.init);
  const test = body[4].test;
  if (!conditionFieldId || test.type !== "LogicalExpression" || test.operator !== "&&" ||
    test.left.type !== "BinaryExpression" || !["==", "==="].includes(test.left.operator) ||
    !identifier(test.left.left, conditionVariable.id.name) || test.left.right.type !== "Literal" ||
    typeof test.left.right.value !== "string") return undefined;
  const attachmentList = attachmentVariable.init;
  if (attachmentList?.type !== "MemberExpression" || attachmentList.computed || !identifier(attachmentList.property, "fileList") ||
    attachmentList.object?.type !== "MemberExpression" || !identifier(attachmentList.object.object, "Attachment_ObjectInfo") ||
    !attachmentList.object.computed || attachmentList.object.property.type !== "Literal" ||
    typeof attachmentList.object.property.value !== "string") return undefined;
  const fieldId = attachmentList.object.property.value;
  const nativeGuard = `${text.slice(helper.start, helper.end)}\nCom_Parameter.event.submit.push(function(){\n` +
    body.slice(1, 4).map(node => text.slice(node.start, node.end)).join("\n") +
    `\nif (${text.slice(test.right.start, test.right.end)}) ${text.slice(body[4].consequent.start, body[4].consequent.end)}\n` +
    text.slice(body[5].start, body[5].end) + "\n});";
  if (!isUnconditionalAttachmentRequirement(nativeGuard, fieldId)) return undefined;
  const conditionField = (form.fields || []).find(field => field.id === conditionFieldId && field.type === "radio" && field.componentId === "xform-radio" && !field.dataOnly);
  const attachmentField = (form.fields || []).find(field => field.id === fieldId && field.type === "attachment" && field.componentId === "xform-attach" && !field.dataOnly);
  const conditionValue = test.left.right.value;
  if (!conditionField || !attachmentField || !(conditionField.props?.options || []).some(option => option.value === conditionValue)) return undefined;
  const failure = significant(body[4].consequent.body);
  const message = failure[0].expression.arguments[0].value;
  const sourceRef = source.sourceRef || source.id;
  if (typeof source.id !== "string" || !source.id || !sourceRef) return undefined;
  return {
    fieldId, conditionFieldId, conditionValue, message, sourceRef,
    sourceHelperName: helper.id.name,
    displayGate: source.displayGate,
    runWhen: source.displayGate === "xform:editShow" ? { viewStatusIn: ["add", "edit"] } : undefined,
    baselineRequired: attachmentField.props?.required === true,
    comparisonOperator: test.left.operator,
    sourceShape: "conditional-active-file-submit-guard",
    activeFileSemantics: "fileStatus != -1",
    targetValidation: "native-getValue-mechanism-array-excluding-DELETE-bindings",
    sourceMessagePolicy: "Preserve source alert text through the platform-specific native message and false return.",
    sourceRanges: [{ sourceRef, start: helper.start, end: registration.end }],
    sourceId: source.id,
    sourceSha256: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    sourceLength: text.length,
    ...(source.sourceActionKey ? { originalSubmitSourceActionKey: source.sourceActionKey } : {})
  };
}

export function conditionalAttachmentRequirementCandidates(source = {}, form = {}, sourceScripts = {}) {
  const model = analyzeConditionalAttachmentRequirement(source, form);
  if (!model || !sourceGlobalsStable(source, sourceScripts, model.sourceHelperName)) return [];
  return [{
    id: `${source.id}.event.1`,
    index: model.sourceRanges[0].start,
    javascript: source.javascript,
    sourceActionKey: source.sourceActionKey,
    sourceRefs: [model.sourceRef],
    event: "onBeforeSubmit",
    scope: "global",
    runWhen: model.runWhen,
    function: [
      "function onBeforeSubmit(context) {",
      "  if (context && context.isDraft) return true",
      `  var selected = MKXFORM.getValue(${JSON.stringify(model.conditionFieldId)})`,
      "  selected = Array.isArray(selected) ? selected[0] : selected",
      `  if (selected ${model.comparisonOperator} ${JSON.stringify(model.conditionValue)}) {`,
      `    var files = MKXFORM.getValue(${JSON.stringify(model.fieldId)})`,
      "    files = files && files.mechanismKey ? files.mechanismValue : files",
      "    var activeFiles = Array.isArray(files) ? files.filter(function(file) { return file.fdBindType !== \"DELETE\" }) : []",
      "    if (activeFiles.length === 0) {",
      nativeValidationMessage(JSON.stringify(model.message), "      "),
      "      return false",
      "    }",
      "  }",
      "  return true",
      "}"
    ].join("\n"),
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "checked-radio conditional active attachment fileList submit guard",
      target: "synchronous onBeforeSubmit + native attachment getValue + DELETE filtering + toast",
      basis: "deterministic-conditional-attachment-submit",
      reviewRequired: false
    }],
    semanticHints: {
      coveredLegacyFunctions: ["alert"],
      coveredCalculationRanges: model.sourceRanges.map(range => ({ ...range, name: "conditional_attachment_submit" })),
      conditionalAttachmentRequirement: {
        ...model,
        nativeReadContract: {
          runtimeSha256: "a3ee70fad7030bd66884aa39a2e28e59d3472671b0d633acd0fb05d4d48c91ba",
          attachmentStrings: "unreadable-as-empty",
          mechanismValue: "truthy-mechanismKey-unwrapped",
          activeBindings: "array-excluding-fdBindType-DELETE",
          unknownOuterValues: "fail-closed-as-empty",
          fieldState: "read-only; no required or visibility mutation"
        }
      }
    }
  }];
}

function sourceGlobalsStable(source, sourceScripts, helperName) {
  const globals = new Set([helperName, "$", "Attachment_ObjectInfo", "Com_Parameter", "alert"]);
  const others = (sourceScripts.sources || []).filter(candidate => candidate !== source);
  for (const candidate of [source, ...others]) {
    const text = String(candidate.javascript || "");
    const bindings = buildJavaScriptBindingModel(text);
    if (!bindings.ok) return false;
    for (const name of globals) {
      if (candidate === source && name === helperName) continue;
      if (!bindings.isUnshadowedGlobal(name, text.length)) return false;
    }
    let ast;
    try { ast = parse(text, { ecmaVersion: "latest" }); }
    catch { return false; }
    let mutated = false;
    walk(ast, node => {
      let target;
      if (node.type === "AssignmentExpression") target = node.left;
      if (node.type === "UpdateExpression" || node.type === "UnaryExpression" && node.operator === "delete") target = node.argument;
      if (!target) return;
      const path = [];
      while (target?.type === "MemberExpression") {
        path.unshift(target.computed ? target.property.type === "Literal" ? target.property.value : undefined : target.property.name);
        target = target.object;
      }
      if (target?.type !== "Identifier") return;
      const name = globals.has(target.name) ? target.name
        : ["window", "globalThis", "self"].includes(target.name) && globals.has(path[0]) ? path[0] : undefined;
      const binding = bindings.bindingAtUse(target.name, node.start);
      if (name && (!binding || binding.scope.kind === "program")) mutated = true;
    });
    if (mutated) return false;
  }
  return true;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(item => walk(item, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}

function checkedRadioField(node) {
  if (node?.type !== "CallExpression" || node.arguments.length || node.callee.type !== "MemberExpression" ||
    node.callee.computed || !identifier(node.callee.property, "val")) return undefined;
  const selectorCall = node.callee.object;
  if (selectorCall?.type !== "CallExpression" || !identifier(selectorCall.callee, "$") ||
    selectorCall.arguments.length !== 1 || selectorCall.arguments[0].type !== "Literal" ||
    typeof selectorCall.arguments[0].value !== "string") return undefined;
  return selectorCall.arguments[0].value.match(/^\[name=(["'])extendDataFormInfo\.value\(([A-Za-z_$][\w$]*)\)\1\]:checked$/)?.[2];
}

function significant(body) { return (body || []).filter(node => node.type !== "EmptyStatement"); }
function identifier(node, name) { return node?.type === "Identifier" && node.name === name; }
function singleVariable(node) {
  return node?.type === "VariableDeclaration" && node.declarations.length === 1 && node.declarations[0].id.type === "Identifier"
    ? node.declarations[0] : undefined;
}
function memberPath(node, path) {
  if (path.length === 1) return identifier(node, path[0]);
  if (node?.type !== "MemberExpression" || node.optional) return false;
  const name = node.computed && node.property.type === "Literal" ? node.property.value : node.property.name;
  return name === path.at(-1) && memberPath(node.object, path.slice(0, -1));
}
