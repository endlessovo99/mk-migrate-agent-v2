import { buildNativeImportCalculationSpec } from "./native-import-calculations.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "../agent-review/digest.js";
import { parse } from "acorn";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";
import { legacyExcelImportDescriptor } from "./legacy-detail-excel-import.js";
import { detailMainRowLifecycleCandidates } from "./detail-main-row-lifecycle.js";
import { nativeDetailImportFunction, NATIVE_DETAIL_IMPORT_PROFILE, NATIVE_DETAIL_IMPORT_CALCULATION_PROFILE, NATIVE_IMPORT_CALCULATION_POLICY_PROFILE } from "./native-detail-import-runtime.js";
import { scanHtmlTags } from "./designer-html-tokenizer.js";
import { parseStaticMarkupAttributes, staticSourceMarkup } from "./source-static-markup.js";
import { inspectLegacyDetailControlTarget, legacyControlAliases } from "./detail-control-target.js";

const KIND = "native-detail-import-replace";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const digest = text => "sha256:" + createHash("sha256").update(String(text)).digest("hex");
const text = value => typeof value === "string" && value.trim() === value && value.length > 0;
const record = value => value && typeof value === "object" && !Array.isArray(value);
const exact = (value, allowed, required = allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
const error = (code, message, details) => ({ level: "error", code, message, ...(details ? { details } : {}) });
export const approvedImportSourceJavascriptDigest = source => digest(source?.javascript || "");

export function validateApprovedImportDecisions(decisions) {
  const diagnostics = [], ids = new Set();
  if (!Array.isArray(decisions)) return { ok: false, diagnostics: [error("migration.policy.import.invalid", "Import decisions must be an array.")] };
  for (const decision of decisions) {
    const required = ["id", "kind", "tableId", "sourceActionId", "sourceRef", "sourceDeclarationSha256", "newTemplateOnly", "legacyFiles", "mode"];
    let valid = exact(decision, [...required, "retiredUnboundSlots", "retireUnboundMainWrites", "downloadFieldSourceRef", "calculationProfile"], required) &&
      ["id", "tableId", "sourceActionId", "sourceRef"].every(key => text(decision[key])) && decision.kind === KIND &&
      DIGEST.test(decision.sourceDeclarationSha256) && decision.newTemplateOnly === true && decision.legacyFiles === "reject" && decision.mode === "replace";
    if (decision?.calculationProfile !== undefined) valid &&= decision.calculationProfile === NATIVE_IMPORT_CALCULATION_POLICY_PROFILE;
    if (decision?.downloadFieldSourceRef !== undefined) valid &&= text(decision.downloadFieldSourceRef);
    if (decision?.retiredUnboundSlots !== undefined) valid &&= Array.isArray(decision.retiredUnboundSlots) && decision.retiredUnboundSlots.every(slot =>
      exact(slot, ["fieldId", "sourceSlot"]) && text(slot.fieldId) && Number.isInteger(slot.sourceSlot) && slot.sourceSlot >= 0) &&
      new Set(decision.retiredUnboundSlots.map(slot => slot.sourceSlot)).size === decision.retiredUnboundSlots.length;
    if (decision?.retireUnboundMainWrites !== undefined) valid &&= Array.isArray(decision.retireUnboundMainWrites) && decision.retireUnboundMainWrites.every(item =>
      exact(item, ["fieldId", "sourceActionId", "callRanges"]) && text(item.fieldId) && text(item.sourceActionId) &&
      Array.isArray(item.callRanges) && item.callRanges.length > 0 && item.callRanges.every(range => exact(range, ["start", "end", "sha256"]) &&
        Number.isInteger(range.start) && range.start >= 0 && Number.isInteger(range.end) && range.end > range.start && DIGEST.test(range.sha256))) &&
      new Set(decision.retireUnboundMainWrites.map(item => item.fieldId + "\0" + item.sourceActionId)).size === decision.retireUnboundMainWrites.length;
    if (!valid || ids.has(decision?.id)) diagnostics.push(error("migration.policy.import.invalid", "Import policy has unknown, missing, duplicated or unsupported fields."));
    if (text(decision?.id)) ids.add(decision.id);
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

export function applyApprovedImportPolicies(sourceDraft, draft, decisions) {
  const result = { draft: structuredClone(draft), audits: [], changedActionIds: [] };
  const validation = validateApprovedImportDecisions(decisions);
  if (!validation.ok) return { ...result, audits: [{ kind: KIND, status: "rejected", diagnostics: validation.diagnostics, actions: [] }] };
  for (const decision of decisions) {
    const audit = { decisionId: decision.id, kind: KIND, status: "blocked", sourceRef: decision.sourceRef,
      changedActionIds: [], actions: [], diagnostics: [] };
    result.audits.push(audit);
    const sources = (sourceDraft?.scripts?.sources || []).filter(source => (source.sourceRef || source.id) === decision.sourceRef);
    const actions = (draft?.scripts?.actions || []).filter(action => action.id === decision.sourceActionId);
    const tables = (draft?.form?.fields || []).filter(field => field.type === "detailTable" &&
      [field.id, field.sourceProps?.originalId].includes(decision.tableId));
    const source = sources.length === 1 ? sources[0] : undefined;
    const descriptor = source && legacyExcelImportDescriptor(source, draft.form);
    audit.sourceJavascriptSha256 = source && approvedImportSourceJavascriptDigest(source);
    if (!source || actions.length !== 1 || !actions[0].sourceRefs?.includes(decision.sourceRef) || tables.length !== 1 ||
        descriptor?.tableId !== decision.tableId || decision.sourceDeclarationSha256 !== audit.sourceJavascriptSha256) {
      audit.status = "rejected"; audit.diagnostics.push(error("migration.policy.import.source_mismatch", "Import policy must match one original source declaration, action and table.")); continue;
    }
    const retired = decision.retiredUnboundSlots || [];
    if (retired.some(slot => descriptor.columnSlots[slot.sourceSlot] !== slot.fieldId || hasSourceBinding(sourceDraft, draft, slot.fieldId)) ||
        descriptor.missingFieldIds.some(fieldId => !retired.some(slot => slot.fieldId === fieldId))) {
      audit.status = "rejected"; audit.diagnostics.push(error("migration.policy.import.slot_mismatch", "Only explicitly approved genuinely unbound source slots may retire.")); continue;
    }
    audit.originalColumnSlots = descriptor.columnSlots;
    audit.retiredUnboundSlots = structuredClone(retired);
    audit.proposedNativeTemplateFieldIds = tables[0].columns.map(column => column.id);
    audit.legacyFileConversion = "not-implemented-or-attempted";
    const native = decision.downloadFieldSourceRef && applyNativeImport(sourceDraft, result.draft, decision, source, descriptor, tables[0]);
    if (native?.ok) {
      audit.status = "applied"; audit.nativeImport = native.audit;
      audit.proposedNativeTemplateFieldIds = native.audit.importFieldIds;
      for (const id of native.changedActionIds) { audit.changedActionIds.push(id); result.changedActionIds.push(id); }
      audit.actions.push(...native.actions);
    } else audit.diagnostics.push(native?.diagnostic || error("migration.policy.import.native_replace_unproven",
      "Native confirmed replacement requires a source-bound click entrance, explicit new-template download field and the proved non-calculated native form profile."));
    for (const retirement of decision.retireUnboundMainWrites || []) {
      const change = retireMainWrites(sourceDraft, result.draft, retirement);
      if (!change.ok) { audit.diagnostics.push(change.diagnostic); continue; }
      const index = result.draft.scripts.actions.findIndex(action => action.id === retirement.sourceActionId);
      result.draft.scripts.actions[index] = change.action;
      audit.changedActionIds.push(change.action.id); audit.actions.push(change.audit);
      result.changedActionIds.push(change.action.id);
    }
  }
  return result;
}

function retireMainWrites(sourceDraft, draft, decision) {
  const fail = message => ({ ok: false, diagnostic: error("migration.policy.import.retirement_unproven", message, { actionId: decision.sourceActionId }) });
  const actions = (draft.scripts?.actions || []).filter(action => action.id === decision.sourceActionId);
  if (actions.length !== 1 || actions[0].event !== "onChange" || actions[0].translationStatus !== "needs_review" || hasSourceBinding(sourceDraft, draft, decision.fieldId))
    return fail("Retirement requires one pending onChange action and an unbound source identity.");
  const action = actions[0], refs = action.sourceRefs || [];
  const sources = (sourceDraft.scripts?.sources || []).filter(source => refs.includes(source.sourceRef || source.id));
  if (refs.length !== 1 || sources.length !== 1) return fail("Retirement source action binding is ambiguous.");
  const source = sources[0], javascript = String(source.javascript || ""); let program;
  try { program = parse(javascript, { ecmaVersion: "latest" }); } catch { return fail("The original authored callback is not parseable."); }
  const bindings = buildJavaScriptBindingModel(javascript), statements = program.body.filter(node => node.type !== "EmptyStatement");
  const call = statements.length === 1 && statements[0].type === "ExpressionStatement" ? statements[0].expression : undefined;
  const callback = call?.arguments?.[1], triggerId = call?.arguments?.[0]?.value;
  if (!bindings.ok || call?.type !== "CallExpression" || call.optional || call.callee?.name !== "AttachXFormValueChangeEventById" ||
      !bindings.isUnshadowedGlobal(call.callee.name, call.start) || callback?.type !== "FunctionExpression" || callback.async || callback.generator ||
      callback.params[0]?.type !== "Identifier" || callback.body?.type !== "BlockStatement") return fail("Only one direct source-bound detail callback may retire literal stores.");
  const detail = inspectLegacyDetailControlTarget(draft.form, triggerId);
  if (detail.status !== "resolved" || detail.column.type !== "singleSelect" || detail.column.componentId !== "xform-select") return fail("Retirement must retain a unique detail select event.");
  let valid = true, conditions = 0; const removed = [];
  walk(callback.body, (node, parent) => {
    if (node.type === "IfStatement") {
      conditions += 1; const test = node.test, name = callback.params[0].name;
      const value = test?.left?.name === name ? test.right : test?.right?.name === name ? test.left : undefined;
      if (test?.type !== "BinaryExpression" || !["==", "==="].includes(test.operator) || value?.type !== "Literal" ||
          !(typeof value.value === "number" && Number.isFinite(value.value) && value.value !== 0 || typeof value.value === "string" && value.value !== "" && Number(value.value) !== 0)) valid = false;
    }
    if (node.type !== "CallExpression" || node.callee?.name !== "SetXFormFieldValueById" || node.arguments?.[0]?.value !== decision.fieldId) return;
    if (node.optional || node.arguments.length !== 2 || parent?.type !== "ExpressionStatement" || parent.expression !== node ||
        !bindings.isUnshadowedGlobal(node.callee.name, node.start) || node.arguments[1]?.type !== "Literal" ||
        !(typeof node.arguments[1].value === "string" || typeof node.arguments[1].value === "number" && Number.isFinite(node.arguments[1].value))) { valid = false; return; }
    removed.push({ start: parent.start, end: parent.end, sha256: digest(javascript.slice(parent.start, parent.end)) });
  });
  const ordered = ranges => [...ranges].sort((a, b) => a.start - b.start);
  if (!valid || !conditions || !removed.length || canonicalJson(ordered(removed)) !== canonicalJson(ordered(decision.callRanges))) return fail("Retirement ranges must cover exactly the approved standalone literal stores.");
  const normalized = [...removed].sort((a, b) => b.start - a.start).reduce((current, range) => current.slice(0, range.start) + ";" +
    current.slice(range.start + 1, range.end).replace(/[^\r\n]/g, " ") + current.slice(range.end), javascript);
  const candidates = detailMainRowLifecycleCandidates({ ...source, javascript: normalized }, draft.form, sourceDraft.scripts);
  const selected = candidates.filter(candidate => candidate.event === action.event && candidate.sourceActionKey === action.sourceActionKey);
  if (selected.length !== 1) return fail("The complete retained callback cannot be compiled without extra changes.");
  const candidate = selected[0], changed = { ...action, function: candidate.function, scope: candidate.scope, tableId: candidate.tableId,
    controlId: candidate.controlId, translationStatus: "mapped", coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{ source: "Explicit approved retirement of unbound literal auxiliary stores", target: "Retained source Number comparisons and row effects", basis: "approved-import-policy-pending-wrapper", reviewRequired: true }],
    semanticHints: { ...candidate.semanticHints, coveredCalculationRanges: [{ sourceRef: refs[0], name: "approvedUnboundMainWriteRetirement", start: call.start, end: call.end }] } };
  delete changed.deterministicBranchProof;
  return { ok: true, action: changed, audit: { actionId: action.id, status: "applied", sourceRef: refs[0], sourceJavascriptSha256: digest(javascript),
    normalizedJavascriptSha256: digest(normalized), retiredFieldId: decision.fieldId, removedCallRanges: removed,
    coveredRanges: [{ sourceRef: refs[0], start: call.start, end: call.end, sha256: digest(javascript.slice(call.start, call.end)) }],
    retainedFunctionSha256: digest(candidate.function), addedActions: [], removedActions: [] } };
}
function hasSourceBinding(source, draft, id) {
  const fields = [ ...(source.form?.controls || []), ...(source.form?.dataFields || []),
    ...(source.form?.detailTables || []).flatMap(table => [table, ...(table.columns || [])]),
    ...(draft.form?.fields || []).flatMap(field => [field, ...(field.columns || [])]) ];
  return fields.some(field => [field.id, field.sourceProps?.designerId, field.sourceProps?.metadataId, field.sourceProps?.originalId, ...legacyControlAliases(field)].includes(id));
}
function walk(node, fn, parent) { if (!node || typeof node !== "object") return; fn(node, parent); for (const [key, value] of Object.entries(node)) {
  if (["start", "end", "raw"].includes(key)) continue; if (Array.isArray(value)) value.forEach(child => walk(child, fn, node)); else walk(value, fn, node);
} }


export function approvedNativeImportSourceWitness(sourceDraft, decision) {
  const source = (sourceDraft.scripts?.sources || []).filter(source => (source.sourceRef || source.id) === decision.sourceRef);
  if (source.length !== 1 || source[0].sourceType !== "designer-jsp" || source[0].displayGate !== "xform:editShow") return undefined;
  const fragments = (sourceDraft.scripts?.fragments || []).filter(fragment => fragment.id === source[0].fragmentId);
  if (fragments.length !== 1) return undefined;
  const fragment = fragments[0], markup = staticSourceMarkup(fragment.content || "");
  const normalizedScript = value => String(value).replace(/\r\n/g, "\n").trim();
  const scriptMatches = [...String(fragment.content || "").matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].filter(match => normalizedScript(match[1]) === normalizedScript(source[0].javascript));
  if (scriptMatches.length !== 1) return undefined;
  if (markup === undefined) return undefined;
  const buttons = [];
  for (const tag of scanHtmlTags(markup)) {
    if (tag.closing) continue;
    const attrs = parseStaticMarkupAttributes(tag.attrs); if (!attrs) continue;
    const events = [...attrs.keys()].filter(name => name.startsWith("on"));
    if (!events.length) continue;
    if (events.length !== 1 || events[0] !== "onclick") return undefined;
    let program; try { program = parse(attrs.get("onclick"), { ecmaVersion: "latest" }); } catch { return undefined; }
    const statements = program.body.filter(node => node.type !== "EmptyStatement"), call = statements[0]?.expression;
    if (statements.length !== 1 || call?.type !== "CallExpression" || call.optional || call.callee?.type !== "Identifier" || call.callee.name !== "importExcel" || call.arguments.length) return undefined;
    buttons.push({ start: tag.start, end: tag.end, sha256: digest(fragment.content.slice(tag.start, tag.end)), tagName: tag.name });
  }
  if (buttons.length !== 1 || !closedLegacyImportSource(source[0].javascript)) return undefined;
  const links = [...(sourceDraft.form?.controls || []), ...(sourceDraft.form?.dataFields || [])].filter(field => field.sourceRef === decision.downloadFieldSourceRef);
  if (links.length !== 1 || String(links[0].sourceProps?.designerType || "").toLowerCase() !== "linklabel") return undefined;
  return { version: 1, sourceRef: decision.sourceRef, sourceJavascriptSha256: digest(source[0].javascript), fragmentSourceRef: fragment.sourceRef,
    fragmentSha256: digest(fragment.content), sourceButton: buttons[0], downloadFieldSourceRef: decision.downloadFieldSourceRef,
    sourceDownloadDeclarationSha256: digest(canonicalJson(links[0].sourceProps)), emptyArray: "clear", nullOrUndefined: "retain" };
}

function applyNativeImport(sourceDraft, draft, decision, source, descriptor, originalTable) {
  const fail = (code, message) => ({ ok: false, diagnostic: error(code, message) });
  const witness = approvedNativeImportSourceWitness(sourceDraft, decision), origin = sourceDraft.migrationPolicies?.scope?.baseUrl;
  if (!witness || !origin) return fail("migration.policy.import.native_source_unproven", "The native import needs an exact source click/download witness and authorized target origin.");
  let parsed; try { parsed = new URL(origin); } catch { return fail("migration.policy.import.native_source_unproven", "Invalid target origin."); }
  if (parsed.origin !== origin || !["https:", "http:"].includes(parsed.protocol)) return fail("migration.policy.import.native_source_unproven", "Invalid target root origin.");
  const table = draft.form.fields.find(field => field.id === originalTable.id), download = draft.form.fields.filter(field => field.sourceRef === decision.downloadFieldSourceRef);
  const hasFormula = field => field.props?.formula !== undefined || field.props?.calculation !== undefined || field.type === "calculation" ||
    (field.columns || []).some(hasFormula);
  let calculationPlan;
  const calculated = draft.form.fields.some(hasFormula);
  if (calculated && decision.calculationProfile === NATIVE_IMPORT_CALCULATION_POLICY_PROFILE) {
    try { calculationPlan = buildNativeImportCalculationSpec(draft, table.id, sourceDraft); } catch (cause) {
      return fail("migration.policy.import.native_calculation_unproven", cause.message);
    }
  }
  if (download.length !== 1 || download[0].type !== "description" || calculated && !calculationPlan || !calculated && decision.calculationProfile !== undefined || (draft.formRules?.calculations || []).length || table.props?.popup === true || table.columns.some(field => field.type === "detailTable"))
    return fail("migration.policy.import.native_formula_unproven", "The first native import profile requires one source-backed link and an ordinary form without calculation columns, nested or popup details.");
  const retired = new Set((decision.retiredUnboundSlots || []).map(slot => slot.sourceSlot)), selected = [...new Set(descriptor.columnSlots.filter((id, index) => id && !retired.has(index)))];
  const columns = selected.map(id => table.columns.filter(column => [column.id, ...legacyControlAliases(column)].includes(id)));
  if (!columns.length || columns.some(matches => matches.length !== 1) || new Set(columns.map(matches => matches[0].id)).size !== columns.length ||
      columns.some(([field]) => !["text", "longText", "number", "date", "dateTime", "singleSelect", "radio"].includes(field.type) || field.componentId === "xform-address"))
    return fail("migration.policy.import.native_field_unproven", "Every retained source import slot must resolve to one supported primitive native column; organization identities are not inferred from names.");
  const fields = columns.map(([column]) => ({ id: column.id, title: column.title, required: column.props?.required === true })), field = download[0];
  const action = draft.scripts.actions.find(action => action.id === decision.sourceActionId);
  const nodes = []; walk(draft.form.layout?.mkTree, node => { if (Array.isArray(node.refIds) && node.refIds.includes(field.id)) nodes.push(node); });
  if (nodes.length !== 1) return fail("migration.policy.import.native_layout_unproven", "The source download link must own one retained native layout cell.");
  const spec = { targetOrigin: origin, tableId: table.id, fields, allFieldIds: table.columns.map(column => column.id), maxPolls: 300,
    systemFieldNames: ["fd_id", "fd_main_id", "fd_parent_id", "fd_order", "fd_creator", "fd_create_time", "fd_alter", "fd_alter_time"],
    ...(calculationPlan ? { calculationPlan } : {}) };
  const profile = calculationPlan ? NATIVE_DETAIL_IMPORT_CALCULATION_PROFILE : NATIVE_DETAIL_IMPORT_PROFILE;
  // One source-backed native entrance owns both capabilities. The source LinkLabel
  // witness remains a field fact, never an invented authored JavaScript range.
  const originalFieldId = field.id;
  field.type = "button"; field.componentId = "xform-button"; field.title = "Excel导入"; field.props = { hiddenLabel: true };
  const covered = [{ sourceRef: decision.sourceRef, name: "approvedNativeImportSource", start: 0, end: source.javascript.length },
    ...(calculationPlan?.currencyEffects || []).flatMap(effect => effect.coveredCalculationRanges)];
  const configure = (target, entry, controlId) => {
    target.name = target.event = "onClick"; target.scope = "control"; target.controlId = controlId; delete target.tableId;
    target.function = nativeDetailImportFunction(spec, entry); target.translationStatus = "mapped";
    target.sourceRefs = [...new Set([decision.sourceRef, ...(calculationPlan?.currencyEffects || []).map(effect => effect.sourceRef)])]; target.sourceActionKey = decision.sourceRef + "#approved-native-" + entry;
    target.coverage = { status: "translated", nativeRules: [], residuals: [] };
    target.functionMappings = [{ source: "Explicit native new-template replacement policy", target: "Native upload, parser, preview and confirmation", basis: "approved-import-policy-pending-wrapper", reviewRequired: true }];
    target.semanticHints = { coveredCalculationRanges: covered, approvedNativeImport: { profile, entry, decisionId: decision.id, witnessSha256: digest(canonicalJson(witness)), noCalculatedFields: !calculationPlan,
      ...(calculationPlan ? { calculationProfile: NATIVE_IMPORT_CALCULATION_POLICY_PROFILE, calculationPlanSha256: digest(canonicalJson(calculationPlan)) } : {}) } };
    delete target.deterministicBranchProof; delete target.branchProvenance;
  };
  configure(action, "import", originalFieldId); action.runWhen = { viewStatusIn: ["add", "edit"] };
  const changedActionIds = [action.id], actions = [{ actionId: action.id, status: "applied", sourceRef: decision.sourceRef,
    sourceJavascriptSha256: digest(source.javascript), coveredRanges: covered.map(range => ({ ...range, sha256: digest((sourceDraft.scripts.sources.find(item => item.sourceRef === range.sourceRef)?.javascript || "").slice(range.start, range.end)) })),
    retainedFunctionSha256: digest(action.function), addedActions: [], removedActions: [] }];
  return { ok: true, changedActionIds, actions, audit: { profile, witness, ...(calculationPlan ? { calculationPlan, calculationPlanSha256: digest(canonicalJson(calculationPlan)) } : {}), importFieldIds: fields.map(field => field.id), retainedTableFieldIds: table.columns.map(field => field.id),
    nativeEntranceFieldId: originalFieldId, downloadCapability: "inside-native-import-modal", presentationChange: "The original template-link cell hosts the source-backed import entrance; new-template download is inside the same native modal.", newTemplateDownload: "native-exportDetailTemplate", parser: "native-asyncImportDetailData", mode: "confirmed-replace", emptyArray: "clear", nullOrError: "retain",
    originalSourceFormatConverted: false, legacyParserEnabled: false, allLegacyFilesRejectionProven: false,
    compatibilityBoundary: "Only native-export/native-parser format is supported. No positional legacy conversion or fallback is implemented; a structurally native-compatible old file is not distinguished by its historical origin.",
    ambientContext: "public-getFormConfigs + getFormValues._dynamicProps.mechanisms.sys-xform.dynamicProps", nativeSystemReservedName: "mechanisms", formulaProfile: calculationPlan ? NATIVE_IMPORT_CALCULATION_POLICY_PROFILE : "none" } };
}

function closedLegacyImportSource(javascript) {
  let program; try { program = parse(javascript, { ecmaVersion: "latest" }); } catch { return false; }
  const body = program.body.filter(node => node.type !== "EmptyStatement"), declarations = body.filter(node => node.type === "FunctionDeclaration");
  if (body.length !== 4 || declarations.length !== 3 || !["importExcel", "parsingExcelContent", "_DocList_AddRows"].every(name => declarations.filter(node => node.id.name === name).length === 1)) return false;
  const first = body.find(node => node.type === "VariableDeclaration"), variable = first?.declarations[0];
  if (!variable || first.declarations.length !== 1 || variable.id.name !== "ImportExcel_Parameter" || variable.init?.type !== "NewExpression" || variable.init.callee?.name !== "Array" || variable.init.arguments.length) return false;
  const importer = declarations.find(node => node.id.name === "importExcel"), importNames = ["startRowNo", "startCellNo", "detailTableId", "detailControlIds"], declaredNames = [];
  if (importer.params.length || importer.async || importer.generator) return false;
  for (const statement of importer.body.body) {
    if (statement.type === "VariableDeclaration") {
      for (const item of statement.declarations) { if (item.id.type !== "Identifier" || !importNames.includes(item.id.name) || item.init?.type !== "Literal") return false; declaredNames.push(item.id.name); }
    } else if (statement.type !== "ExpressionStatement" || statement.expression?.type !== "CallExpression" || statement.expression.callee?.name !== "parsingExcelContent" || statement.expression.arguments.length !== 4 || statement.expression.arguments.some((argument, index) => argument.name !== importNames[index])) return false;
  }
  if (declaredNames.length !== 4 || new Set(declaredNames).size !== 4) return false;
  const helper = declarations.find(node => node.id.name === "_DocList_AddRows"), parser = declarations.find(node => node.id.name === "parsingExcelContent");
  const expectedHelper = parse(`function _DocList_AddRows(detailTableId, rowsCtrlValue) { var optTB=document.getElementById("TABLE_DL_"+detailTableId);var tbInfo=DocList_TableInfo[optTB.id];for(var i=tbInfo.lastIndex-1;i>0;i--){optTB.deleteRow(i);tbInfo.lastIndex--;for(var j=i;j<tbInfo.lastIndex;j++){DocListFunc_RefreshIndex(tbInfo,j);}}for(var i=0;i<rowsCtrlValue.length;i++){DocList_AddRow(optTB,null,rowsCtrlValue[i]);}}`, { ecmaVersion: "latest" }).body[0];
  const statements = parser.body.body, guard = statements.at(-1);
  if (statements.length !== 6 || guard?.type !== "IfStatement" || guard.test?.type !== "BinaryExpression" || guard.test.operator !== "!=" || guard.test.left?.name !== "excelContent" || guard.test.right?.value !== null ||
      guard.alternate || guard.consequent.body?.length !== 1 || guard.consequent.body[0].expression?.callee?.name !== "_DocList_AddRows") return false;
  // The approved replacement retires only this complete generated modal parser,
  // not arbitrary authored sibling effects. Match the remaining AST exactly.
  const expectedParser = parse(`function parsingExcelContent(startRowNo,startCellNo,detailTableId,detailControlIds){var parsingContent=new Array(detailTableId,detailControlIds,startRowNo,startCellNo);var params=new Array(detailTableId,detailControlIds,startRowNo,startCellNo);var style="dialogWidth:650px; dialogHeight:350px; status:0;scroll:0; help:0; resizable:1";var excelContent;if(window.showModalDialog){excelContent=window.showModalDialog(Com_Parameter.ContextPath+"km/review/km_review_detail_excel/kmReviewDetailImport_excel.jsp",params,style);}else{ImportExcel_Parameter=params;excelContent=window.open(Com_Parameter.ContextPath+"km/review/km_review_detail_excel/kmReviewDetailImport_excel.jsp",params,style);}if(excelContent!=null){_DocList_AddRows(detailTableId,excelContent);}}`, { ecmaVersion: "latest" }).body[0];
  const normalized = structuredClone(parser); if (normalized.body.body[3]?.declarations?.[0]?.init?.value === "") normalized.body.body[3].declarations[0].init = null;
  return canonicalJson(astValue(helper)) === canonicalJson(astValue(expectedHelper)) && canonicalJson(astValue(normalized)) === canonicalJson(astValue(expectedParser));
}
function astValue(node) { if (Array.isArray(node)) return node.map(astValue); if (!node || typeof node !== "object") return node; return Object.fromEntries(Object.entries(node).filter(([key]) => !["start", "end", "raw"].includes(key)).map(([key, value]) => [key, astValue(value)])); }
