import { canonicalJson } from "../agent-review/digest.js";
import { parse, parseExpressionAt } from "acorn";
import { buildJavaScriptBindingModel } from "./javascript-binding-provenance.js";
import { parseOptions } from "../translator/xml-utils.js";
import { proveSelectEmptySourceCallback } from "./source-select-empty-callback.js";

// This view exists only for proof. The actual action function is never changed.
// A recorded source empty choice and the native select null event represent the
// same declared state; other event values retain their original identity. Every
// diagnostic read uses that same bridge and remains in the source effect trace.
export function selectEmptyEventProof(action, { sourceAction = action, sourceForm, targetForm, sourceFormRules, targetFormRules, sourceScripts, authoritative = false } = {}) {
  const unchanged = { ok: true, function: action?.function, adapted: false };
  if (sourceAction?.event !== "onChange" || sourceAction.scope !== "control") return unchanged;
  const conditions = sourceAction.branchProvenance?.conditions || [];
  const relevant = conditions.some(condition => condition.kind === "contains" && condition.origin === "event:value" && condition.predicate === "indexOf");
  if (!relevant) return unchanged;
  const main = sourceForm?.controls || (sourceForm?.fields || []).filter(field => field.type !== "detailTable");
  const originals = (main || []).filter(field => field.id === sourceAction.controlId);
  const original = originals.length === 1 ? originals[0] : undefined;
  const props = original?.sourceProps || {};
  const hasFact = Object.hasOwn(props, "runtimeSelectEmpty");
  const looksAdapted = /===\s*null\s*\?/.test(String(action?.function || ""));
  // Old retained SourceDraft snapshots have no new runtime fact. They are not
  // silently rewritten or used to authorize this new bridge.
  if (!hasFact) return looksAdapted ? invalid("source_empty_fact_missing") : unchanged;
  if (!["mapped", "omitted"].includes(action?.translationStatus)) return unchanged;
  if (action.translationStatus === "omitted") {
    if (authoritative && (sourceAction.coverage?.residuals?.length || 0) > 0) return invalid("source_empty_action_omitted");
    if (authoritative && !sameOwner(sourceAction, action)) return invalid("source_empty_action_owner_changed");
    if (authoritative && !sameNativeEffects(sourceAction, action, sourceFormRules, targetFormRules)) return invalid("source_empty_native_effects_changed");
    return unchanged;
  }
  if (!sameOwner(sourceAction, action)) return invalid("source_empty_action_owner_changed");
  const targets = (targetForm?.fields || []).filter(field => field.id === sourceAction.controlId);
  const target = targets.length === 1 ? targets[0] : undefined;
  if (!qualifies(original, target, sourceForm, targetForm)) return invalid("source_empty_select_contract_unproven");
  if (conditions.length !== 1 || conditions[0].kind !== "contains" || conditions[0].predicate !== "indexOf" ||
      conditions[0].origin !== "event:value" || conditions[0].transforms?.length || typeof conditions[0].value !== "string") return invalid("source_empty_predicate_unproven");
  const needle = conditions[0].value;
  const domain = [...new Set([...originalOptions(original).map(option => option.value), ""])];
  if (!needle || !domain.every(value => (value.indexOf(needle) >= 0) === ([value].indexOf(needle) >= 0))) return invalid("source_empty_domain_ambiguous");

  const text = String(action.function || "");
  let ast;
  try { ast = parse(text, { ecmaVersion: "latest" }); } catch { return invalid("source_empty_action_parse_failed"); }
  const roots = ast.body.filter(node => node.type !== "EmptyStatement");
  const root = roots[0];
  if (roots.length !== 1 || root.type !== "FunctionDeclaration" || root.id?.name !== "onChange" || root.async || root.generator ||
      root.params[0]?.type !== "Identifier" || root.params.some(parameter => parameter.type !== "Identifier")) return invalid("source_empty_action_shape_unproven");
  const bindings = buildJavaScriptBindingModel(text, { event: "onChange" });
  if (!bindings.ok || !bindings.eventBinding) return invalid("source_empty_event_binding_unproven");
  const body = root.body.body.filter(node => node.type !== "EmptyStatement");
  const branches = body.filter(statement => statement.type === "IfStatement");
  if (branches.length !== 1 || branches[0].consequent.type !== "BlockStatement" || branches[0].alternate?.type !== "BlockStatement") return invalid("source_empty_effect_shape_unproven");
  const branch = branches[0], branchIndex = body.indexOf(branch);
  const test = branch.test;
  const call = test.type === "BinaryExpression" && test.operator === ">=" && test.right.type === "Literal" && test.right.value === 0 ? test.left : undefined;
  if (call?.type !== "CallExpression" || call.optional || call.arguments.length !== 1 || call.arguments[0].type !== "Literal" || call.arguments[0].value !== needle ||
      call.callee.type !== "MemberExpression" || call.callee.computed || call.callee.optional || call.callee.property.name !== "indexOf") return invalid("source_empty_predicate_changed");
  const bridge = call.callee.object;
  const isEvent = node => node?.type === "Identifier" && bindings.bindingAtUse(node.name, node.start) === bindings.eventBinding &&
    bindings.stableEventUse(bindings.eventBinding, bindings.scopeAt(node.start), node.start);
  const bridges = [];
  const isBridge = node => {
    if (node?.type !== "ConditionalExpression" || node.test.type !== "BinaryExpression" || node.test.operator !== "===" ||
        !isEvent(node.test.left) || node.test.right.type !== "Literal" || node.test.right.value !== null ||
        node.consequent.type !== "Literal" || node.consequent.value !== "" || !isEvent(node.alternate)) return false;
    bridges.push(node);
    return true;
  };
  if (!isBridge(bridge)) return invalid("native_select_null_bridge_required");
  const targetTrace = { before: [], branches: [[], []], after: [] }, writes = [];
  const diagnostic = expression => {
    if (expression?.type !== "CallExpression" || expression.optional || expression.callee.type !== "MemberExpression" ||
        expression.callee.computed || expression.callee.optional || expression.callee.object.type !== "Identifier" ||
        expression.callee.object.name !== "console" || expression.callee.property.name !== "log" ||
        !bindings.isUnshadowedGlobal("console", expression.start)) return undefined;
    const args = expression.arguments.map(argument => {
      if (argument.type === "Literal" && !argument.regex && (argument.value === null ||
          ["string", "boolean"].includes(typeof argument.value) || typeof argument.value === "number" && Number.isFinite(argument.value))) {
        return { kind: "literal", value: argument.value };
      }
      return isBridge(argument) ? { kind: "event" } : undefined;
    });
    return args.every(Boolean) ? { type: "console.log", args } : undefined;
  };
  const sequence = (statements, trace, allowWrites) => {
    for (const statement of statements) {
      if (statement.type === "EmptyStatement") continue;
      const expression = statement.type === "ExpressionStatement" && statement.expression;
      const log = diagnostic(expression);
      if (log) { trace.push(log); continue; }
      if (!allowWrites || expression?.type !== "CallExpression" || expression.optional || expression.callee.type !== "MemberExpression" || expression.callee.computed || expression.callee.optional ||
          expression.callee.object.type !== "Identifier" || expression.callee.object.name !== "MKXFORM" || expression.callee.property.name !== "setValue" ||
          !bindings.isUnshadowedGlobal("MKXFORM", expression.start) || expression.arguments.length !== 2 ||
          expression.arguments.some(argument => argument.type !== "Literal" || typeof argument.value !== "string")) return false;
      const write = { target: expression.arguments[0].value, value: expression.arguments[1].value };
      writes.push(write); trace.push({ type: "setValue", ...write });
    }
    return true;
  };
  if (!sequence(body.slice(0, branchIndex), targetTrace.before, false) ||
      !sequence(body.slice(branchIndex + 1), targetTrace.after, false) ||
      !sequence(branch.consequent.body, targetTrace.branches[0], true) ||
      !sequence(branch.alternate.body, targetTrace.branches[1], true)) return invalid("source_empty_additional_effect_unproven");
  if (!targetTrace.branches.every(steps => steps.some(step => step.type === "setValue"))) return invalid("source_empty_assignment_branch_empty");
  if (authoritative) {
    const sourceClosure = proveSelectEmptySourceCallback({ action: sourceAction, sources: sourceScripts,
      form: sourceForm, formRules: sourceFormRules, needle, writes, targetTrace });
    if (!sourceClosure.ok) return invalid(sourceClosure.reason);
    const residuals = (sourceAction.coverage?.residuals || []).filter(residual => residual.code === "script.residual.field_value_assignment");
    const expected = residuals.map(residual => {
      const rhs = String(residual.evidence || "").match(/\.\s*value\s*=\s*([\s\S]+?)\s*;?$/)?.[1];
      try {
        const literal = parseExpressionAt(rhs || "", 0, { ecmaVersion: "latest" });
        return literal.type === "Literal" && typeof literal.value === "string" && !rhs.slice(literal.end).trim()
          ? { target: residual.target, value: literal.value } : undefined;
      } catch { return undefined; }
    });
    if (!expected.length || expected.some(value => !value) || canonicalJson(expected) !== canonicalJson(writes)) return invalid("source_empty_assignment_evidence_changed");
  }
  if (authoritative && !sameNativeEffects(sourceAction, action, sourceFormRules, targetFormRules)) return invalid("source_empty_native_effects_changed");
  let proofFunction = text;
  for (const node of bridges.sort((a, b) => b.start - a.start)) {
    proofFunction = proofFunction.slice(0, node.start) + root.params[0].name + proofFunction.slice(node.end);
  }
  return { ok: true, adapted: true, function: proofFunction,
    evidence: { controlId: original.id, sourceRef: original.sourceRef, targetComponent: "xform-select", nullAs: "", nonNull: "unchanged", domain, needle } };
}

function qualifies(source, target, sourceForm, targetForm) {
  if (!source || !target || (source.sourceType || source.type) !== "singleSelect" || target.type !== "singleSelect" || target.componentId !== "xform-select" || source.dataOnly || target.dataOnly ||
      source.id !== target.id || !source.sourceRef || source.sourceRef !== target.sourceRef) return false;
  const allSource = sourceForm.controls ? [...sourceForm.controls, ...(sourceForm.dataFields || []), ...(sourceForm.detailTables || []).flatMap(table => table.columns || [])]
    : (sourceForm.fields || []).flatMap(field => field.type === "detailTable" ? field.columns || [] : [field]);
  const allTarget = (targetForm.fields || []).flatMap(field => field.type === "detailTable" ? field.columns || [] : [field]);
  if (allSource.filter(field => field.id === source.id || field.sourceRef === source.sourceRef).length !== 1 ||
      allTarget.filter(field => field.id === source.id || field.sourceRef === source.sourceRef).length !== 1) return false;
  const props = source.sourceProps || {}, values = props.designerValues || {}, fact = props.runtimeSelectEmpty, options = originalOptions(source);
  const metadataKeys = ["metadataId", "metadataKind", "metadataAttributes"], metadata = props.metadataAttributes;
  const metadataOk = metadataKeys.every(key => !Object.hasOwn(props, key)) || props.metadataId === source.id && props.metadataKind === "simple" &&
    metadata?.name === source.id && metadata.type === "String" && metadata.kind === "simple" &&
    (!Object.hasOwn(metadata, "defaultValue") || metadata.defaultValue === "") &&
    (!Object.hasOwn(metadata, "enumValues") || canonicalJson(parseOptions(metadata.enumValues)) === canonicalJson(options));
  const fixedKeys = ["designerId", "designerType", "designerValues", "metadataId", "metadataKind", "metadataAttributes", "runtimeSelectEmpty"];
  return fixedKeys.every(key => canonicalJson(props[key]) === canonicalJson(target.sourceProps?.[key])) && metadataOk && props.designerId === source.id && props.designerType === "select" && values.id === source.id && values.dataType === "String" &&
    values.defaultValue === "" && (!Object.hasOwn(values, "formula") || values.formula === "") &&
    [undefined, false, "false"].includes(values.multiSelect) && typeof values.items === "string" &&
    Array.isArray(options) && options.length > 0 && options.every(option => typeof option.label === "string" && typeof option.value === "string") &&
    new Set(options.map(option => option.value)).size === options.length && canonicalJson(parseOptions(values.items)) === canonicalJson(options) &&
    fact?.version === 1 && fact.source === "fdDisplayJsp" && fact.status === "proven" && fact.showPleaseSelect === true &&
    fact.property === `extendDataFormInfo.value(${source.id})` && Number.isSafeInteger(fact.offset) && fact.offset >= 0 && canonicalJson(fact.options) === canonicalJson(options) &&
    canonicalJson(target.sourceProps?.runtimeSelectEmpty) === canonicalJson(fact) && canonicalJson(target.props?.options) === canonicalJson(options) &&
    target.props?.defaultValue?.kind === "literal" && target.props.defaultValue.value === "" &&
    Boolean(source.required ?? source.props?.required) === Boolean(target.props?.required);
}

function originalOptions(field) { return field?.options || field?.props?.options; }
function sameOwner(expected, actual) {
  return ["id", "event", "scope", "controlId", "tableId", "sourceActionKey", "sourceRefs", "runWhen"].every(key => canonicalJson(expected?.[key]) === canonicalJson(actual?.[key])) &&
    !expected.tableId && typeof expected.sourceActionKey === "string" && expected.sourceRefs?.includes(expected.branchProvenance?.sourceRef);
}
function invalid(reason) { return { ok: false, reason }; }

// The proof view removes only the representation bridge. Source-owned native
// row effects remain part of the complete action and cannot be erased later.
function sameNativeEffects(expected, actual, sourceRules, targetRules) {
  const ids = expected.coverage?.nativeRules || [];
  if (canonicalJson(ids) !== canonicalJson(actual.coverage?.nativeRules || [])) return false;
  return ids.every(id => {
    const original = (sourceRules?.linkage || []).filter(rule => rule.id === id);
    const current = (targetRules?.linkage || []).filter(rule => rule.id === id);
    return original.length === 1 && current.length === 1 && original[0].translationStatus === "executable" &&
      canonicalJson(original[0]) === canonicalJson(current[0]);
  });
}
