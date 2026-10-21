import {parse} from "acorn";
import {createHash} from "node:crypto";
import {canonicalJson, sha256Digest} from "../agent-review/digest.js";
import {compileLegacyDetailProgramIR} from "./legacy-detail-program-ir.js";
import {detailControlDisplayProof, buildDetailRowControlStateFunction} from "./detail-row-control-state.js";
import {detailRowSourceEffectResiduals} from "../dsl/source-detail-row-effects.js";
import {createDetailInlineHandlerProof} from "./detail-inline-handler-proof.js";

export const SUPPORTED_DETAIL_STATE_KIND = "native-detail-state-supported-only";
export const DETAIL_STATE_OMISSIONS = Object.freeze([
  "dynamic-placeholder", "legacy-dom-wrapper-visibility", "source-click-dispatch",
  "source-row-lifecycle", "source-load-reconciliation", "source-helper-validation-restoration"
]);
const digest = /^sha256:[a-f0-9]{64}$/;
const ref = source => source.sourceRef || source.id;
const sourceHash = value => "sha256:" + createHash("sha256").update(value).digest("hex");
const equal = (left, right) => canonicalJson(left) === canonicalJson(right);
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = value => typeof value === "string" && value.length > 0 && value.trim() === value;
function requireProof(value, message) {
  if (!value) throw Object.assign(new Error(message), {code:"policy.detail_state.source_unproved"});
}

export function validateSupportedDetailStateDecisions(decisions) {
  const diagnostics = [], used = new Set();
  const fail = message => diagnostics.push({level:"error", code:"policy.detail_state.invalid", message});
  if (!Array.isArray(decisions) || decisions.length !== 1) fail("One complete detail-state decision is required.");
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (!exact(decision,["kind","sourceScripts","actions","stateActionId","omissions"]) ||
        decision.kind !== SUPPORTED_DETAIL_STATE_KIND || !text(decision.stateActionId) ||
        !equal(decision.omissions, DETAIL_STATE_OMISSIONS)) { fail("The exact supported-only profile and every acknowledged difference are required."); continue; }
    for (const [key, identity] of [["sourceScripts","sourceRef"],["actions","id"]]) {
      const entries = decision[key];
      if (!Array.isArray(entries) || !entries.length || entries.length > 16 || entries.some(entry =>
        !exact(entry,[identity,"sha256"]) || !text(entry[identity]) || !digest.test(entry.sha256 || "")) ||
        new Set(entries.map(entry=>entry[identity])).size !== entries.length) fail("Explicit unique source and original action hashes are required.");
    }
    for (const action of Array.isArray(decision.actions) ? decision.actions : []) {
      if (used.has(action.id)) fail("Duplicate approved action.");
      used.add(action.id);
    }
    if (!Array.isArray(decision.actions) || !decision.actions.some(action=>action?.id === decision.stateActionId)) fail("The retained core action must be explicitly bound.");
  }
  return {ok:diagnostics.length === 0, diagnostics};
}

/** Construct reviewable decision data; this does not supply caller authorization. */
export function buildSupportedDetailStateDecision(sourceDraft, baseDraft) {
  const model = inspectSource(sourceDraft, baseDraft);
  return {kind:SUPPORTED_DETAIL_STATE_KIND,
    sourceScripts:model.sources.map(source=>({sourceRef:ref(source),sha256:sourceHash(source.javascript)})),
    actions:model.actions.map(action=>({id:action.id,sha256:sha256Digest(action)})),
    stateActionId:model.state.id, omissions:[...DETAIL_STATE_OMISSIONS]};
}

export function applySupportedDetailStatePolicies(sourceDraft, baseDraft, decisions) {
  const validation = validateSupportedDetailStateDecisions(decisions);
  requireProof(validation.ok,"Invalid supported-only detail-state decision.");
  const expected = buildSupportedDetailStateDecision(sourceDraft, baseDraft), decision = decisions[0];
  requireProof(equal(decision,expected),"The complete source program or original action scope changed after approval.");
  const model = inspectSource(sourceDraft,baseDraft), draft = structuredClone(baseDraft), audits = [];
  for (const original of model.actions) {
    const action = draft.scripts.actions.find(candidate=>candidate.id === original.id);
    const retainedCore = original.id === model.state.id;
    action.function = retainedCore ? buildDetailRowControlStateFunction(model.core)
      : `function ${action.event}(${action.event === "onChange" ? "value, rowNum, parentRowNum" : ""}) {\n  /* Explicit supported-only policy: this legacy runtime is not executed. */\n}`;
    action.translationStatus = "mapped";
    action.coverage = {status:"translated",nativeRules:[],residuals:[]};
    action.unmappedFunctions = [];
    action.functionMappings = [{source:SUPPORTED_DETAIL_STATE_KIND,target:"Explicit caller-approved supported behavior",basis:"approved-detail-state-pending-wrapper",reviewRequired:false}];
    action.semanticHints = {coveredCalculationRanges:action.sourceRefs.map(sourceRef=>{
      const source = model.sources.find(candidate=>ref(candidate) === sourceRef);
      return {sourceRef,name:"approvedSupportedDetailState",start:0,end:source.javascript.length};
    }),approvedDetailState:{profile:SUPPORTED_DETAIL_STATE_KIND,retainedCore}};
    audits.push({kind:SUPPORTED_DETAIL_STATE_KIND,actionId:action.id,sourceScripts:decision.sourceScripts,
      originalActionSha256:sha256Digest(original),originalCoverage:structuredClone(original.coverage),
      workflowBefore:sha256Digest(baseDraft.workflow ?? null),formBefore:sha256Digest(baseDraft.form),
      formRulesBefore:sha256Digest(baseDraft.formRules ?? null),retainedCore,
      retainedNativeRules:(baseDraft.formRules?.linkage || []).map(rule=>rule.id),
      omissions:[...DETAIL_STATE_OMISSIONS],
      approvedDifference:"No complete source equivalence is claimed. Keep static fields, workflow and existing native rules; retain only the source hidden/display/required branch on native change. Native same-option behavior, initial rendering and row lifecycle remain native. Dynamic hints, legacy wrappers, click dispatch, load reconciliation and helper validation restoration are excluded by caller policy."});
  }
  return {draft,audits,changedActionIds:model.actions.map(action=>action.id)};
}

function inspectSource(sourceDraft, baseDraft) {
  const sources = sourceDraft.scripts?.sources || [];
  requireProof(sources.length > 0 && sources.length <= 4 && new Set(sources.map(ref)).size === sources.length,
    "One bounded, unambiguous source program is required.");
  const parsed = sources.map(source=>({source,ast:parse(source.javascript,{ecmaVersion:"latest"})}));
  // The IR is only a closed syntax/effect inventory here. It is never executed
  // or treated as a proof of unknown source-renderer DOM ownership.
  compileLegacyDetailProgramIR(sources.map(source=>({source:source.javascript,gate:source.displayGate})));
  const helpers = [], handlers = [];
  for (const entry of parsed) {
    const handlerProof = createDetailInlineHandlerProof(entry.source.javascript, entry.ast);
    requireProof(!entry.source.displayGate || ["xform:editShow","xform:viewShow"].includes(entry.source.displayGate),"Unknown source mode gate.");
    const definitions = entry.ast.body.filter(node=>node.type === "FunctionDeclaration" && node.id.name === "controlDisplay");
    requireProof(definitions.length <= 1,"Ambiguous row-state declaration.");
    for (const fn of definitions) {
      const projected = projectCore(entry.source.javascript,fn);
      requireProof(projected,"The helper does not contain the supported hidden/display/required branch.");
      helpers.push({...projected,entry,fn});
    }
    walk(entry.ast,(node,ancestors)=>{
      requireProof(node.type !== "ReturnStatement","Return effects require a different approved profile.");
      if (node.type === "CallExpression" && node.callee.type === "Identifier") {
        const name=node.callee.name;
        requireProof(!name.startsWith("DocList_"),"Automatic row data mutations are outside this profile.");
        if (name === "common_dom_row_set_show_required_reset") requireProof(node.arguments.length === 4 && node.arguments[3]?.value === false,"Row-value reset behavior is outside this profile.");
        if (name === "Com_AddEventListener") requireProof(node.arguments.length === 3 && node.arguments[0]?.name === "window" && node.arguments[1]?.value === "load","Only source window-load registration is eligible.");
      }
      if (node.type === "VariableDeclarator" && node.id.name === "controlDisplay" ||
          node.type === "AssignmentExpression" && node.left.type === "Identifier" && node.left.name === "controlDisplay" ||
          /Function/.test(node.type) && node.params?.some(param=>param.name === "controlDisplay")) requireProof(false,"Rebound row-state helper.");
      if (node.type === "AssignmentExpression" && member(node.left,"value")) {
        const owner = ancestors.findLast(parent=>parent.type === "FunctionDeclaration");
        const helper = helpers.find(candidate=>candidate.fn === owner);
        requireProof(helper && node.left.object.type === "Identifier" && node.left.object.name === helper.hiddenAlias,
          "Persistent field writes outside the retained row-state core are not eligible.");
      }
      if (node.type === "CallExpression" && member(node.callee,"setAttribute")) {
        const attribute = node.arguments[0]?.value;
        if (["placeholder","validate"].includes(attribute)) requireProof(node.arguments.length === 2 && typeof node.arguments[1]?.value === "string","Dynamic property effects require another profile.");
        if (attribute === "onclick") handlers.push({node,ancestors,handlerProof});
      }
    });
  }
  const effective = helpers.filter(helper=>helper.entry.source.displayGate !== "xform:viewShow").at(-1);
  requireProof(effective && helpers.every(helper=>equal(helper.core,effective.core)),"Mode-dependent row-state cores differ.");
  const allActions = baseDraft.scripts?.actions || [];
  const actions = allActions.filter(action=>detailRowSourceEffectResiduals(action).length);
  const states = actions.filter(action=>action.event === "onChange" && action.scope === "control" && action.tableId === effective.core.tableId &&
    detailRowSourceEffectResiduals(action).some(residual=>residual.code === "script.residual.detail_row_effect_unproven"));
  requireProof(states.length === 1 && actions.length > 0 && actions.every(action=>action.translationStatus === "needs_review" &&
    ["onChange","onLoad"].includes(action.event) && action.sourceRefs?.length && action.sourceRefs.every(sourceRef=>sources.some(source=>ref(source) === sourceRef))),"The exact pending source actions cannot be bound.");
  requireProof(allActions.every(action=>action.translationStatus !== "needs_review" || actions.includes(action)),"Other unresolved source behavior is outside this policy.");
  const state = states[0], tables = (baseDraft.form?.fields || []).filter(field=>field.id === effective.core.tableId && field.componentId === "xform-detail-table");
  requireProof(tables.length === 1,"Ambiguous native table mapping.");
  const column = id => {const matches=tables[0].columns.filter(field=>field.id === id);requireProof(matches.length === 1,"Ambiguous detail field mapping.");return matches[0];};
  const trigger = column(state.controlId), target = column(effective.core.targetControlId), hidden = column(effective.core.hiddenControlId);
  requireProof(trigger.componentId === "xform-radio" && trigger.props?.options?.some(option=>option.value === effective.core.matchValue) &&
    ["xform-input","xform-textarea"].includes(target.componentId) && hidden.componentId === "xform-hidden" &&
    new Set([trigger.id,target.id,hidden.id]).size === 3,"Unsupported native detail-state field domain.");
  requireProof(handlers.length && handlers.every(({node,ancestors,handlerProof})=>handlerProof(node,ancestors,{tableId:effective.core.tableId,trigger})),
    "The inline handler must bind the same proven row and static trigger option.");
  return {sources,actions,state,core:effective.core};
}

function projectCore(text, fn) {
  const branch = fn.body.body[1];
  if (fn.body.body.length !== 2 || branch?.type !== "IfStatement" || branch.consequent?.type !== "BlockStatement" || branch.alternate?.type !== "BlockStatement") return undefined;
  const removed = [];
  for (const block of [branch.consequent,branch.alternate]) for (const statement of block.body) {
    const expr = statement.expression;
    if (expr?.type === "CallExpression" && member(expr.callee,"setAttribute") && expr.arguments[0]?.value === "placeholder" && typeof expr.arguments[1]?.value === "string" ||
        expr?.type === "CallExpression" && expr.callee.type === "Identifier" && expr.arguments.length === 0) removed.push(statement);
  }
  let projected=text.slice(fn.start,fn.end);
  for (const node of removed.sort((a,b)=>b.start-a.start)) projected=projected.slice(0,node.start-fn.start)+projected.slice(node.end-fn.start);
  const core=detailControlDisplayProof(projected);
  return core ? {core,hiddenAlias:fn.body.body[0]?.declarations?.[0]?.id?.name} : undefined;
}
function member(node,name) {return node?.type === "MemberExpression" && !node.computed && node.property.name === name;}
function walk(node,visit,ancestors=[]) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node,ancestors);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child=>walk(child,visit,[...ancestors,node]));
    else if (value && typeof value === "object") walk(value,visit,[...ancestors,node]);
  }
}
