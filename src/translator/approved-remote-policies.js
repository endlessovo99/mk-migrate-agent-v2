import {remoteOmissionContractEligible} from "../dsl/remote-omission-contract.js";
import {parseDesignerFdValues} from "./designer-control-values.js";
import {remoteSelectorOmissionDuplicateAnchors} from "./remote-selector-omission-duplicates.js";
import {remoteSelectorScriptClosure,remoteSelectorOmissionScriptClosure} from "./remote-selector-script-closure.js";
import {validateRemoteSelectorDecisions as validateApprovedRemoteDecisions} from "../dsl/remote-selector-contract.js";
import {nativeRemoteSelectorFunction} from "../dsl/native-remote-selector-profile.js";
import { createHash } from "node:crypto";
import { parse } from "acorn";
import { canonicalJson, sha256Digest } from "../agent-review/digest.js";
import { remoteSelectorSourceContracts } from "./remote-selector-source-contract.js";
import { staticSourceMarkup, parseStaticMarkupAttributes } from "./source-static-markup.js";
import { scanHtmlTags } from "./designer-html-tokenizer.js";
import { parseMetadataXml } from "./sysform-metadata.js";

const KIND = "native-tic-rest-selector";
const word = value => typeof value === "string" && /^[A-Za-z_][\w-]*$/.test(value) && !["__proto__", "constructor", "prototype", "__lookupKey"].includes(value);
const rawHash = value => "sha256:" + createHash("sha256").update(String(value || "")).digest("hex");
const entries = form => (form?.fields || []).flatMap(field => field.type === "detailTable" ? (field.columns || []).map(column => ({ table: field, field: column })) : [{ field }]);

export {validateRemoteSelectorDecisions as validateApprovedRemoteDecisions} from "../dsl/remote-selector-contract.js";

// Immutable XML facts, not executable JavaScript. The wrapper must compare these
// independently rebuilt facts at trust time, just as it does the source contract.
export const approvedRemoteSelectorSourceFacts = template => selectorSourceFacts(template, false);
export const remoteSelectorOmissionSourceFacts = template => selectorSourceFacts(template, true);
function selectorSourceFacts(template = {}, omission) {
  const html = String(template.fdDisplayJsp || ""), markup = staticSourceMarkup(html), result = {};
  if (markup === undefined) return result;
  const metadata = parseMetadataXml(template.fdMetadataXml || "").fields;
  const contracts = remoteSelectorSourceContracts(template), bindings = [], anchors = [], inlineHandlers = [], cells = [], stack = [];
  for (const token of scanHtmlTags(markup)) {
    if (["td", "th"].includes(token.name)) {
      if (!token.closing) { const cell = { start: token.start, end: undefined }; cells.push(cell); stack.push(cell); }
      else { const cell = stack.pop(); if (cell) cell.end = token.end; }
    }
    if (token.closing) continue;
    const attrs = parseStaticMarkupAttributes(token.attrs); if (!attrs) continue;
    if (["xform:text", "input"].includes(token.name)) {
      const names = [attrs.get("property"), attrs.get("name")].filter(Boolean);
      for (const name of new Set(names)) if (name.startsWith("extendDataFormInfo.value(")) bindings.push({ name, token, attrs, cell: stack.at(-1) });
    }
    for(const [name,value]of attrs)if(/^on/i.test(name)||name==="href"&&/^javascript:/i.test(value))inlineHandlers.push({token,name,value});
    if (token.name === "a" && attrs.has("onclick")) anchors.push({ token, attrs, cell: stack.at(-1) });
  }
  for (const [identity, contract] of Object.entries(contracts)) {
    if (!(contract.kind === "REST" || omission && contract.kind === "SQL") || (!omission && contract.requestResource?.method !== "GET") || !(omission ? remoteOmissionContractEligible(contract) : contract.status === "static")) continue;
    const prefix = contract.tableId ? contract.tableId + ".!{index}." : "", primary = `extendDataFormInfo.value(${prefix}${contract.fieldId})`;
    const display = `extendDataFormInfo.value(${prefix}${contract.fieldId}_name)`, values = bindings.filter(binding => binding.name === primary), names = bindings.filter(binding => binding.name === display);
    if (values.length !== 1 || names.length !== 1 || values[0].cell !== names[0].cell || !values[0].cell?.end ||
        values[0].token.name !== "xform:text" || names[0].token.name !== "xform:text" || values[0].attrs.get("showstatus") !== "noShow" ||
        !/^\s*readOnly\s*=\s*(['"])readOnly\1\s*$/i.test(names[0].attrs.get("htmlelementproperties") || "")) continue;
    const links = anchors.filter(anchor => anchor.cell === values[0].cell);
    if (links.length !== 1) continue;
    let event;
    try { event = parse(links[0].attrs.get("onclick"), { ecmaVersion: "latest" }).body; } catch { continue; }
    const invocation = event.length === 1 && event[0].type === "ExpressionStatement" ? event[0].expression : undefined;
    if (invocation?.type !== "CallExpression" || invocation.callee.type !== "Identifier" || invocation.optional || invocation.arguments.length !== (contract.tableId ? 1 : 0) ||
        contract.tableId && invocation.arguments[0]?.value !== "!{index}") continue;
    // Require an actual authored generated selector with these two exact role
    // strings and a single Dialog_List invocation; never infer roles from suffix.
    const cell = values[0].cell, cellHtml = html.slice(cell.start, cell.end), scripts = [];
    for (const match of cellHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
      try { const ast = parse(match[1], { ecmaVersion: "latest" }); scripts.push({ ast, javascript: match[1], offset: cell.start + match.index + match[0].indexOf(match[1]) }); } catch { /* not a verified carrier */ }
    }
    const definitions = scripts.flatMap(script => script.ast.body.filter(node => node.type === "FunctionDeclaration" && node.id?.name === invocation.callee.name).map(node => ({ script, node })));
    if (definitions.length !== 1) continue;
    const { script, node } = definitions[0], strings = [], dialogs = [], declarations = [];
    walk(node.body, item => { if (item.type === "VariableDeclarator") declarations.push(item); if (item.type === "Literal" && typeof item.value === "string") strings.push(item.value); if (item.type === "CallExpression" && item.callee?.name === "Dialog_List") dialogs.push(item); });
    const sourcePrimary = primary.replace("!{index}", "!{indexFlag}"), sourceDisplay = display.replace("!{index}", "!{indexFlag}");
    const role = (argument, value) => argument?.type === "Literal" && argument.value === value || argument?.type === "Identifier" && declarations.filter(declaration => declaration.id?.name === argument.name && declaration.init?.type === "Literal" && declaration.init.value === value).length === 1;
    if (!strings.includes(sourcePrimary) || !strings.includes(sourceDisplay) || dialogs.length !== 1 || dialogs[0].arguments[0]?.value !== false || dialogs[0].arguments[3]?.value !== ";" || !role(dialogs[0].arguments[1], sourcePrimary) || !role(dialogs[0].arguments[2], sourceDisplay)) continue;
    const locators = declarations.filter(declaration => declaration.id?.name === "restApiPath" && declaration.init?.type === "Literal" && typeof declaration.init.value === "string");
    const closure=(omission?remoteSelectorOmissionScriptClosure:remoteSelectorScriptClosure)({javascript:script.javascript,selector:node,dialog:dialogs[0],contract});
    if (!closure || contract.kind === "REST" && locators.length !== 1) continue;
    const locator = contract.kind === "SQL" ? closure.queryLiteral : locators[0].init;
    if (omission) {
      const names=closure.functionNames;
      const referenced=text=>names.some(name=>new RegExp("(^|[^A-Za-z0-9_$])"+name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"([^A-Za-z0-9_$]|$)").test(text));
      const foreignScript=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].some(match=>rawHash(match[1].trim())!==closure.javascriptSha256&&referenced(match[1]));
      const duplicates=remoteSelectorOmissionDuplicateAnchors({html,contract,javascriptSha256:closure.javascriptSha256});
      closure.duplicateRowAnchors=duplicates;
      const owned=new Set([links[0].token.start,...duplicates.map(proof=>proof.anchorStart)]);
      const foreignAnchor=inlineHandlers.some(handler=>referenced(handler.value)&&!(handler.name==="onclick"&&owned.has(handler.token.start)));
      closure.foreignReferences=foreignScript||foreignAnchor;
    }
    const metadataDomain = contract.tableId ? metadata.filter(field => field.id === contract.tableId && field.type === "detailTable").flatMap(field => field.columns || []) : metadata.filter(field => field.type !== "detailTable");
    const displayMetadata = metadataDomain.filter(field => field.id === contract.fieldId + "_name");
    if (displayMetadata.length !== 1 || displayMetadata[0].type !== "text" || displayMetadata[0].source?.metadataAttributes?.type !== "String") continue;
    const fact = { version: 1, status: "verified", displayMetadata: { id: displayMetadata[0].id, title: displayMetadata[0].title, type: "String" }, fieldId: contract.fieldId, ...(contract.tableId ? { tableId: contract.tableId } : {}),
      sourceHashes: contract.sourceOrigin, runtimeLocatorSha256: closure.queryLiteral?.sha256 || rawHash(locators[0].init.value), runtimeLocatorAuthority: { sourceKey: "fdDisplayJsp", start: script.offset + locator.start, end: script.offset + locator.end, declarationSha256: rawHash(script.javascript.slice(locator.start, locator.end)) }, ...(contract.kind === "REST" && locators.length ? { runtimeRequest: { locatorSha256: rawHash(locators[0].init.value), locatorRef: "source-private:" + rawHash(locators[0].init.value), differsFromDesigner: rawHash(locators[0].init.value).slice(7) !== contract.requestResource.locatorSha256 } } : {}), primaryFieldId: contract.fieldId, displayFieldId: contract.fieldId + "_name",
      script: closure,
      ...(omission && contract.kind === "SQL" ? {missingOutputFields: contract.outputMappings.filter(m=>m.enabled!==false).map(m=>m.targetField).filter(id=>{const fieldId=id.split(".").at(-1);return !metadataDomain.some(f=>f.id===fieldId)&&![...scanHtmlTags(staticSourceMarkup(template.fdDesignerHtml)||"")].some(token=>!token.closing&&parseDesignerFdValues(token.attrs).id===fieldId)&&![...scanHtmlTags(markup)].some(token=>{if(token.closing)return false;const attrs=parseStaticMarkupAttributes(token.attrs);return attrs&&[attrs.get("property"),attrs.get("name")].some(value=>value===`extendDataFormInfo.value(${id})`);});})} : {}),
      bindings: [values[0], names[0]].map(binding => ({ start: binding.token.start, end: binding.token.end, sha256: rawHash(html.slice(binding.token.start, binding.token.end)), role: binding.name === primary ? "primary-hidden" : "display-readonly" })),
      selector: { start: script.offset + node.start, end: script.offset + node.end, sha256: rawHash(script.javascript.slice(node.start, node.end)), anchorStart: links[0].token.start, anchorEnd: links[0].token.end,
        anchorSha256: rawHash(html.slice(links[0].token.start, links[0].token.end)), selection: "single", separator: ";" } };
    result[identity] = { ...fact, digest: sha256Digest(fact) };
  }
  return result;
}

export function applyApprovedRemotePolicies(sourceDraft, baseDraft, decisions = []) {
  const validation = validateApprovedRemoteDecisions(decisions);
  if (!validation.ok) throw Object.assign(new Error("Invalid approved REST selector policy."), { diagnostics: validation.diagnostics });
  const draft = structuredClone(baseDraft), audits = [], changedActionIds = [];
  for (const decision of decisions) {
    const matches = entries(draft.form).filter(item => item.field.sourceRef === decision.sourceRef && item.field.sourceProps?.remoteSelectorSourceContract);
    const original = entries(sourceDraft.form && { fields: [ ...(sourceDraft.form.controls || []), ...(sourceDraft.form.dataFields || []), ...(sourceDraft.form.detailTables || []).map(table => ({ ...table, type: "detailTable" })) ] }).filter(item => item.field.sourceRef === decision.sourceRef);
    if (matches.length !== 1 || original.length !== 1) throw new Error("REST source identity is ambiguous or absent.");
    const { field, table } = matches[0], contract = field.sourceProps.remoteSelectorSourceContract, facts = field.sourceProps.approvedRemoteSelectorSourceFact;
    if (contract.kind !== "REST" || contract.requestResource?.method !== "GET" || contract.status !== "static" || sha256Digest(contract) !== decision.contractDigest || !facts || facts.status !== "verified" || facts.digest !== decision.runtimeFactDigest ||
      sha256Digest(Object.fromEntries(Object.entries(facts).filter(([key]) => key !== "digest"))) !== facts.digest || facts.fieldId !== field.id || facts.tableId !== table?.id ||
      contract.tableId !== table?.id || contract.fieldId !== field.id || canonicalJson(facts.sourceHashes) !== canonicalJson(contract.sourceOrigin) ||
      contract.selection?.multiSelect !== false || contract.selection.tree !== false || contract.selection.readOnlyText !== true || contract.selection.preload !== false ||
      Object.values(contract.callbacks || {}).some(callback => callback.present) || !word(contract.searchKey)) throw new Error("REST source contract/runtime role witness is stale, incomplete or outside the proved static single-select profile.");
    if (sourceDraft.migrationPolicies && sourceDraft.migrationPolicies.scope.baseUrl !== decision.scopeOrigin) throw new Error("REST resource origin differs from the authorized target.");
    const all = entries(draft.form);
    let displayTargets = all.filter(item => item.field.id === facts.displayFieldId && item.table?.id === table?.id);
    if (!table && displayTargets.length === 0 && facts.displayMetadata?.id === facts.displayFieldId && facts.displayMetadata.type === "String") {
      const restoredId = facts.displayFieldId.length <= 25 ? facts.displayFieldId : "fd_disp_" + rawHash(facts.displayFieldId).slice(7, 23);
      if (all.some(item => item.field.id === restoredId)) throw new Error("The XML-backed display identity collides with an existing target field.");
      const restored = { id: restoredId, title: field.title, type: "text", componentId: "xform-input", props: { readOnly: true }, generated: true, reason: "Preserve the uniquely exported readonly REST display String binding omitted by the legacy main-field projection.", sourceProps: { originalId: facts.displayFieldId, metadataId: facts.displayFieldId, metadataAttributes: { name: facts.displayFieldId, type: "String" }, approvedNativeLookupDisplay: { sourceRef: decision.sourceRef, runtimeFactDigest: facts.digest } } };
      draft.form.fields.splice(draft.form.fields.indexOf(field) + 1, 0, restored);
      const restoredEntry = { field: restored }; all.push(restoredEntry); displayTargets = [restoredEntry];
    }
    if (!word(field.id) || displayTargets.length !== 1 || !word(displayTargets[0].field.id) || !isStringField(field) || !isStringField(displayTargets[0].field) || field.componentId !== "xform-input") throw new Error("REST hidden primary/readonly display String bindings are not unique.");
    const display = displayTargets[0].field, columns = decision.response.columns.map(column => column.name), outputs = contract.outputMappings.filter(mapping => mapping.enabled !== false);
    if (outputs.length && facts.script?.emptyResult !== "clear-explicit-outputs") throw new Error("The supported clear-selection contract requires the source callback's explicit empty-result output clears.");
    if (outputs.some(mapping => !columns.includes(mapping.sourceColumn) || mapping.private) || contract.inputMappings.some(mapping => mapping.private)) throw new Error("Every REST source output and input must have a typed public mapping.");
    const resolve = identity => {
      const parts = identity.split("."), selected = all.filter(item => parts.length === 1 ? !item.table && item.field.id === identity : parts.length === 2 && item.table?.id === parts[0] && item.field.id === parts[1]);
      if (selected.length !== 1 || table && selected[0].table && selected[0].table !== table || !table && selected[0].table || !valueField(selected[0].field) || !isStringField(selected[0].field)) throw new Error("REST mapping has no unique main/current-row value binding.");
      return { tableId: selected[0].table?.id, fieldId: selected[0].field.id };
    };
    const requestedInputs = decision.request.inputParameters;
    if (requestedInputs.length !== contract.inputMappings.length || requestedInputs.some(mapping=>contract.inputMappings.filter(original=>original.parameterName===mapping.sourceParameter).length!==1)) throw new Error("Every XML input requires one explicit wire mapping.");
    const inputMappings = contract.inputMappings.map(mapping => ({ parameterName: requestedInputs.find(item=>item.sourceParameter===mapping.parameterName).targetParameter, ...resolve(mapping.sourceField) }));
    const sourceScripts = (sourceDraft.scripts?.sources || []).filter(source=>rawHash(source.javascript)===facts.script?.javascriptSha256);
    if (!facts.script?.soleSelector || sourceScripts.length!==1) throw new Error("The public REST profile requires one closed verified selector dependency unit; unproved callbacks and prerequisite statements remain blocked.");
    const sourceScriptRef=sourceScripts[0].sourceRef||sourceScripts[0].id, previousActions=(draft.scripts?.actions||[]).filter(action=>action.sourceRefs?.includes(sourceScriptRef));
    if (!previousActions.length || previousActions.some(action=>action.sourceRefs.length!==1)) throw new Error("Only actions belonging exclusively to the verified closed source selector unit may be replaced.");
    const outputMappings = [ { sourceColumn: decision.response.valueColumn, tableId: table?.id, fieldId: field.id }, { sourceColumn: decision.response.labelColumn, tableId: table?.id, fieldId: display.id },
      ...outputs.map(mapping => ({ sourceColumn: mapping.sourceColumn, ...resolve(mapping.targetField) })) ];
    // Preserve source order when a later explicit mapping also writes the primary
    // or display binding, rather than silently deduplicating the source effects.
    const buttonId = "fd_pick_" + rawHash(decision.sourceRef).slice(7, 23), actionId = "policy.remote." + buttonId;
    if (all.some(item => item.field.id === buttonId) || draft.scripts?.actions?.some(action => action.id === actionId)) throw new Error("REST generated entrance collides with an existing identity.");
    const button = { id: buttonId, title: "选择" + field.title, type: "button", componentId: "xform-button", props: { hiddenLabel: true }, generated: true,
      reason: "Explicit approved server-side native REST selector entrance.", sourceProps: { approvedNativeLookup: { sourceRef: decision.sourceRef, contractDigest: decision.contractDigest, runtimeFactDigest: facts.digest, serverSemanticDigest: decision.server.semanticDigest } } };
    const oldDisplayIndex = table?.columns.indexOf(display);
    const required=field.props.required===true;
    field.dataOnly = true; field.props = { ...field.props, required:false, readOnly: true };
    display.dataOnly = false; display.title = field.title; display.props = { ...display.props, required, readOnly: true };
    if (field.sourceProps?.designerValues?.width !== undefined) display.sourceProps = { ...display.sourceProps, designerValues: { ...display.sourceProps.designerValues, width: field.sourceProps.designerValues.width } };
    if (field.sourceProps?.detailHeaderCaption) display.sourceProps = { ...display.sourceProps, detailHeaderCaption: structuredClone(field.sourceProps.detailHeaderCaption) };
    if (table) { table.columns.splice(oldDisplayIndex, 1); table.columns.splice(table.columns.indexOf(field) + 1, 0, display, button); }
    else { draft.form.fields.splice(draft.form.fields.indexOf(display) + 1, 0, button); replaceLayoutReference(draft.form.layout, field.id, display.id, button.id); }
    const functionText = nativeRemoteSelectorFunction({ title: field.title, tableId: table?.id, sourceRef: decision.sourceRef, server: decision.server, response: decision.response, request: decision.request, wireEvidenceSha256: decision.wireEvidenceSha256, inputMappings, outputMappings });
    const action = { id: actionId, name: "onClick", event: "onClick", scope: "control", controlId: buttonId, ...(table ? { tableId: table.id } : {}),
      runWhen: { viewStatusIn: ["add", "edit"] }, function: functionText, sourceRefs: [sourceScriptRef], sourceActionKey: sourceScriptRef + "#approved-native-selector",
      translationStatus: "mapped", coverage: { status: "translated", nativeRules: [], residuals: [] }, functionMappings: [{ source: "Source REST selector", target: "Approved native TIC selector", basis: "approved-native-lookup-pending-wrapper", reviewRequired: true }],
      semanticHints: { approvedNativeLookup: { sourceRef:decision.sourceRef, decisionId: decision.id, contractDigest: decision.contractDigest, runtimeFactDigest: facts.digest, serverSemanticDigest: decision.server.semanticDigest } } };
    draft.scripts ||= { actions: [] }; draft.scripts.actions = (draft.scripts.actions||[]).filter(candidate=>!previousActions.includes(candidate)); draft.scripts.actions.push(action); changedActionIds.push(action.id);
    audits.push({ kind: KIND, decisionId: decision.id, actionId: action.id, sourceRef: decision.sourceRef, contractDigest: decision.contractDigest, runtimeFactDigest: facts.digest,
      sourceDeclarations: structuredClone(contract.declarations), sourceRuntimeBindings: structuredClone(facts.bindings), sourceSelector: structuredClone(facts.selector),
      sourceOrigin: structuredClone(contract.sourceOrigin), sourceScript: {sourceRef:sourceScriptRef,javascriptSha256:facts.script.javascriptSha256}, request: structuredClone(decision.request), response:structuredClone(decision.response), wireEvidenceSha256:decision.wireEvidenceSha256, ...(facts.runtimeRequest ? { runtimeRequest: structuredClone(facts.runtimeRequest) } : {}), server: structuredClone(decision.server), functionSha256: rawHash(functionText),
      addedField: { tableId: table?.id, fieldId: buttonId, afterFieldId: display.id }, primaryFieldId: field.id, displayFieldId: display.id, inputMappings, outputMappings,
      changedActionIds: [action.id], addedActions: [action.id], removedActions: previousActions.map(item=>item.id), queryOnMount: false, cancelWrites: 0, errorWrites: 0 });
  }
  return { draft, audits, changedActionIds };
}



function valueField(field) { return !["detailTable", "button", "description", "attachment"].includes(field.type) && field.componentId !== "xform-button"; }
function isStringField(field) { return ["text", "longText"].includes(field.type) && field.sourceProps?.metadataAttributes?.type === "String"; }
function replaceLayoutReference(layout, from, display, button) {
  walk(layout, node => {
    if (Array.isArray(node.refIds) && node.refIds.includes(from)) { node.refIds = node.refIds.flatMap(id => id === from ? [display, button] : [id]); node.keepInline=true; }
    if (Array.isArray(node.items)) node.items=node.items.flatMap(item=>item.referenceId===from?[{...item,referenceId:display},{referenceId:button}]:[item]);
    if (Array.isArray(node.references)) node.references = node.references.flatMap(ref => ref.referenceId === from ? [{ ...ref, referenceId: display }, { referenceType: "control", referenceId: button }] : [ref]);
    if (node.referenceId === from) node.referenceId = display;
    if (Array.isArray(node.lines)) node.lines = node.lines.map(line => line.flatMap(id => id === from ? [display, button] : [id]));
  });
}
function walk(node, fn) { if (!node || typeof node !== "object") return; fn(node); for (const value of Object.values(node)) Array.isArray(value) ? value.forEach(child => walk(child, fn)) : walk(value, fn); }
