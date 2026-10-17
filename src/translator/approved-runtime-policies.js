import { createHash } from "node:crypto";
import { parse } from "acorn";
import { canonicalJson } from "../agent-review/digest.js";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";
import { inspectSharedJsonStateModel } from "./source-shared-json-state.js";
import { sharedJsonStateSourceDomain } from "./source-shared-json-state-domain.js";
import { scanHtmlTags, findMatchingCloseTag } from "./designer-html-tokenizer.js";
import { parseStaticMarkupAttributes } from "./source-static-markup.js";

export const APPROVED_RUNTIME_POLICY_BASIS = "approved-runtime-policy";
const ORDINARY = "shared-json-ordinary-runtime", ADVICE = "detail-card-number-advice-column";
const sha = text => createHash("sha256").update(String(text || "")).digest("hex");
const sourceSha = text => "sha256:" + sha(text);
const ref = source => source.sourceRef || source.id;
const hashPattern = /^sha256:[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z_$][\w$]*$/;

export function validateApprovedRuntimePolicyDecisions(decisions = []) {
  const diagnostics = [], covered = new Set();
  const error = (code, message, path) => diagnostics.push({ level: "error", code, message, path });
  if (!Array.isArray(decisions)) error("policy.decisions_required", "decisions must be an array.", "/decisions");
  else for (const [index, decision] of decisions.entries()) {
    const path = "/decisions/" + index, keys = decision?.kind === ORDINARY
      ? ["kind", "initializerSourceRef", "sourceJavascriptSha256", "actionIds"]
      : decision?.kind === ADVICE ? ["kind", "sourceRef", "sourceJavascriptSha256", "actionId"] : [];
    if (!decision || typeof decision !== "object" || Array.isArray(decision) || !keys.length) { error("policy.kind_unsupported", "Unsupported approved runtime policy kind.", path); continue; }
    if (Object.keys(decision).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(decision, key))) error("policy.schema_invalid", "Policy properties must match the exact kind schema.", path);
    for (const key of keys.filter(key => !["kind", "actionIds", "sourceJavascriptSha256"].includes(key))) {
      if (typeof decision[key] !== "string" || !decision[key] || decision[key].trim() !== decision[key] || /[\r\n]/.test(decision[key])) error("policy.schema_invalid", key + " must be a nonempty string.", path + "/" + key);
    }
    if (!hashPattern.test(decision.sourceJavascriptSha256 || "")) error("policy.source_hash_required", "sourceJavascriptSha256 must be sha256: followed by lowercase hex.", path + "/sourceJavascriptSha256");
    const actions = decision.kind === ORDINARY ? decision.actionIds : [decision.actionId];
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 16 || actions.some(id => typeof id !== "string" || !id || id.trim() !== id || /[\r\n]/.test(id))) error("policy.action_scope_invalid", "The policy requires 1 to 16 explicit action IDs.", path);
    else for (const id of actions) { if (covered.has(id)) error("policy.action_scope_duplicate", "An action may be covered by only one approved decision.", path); covered.add(id); }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

export function applyApprovedRuntimePolicies(sourceDraft, draft, decisions = []) {
  const validation = validateApprovedRuntimePolicyDecisions(decisions);
  if (!validation.ok) throw policyError("policy.decisions_invalid", "Invalid approved runtime policy decisions.", validation.diagnostics);
  const result = structuredClone(draft), audits = [];
  for (const decision of decisions) {
    if (decision.kind === ORDINARY) applyOrdinary(sourceDraft, result, decision, audits);
    else applyAdvice(sourceDraft, result, decision, audits);
  }
  return { draft: result, audits, changedActionIds: [...new Set(audits.map(audit => audit.actionId))] };
}

// Root attaches this immutable raw-export witness during normal XML intake.
export function approvedRuntimePolicySourceFacts(template = {}, sources = []) {
  const order = sharedJsonStateSourceDomain(template, sources);
  if (!order) return undefined;
  const text = String(template.fdDisplayJsp || ""), markup = maskMarkup(text), tables = [];
  if (markup === undefined) return undefined;
  for (const token of scanHtmlTags(markup)) {
    if (token.closing || token.name !== "table") continue;
    const attrs = parseStaticMarkupAttributes(token.attrs), id = attrs?.get("id");
    if (!/^TABLE_DL_[A-Za-z_][\w-]*$/.test(id || "")) continue;
    const end = findMatchingCloseTag(markup, token.end, "table");
    if (end < 0) return undefined;
    let tableDepth = 0, rowStart; const rows = [];
    for (const child of scanHtmlTags(markup.slice(token.end, end))) {
      if (child.name === "table") { tableDepth += child.closing ? -1 : 1; continue; }
      if (tableDepth) continue;
      if (child.name === "tr" && !child.closing) {
        if (rowStart) return undefined;
        rowStart = { start: token.end + child.start, attrs: parseStaticMarkupAttributes(child.attrs) };
      } else if (child.name === "tr" && child.closing && rowStart) {
        rows.push({ ...rowStart, end: token.end + child.end }); rowStart = undefined;
      }
    }
    if (rows.length < 2 || rowStart || rows.some(row => !row.attrs)) continue;
    const beforeReference = markup.slice(token.end, rows[1].start);
    if (/<%|<\s*(?:c:(?:if|choose|when|otherwise|foreach)|thead|tfoot)\b/i.test(beforeReference)) continue;
    if (rows[0].attrs.get("type") !== "titleRow" || rows[1].attrs.get("kmss_isreferrow") !== "1" || rows[1].attrs.get("type") !== "templateRow" ||
      !/(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/i.test(rows[1].attrs.get("style") || "")) continue;
    tables.push({ sourceTableId: id.slice("TABLE_DL_".length), domId: id, tableStart: token.start, tableEnd: end,
      referenceRowIndex: 1, referenceRowStart: rows[1].start, referenceRowEnd: rows[1].end,
      referenceRowSha256: sha(text.slice(rows[1].start, rows[1].end)) });
  }
  const facts = { version: 1, sourceHashes: Object.fromEntries(["fdDesignerHtml", "fdDisplayJsp", "fdMetadataXml"].map(key => [key, sha(template[key])])),
    scripts: sources.map(source => ({ sourceRef: ref(source), sourceJavascriptSha256: sha(source.javascript) })), templateRows: tables };
  return { ...facts, digest: sha(canonicalJson(facts)) };
}

function applyOrdinary(sourceDraft, draft, decision, audits) {
  const sources = sourceDraft.scripts?.sources || [], initializerSource = unique(sources, source => ref(source) === decision.initializerSourceRef);
  requireMatch(initializerSource && sourceSha(initializerSource.javascript) === decision.sourceJavascriptSha256, "The shared initializer source does not match its approved hash.");
  const model = inspectSharedJsonStateModel(draft.form, sourceDraft.scripts);
  requireMatch(model && model.initializer.sourceRef === decision.initializerSourceRef && model.initializer.residuals.length === 1, "The source is not the closed shared JSON initialization profile.");
  const entries = sourceEntries(sources), entry = entries.find(entry => entry.source === initializerSource);
  const init = unique(entry.ast.body, node => node.type === "FunctionDeclaration" && node.id?.name === model.initializer.name);
  requireMatch(init && nonEmpty(init.body.body).length === 4, "Initialization must contain only the proven prefix and one optional branch.");
  const optional = nonEmpty(init.body.body)[3], branch = optionalTemplateBranch(optional, entry, model.stateName, entries);
  requireMatch(branch && optional.start === model.initializer.residuals[0].start && optional.end === model.initializer.residuals[0].end, "The remaining branch is not the approved optional template-row surgery.");
  const facts = verifiedFacts(sourceDraft), witness = unique(facts?.templateRows || [], table => table.sourceTableId === branch.tableId);
  requireMatch(witness && witness.referenceRowIndex === 1, "No immutable hidden reference-row witness matches the optional source operation.");
  const table = unique(draft.form.fields || [], field => field.type === "detailTable" && sourceIds(field).has(branch.tableId));
  requireMatch(table, "The source template table has no unambiguous native detail mapping.");
  for (const actionId of decision.actionIds) {
    const action = unique(draft.scripts?.actions || [], action => action.id === actionId), callback = action && sourceCallback(sourceDraft, action);
    requireMatch(action && callback?.event === "onLoad" && callback.fn.params.length === 0, "The approved action is not an original zero-argument load callback.");
    const body = nonEmpty(callback.fn.body.body);
    requireMatch(body.length >= 1 && body.length <= 3 && isCall(body[0]?.expression, model.initializer.name) && !body[0].expression.arguments.length &&
      globalFunctionReference(model.initializer.name, body[0].start, callback.entry), "The load callback does not begin with the source initializer.");
    const removed = body.slice(1).map(node => mismatchedOptionRemoval(node, callback.entry, sourceDraft, draft.form));
    requireMatch(removed.every(Boolean) && (removed.length === 0 || removed.length === 2 && new Set(removed.map(item => item.optionValue)).size === 2 &&
      removed.every(item => item.sourceFieldId === removed[0].sourceFieldId) && ["4", "5"].every(value => removed.some(item => item.optionValue === value))), "Only the approved scope-mismatched value 4/5 radio removals may be omitted.");
    const audit = { kind: decision.kind, actionId, sourceRef: ref(callback.entry.source), sourceJavascriptSha256: sourceSha(callback.entry.source.javascript),
      retainedFieldRefs: [model.fieldId, ...removed.map(item => item.targetTableId + "." + item.targetFieldId)],
      coveredRanges: [range(callback.entry.source, callback.call, "approvedOrdinaryLoad"), range(initializerSource, init, "approvedOrdinaryInitializer")], omitted: [
        { sourceRef: decision.initializerSourceRef, start: optional.start, end: optional.end, behavior: "external optional flag and source hidden template-row surgery", flag: branch.flag, sourceTableId: branch.tableId, targetTableId: table.id, witnessDigest: facts.digest },
        ...removed.map(item => ({ ...item, behavior: "unqualified main-name option removal for a detail-only radio; exported options retained" }))
      ] };
    replaceAction(action, model.initializer.provenPrefixFunction, decision, audit);
    audits.push(audit);
  }
}

function applyAdvice(sourceDraft, draft, decision, audits) {
  const source = unique(sourceDraft.scripts?.sources || [], source => ref(source) === decision.sourceRef);
  requireMatch(source && sourceSha(source.javascript) === decision.sourceJavascriptSha256, "The card action source does not match its approved hash.");
  const action = unique(draft.scripts?.actions || [], action => action.id === decision.actionId), callback = action && sourceCallback(sourceDraft, action);
  requireMatch(callback?.entry.source === source && callback.event === "onChange", "The approved advice action is not the retained source callback.");
  const model = cardAdviceModel(callback, sourceEntries(sourceDraft.scripts?.sources || []));
  requireMatch(model, "The complete source callback/helper is not the approved card normalization and advisory profile.");
  const targets = (draft.form.fields || []).filter(field => field.type === "detailTable").flatMap(table => (table.columns || []).filter(column => sourceIds(column).has(callback.controlId)).map(column => ({ table, column })));
  const nonDetailCollision = (draft.form.fields || []).some(field => sourceIds(field).has(callback.controlId));
  requireMatch(targets.length === 1 && !nonDetailCollision && targets[0].table.componentId === "xform-detail-table" && targets[0].table.props?.popup !== true &&
    targets[0].column.type === "text" && targets[0].column.componentId === "xform-input" &&
    (!action.tableId || action.tableId === targets[0].table.id) && [targets[0].column.id, callback.controlId].includes(action.controlId), "Card advice requires one ordinary detail text input.");
  const { table, column } = targets[0], fieldId = "fd_hint_" + sha(decision.sourceRef + "@" + callback.call.start + ":" + table.id + "." + column.id).slice(0, 16);
  const field = { id: fieldId, title: "卡号检查", type: "text", componentId: "xform-input", generated: true, sourceRef: decision.sourceRef,
    reason: "Explicitly approved derived per-row card-length advisory column.",
    props: { readOnly: true, required: false, defaultValue: { kind: "literal", value: "" } },
    sourceProps: { designerValues: { width: "260" }, approvedRuntimePolicy: { kind: decision.kind, sourceActionId: action.id, sourceRef: decision.sourceRef, sourceJavascriptSha256: decision.sourceJavascriptSha256,
      derivedValuePersistence: true, sourceControlId: callback.controlId } } };
  const collisions = (draft.form.fields || []).flatMap(field => field.type === "detailTable" ? field.columns || [] : [field]).filter(item => item.id === fieldId);
  if (collisions.length) requireMatch(collisions.length === 1 && canonical(collisions[0]) === canonical(field) && table.columns.indexOf(collisions[0]) === table.columns.indexOf(column) + 1, "The derived advice field collides with an existing or modified field.");
  else table.columns.splice(table.columns.indexOf(column) + 1, 0, field);
  const fn = ["function onChange(value, rowNum, parentRowNum) {", "  if (!value || value.length < 1) return;", "  var sanitized = value.replace(/\\D/g, \"\");",
    "  var advice = sanitized.length < 16 ? " + JSON.stringify(model.message) + ' : "";',
    "  MKXFORM.updateRow(" + JSON.stringify(table.id) + ", rowNum, { " + JSON.stringify(column.id) + ": sanitized, " + JSON.stringify(fieldId) + ": advice });", "}"].join("\n");
  const audit = { kind: decision.kind, actionId: action.id, sourceRef: decision.sourceRef, sourceJavascriptSha256: decision.sourceJavascriptSha256,
    coveredRanges: [range(source, callback.call, "approvedCardAdviceCallback"), range(model.helper.entry.source, model.helper.node, "approvedCardAdviceHelper")],
    addedField: { tableId: table.id, fieldId, afterFieldId: column.id, title: field.title, width: 260, readOnly: true, required: false, defaultValue: "", derivedValuePersistence: true },
    presentationChange: "A stable per-row derived String column replaces source sibling-div advice; the derived value may persist in drafts/records.",
    omitted: [{ sourceRef: ref(model.helper.entry.source), start: model.helper.node.start, end: model.helper.node.end, behavior: "create/reuse/show/hide a source DOM sibling div" }] };
  replaceAction(action, fn, decision, audit); audits.push(audit);
}

function replaceAction(action, fn, decision, audit) {
  action.function = fn; action.translationStatus = "mapped";
  action.coverage = { status: "translated", nativeRules: action.coverage?.nativeRules || [], residuals: [] };
  action.functionMappings = [{ source: decision.kind, target: "explicitly approved runtime behavior", basis: APPROVED_RUNTIME_POLICY_BASIS, reviewRequired: false }];
  action.sourceRefs = [...new Set([...(action.sourceRefs || []), ...audit.coveredRanges.map(range => range.sourceRef)])];
  action.semanticHints = { ...action.semanticHints, coveredCalculationRanges: audit.coveredRanges, approvedRuntimePolicy: { decision, audit } };
}

function optionalTemplateBranch(node, entry, state, entries) {
  const test = node?.test;
  if (node?.type !== "IfStatement" || node.alternate || test?.type !== "BinaryExpression" || test.operator !== "!=" || test.left?.type !== "UnaryExpression" || test.left.operator !== "typeof" ||
    test.left.argument.type !== "Identifier" || literal(test.right) !== "undefined") return undefined;
  const flag = test.left.argument.name, body = nonEmpty(node.consequent?.body), declared = declaration(body[0]), condition = body[1]?.test;
  const property = condition?.left?.argument?.property?.name, elseBody = nonEmpty(body[1]?.alternate?.body), array = declaration(elseBody[0]), final = body[2]?.consequent?.body?.[0]?.expression;
  if (body.length !== 3 || !declared || !property || !array || !isCall(final) || final.arguments.length !== 1 || typeof literal(final.arguments[0]) !== "string" ||
    !entry.bindings.isUnshadowedGlobal(flag, test.start) || authoredBinding(entries, flag)) return undefined;
  const tableId = literal(final.arguments[0]), temporary = declared.id.name, list = array.id.name;
  const expected = statements(`if(typeof ${flag}!='undefined'){var ${temporary}=true;if(!${state}.${property}||${state}.${property}.length<1){${temporary}=false;}else{var ${list}=${state}.${property}.split(";");if(${list}.length<=1&&${list}[0]=='3'){${temporary}=false;}}if(!${temporary}){${final.callee.name}(${JSON.stringify(tableId)});}}`);
  if (!same([node], expected) || !globalFunctionReference(final.callee.name, final.start, entry)) return undefined;
  const helper = functionDefinition(final.callee.name, entries), pollBody = helper && nonEmpty(helper.node.body.body), local = declaration(pollBody?.[0]), parameter = helper?.node.params[0]?.name;
  if (!helper || helper.node.params.length !== 1 || !parameter || !local || helper.node.async || helper.node.generator || !identifierPattern.test(parameter)) return undefined;
  const timer = pollBody[1]?.consequent?.body?.[0]?.expression, delay = timer?.arguments?.[1];
  if (!Number.isInteger(literal(delay)) || literal(delay) < 0 || literal(delay) > 2147483647) return undefined;
  const expectedPoll = statements(`var ${local.id.name}=document.getElementById("TABLE_DL_"+${parameter});if(!${local.id.name}){setTimeout(${helper.node.id.name},${literal(delay)});}else{$(${JSON.stringify("#TABLE_DL_" + tableId + " > tbody > tr")}).eq(1).remove();}`);
  return same(pollBody, expectedPoll) && stableNodeGlobals(helper.node, helper.entry, ["document", "$", "setTimeout"]) &&
    globalFunctionReference(helper.node.id.name, timer.arguments[0].start, helper.entry) ? { flag, tableId, helper } : undefined;
}

function mismatchedOptionRemoval(node, entry, sourceDraft, form) {
  const call = node.expression;
  if (!method(call, "remove") || call.arguments.length || !method(call.callee.object, "parent") || call.callee.object.arguments.length) return undefined;
  const selector = call.callee.object.callee.object;
  if (!isCall(selector, "$") || selector.arguments.length !== 1 || !entry.bindings.isUnshadowedGlobal("$", selector.start)) return undefined;
  const match = literal(selector.arguments[0])?.match(/^input\[name=(["'])extendDataFormInfo\.value\(([A-Za-z_][\w-]*)\)\1\]\[value=(["'])(4|5)\3\]$/);
  if (!match) return undefined;
  const sourceFieldId = match[2], sourceForm = sourceDraft.form || {};
  if ([...(sourceForm.controls || []), ...(sourceForm.dataFields || [])].some(field => sourceIds(field).has(sourceFieldId))) return undefined;
  const tables = (sourceForm.detailTables || []).filter(table => table.columns?.some(column => sourceIds(column).has(sourceFieldId) && column.sourceType === "radio"));
  const targets = (form.fields || []).filter(table => table.type === "detailTable").flatMap(table => (table.columns || []).filter(column => sourceIds(column).has(sourceFieldId) && column.componentId === "xform-radio").map(column => ({ table, column })));
  if (tables.length !== 1 || targets.length !== 1) return undefined;
  const sourceColumn = tables[0].columns.find(column => sourceIds(column).has(sourceFieldId));
  if (canonical(sourceColumn.options) !== canonical(targets[0].column.props?.options)) return undefined;
  return { sourceRef: ref(entry.source), start: node.start, end: node.end, sourceFieldId, sourceTableId: tables[0].id,
    targetTableId: targets[0].table.id, targetFieldId: targets[0].column.id, optionValue: match[4], retainedOptions: structuredClone(sourceColumn.options) };
}

function cardAdviceModel(callback, entries) {
  const { fn, entry } = callback, body = nonEmpty(fn.body.body);
  if (!plainFunction(fn) || fn.params.length !== 2 || body.length !== 5) return undefined;
  const value = fn.params[0].name, element = fn.params[1].name, tip = declaration(body[2]), call = body[4]?.expression;
  if (!tip || !isCall(call) || call.arguments.length !== 3 || typeof literal(call.arguments[1]) !== "string" || !literal(call.arguments[1])) return undefined;
  const message = literal(call.arguments[1]);
  const expected = statements(`if(!${value}||${value}.length<1){return;}${element}.value=${value}.replace(/\\D/g,'');var ${tip.id.name}=false;if(${element}.value.length<16){${tip.id.name}=true;}${call.callee.name}(${element},${JSON.stringify(message)},${tip.id.name});`);
  if (!same(body, expected) || new Set([value, element, tip.id.name]).size !== 3 || !globalFunctionReference(call.callee.name, call.start, entry)) return undefined;
  const helper = functionDefinition(call.callee.name, entries);
  if (!helper || helper.node.params.length !== 3 || helper.node.params.some(node => node.type !== "Identifier") || helper.node.async || helper.node.generator) return undefined;
  const [dom, content, flag] = helper.node.params.map(node => node.name), helperBody = nonEmpty(helper.node.body.body), div = declaration(helperBody[0]), object = declaration(helperBody[1]);
  if (!div || div.init || !object || new Set([dom, content, flag, div.id.name, object.id.name]).size !== 5) return undefined;
  const d = div.id.name, o = object.id.name;
  const expectedHelper = statements(`var ${d};var ${o}=$(${dom});if(!${o}.next().next()||${o}.next().next().length<1){${d}=document.createElement("div");${d}.setAttribute("class","validation-advice");${d}.textContent=${content};${o}.parent().append(${d});}else{${d}=${o}.next().next()[0];}if(${flag}){$(${d}).show();}else{$(${d}).hide();}`);
  return same(helperBody, expectedHelper) && stableNodeGlobals(helper.node, helper.entry, ["$", "document"]) ? { message, helper } : undefined;
}

function sourceCallback(sourceDraft, action) {
  const entries = sourceEntries(sourceDraft.scripts?.sources || []), matches = [];
  for (const entry of entries) {
    let ordinal = 0;
    for (const statement of entry.ast.body) {
      const call = statement.expression; let event, fn, controlId;
      if (isCall(call, "AttachXFormValueChangeEventById") && call.arguments.length === 2) { event = "onChange"; fn = call.arguments[1]; controlId = literal(call.arguments[0]); }
      else if (isCall(call, "Com_AddEventListener") && call.arguments.length === 3 && id(call.arguments[0], "window") && literal(call.arguments[1]) === "load") { event = "onLoad"; fn = call.arguments[2]; }
      else continue;
      ordinal += 1;
      const exactKey = event === "onChange" && action.sourceActionKey === ref(entry.source) + "#onChange@" + call.start;
      if ((exactKey || action.id === entry.source.id + ".event." + ordinal) && event === action.event && (exactKey || action.controlId === controlId) && plainFunction(fn) &&
        action.sourceRefs?.includes(ref(entry.source)) && entry.bindings.isUnshadowedGlobal(call.callee.name, call.start)) matches.push({ entry, call, fn, event, controlId });
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function verifiedFacts(sourceDraft) {
  const sources = sourceDraft.scripts?.sources || [], facts = sources.map(source => source.semanticFacts?.approvedRuntimePolicies).filter(Boolean);
  if (facts.length !== 1) return undefined;
  const { digest, ...body } = facts[0];
  if (body.version !== 1 || sha(canonicalJson(body)) !== digest || body.scripts?.length !== sources.length) return undefined;
  return sources.every(source => body.scripts.filter(script => script.sourceRef === ref(source) && script.sourceJavascriptSha256 === sha(source.javascript)).length === 1) ? facts[0] : undefined;
}
function sourceEntries(sources) { return sources.map(source => { const ast = parse(source.javascript, { ecmaVersion: "latest" }), bindings = buildJavaScriptBindingModel(source.javascript); requireMatch(bindings.ok, "The source script binding model is invalid."); return { source, ast, bindings }; }); }
function globalFunctionReference(name, index, entry) { const binding = entry.bindings.bindingAtUse(name, index); return entry.bindings.isUnshadowedGlobal(name, index) || binding?.scope.kind === "program" && binding.kinds.has("function"); }
function stableNodeGlobals(node, entry, names) { let valid = true; walk(node, child => { if (child.type === "CallExpression") { const name = child.callee.type === "Identifier" ? child.callee.name : child.callee.object?.name; if (names.includes(name) && !entry.bindings.isUnshadowedGlobal(name, child.callee.start)) valid = false; } }); return valid; }
function functionDefinition(name, entries) {
  const matches = entries.flatMap(entry => entry.ast.body.filter(node => node.type === "FunctionDeclaration" && node.id?.name === name).map(node => ({ entry, node })));
  if (matches.length !== 1) return undefined;
  let stable = true;
  for (const entry of entries) walk(entry.ast, node => {
    if (node.type === "FunctionDeclaration" && node.id?.name === name && node !== matches[0].node || node.type === "VariableDeclarator" && node.id?.name === name) stable = false;
    if (node.type === "AssignmentExpression" && (id(node.left, name) || node.left?.type === "MemberExpression" && ["window", "globalThis", "self"].includes(node.left.object?.name) &&
      (node.left.computed ? typeof literal(node.left.property) !== "string" || literal(node.left.property) === name : id(node.left.property, name)))) stable = false;
  });
  return stable ? matches[0] : undefined;
}
function authoredBinding(entries, name) { let found = false; for (const entry of entries) walk(entry.ast, node => { if (node.type === "VariableDeclarator" && node.id?.name === name || node.type === "FunctionDeclaration" && node.id?.name === name || node.type === "AssignmentExpression" && id(node.left, name)) found = true; }); return found; }
function sourceIds(field) { return new Set([field.id, field.sourceProps?.originalId, field.sourceProps?.metadataId, field.sourceProps?.designerId].filter(Boolean)); }
function unique(values, predicate) { const matches = values.filter(predicate); return matches.length === 1 ? matches[0] : undefined; }
function range(source, node, name) { return { sourceRef: ref(source), start: node.start, end: node.end, name }; }
function requireMatch(condition, message) { if (!condition) throw policyError("policy.source_not_matched", message); }
function policyError(code, message, diagnostics) { const error = new Error(message); error.code = code; error.diagnostics = diagnostics || [{ level: "error", code, message }]; return error; }
function nonEmpty(body = []) { return body.filter(node => node.type !== "EmptyStatement"); }
function declaration(node) { return node?.type === "VariableDeclaration" && node.kind === "var" && node.declarations.length === 1 && node.declarations[0].id.type === "Identifier" ? node.declarations[0] : undefined; }
function literal(node) { return node?.type === "Literal" ? node.value : undefined; }
function id(node, name) { return node?.type === "Identifier" && node.name === name; }
function isCall(node, name) { return node?.type === "CallExpression" && !node.optional && node.callee?.type === "Identifier" && (!name || node.callee.name === name); }
function method(node, name) { return node?.type === "CallExpression" && !node.optional && node.callee?.type === "MemberExpression" && !node.callee.computed && !node.callee.optional && id(node.callee.property, name); }
function plainFunction(node) { return node?.type === "FunctionExpression" && !node.async && !node.generator && !node.id && node.params.every(node => node.type === "Identifier") && new Set(node.params.map(node => node.name)).size === node.params.length; }
function statements(text) { return parse("function __policyAudit(){" + text + "}", { ecmaVersion: "latest" }).body[0].body.body; }
function canonical(value) { return JSON.stringify(value, (key, value) => ["start", "end", "raw"].includes(key) ? undefined : value); }
function same(left, right) { return canonical(left) === canonical(right); }
function walk(node, visit) { if (!node || typeof node !== "object") return; visit(node); for (const value of Object.values(node)) if (value && typeof value === "object") Array.isArray(value) ? value.forEach(child => walk(child, visit)) : walk(value, visit); }
function maskMarkup(text) {
  let value = text.replace(/<%--[\s\S]*?--%>|<!--[\s\S]*?-->/g, text => text.replace(/[^\r\n]/g, " "));
  const ranges = []; let skip = 0;
  for (const token of scanHtmlTags(value)) {
    if (token.start < skip || token.closing || !["script", "style", "textarea", "pre", "code"].includes(token.name)) continue;
    const close = new RegExp("<\\/\\s*" + token.name + "\\s*>", "ig"); close.lastIndex = token.end;
    if (!close.exec(value)) return undefined;
    ranges.push([token.start, close.lastIndex]); skip = close.lastIndex;
  }
  for (const [start, end] of ranges.reverse()) value = value.slice(0, start) + value.slice(start, end).replace(/[^\r\n]/g, " ") + value.slice(end);
  return value;
}
