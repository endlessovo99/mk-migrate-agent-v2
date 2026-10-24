import { parse } from "acorn";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";
import { analyzeScriptFunction } from "../dsl/scripts.js";
import { JS_METHOD_CATALOG } from "../dsl/catalogs.js";
import {
  buildConditionOperandResolver,
  parseProvenanceCondition,
  traceStaticFieldValueExpression
} from "../dsl/script-condition-provenance.js";
import { legacySourceFromGeneratedFunction } from "./row-marker-policy.js";

// This is intentionally a recognizer for the reviewed script shapes used
// by tracked routes, not a JavaScript evaluator. Any condition, nesting, or
// call placement that cannot be associated statically with the source branch
// model returns `ok: false` and leaves the residual open.
export function validateAssignmentBranchSemantics({
  sourceFunction,
  reviewedFunction,
  residuals,
  form
}) {
  const source = legacySourceFromGeneratedFunction(sourceFunction);
  const sourceResolver = buildConditionOperandResolver(source);
  const expectedAssignments = (residuals || []).map((residual) => (
    parseResidualAssignment(residual, sourceResolver, source)
  ));
  if (
    !expectedAssignments.length ||
    expectedAssignments.some((assignment) => !assignment.target || !assignment.valueSignature)
  ) {
    return invalid("assignment_evidence_unparseable");
  }

  const sourceModel = sourceAssignmentModel(source, expectedAssignments);
  if (!sourceModel.ok) return sourceModel;

  const targetModel = targetAssignmentModel(reviewedFunction, expectedAssignments);
  if (!targetModel.ok) return targetModel;

  if (sourceModel.conditions.some((condition) => condition.kind === "or")) {
    const shape = validateOrTargetShape(source, reviewedFunction);
    if (!shape.ok) return shape;
  }
  if (expectedAssignments.some((assignment) => assignment.valueSignature === "event:value") ||
      sourceModel.conditions.some((condition) => condition.kind === "or")) {
    const additional = validateAdditionalEventAssignments(
      source, reviewedFunction, expectedAssignments, sourceModel.kind, form
    );
    if (!additional.ok) return additional;
  }

  if (sourceModel.kind !== targetModel.kind) {
    return invalid("assignment_control_flow_changed");
  }
  if (!sameConditionSequence(sourceModel.conditions, targetModel.conditions)) {
    return invalid("condition_chain_changed", {
      expectedConditions: sourceModel.conditions,
      observedConditions: targetModel.conditions
    });
  }
  if (!sameBranchAssignments(sourceModel.branches, targetModel.branches)) {
    return invalid("assignment_branch_association_changed", {
      expectedBranches: sourceModel.branches,
      observedBranches: targetModel.branches
    });
  }
  return { ok: true };
}

export function validateRowMarkerBranchSemantics({
  sourceFunction,
  reviewedFunction,
  resolvedMarkers,
  primaryMarkerByAlias,
  sourceControls,
  targetFields,
  sourceForm,
  sourceScripts,
  sourceRefs,
  auditedOrphanMarkers
}) {
  const resolved = new Set(resolvedMarkers || []);
  if (!resolved.size) return { ok: true };
  const canonicalTarget = (marker) => primaryMarkerByAlias.get(marker) || marker;
  const targetIds = new Set([...resolved].map(canonicalTarget));
  const source = legacySourceFromGeneratedFunction(sourceFunction);
  const timed = validateTimedRowInitialization(source, reviewedFunction, resolved, canonicalTarget, { sourceControls, targetFields, sourceForm, sourceScripts, sourceRefs });
  if (timed) return timed;
  const sourceModel = sourceRowModel(source, resolved, canonicalTarget);
  if (!sourceModel.ok) return sourceModel;
  const hasOrCondition = sourceModel.conditions?.some((condition) => condition.kind === "or");
  if (hasOrCondition) {
    const shape = validateOrTargetShape(source, reviewedFunction);
    if (!shape.ok) return shape;
  }
  if (hasOrCondition && targetCalls(reviewedFunction, "MKXFORM.setFieldAttr").length !==
      legacyRowCalls(source, maskStringsAndComments(source)).filter((call) => resolved.has(call.target)).length) {
    return invalid("row_attribute_call_count_changed");
  }
  if (hasOrCondition &&
      !legacyAssignmentCalls(source, maskStringsAndComments(source)).length) {
    const additional = validateAdditionalEventAssignments(source, reviewedFunction, [], "row-only");
    if (!additional.ok) return additional;
  }
  if (sourceModel.trivial === true) {
    const targetModel = targetTrivialRowModel(reviewedFunction, targetIds);
    if (!targetModel.ok) return targetModel;
    const stateMismatch = compareScenarioStates(sourceModel.states, targetModel.states);
    return stateMismatch
      ? invalid("row_branch_association_changed", stateMismatch)
      : validateOrderedRowEffects(source, reviewedFunction, resolved, canonicalTarget, sourceModel.conditions, { auditedOrphanMarkers, sourceControls, sourceForm, sourceScripts, sourceRefs, targetFields });
  }

  const conditional = targetConditionalRowModel(
    reviewedFunction,
    targetIds,
    sourceModel.conditions
  );
  const targetModel = conditional.ok
    ? conditional
    : targetTernaryRowModel(reviewedFunction, targetIds, sourceModel.conditions);
  if (!targetModel.ok) {
    return invalid("row_control_flow_unverified", {
      conditionalReason: conditional.reason,
      ternaryReason: targetModel.reason,
      conditionalDetails: conditional,
      ternaryDetails: targetModel
    });
  }
  if (!sameConditionSequence(sourceModel.conditions, targetModel.conditions)) {
    return invalid("row_condition_chain_changed", {
      expectedConditions: sourceModel.conditions,
      observedConditions: targetModel.conditions
    });
  }

  const stateMismatch = compareScenarioStates(sourceModel.states, targetModel.states);
  if (stateMismatch) {
    return invalid("row_branch_association_changed", stateMismatch);
  }
  return validateOrderedRowEffects(source, reviewedFunction, resolved, canonicalTarget, sourceModel.conditions, { auditedOrphanMarkers, sourceControls, sourceForm, sourceScripts, sourceRefs, targetFields });
}

// A timer is part of the action, not a transparent wrapper. This recognizer
// compares the original callback scopes without rebuilding either program.
function validateTimedRowInitialization(source, reviewed, resolved, canonicalTarget, fieldEvidence) {
  let sourceProgram;
  let targetProgram;
  try {
    sourceProgram = parse(source, { ecmaVersion: "latest" });
    targetProgram = parse(reviewed, { ecmaVersion: "latest" });
  } catch { return invalid("timed_initialization_parse_unproven"); }
  const sourceScheduled = astNodes(sourceProgram).some(sourceSchedulingNode);
  const targetScheduled = astNodes(targetProgram).some(sourceSchedulingNode);
  if (!sourceScheduled && !targetScheduled) return undefined;
  if (!sourceScheduled || !targetScheduled) {
    return invalid("source_or_scheduling_unproven");
  }
  const before = timedRowEnvelope(source, sourceProgram, true);
  const after = timedRowEnvelope(reviewed, targetProgram, false);
  if (!before || !after) return invalid("timed_initialization_wrapper_unproven");
  if (before.delay !== after.delay) return invalid("timed_initialization_delay_changed");

  const sourceTokens = timedRowTokens(before.callback.body, {
    text: source, resolver: before.resolver, legacy: true, resolved, canonicalTarget, ...fieldEvidence
  });
  const targetTokens = timedRowTokens(after.callback.body, {
    text: reviewed, resolver: after.resolver, legacy: false,
    resolved: new Set([...resolved].map(canonicalTarget)), canonicalTarget: value => value
  });
  if (!sourceTokens || !targetTokens ||
      !legacyRowCalls(source, maskStringsAndComments(source)).some(call => resolved.has(call.target))) {
    return invalid("timed_initialization_callback_unproven");
  }
  if (JSON.stringify(sourceTokens) !== JSON.stringify(targetTokens)) {
    return invalid("timed_initialization_order_changed", {
      expected: sourceTokens, observed: targetTokens
    });
  }
  return { ok: true };
}

function timedRowEnvelope(text, program, legacy) {
  const entryResolver = buildConditionOperandResolver(text, { event: "onLoad" });
  const statements = program.body.filter(node => node.type !== "EmptyStatement");
  if (statements.length !== 1 || !entryResolver.entrypoint) return undefined;
  const root = astNodes(program).find(node =>
    node.start === entryResolver.entrypoint.start && /^(?:Function|ArrowFunction)/.test(node.type));
  if (!root || root.async || root.generator || root.params.length || root.body.type !== "BlockStatement") return undefined;
  if (legacy) {
    const call = statements[0].type === "ExpressionStatement" && statements[0].expression;
    if (root.type !== "FunctionExpression" || root.id || call?.type !== "CallExpression" || call.optional ||
        call.callee.type !== "Identifier" || call.callee.name !== "Com_AddEventListener" ||
        !entryResolver.isUnshadowedGlobal("Com_AddEventListener", call.start) ||
        !entryResolver.isUnshadowedGlobal("window", call.start) || call.arguments.length !== 3 ||
        call.arguments[0]?.type !== "Identifier" || call.arguments[0].name !== "window" ||
        call.arguments[1]?.type !== "Literal" || call.arguments[1].value !== "load" ||
        call.arguments[2] !== root) return undefined;
  } else if (statements[0] !== root || root.type !== "FunctionDeclaration" || root.id?.name !== "onLoad") {
    return undefined;
  }
  const body = root.body.body.filter(node => node.type !== "EmptyStatement");
  const call = body.length === 1 && body[0].type === "ExpressionStatement" && body[0].expression;
  if (call?.type !== "CallExpression" || call.optional || call.callee.type !== "Identifier" ||
      call.callee.name !== "setTimeout" || !entryResolver.isUnshadowedGlobal("setTimeout", call.start) ||
      call.arguments.length !== 2) return undefined;
  const [callback, delay] = call.arguments;
  if (callback.type !== "FunctionExpression" || callback.id || callback.async || callback.generator ||
      callback.params.length || callback.body.type !== "BlockStatement" ||
      delay.type !== "Literal" || typeof delay.value !== "number" ||
      !Number.isFinite(delay.value) || delay.value < 0 ||
      astNodes(callback.body).some(node => sourceSchedulingNode(node) ||
        /^(?:Function|ArrowFunction)/.test(node.type))) return undefined;
  return {
    callback, delay: delay.value,
    resolver: buildConditionOperandResolver(text, { eventFunctionStart: callback.start })
  };
}

// Tokens retain observable reads and each row dimension in statement order,
// including separate if/else branches. This is not a JavaScript evaluator.
function timedRowTokens(node, context) {
  if (!context.diagnosticBindings) {
    const tokens = timedRowTokens(node, { ...context, diagnosticBindings: new Map() });
    return tokens && uniqueDiagnosticReads(tokens) ? tokens : undefined;
  }
  const { text, resolver, legacy, resolved, canonicalTarget } = context;
  if (node.type === "EmptyStatement") return [];
  if (node.type === "BlockStatement" || node.type === "Program") {
    const children = node.body.map(statement => timedRowTokens(statement, context));
    return children.every(Boolean) ? children.flat() : undefined;
  }
  if (node.type === "VariableDeclaration") {
    if (context.atomic) {
      const declarations = node.declarations.map(declaration => {
        if (declaration.id.type !== "Identifier" || !declaration.init) return undefined;
        const value = text.slice(declaration.init.start, declaration.init.end);
        const condition = conditionSpec(value, resolver, declaration.init.start);
        if (condition && !legacy) {
          if (condition.kind !== "eq" || declaration.init.type === "Identifier") return undefined;
          context.aliases.set(declaration.id.name, condition);
        } else if (!resolver.trace(value, { beforeIndex: declaration.init.start })) return undefined;
        const reads = rowExpressionReads(declaration.init, context);
        rememberDiagnosticRead(declaration, reads, context);
        return reads;
      });
      return declarations.every(Boolean) ? declarations.flat() : undefined;
    }
    const reads = node.declarations.map(declaration => {
      if (declaration.id.type !== "Identifier" || !timedFieldRead(declaration.init, context)) return undefined;
      const trace = resolver.trace(text.slice(declaration.init.start, declaration.init.end), {
        beforeIndex: declaration.init.start
      });
      if (!trace?.origin?.startsWith("field:") || trace.transforms?.length) return undefined;
      const read = { kind: "read", field: trace.origin };
      rememberDiagnosticRead(declaration, [read], context);
      return read;
    });
    return reads.every(Boolean) ? reads : undefined;
  }
  if (node.type === "IfStatement") {
    if (context.atomic && !legacy && node.consequent.type === "ReturnStatement" && !node.consequent.argument && !node.alternate &&
        guardedBinaryEqualityDomain(text.slice(node.start, node.end), context.conditions, new Set(context.conditions.slice(0, 1).map(conditionKey)),
          (expression) => resolver(expression, { beforeIndex: node.test.start })) &&
        astNodes(node.test).every(item => ["LogicalExpression", "BinaryExpression", "Identifier", "Literal"].includes(item.type))) {
      return [{ kind: "guard", keys: context.conditions.map(conditionKey) }];
    }
    // Reads must be explicit declarations in this callback. Inlining a getter
    // into repeated OR leaves would change the number and position of reads.
    const testNodes = astNodes(node.test);
    if (!context.atomic && testNodes.some(test => !["Identifier", "Literal", "BinaryExpression", "LogicalExpression"].includes(test.type))) return undefined;
    const condition = conditionSpec(text.slice(node.test.start, node.test.end), resolver, node.test.start);
    if (!condition || !context.atomic && (!["eq", "or"].includes(condition.kind) || !condition.operand?.startsWith("field:")) ||
        node.consequent.type !== "BlockStatement" ||
        node.alternate && !["BlockStatement", "IfStatement"].includes(node.alternate.type)) return undefined;
    const branchContext = () => ({ ...context, diagnosticBindings: new Map(context.diagnosticBindings) });
    const yes = timedRowTokens(node.consequent, branchContext());
    const no = node.alternate ? timedRowTokens(node.alternate, branchContext()) : [];
    const reads = context.atomic ? rowExpressionReads(node.test, context) : [];
    return yes && no && reads ? [...reads, { kind: "if", condition, yes, no }] : undefined;
  }
  if (context.atomic && node.type === "ExpressionStatement") {
    if (context.clearTokens?.has(node.expression.start)) return context.clearTokens.get(node.expression.start);
    const assignment = rowAssignmentTokens(node.expression, context);
    if (assignment) return assignment;
  }
  if (node.type !== "ExpressionStatement" || node.expression.type !== "CallExpression" || node.expression.optional) return undefined;
  const call = node.expression;
  const diagnostic = rowDiagnosticToken(call, context);
  if (diagnostic) return [diagnostic];
  if (legacy) {
    if (call.callee.type === "Identifier" && call.callee.name === "common_dom_row_set_show_required_reset" &&
        resolver.isUnshadowedGlobal(call.callee.name, call.start) && call.arguments.length === 4 &&
        call.arguments.every(argument => argument.type === "Literal")) {
      const [target, visible, required, reset] = call.arguments.map(argument => argument.value);
      if (context.atomic && context.auditedOrphanMarkers?.includes(target)) return [];
      if (!resolved.has(target) || typeof visible !== "boolean" || typeof required !== "boolean" || reset !== false) return undefined;
      return [visible ? 5 : 4, required ? 3 : 6].map(attribute => ({
        kind: "attribute", target: canonicalTarget(target), attribute
      }));
    }
    return undefined;
  }
  const callee = call.callee;
  if (callee.type !== "MemberExpression" || callee.computed || callee.optional ||
      callee.object?.type !== "Identifier" || callee.object.name !== "MKXFORM" ||
      callee.property?.name !== "setFieldAttr" || !resolver.isUnshadowedGlobal("MKXFORM", call.start) ||
      call.arguments.length !== 2 || call.arguments[0].type !== "Literal") return undefined;
  if (context.atomic && call.arguments[1].type === "ConditionalExpression") {
    const expression = call.arguments[1];
    const stable = expression.test.type === "Identifier" && resolver.stableInitializer(expression.test.name, { beforeIndex: expression.start });
    const condition = stable && context.aliases.get(expression.test.name);
    const target = call.arguments[0].value;
    if (!condition || !resolved.has(target) || expression.consequent.type !== "Literal" || expression.alternate.type !== "Literal") return undefined;
    const yes = expression.consequent.value, no = expression.alternate.value;
    if (![3, 4, 5, 6].includes(yes) || ![3, 4, 5, 6].includes(no) || attributeDimension(yes) !== attributeDimension(no)) return undefined;
    return [{ kind: "if", condition, yes: [{ kind: "attribute", target, attribute: yes }], no: [{ kind: "attribute", target, attribute: no }] }];
  }
  if (call.arguments[1].type !== "Literal") return undefined;
  const [target, attribute] = call.arguments.map(argument => argument.value);
  return resolved.has(target) && [3, 4, 5, 6].includes(attribute)
    ? [{ kind: "attribute", target, attribute }] : undefined;
}

function rememberDiagnosticRead(declaration, reads, context) {
  if (reads?.length === 1 && reads[0].kind === "read" &&
      (timedFieldRead(declaration.init, context) || orderedHiddenStringRead(declaration.init, context))) {
    context.diagnosticBindings.set(declaration.init.start, reads[0].field);
  }
}

// The synchronous row grammar already admits this indexed value getter for
// retained hidden String fields. It is not a DOM handle or a timer extension.
function orderedHiddenStringRead(node, { atomic, legacy, resolver, sourceForm, sourceControls, targetFields }) {
  if (!atomic || !legacy || sourceForm?.controls !== sourceControls ||
      node?.type !== "MemberExpression" || node.optional || !node.computed ||
      node.property.type !== "Literal" || node.property.value !== 0 ||
      node.object.type !== "CallExpression" || node.object.optional ||
      node.object.callee.type !== "Identifier" || node.object.callee.name !== "GetXFormFieldValueById" ||
      !resolver.isUnshadowedGlobal("GetXFormFieldValueById", node.start) || node.object.arguments.length !== 1 ||
      node.object.arguments[0].type !== "Literal" || typeof node.object.arguments[0].value !== "string") return false;
  const id = node.object.arguments[0].value;
  const matches = (sourceForm.dataFields || []).filter(field => field.id === id);
  const all = [...(sourceForm.controls || []), ...(sourceForm.dataFields || []),
    ...(sourceForm.detailTables || []).flatMap(table => table.columns || table.controls || [])];
  if (matches.length !== 1 || all.filter(field => field.id === id).length !== 1) return false;
  const field = matches[0], props = field.sourceProps || {}, values = props.designerValues || {};
  const targets = (targetFields || []).filter(target => target.id === id);
  if (!field.sourceRef || all.filter(item => item.sourceRef === field.sourceRef).length !== 1 ||
      targets.length !== 1) return false;
  const target = targets[0], targetSource = target.sourceProps || {};
  return field.sourceType === "text" && props.hardHidden === true && props.designerType === "inputText" &&
    props.designerId === id && values.id === id && values.dataType === "String" && values.canShow === "false" &&
    props.metadataId === id && props.metadataKind === "simple" && props.metadataAttributes?.name === id &&
    props.metadataAttributes?.type === "String" && props.metadataAttributes?.kind === "simple" &&
    props.metadataAttributes?.canDisplay === "false" && target.type === "text" && target.componentId === "xform-hidden" &&
    target.sourceRef === field.sourceRef && targetSource.hardHidden === true && targetSource.designerId === id &&
    targetSource.metadataId === id && targetSource.metadataKind === "simple" &&
    targetSource.metadataAttributes?.name === id && targetSource.metadataAttributes?.type === "String" &&
    targetSource.metadataAttributes?.canDisplay === "false";
}

function rowDiagnosticToken(call, context) {
  const { resolver } = context, callee = call.callee;
  if (callee.type !== "MemberExpression" || callee.computed || callee.optional ||
      callee.object?.type !== "Identifier" || callee.object.name !== "console" ||
      callee.property?.name !== "log" || !resolver.isUnshadowedGlobal("console", call.start)) return undefined;
  const args = call.arguments.map(argument => {
    if (argument.type === "Literal" && (argument.value === null ||
        ["string", "boolean"].includes(typeof argument.value) ||
        typeof argument.value === "number" && Number.isFinite(argument.value))) {
      return { kind: "literal", type: argument.value === null ? "null" : typeof argument.value, value: argument.value };
    }
    if (argument.type !== "Identifier") return undefined;
    const trace = resolver.trace(argument.name, { beforeIndex: argument.start });
    if (!trace || trace.transforms?.length) return undefined;
    if (trace.origin === "event:value") return { kind: "event" };
    const declaration = resolver.stableInitializer(argument.name, { beforeIndex: argument.start, sameFunction: true });
    return declaration && context.diagnosticBindings.get(declaration.expressionIndex) === trace.origin
      ? { kind: "field", field: trace.origin } : undefined;
  });
  return args.every(Boolean) ? { kind: "diagnostic", method: "console.log", args } : undefined;
}

// A field origin alone cannot identify which value snapshot was logged.
// Restrict the new local diagnostics to one explicit read in this callback;
// callbacks without field diagnostics keep their existing read grammar.
function uniqueDiagnosticReads(tokens) {
  const reads = new Map(), logged = new Set();
  function visit(items) {
    for (const token of items) {
      if (token.kind === "read") reads.set(token.field, (reads.get(token.field) || 0) + 1);
      if (token.kind === "diagnostic") for (const arg of token.args) if (arg.kind === "field") logged.add(arg.field);
      if (token.kind === "if") { visit(token.yes); visit(token.no); }
    }
  }
  visit(tokens);
  return [...logged].every(field => reads.get(field) === 1);
}

function timedFieldRead(node, context) {
  const { resolver, legacy, sourceControls, targetFields } = context;
  if (legacy && node?.type === "MemberExpression" && node.computed && !node.optional &&
      node.property.type === "Literal" && node.property.value === 0 &&
      node.object.type === "CallExpression" && !node.object.optional &&
      node.object.callee.type === "Identifier" && node.object.callee.name === "GetXFormFieldValueById" &&
      resolver.isUnshadowedGlobal("GetXFormFieldValueById", node.start) && node.object.arguments.length === 1 &&
      node.object.arguments[0].type === "Literal" && typeof node.object.arguments[0].value === "string") {
    return mainSingleSelectRead(node.object.arguments[0].value, context) && stableSourceValueGetter(context);
  }
  if (node?.type !== "CallExpression" || node.optional || node.callee.type !== "MemberExpression" ||
      node.callee.computed || node.callee.optional) return false;
  const member = node.callee;
  if (!legacy) return member.object?.type === "Identifier" && member.object.name === "MKXFORM" &&
    member.property?.name === "getValue" && resolver.isUnshadowedGlobal("MKXFORM", node.start) &&
    node.arguments.length === 1 && node.arguments[0].type === "Literal" && typeof node.arguments[0].value === "string";
  const query = member.object;
  if (member.property?.name !== "val" || node.arguments.length !== 0 ||
      query.type !== "CallExpression" || query.optional || query.callee.type !== "Identifier" ||
      query.callee.name !== "$" || !resolver.isUnshadowedGlobal("$", query.start) ||
      query.arguments.length !== 1 || query.arguments[0].type !== "Literal" || typeof query.arguments[0].value !== "string") return false;
  // The source read returns one checked radio value. Unfiltered radio sets or
  // checked checkbox sets do not share MKXFORM's single-value contract.
  const selected = query.arguments[0].value.match(
    /^\s*\[\s*name\s*=\s*(["'])extendDataFormInfo\.value\(([A-Za-z0-9_.-]+)\)\1\s*\]:checked\s*$/
  );
  if (!selected) return false;
  const original = (sourceControls || []).filter(field => field.id === selected[2]);
  const target = (targetFields || []).filter(field => field.id === selected[2]);
  return original.length === 1 && original[0].sourceType === "radio" &&
    target.length === 1 && target[0].type === "radio" && target[0].componentId === "xform-radio";
}

// The indexed vendor getter is already a registered array-first-item recipe.
// This timer extension requires immutable main-field evidence, not a target hint.
function mainSingleSelectRead(id, { sourceForm, sourceControls, targetFields }) {
  if (!sourceForm || sourceForm.controls !== sourceControls || !/^[A-Za-z0-9_-]+$/.test(id)) return false;
  const all = [...(sourceForm.controls || []), ...(sourceForm.dataFields || []),
    ...(sourceForm.detailTables || []).flatMap(table => table.columns || table.controls || [])];
  const matches = all.filter(field => field.id === id);
  if (matches.length !== 1 || !sourceControls.includes(matches[0])) return false;
  const field = matches[0], props = field.sourceProps || {};
  const targets = (targetFields || []).flatMap(field => field.type === "detailTable" ? field.columns || [] : [field])
    .filter(field => field.id === id || field.sourceRef === matches[0].sourceRef);
  const options = field.options;
  const metadataKeys = ["metadataId", "metadataKind", "metadataAttributes"];
  const metadataAbsent = metadataKeys.every(key => !Object.hasOwn(props, key));
  const metadataMatches = props.metadataId === id && props.metadataKind === "simple" &&
    props.metadataAttributes?.name === id && props.metadataAttributes?.type === "String" && props.metadataAttributes?.kind === "simple";
  return (metadataAbsent || metadataMatches) && Boolean(field.sourceRef) && all.filter(item => item.sourceRef === field.sourceRef).length === 1 &&
    field.sourceType === "singleSelect" && props.designerType === "select" &&
    props.designerId === id && props.designerValues?.id === id && props.designerValues?.dataType === "String" &&
    Array.isArray(options) && options.length > 0 && options.every(option => typeof option.value === "string" && typeof option.label === "string") &&
    new Set(options.map(option => option.value)).size === options.length && targets.length === 1 &&
    (targetFields || []).includes(targets[0]) && targets[0].id === id && targets[0].sourceRef === field.sourceRef &&
    targets[0].type === "singleSelect" && targets[0].componentId === "xform-select" &&
    JSON.stringify(targets[0].props?.options) === JSON.stringify(options);
}

// Closed source grammar for the new getter proof. Every global value and every
// call must have a complete consumer; unsupported values never become ordinary
// objects merely because their originating expression was already visited.
function stableSourceValueGetter({ sourceScripts, sourceRefs }) {
  const sources = sourceScripts?.sources;
  if (!Array.isArray(sources) || !sourceRefs?.length || sourceRefs.some(ref => sources.filter(source => source.sourceRef === ref).length !== 1)) return false;
  const globals = new Set(["window", "globalThis", "self"]);
  const platform = new Set([...globals, "Com_AddEventListener", "AttachXFormValueChangeEventById", "setTimeout",
    "GetXFormFieldValueById", "GetXFormFieldById", "SetXFormFieldValueById", "common_dom_row_set_show_required_reset",
    "console", "String", "Number", "undefined", "eval", "Function"]);
  const records = [];
  const scriptBindings = new Map();
  for (const source of sources) {
    const text = String(source.javascript || "");
    let program;
    try { program = parse(text, { ecmaVersion: "latest" }); } catch { return false; }
    const bindings = buildJavaScriptBindingModel(text, { programIsEntrypoint: true });
    if (!bindings.ok) return false;
    const nodes = astNodes(program), parents = new Map();
    for (const parent of nodes) for (const value of Object.values(parent)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === "object" && typeof child.type === "string") parents.set(child, parent);
      }
    }
    const record = { program, bindings, nodes, parents, aliases: new Set() };
    records.push(record);
    // Script-level bindings are shared by all retained sources. A sibling
    // definition cannot silently replace any callee whose platform contract we use.
    for (const name of platform) if (bindings.bindingAtUse(name, program.end)?.scope.kind === "program") return false;
    for (const node of record.nodes) {
      if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") continue;
      const binding = bindings.bindingAtUse(node.id.name, node.id.start);
      if (binding?.scope.kind !== "program") continue;
      const entries = scriptBindings.get(node.id.name) || [];
      if (!entries.some(entry => entry.binding === binding)) entries.push({ record, binding });
      scriptBindings.set(node.id.name, entries);
    }
  }
  const globalAliases = new Set();
  const mayBeGlobal = (node, record) => {
    if (node?.type === "ThisExpression") return record.bindings.scopeAt(node.start).functionScope.kind === "program";
    if (node?.type !== "Identifier") return false;
    const binding = record.bindings.bindingAtUse(node.name, node.start);
    return !binding && globals.has(node.name) || record.aliases.has(binding) ||
      (!binding || binding.scope.kind === "program") && globalAliases.has(node.name);
  };
  // Union only direct bindings, without assuming path or script execution order.
  // Nested assignment results are not consumers and are rejected by the grammar.
  let changed;
  do {
    changed = false;
    for (const record of records) for (const node of record.nodes) {
      const left = node.type === "VariableDeclarator" ? node.id : node.type === "AssignmentExpression" ? node.left : null;
      const right = node.type === "VariableDeclarator" ? node.init : node.type === "AssignmentExpression" ? node.right : null;
      if (left?.type !== "Identifier" || !mayBeGlobal(right, record)) continue;
      const binding = record.bindings.bindingAtUse(left.name, left.start);
      if (binding && !record.aliases.has(binding)) { record.aliases.add(binding); changed = true; }
      if ((!binding || binding.scope.kind === "program") && !globalAliases.has(left.name)) { globalAliases.add(left.name); changed = true; }
    }
  } while (changed);

  // May-global union is only a rejection fact. A platform consumer needs a
  // separate same-source, same-execution-domain initialization proof.
  function definitelyGlobal(node, record, atIndex = node?.start, seen = new Set()) {
    if (node?.type === "ThisExpression") return record.bindings.scopeAt(atIndex).functionScope.kind === "program";
    if (node?.type !== "Identifier") return false;
    const binding = record.bindings.bindingAtUse(node.name, atIndex);
    if (!binding) return globals.has(node.name);
    if (binding.ambiguous || seen.has(binding) || binding.declarations.length !== 1 ||
        binding.scope.functionScope !== record.bindings.scopeAt(atIndex).functionScope ||
        binding.effects.some(effect => effect.kind === "mutation")) return false;
    if (binding.scope.kind === "program" && records.some(other => other !== record && (
      other.bindings.bindingAtUse(node.name, other.program.end)?.scope.kind === "program" ||
      other.nodes.some(candidate => {
        const target = candidate.type === "AssignmentExpression" ? candidate.left : candidate.type === "UpdateExpression" ? candidate.argument : null;
        if (target?.type !== "Identifier" || target.name !== node.name) return false;
        const foreign = other.bindings.bindingAtUse(target.name, target.start);
        return !foreign || foreign.scope.kind === "program";
      })
    ))) return false;
    const declaration = binding.declarations[0];
    if (declaration.controlFlowUnproven || declaration.index >= atIndex) return false;
    const declarator = record.nodes.find(item => item.type === "VariableDeclarator" && item.id.start === declaration.index);
    const declarationStatement = declarator && record.parents.get(declarator);
    if (!directExecutionStatement(declarationStatement, record)) return false;
    const writes = binding.effects.filter(effect => effect.kind === "write");
    let initializer = declarator?.init;
    if (initializer) {
      if (writes.length || initializer.end >= atIndex) return false;
    } else {
      if (writes.length !== 1) return false;
      const assignment = record.nodes.find(item => item.type === "AssignmentExpression" && item.start === writes[0].index);
      if (!assignment || assignment.operator !== "=" || assignment.left.type !== "Identifier" || assignment.left.name !== node.name ||
          assignment.end > atIndex || assignment.start <= declaration.index ||
          record.bindings.scopeAt(assignment.start).functionScope !== binding.scope.functionScope ||
          !directExecutionStatement(record.parents.get(assignment), record)) return false;
      initializer = assignment.right;
    }
    const next = new Set(seen); next.add(binding);
    return definitelyGlobal(initializer, record, initializer.start, next);
  }

  function directExecutionStatement(statement, record) {
    if (!statement || !["VariableDeclaration", "ExpressionStatement"].includes(statement.type)) return false;
    const container = record.parents.get(statement), owner = container && record.parents.get(container);
    return container?.type === "Program" || container?.type === "BlockStatement" &&
      ["FunctionExpression", "FunctionDeclaration"].includes(owner?.type) && owner.body === container;
  }

  const dataKinds = new Set(["data", "field-data", "object", "array"]);
  const localKinds = new Set([...dataKinds, "global", "field-list", "field", "value-list"]);
  const literal = (node, type) => node?.type === "Literal" && typeof node.value === type;
  const unshadowed = (name, node, record) => record.bindings.isUnshadowedGlobal(name, node.start) && !scriptBindings.has(name);

  function kind(node, record, parameters, seen = new Set()) {
    if (!node) return "unknown";
    if (mayBeGlobal(node, record)) return definitelyGlobal(node, record) ? "global" : "unknown";
    if (node.type === "Literal") return node.value === null || ["string", "number", "boolean"].includes(typeof node.value) ? "data" : "unknown";
    if (node.type === "Identifier") {
      let binding = record.bindings.bindingAtUse(node.name, node.start), owner = record;
      if (!binding && node.name === "undefined" && unshadowed(node.name, node, record)) return "data";
      if (!binding) {
        const shared = scriptBindings.get(node.name);
        if (shared?.length !== 1) return "unknown";
        ({ binding, record: owner } = shared[0]);
      }
      if (parameters.has(binding)) return parameters.get(binding);
      if (binding.ambiguous || seen.has(binding) || binding.declarations.length !== 1 || binding.effects.some(effect => effect.kind === "write")) return "unknown";
      const declaration = binding.declarations[0];
      if (!declaration.expression || declaration.controlFlowUnproven || owner === record && declaration.index >= node.start) return "unknown";
      const initializer = owner.nodes.find(item => item.start === declaration.expressionIndex && item.type !== "VariableDeclarator");
      const next = new Set(seen); next.add(binding);
      // Identity-preserving local property writes are checked by statement().
      // No call or escape is trusted merely from this initializer's kind.
      return kind(initializer, owner, parameters, next);
    }
    if (node.type === "ArrayExpression") return node.elements.every(item => item && dataKinds.has(kind(item, record, parameters, seen))) ? "array" : "unknown";
    if (node.type === "ObjectExpression") return node.properties.every(property => property.type === "Property" &&
      !property.computed && !property.method && property.kind === "init" && dataKinds.has(kind(property.value, record, parameters, seen))) ? "object" : "unknown";
    if (node.type === "MemberExpression" && !node.optional) {
      const receiver = kind(node.object, record, parameters, seen);
      // No global member name has a special return-value exemption.
      if (node.computed && node.property.type === "Literal" && node.property.value === 0) {
        if (receiver === "field-list") return "field";
        if (receiver === "value-list") return "field-data";
      }
      if (!node.computed && node.property.name === "value" && receiver === "field") return "field-data";
      if (["object", "array"].includes(receiver) && (!node.computed || node.property.type === "Literal")) return "data";
      return "unknown";
    }
    if (["BinaryExpression", "LogicalExpression"].includes(node.type)) return dataKinds.has(kind(node.left, record, parameters, seen)) &&
      dataKinds.has(kind(node.right, record, parameters, seen)) ? "data" : "unknown";
    if (node.type === "UnaryExpression" && ["!", "+", "-", "typeof", "void"].includes(node.operator)) {
      return dataKinds.has(kind(node.argument, record, parameters, seen)) ? "data" : "unknown";
    }
    if (node.type !== "CallExpression" || node.optional || node.arguments.some(argument => argument.type === "SpreadElement")) return "unknown";
    const callee = node.callee, args = node.arguments;
    if (callee.type === "Identifier" && unshadowed(callee.name, node, record)) {
      if (callee.name === "Com_AddEventListener") return args.length === 3 && kind(args[0], record, parameters, seen) === "global" &&
        literal(args[1], "string") && args[1].value === "load" && callback(args[2], [], record, parameters) ? "effect" : "unknown";
      if (callee.name === "AttachXFormValueChangeEventById") return args.length === 2 && literal(args[0], "string") &&
        callback(args[1], ["field-data", "unknown"], record, parameters, 1) ? "effect" : "unknown";
      if (callee.name === "setTimeout") return args.length === 2 && literal(args[1], "number") && Number.isFinite(args[1].value) && args[1].value >= 0 &&
        callback(args[0], [], record, parameters) ? "effect" : "unknown";
      if (["GetXFormFieldValueById", "GetXFormFieldById"].includes(callee.name)) return args.length === 1 && literal(args[0], "string") && args[0].value
        ? callee.name === "GetXFormFieldById" ? "field-list" : "value-list" : "unknown";
      if (callee.name === "common_dom_row_set_show_required_reset") return args.length === 4 && literal(args[0], "string") &&
        args.slice(1).every(argument => literal(argument, "boolean")) ? "effect" : "unknown";
      if (callee.name === "SetXFormFieldValueById") return args.length === 3 && literal(args[0], "string") &&
        dataKinds.has(kind(args[1], record, parameters, seen)) && args[2].type === "Literal" && args[2].value === false ? "effect" : "unknown";
      if (["String", "Number"].includes(callee.name)) return args.length === 1 && ["data", "field-data"].includes(kind(args[0], record, parameters, seen)) ? "data" : "unknown";
    }
    if (callee.type !== "MemberExpression" || callee.computed || callee.optional) return "unknown";
    if (callee.object.type === "Identifier" && callee.object.name === "console" && unshadowed("console", node, record) &&
        JS_METHOD_CATALOG.staticMethods.some(entry => entry.name === `console.${callee.property.name}` && entry.status === "supported" && entry.notes?.startsWith("Debug only"))) {
      return args.every(argument => dataKinds.has(kind(argument, record, parameters, seen))) ? "effect" : "unknown";
    }
    return callee.property.name === "indexOf" && ["data", "field-data"].includes(kind(callee.object, record, parameters, seen)) &&
      args.length === 1 && literal(args[0], "string") ? "data" : "unknown";
  }

  function callback(node, parameterKinds, record, outer, minimum = parameterKinds.length) {
    if (node?.type !== "FunctionExpression" || node.id || node.async || node.generator || node.body.type !== "BlockStatement" ||
        node.params.length < minimum || node.params.length > parameterKinds.length || node.params.some(parameter => parameter.type !== "Identifier")) return false;
    const parameters = new Map(outer);
    node.params.forEach((parameter, index) => parameters.set(record.bindings.bindingAtUse(parameter.name, parameter.start), parameterKinds[index]));
    return statement(node.body, record, parameters);
  }

  function statement(node, record, parameters) {
    if (node.type === "Program" || node.type === "BlockStatement") return node.body.every(child => statement(child, record, parameters));
    if (node.type === "EmptyStatement") return true;
    if (node.type === "VariableDeclaration") return node.declarations.every(declaration => declaration.id.type === "Identifier" &&
      (!declaration.init || localKinds.has(kind(declaration.init, record, parameters))));
    if (node.type === "FunctionDeclaration") {
      if (node.async || node.generator || node.params.some(parameter => parameter.type !== "Identifier")) return false;
      const local = new Map(parameters);
      node.params.forEach(parameter => local.set(record.bindings.bindingAtUse(parameter.name, parameter.start), "unknown"));
      return statement(node.body, record, local);
    }
    if (node.type === "IfStatement") return dataKinds.has(kind(node.test, record, parameters)) && statement(node.consequent, record, parameters) &&
      (!node.alternate || statement(node.alternate, record, parameters));
    if (node.type === "ReturnStatement") return !node.argument || dataKinds.has(kind(node.argument, record, parameters));
    if (node.type !== "ExpressionStatement") return false;
    const expression = node.expression;
    if (expression.type !== "AssignmentExpression") return expression.type === "CallExpression" && ["effect", "data"].includes(kind(expression, record, parameters));
    if (expression.operator !== "=") return false;
    const right = kind(expression.right, record, parameters), left = expression.left;
    if (left.type === "Identifier") {
      const binding = record.bindings.bindingAtUse(left.name, left.start);
      return Boolean(binding || scriptBindings.get(left.name)?.length === 1) && !platform.has(left.name) &&
        (dataKinds.has(right) || right === "global" && definitelyGlobal(left, record, expression.end));
    }
    if (left.type !== "MemberExpression" || left.optional || !dataKinds.has(right)) return false;
    const receiver = kind(left.object, record, parameters);
    return receiver === "field" && !left.computed && left.property.name === "value" ||
      ["object", "array"].includes(receiver) && (!left.computed || left.property.type === "Literal");
  }
  return records.every(record => statement(record.program, record, new Map()));
}

// Complete synchronous closure reuses the timer's token walk. Old branch-state
// checks still own condition association; tokens additionally retain every read
// and effect, including duplicates and prelude effects that a final-state map loses.
export function validateOrderedRowEffects(source, reviewed, resolved, canonicalTarget, conditions, fieldEvidence) {
  const before = synchronousRowEnvelope(source, true), after = synchronousRowEnvelope(reviewed, false);
  if (!before || !after) return invalid("row_ordered_shape_unproven");
  const clears = orderedChoiceClearEvidence(source, reviewed, before, fieldEvidence);
  if (!clears.ok) return clears;
  const expected = timedRowTokens(before.body, { text: source, resolver: before.resolver, legacy: true, clearTokens: clears.source,
    atomic: true, aliases: new Map(), conditions, resolved, canonicalTarget, ...fieldEvidence });
  const observed = timedRowTokens(after.body, { text: reviewed, resolver: after.resolver, legacy: false, clearTokens: clears.target,
    atomic: true, aliases: new Map(), conditions, resolved: new Set([...resolved].map(canonicalTarget)), canonicalTarget: value => value, ...fieldEvidence });
  if (!expected || !observed) return invalid("row_ordered_effect_unproven");
  const keys = conditions.map(conditionKey);
  const trace = (tokens, key) => {
    const result = [];
    for (const token of tokens) {
      if (token.kind === "guard") { if (!token.keys.includes(key)) break; }
      else if (token.kind === "if") result.push(...trace(conditionKey(token.condition) === key ? token.yes : token.no, key));
      else result.push(token);
    }
    return result;
  };
  // Source row models accept a single condition chain; there is no arbitrary
  // Boolean execution here. Every supported condition and its else is compared.
  for (const key of [...keys, "else"]) {
    const left = trace(expected, key), right = trace(observed, key);
    if (JSON.stringify(left) !== JSON.stringify(right)) return invalid("row_ordered_effect_changed", { scenario: key, expected: left, observed: right });
  }
  return { ok: true };
}

// Reuse the existing event-prefix/typed-checkbox/selector/guard proof before
// exposing clear tokens. Two source operations represent one native clear;
// retaining both tokens also rejects effects interleaved between the pair.
function orderedChoiceClearEvidence(source, reviewed, before, { sourceControls, targetFields } = {}) {
  const empty = { ok: true, source: new Map(), target: new Map() };
  const hasClearCandidate = astNodes(before.body).some(node => node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" && ["val", "prop"].includes(node.callee.property?.name) && node.arguments.length > 0);
  if (!hasClearCandidate) return empty;
  const sourceClears = choiceClearCalls(source, "source", new Set());
  if (!sourceClears.ok) return invalid("row_choice_clear_unproven");
  if (!sourceClears.calls.length) return empty;
  const assignments = astNodes(before.body).filter(node => node.type === "AssignmentExpression")
    .sort((left, right) => left.start - right.start).flatMap(node => {
      const tokens = rowAssignmentTokens(node, { text: source, resolver: before.resolver, legacy: true });
      return (tokens || []).filter(token => token.kind === "assignment").map(token => ({ target: token.target, valueSignature: token.value }));
    });
  const model = sourceAssignmentModel(source, assignments);
  if (!model.ok || model.kind !== "event-prefix") return invalid("row_choice_clear_prefix_unproven");
  const proof = validateAdditionalEventAssignments(source, reviewed, assignments, model.kind, { fields: targetFields });
  if (!proof.ok) return proof;
  for (const call of sourceClears.calls) {
    const originals = (sourceControls || []).filter(field => field.id === call.target);
    const targets = (targetFields || []).filter(field => field.id === call.target);
    if (originals.length !== 1 || originals[0].sourceType !== "checkbox" || targets.length !== 1 ||
        targets[0].sourceRef !== originals[0].sourceRef) return invalid("row_choice_clear_source_type_unproven");
    empty.source.set(call.index, [{ kind: "choice-clear", target: call.target, part: call.kind }]);
  }
  const targets = choiceClearCalls(reviewed, "target", new Set(assignments.map(assignment => assignment.target)));
  for (const call of targets.calls) empty.target.set(call.index, ["value", "checked"].map(part => ({ kind: "choice-clear", target: call.target, part })));
  return empty;
}

function synchronousRowEnvelope(text, legacy) {
  let program;
  try { program = parse(text, { ecmaVersion: "latest" }); } catch { return undefined; }
  if (astNodes(program).some(sourceSchedulingNode)) return undefined;
  let resolver = buildConditionOperandResolver(text);
  if (!resolver.entrypoint) resolver = buildConditionOperandResolver(text, { event: "onLoad" });
  const statements = program.body.filter(node => node.type !== "EmptyStatement");
  if (!resolver.entrypoint && legacy && !astNodes(program).some(node => /^(?:Function|ArrowFunction)/.test(node.type))) {
    return { body: program, resolver: buildConditionOperandResolver(text, { programIsEntrypoint: true }) };
  }
  const root = astNodes(program).find(node => node.start === resolver.entrypoint?.start && /^(?:Function|ArrowFunction)/.test(node.type));
  if (!root || root.async || root.generator || root.body.type !== "BlockStatement" || root.params.some(param => param.type !== "Identifier") || statements.length !== 1 ||
      astNodes(root.body).some(node => /^(?:Function|ArrowFunction)/.test(node.type))) return undefined;
  if (legacy) {
    const call = statements[0].type === "ExpressionStatement" && statements[0].expression;
    if (call?.type !== "CallExpression" || call.optional || call.callee.type !== "Identifier" ||
        !resolver.isUnshadowedGlobal(call.callee.name, call.start) || call.arguments.at(-1) !== root) return undefined;
    if (call.callee.name === "Com_AddEventListener") {
      if (call.arguments.length !== 3 || call.arguments[0].name !== "window" ||
          !resolver.isUnshadowedGlobal("window", call.start) || call.arguments[1].value !== "load" || root.params.length) return undefined;
    } else if (call.callee.name !== "AttachXFormValueChangeEventById" || call.arguments.length !== 2 ||
        call.arguments[0].type !== "Literal" || typeof call.arguments[0].value !== "string") return undefined;
  } else if (statements[0] !== root || root.type !== "FunctionDeclaration") return undefined;
  return { body: root.body, resolver };
}

function rowExpressionReads(node, { text, resolver, legacy }) {
  if (!node) return undefined;
  const expression = text.slice(node.start, node.end);
  if (!resolver.trace(expression, { beforeIndex: node.start }) && !conditionSpec(expression, resolver, node.start)) return undefined;
  function reads(item) {
    const trace = resolver.trace(text.slice(item.start, item.end), { beforeIndex: item.start });
    if (["CallExpression", "MemberExpression"].includes(item.type) && trace?.origin?.startsWith("field:") && !trace.transforms?.length) {
      // Source element references used only as assignment handles are not value reads.
      if (legacy && /^GetXFormFieldById\([^)]*\)(?:\s*\[\s*0\s*\])?$/.test(text.slice(item.start, item.end))) return [];
      return [{ kind: "read", field: trace.origin }];
    }
    const children = Object.values(item).flatMap(value => Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [])
      .filter(value => typeof value.type === "string").sort((left, right) => left.start - right.start);
    const result = children.flatMap(reads);
    // Repeated inline reads in a short-circuit expression need an explicit
    // conditional read model; leave them unresolved instead of flattening it.
    if (item.type === "LogicalExpression" && result.length) {
      const nullableRead = item.operator === "??" && item.right.type === "Literal" && item.right.value === "" &&
        resolver.trace(text.slice(item.left.start, item.left.end), { beforeIndex: item.left.start })?.origin?.startsWith("field:");
      if (!nullableRead) return undefined;
    }
    return result;
  }
  const result = reads(node);
  return result?.every(Boolean) ? result : undefined;
}

function rowAssignmentTokens(node, context) {
  const { text, resolver, legacy } = context;
  const assignment = (target, value, expression) => {
    const reads = expression.type === "Literal" ? [] : rowExpressionReads(expression, context);
    return reads ? [...reads, { kind: "assignment", target, value }] : undefined;
  };
  if (legacy && node.type === "CallExpression" && !node.optional && node.callee.type === "Identifier" &&
      node.callee.name === "SetXFormFieldValueById" && resolver.isUnshadowedGlobal(node.callee.name, node.start) &&
      node.arguments.length === 3 && node.arguments[0].type === "Literal" && typeof node.arguments[0].value === "string" &&
      node.arguments[2].type === "Literal" && node.arguments[2].value === false) {
    const value = valueExpressionSignature(text.slice(node.arguments[1].start, node.arguments[1].end), resolver, node.start, text);
    if (value) return assignment(node.arguments[0].value, value, node.arguments[1]);
  }
  if (legacy && node.type === "AssignmentExpression" && node.operator === "=") {
    const target = traceStaticFieldValueExpression(text, text.slice(node.left.start, node.left.end), { resolver, beforeIndex: node.start });
    const value = valueExpressionSignature(text.slice(node.right.start, node.right.end), resolver, node.start, text);
    if (target?.origin?.startsWith("field:") && value && legacyAssignmentCalls(text, maskStringsAndComments(text)).some(call => call.index === node.start)) {
      return assignment(target.origin.slice(6), value, node.right);
    }
  }
  if (!legacy && node.type === "CallExpression" && !node.optional && node.callee.type === "MemberExpression" &&
      !node.callee.computed && !node.callee.optional && node.callee.object.name === "MKXFORM" && node.callee.property.name === "setValue" &&
      resolver.isUnshadowedGlobal("MKXFORM", node.start) && node.arguments.length === 2 && node.arguments[0].type === "Literal") {
    const expression = text.slice(node.arguments[1].start, node.arguments[1].end);
    const value = valueExpressionSignature(expression, resolver, node.start, text);
    const traced = resolver.trace(expression, { beforeIndex: node.start });
    // The existing helper setter recipe selects the first event value. Keep that
    // one established normalization in the order audit, without allowing arbitrary transforms.
    const normalized = traced?.origin === "event:value" && JSON.stringify(traced.transforms) === '["array-first"]' ? "event:value" : undefined;
    if (value || normalized) return assignment(node.arguments[0].value, value || normalized, node.arguments[1]);
  }
  return undefined;
}

// The OR route proves only reads, literal row attributes and field assignments.
// Other calls/effects cannot borrow that proof merely by preserving its guard.
function validateOrTargetShape(source, reviewed) {
  const maskedSource = maskStringsAndComments(source);
  const hasRows = legacyRowCalls(source, maskedSource).length > 0;
  const hasAssignments = legacyAssignmentCalls(source, maskedSource).length > 0;
  let program;
  let sourceProgram;
  try {
    program = parse(reviewed, { ecmaVersion: "latest" });
    sourceProgram = parse(source, { ecmaVersion: "latest" });
  }
  catch { return invalid("or_target_shape_unparseable"); }
  let resolver = buildConditionOperandResolver(reviewed);
  if (!resolver.entrypoint) resolver = buildConditionOperandResolver(reviewed, { event: "onLoad" });
  if (!resolver.entrypoint) return invalid("or_target_entrypoint_unproven");
  const root = program.body.filter(node => node.type !== "EmptyStatement");
  if (root.length !== 1 || root[0].type !== "FunctionDeclaration" ||
      root[0].start !== resolver.entrypoint.start || root[0].async || root[0].generator ||
      root[0].params.some(parameter => parameter.type !== "Identifier") ||
      !orStatementsSupported(root[0].body, resolver, reviewed)) {
    return invalid("or_target_control_flow_unproven");
  }
  let sourceResolver = buildConditionOperandResolver(source);
  if (!sourceResolver.entrypoint) sourceResolver = buildConditionOperandResolver(source, { event: "onLoad" });
  const sourceNodes = astNodes(sourceProgram);
  const sourceRoot = sourceNodes.find(node => /^(?:Function|ArrowFunction)/.test(node.type) &&
    node.start === sourceResolver.entrypoint?.start);
  if (!sourceRoot) return invalid("source_or_entrypoint_unproven");
  const focusedSourceNodes = astNodes(sourceRoot);
  if (focusedSourceNodes.some(sourceSchedulingNode)) return invalid("source_or_scheduling_unproven");
  if (sourceRoot.params.some(parameter => parameter.type !== "Identifier") ||
      focusedSourceNodes.some(node => node !== sourceRoot && /^(?:Function|ArrowFunction)/.test(node.type)) ||
      !orStatementsSupported(sourceRoot.body, sourceResolver, source, true)) {
    return invalid("source_or_control_flow_unproven");
  }
  let ok = true;
  function visit(node, parent, provenTest = false) {
    if (!node || typeof node !== "object") return;
    if (["AssignmentExpression", "UpdateExpression", "NewExpression", "ThisExpression"].includes(node.type) ||
        node.type === "UnaryExpression" && node.operator === "delete" ||
        node.type === "Identifier" && ["window", "globalThis", "self"].includes(node.name)) ok = false;
    if (/^(?:Function|ArrowFunction)/.test(node.type) && node.start !== resolver.entrypoint.start) ok = false;
    if (node.type === "Identifier" && node.name === "MKXFORM" &&
        (parent?.type !== "MemberExpression" || parent.object !== node)) ok = false;
    if (node.type === "MemberExpression" && node.object?.name === "MKXFORM") {
      const method = node.property?.name;
      const supported = method === "getValue" || method === "setValue" && hasAssignments ||
        method === "setFieldAttr" && hasRows;
      if (!supported || node.computed || node.optional || parent?.type !== "CallExpression" ||
          parent.callee !== node || parent.optional ||
          !resolver.isUnshadowedGlobal("MKXFORM", node.start)) ok = false;
    }
    if (node.type === "CallExpression") {
      const member = node.callee;
      if (member?.type === "MemberExpression" && member.object?.name === "MKXFORM") {
        if (node.arguments[0]?.type !== "Literal" || typeof node.arguments[0].value !== "string" ||
            node.arguments.length !== (member.property?.name === "getValue" ? 1 : 2)) ok = false;
      } else if (!provenTest) {
        const primitive = member?.type === "Identifier" && ["String", "Number"].includes(member.name) &&
          resolver.isUnshadowedGlobal(member.name, node.start) &&
          resolver.trace(reviewed.slice(node.start, node.end), { beforeIndex: node.start });
        const diagnostic = member?.type === "MemberExpression" && member.object?.name === "console" &&
          orSourceExpressionSupported(node, resolver, reviewed);
        if (!primitive && !diagnostic) ok = false;
      }
    }
    if (node.type === "IfStatement") {
      const test = conditionSpec(reviewed.slice(node.test.start, node.test.end), resolver, node.test.start);
      visit(node.test, node, Boolean(test));
      visit(node.consequent, node);
      visit(node.alternate, node);
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, node, provenTest));
      else if (value && typeof value === "object") visit(value, node, provenTest);
    }
  }
  visit(program);
  return ok ? { ok: true } : invalid("or_target_effect_unproven");
}

function orStatementsSupported(node, resolver, source, legacy = false) {
  if (node?.type === "BlockStatement") {
    return node.body.every(statement => orStatementsSupported(statement, resolver, source, legacy));
  }
  if (node?.type === "EmptyStatement") return true;
  if (node?.type === "VariableDeclaration") {
    return node.declarations.every(item => item.id.type === "Identifier" && (!item.init ||
      item.init.type === "Literal" && (item.init.value === null ||
        ["string", "number", "boolean"].includes(typeof item.init.value)) ||
      resolver.trace(source.slice(item.init.start, item.init.end), { beforeIndex: item.init.start })));
  }
  if (node?.type === "ExpressionStatement") {
    return legacy ? orSourceExpressionSupported(node.expression, resolver, source)
      : node.expression.type === "CallExpression";
  }
  if (node?.type !== "IfStatement" || node.consequent.type !== "BlockStatement" ||
      !conditionSpec(source.slice(node.test.start, node.test.end), resolver, node.test.start)) return false;
  return orStatementsSupported(node.consequent, resolver, source, legacy) &&
    (!node.alternate || ["BlockStatement", "IfStatement"].includes(node.alternate.type) &&
      orStatementsSupported(node.alternate, resolver, source, legacy));
}

function orSourceExpressionSupported(node, resolver, source) {
  const text = source.slice(node.start, node.end);
  const masked = maskStringsAndComments(source);
  if (node.type === "AssignmentExpression") {
    const left = traceStaticFieldValueExpression(source, source.slice(node.left.start, node.left.end), {
      resolver, beforeIndex: node.start
    });
    return node.operator === "=" && left?.origin?.startsWith("field:") &&
      legacyAssignmentCalls(source, masked).some(call => call.index === node.start) &&
      Boolean(valueExpressionSignature(source.slice(node.right.start, node.right.end), resolver, node.start, source));
  }
  if (node.type !== "CallExpression" || node.optional) return false;
  if (resolver.trace(text, { beforeIndex: node.start })) return true;
  const callee = node.callee;
  if (callee.type === "Identifier" && callee.name === "common_dom_row_set_show_required_reset") {
    return resolver.isUnshadowedGlobal(callee.name, node.start) && node.arguments.length === 4 &&
      legacyRowCalls(source, masked).some(call => call.index === node.start);
  }
  // Reuse the exact source clear recognizer; the assignment proof separately
  // requires the typed checkbox pair and matching target clear/guards.
  const clears = choiceClearCalls(source, "source", new Set());
  if (clears.ok && clears.calls.some(call => call.index === node.start)) return true;
  if (callee.type !== "MemberExpression" || callee.computed || callee.optional ||
      callee.object?.type !== "Identifier" || callee.object.name !== "console" ||
      !resolver.isUnshadowedGlobal("console", node.start)) return false;
  const name = `console.${callee.property?.name}`;
  const debugOnly = JS_METHOD_CATALOG.staticMethods.some(entry =>
    entry.name === name && entry.status === "supported" && entry.notes?.startsWith("Debug only"));
  return debugOnly && node.arguments.every(argument =>
    argument.type === "Literal" && (argument.value === null ||
      ["string", "number", "boolean"].includes(typeof argument.value)) ||
    resolver.trace(source.slice(argument.start, argument.end), { beforeIndex: argument.start }));
}

function astNodes(root) {
  const nodes = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object" || typeof node.type !== "string") continue;
    nodes.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === "object") pending.push(value);
    }
  }
  return nodes;
}

function sourceSchedulingNode(node) {
  const schedulers = ["setTimeout", "setInterval", "queueMicrotask", "requestAnimationFrame", "requestIdleCallback"];
  if (/^(?:Function|ArrowFunction)/.test(node.type) && (node.async || node.generator)) return true;
  if (["AwaitExpression", "YieldExpression"].includes(node.type)) return true;
  if (node.type === "Identifier" && schedulers.includes(node.name)) return true;
  if (node.type === "NewExpression" && node.callee?.name === "Promise") return true;
  if (node.type !== "MemberExpression") return false;
  const member = node.computed ? node.property?.value : node.property?.name;
  return [...schedulers, "then", "catch", "finally"].includes(member);
}

function sourceAssignmentModel(source, expectedAssignments) {
  if (!source) return invalid("source_function_missing");
  const masked = maskStringsAndComments(source);
  const calls = legacyAssignmentCalls(source, masked);
  if (calls.length !== expectedAssignments.length) {
    return invalid("source_assignment_count_changed", {
      expectedCount: expectedAssignments.length,
      observedCount: calls.length
    });
  }
  const pairedCalls = calls.map((call, index) => ({
    ...call,
    target: expectedAssignments[index]?.target
  }));
  if (pairedCalls.some((call, index) => (
    call.valueSignature !== expectedAssignments[index]?.valueSignature
  ))) {
    return invalid("source_assignment_evidence_order_changed");
  }

  const resolver = buildOperandResolver(source, masked);
  const prefix = eventAssignmentPrefixModel(source, pairedCalls, resolver);
  if (prefix) return prefix;
  const model = assignmentBranchModel(
    source,
    masked,
    pairedCalls,
    resolver
  );
  if (!model.ok) return model;
  if (model.flattenedCallCount !== pairedCalls.length) {
    return invalid("source_assignment_outside_condition_chain");
  }
  return model;
}

function targetAssignmentModel(functionText, expectedAssignments) {
  const source = String(functionText || "");
  const masked = maskStringsAndComments(source);
  const functionBody = primaryFunctionBody(masked);
  if (!functionBody) return invalid("target_function_body_unparseable");
  const expectedTargets = new Set(expectedAssignments.map((assignment) => assignment.target));
  const allCalls = targetCalls(source, "MKXFORM.setValue");
  if (allCalls.some((call) => call.target === undefined)) {
    return invalid("dynamic_set_value_target");
  }
  const calls = allCalls.filter((call) => expectedTargets.has(call.target));
  if (calls.length !== expectedAssignments.length) {
    return invalid("target_assignment_count_changed", {
      expectedCount: expectedAssignments.length,
      observedCount: calls.length
    });
  }
  const resolver = buildOperandResolver(source, masked);
  const prefix = eventAssignmentPrefixModel(source, calls, resolver);
  if (prefix) return prefix;
  const model = assignmentBranchModel(
    source,
    masked,
    calls,
    resolver,
    functionBody.depth
  );
  if (!model.ok) return model;
  if (model.flattenedCallCount !== calls.length) {
    return invalid("target_assignment_outside_condition_chain");
  }
  return model;
}

// Unconditional event copies may precede row conditions. Keep every write in
// order and require direct statements before control flow; row/condition
// behavior remains subject to its separate semantic-closure checks.
function eventAssignmentPrefixModel(source, calls, resolver) {
  if (!calls.length || calls.some((call) => call.valueSignature !== "event:value")) {
    return undefined;
  }
  const body = entrypointBody(source, resolver.entrypoint);
  if (!body) return undefined;
  const directStatements = body.body.filter((statement) => (
    statement.type === "ExpressionStatement" &&
    ["AssignmentExpression", "CallExpression"].includes(statement.expression.type)
  ));
  const directIndexes = new Set(directStatements.map((statement) => statement.expression.start));
  if (!calls.some((call) => directIndexes.has(call.index))) return undefined;
  if (calls.some((call) => !directIndexes.has(call.index))) {
    return invalid("event_assignment_not_unconditional");
  }
  for (const call of calls) {
    const expression = directStatements.find((statement) => statement.expression.start === call.index)?.expression;
    if (expression?.type !== "AssignmentExpression") continue;
    const target = resolver.trace(source.slice(expression.left.start, expression.left.end), { beforeIndex: call.index });
    if (expression.operator !== "=" || target?.origin !== `field:${call.target}` || target.transforms?.length) {
      return invalid("event_assignment_source_target_unproven");
    }
  }
  const lastAssignment = calls.at(-1).index;
  if (body.body.some((statement) => statement.start < lastAssignment &&
      !["VariableDeclaration", "ExpressionStatement", "EmptyStatement"].includes(statement.type))) {
    return invalid("event_assignment_after_control_flow");
  }
  if (calls.some((call) => /^MKXFORM\s*\.\s*setValue\b/.test(source.slice(call.index)) &&
      !resolver.isUnshadowedGlobal("MKXFORM", call.index))) {
    return invalid("event_assignment_api_shadowed");
  }
  return {
    ok: true,
    kind: "event-prefix",
    conditions: [],
    branches: [assignmentSignatures(calls)],
    flattenedCallCount: calls.length
  };
}

function entrypointBody(source, entrypoint) {
  if (!entrypoint) return undefined;
  let program;
  try {
    program = parse(source, { ecmaVersion: "latest" });
  } catch {
    return undefined;
  }
  const pending = [program];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type) &&
        node.start === entrypoint.start && node.body?.type === "BlockStatement") {
      return node.body;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === "object") pending.push(value);
    }
  }
  return undefined;
}

// A checkbox's serialized value and its checked inputs are one source choice.
// Only this exact paired clear is allowed beside a prefix copy; every other
// extra target write remains unproved, including a missing or moved clear.
function validateAdditionalEventAssignments(source, reviewed, assignments, kind, form) {
  const targets = new Set(assignments.map((assignment) => assignment.target));
  const sourceCalls = choiceClearCalls(source, "source", targets);
  const targetCalls = choiceClearCalls(reviewed, "target", targets);
  if (!sourceCalls.ok || !targetCalls.ok) return invalid("additional_assignment_unproven");
  if (targetCalls.primaryCalls.length !== assignments.length) {
    return invalid("event_assignment_call_count_changed");
  }
  if (!sourceCalls.calls.length && !targetCalls.calls.length) return { ok: true };
  if (kind !== "event-prefix") return invalid("additional_assignment_shape_unsupported");
  const fields = new Map((form?.fields || []).map((field) => [field.id, field]));
  const expected = [];
  for (let index = 0; index < sourceCalls.calls.length; index += 2) {
    const value = sourceCalls.calls[index];
    const checked = sourceCalls.calls[index + 1];
    if (value?.kind !== "value" || checked?.kind !== "checked" ||
        value.target !== checked.target || !value.guards?.length ||
        JSON.stringify(value.guards) !== JSON.stringify(checked.guards) ||
        fields.get(value.target)?.componentId !== "xform-checkbox" ||
        fields.get(value.target)?.dataOnly === true) {
      return invalid("source_choice_clear_unproven");
    }
    expected.push({ target: value.target, guards: value.guards });
  }
  const observed = targetCalls.calls.map(({ target, guards }) => ({ target, guards }));
  return JSON.stringify(expected) === JSON.stringify(observed)
    ? { ok: true }
    : invalid("additional_assignment_changed", { expected, observed });
}

function choiceClearCalls(source, mode, assignmentTargets) {
  let resolver = buildConditionOperandResolver(source);
  if (!resolver.entrypoint) resolver = buildConditionOperandResolver(source, { event: "onLoad" });
  const body = entrypointBody(source, resolver.entrypoint);
  if (!body) return { ok: false };
  const calls = [];
  const primaryCalls = [];
  let ok = true;
  let root = body;
  if (mode === "target") {
    try { root = parse(source, { ecmaVersion: "latest" }); }
    catch { return { ok: false }; }
  }
  const inspectTargetReference = (node, parent) => {
    if (mode !== "target") return;
    if (node.type === "ThisExpression" || node.type === "Identifier" &&
        ["globalThis", "window", "self"].includes(node.name)) ok = false;
    if (node.type === "Identifier" && node.name === "MKXFORM") {
      if (parent?.type !== "MemberExpression" || parent.object !== node || parent.computed ||
          !resolver.isUnshadowedGlobal("MKXFORM", node.start)) ok = false;
    }
    if (node.type !== "MemberExpression") return;
    const memberName = node.computed ? node.property?.value : node.property?.name;
    if (memberName === "setValue" &&
        (node.computed || node.object?.type !== "Identifier" || node.object.name !== "MKXFORM")) ok = false;
    if (node.computed && node.property?.type === "Literal" && node.property.value === "MKXFORM") {
      ok = false;
    }
    if (node.object?.type === "Identifier" && node.object.name === "MKXFORM" &&
        (node.computed || node.optional || parent?.type !== "CallExpression" ||
          parent.callee !== node || parent.optional)) ok = false;
  };
  const inspect = (node, guards, direct) => {
    if (node.type !== "CallExpression" || node.callee?.type !== "MemberExpression" || node.callee.computed) return;
    const member = node.callee;
    if (mode === "target") {
      if (member.object?.name !== "MKXFORM" || member.property?.name !== "setValue") return;
      const target = node.arguments[0]?.type === "Literal" ? node.arguments[0].value : undefined;
      if (!direct || !guards || typeof target !== "string" || node.arguments.length !== 2 ||
          !resolver.isUnshadowedGlobal("MKXFORM", node.start)) { ok = false; return; }
      if (assignmentTargets.has(target)) { primaryCalls.push({ target, index: node.start }); return; }
      if (node.arguments[1]?.type !== "ArrayExpression" || node.arguments[1].elements.length !== 0) {
        ok = false; return;
      }
      calls.push({ target, guards, index: node.start });
      return;
    }
    const method = member.property?.name;
    if (!["val", "prop"].includes(method) || !node.arguments.length) return;
    if (method === "prop" && node.arguments.length < 2) return;
    const query = member.object;
    const selector = query?.type === "CallExpression" && query.callee?.name === "$" &&
      query.arguments.length === 1 && query.arguments[0]?.type === "Literal"
      ? query.arguments[0].value : undefined;
    const match = typeof selector === "string" && selector.match(
      /^input\[name=(["'])(_?)extendDataFormInfo\.value\(([A-Za-z_][A-Za-z0-9_]*)\)\1\]$/
    );
    const valueClear = method === "val" && node.arguments.length === 1 &&
      node.arguments[0]?.type === "Literal" && node.arguments[0].value === "";
    const checkedClear = method === "prop" && node.arguments.length === 2 &&
      node.arguments[0]?.type === "Literal" && node.arguments[0].value === "checked" &&
      node.arguments[1]?.type === "Literal" && node.arguments[1].value === false;
    if (!direct || !guards || !match || !resolver.isUnshadowedGlobal("$", node.start) ||
        !(valueClear && match[2] === "" || checkedClear && match[2] === "_")) {
      ok = false; return;
    }
    calls.push({ target: match[3], kind: valueClear ? "value" : "checked", guards, index: node.start });
  };
  const visit = (node, guards, direct = false, parent) => {
    if (!node || typeof node !== "object") return;
    if (mode === "target" && node.type === "BlockStatement" && node.start === body.start) guards = [];
    inspectTargetReference(node, parent);
    inspect(node, guards, direct);
    if (node.type === "IfStatement") {
      const condition = conditionSpec(source.slice(node.test.start, node.test.end), resolver, node.test.start);
      visit(node.test, undefined, false, node);
      visit(node.consequent, guards && condition ? [...guards, { condition, branch: true }] : undefined, false, node);
      visit(node.alternate, guards && condition ? [...guards, { condition, branch: false }] : undefined, false, node);
      return;
    }
    const blocked = /^(?:For|While|DoWhile|Switch|Try|With|Function|ArrowFunction|ConditionalExpression|LogicalExpression)/.test(node.type);
    for (const [key, value] of Object.entries(node)) {
      const nextGuards = blocked ? undefined : guards;
      const nextDirect = node.type === "ExpressionStatement" && key === "expression";
      if (Array.isArray(value)) for (const child of value) visit(child, nextGuards, nextDirect, node);
      else if (value && typeof value === "object") visit(value, nextGuards, nextDirect, node);
    }
  };
  visit(root, mode === "source" ? [] : undefined);
  return { ok, calls, primaryCalls };
}

function assignmentBranchModel(source, masked, calls, resolveOperand, requiredDepth) {
  const candidate = selectSingleChain(source, masked, calls, requiredDepth);
  if (candidate.ok) {
    return assignmentBranchesForChain(candidate.chain, calls, masked, resolveOperand);
  }
  if (candidate.reason !== "multiple_condition_chains") return candidate;

  const chains = conditionalChains(source, masked)
    .filter((chain) => requiredDepth === undefined || chain.depth === requiredDepth)
    .filter((chain) => chain.branches.some((branch) => (
      directCalls(calls, masked, branch.bodyStart, branch.bodyEnd, chain.depth + 1).length > 0
    )));
  if (
    chains.length < 2 ||
    chains.some((chain) => chain.branches.length !== 1 || chain.elseBody)
  ) return candidate;

  const conditions = chains.map((chain) => conditionSpec(
    chain.branches[0].condition,
    resolveOperand,
    chain.branches[0].conditionStart
  ));
  if (
    conditions.some((condition) => !condition || condition.kind !== "eq") ||
    new Set(conditions.map((condition) => condition.operand)).size !== 1 ||
    new Set(conditions.map(conditionKey)).size !== conditions.length
  ) return invalid("independent_assignment_conditions_unproven");

  const branches = chains.map((chain) => assignmentSignatures(directCalls(
    calls,
    masked,
    chain.branches[0].bodyStart,
    chain.branches[0].bodyEnd,
    chain.depth + 1
  )));
  if (branches.some((branch) => branch.length === 0)) {
    return invalid("assignment_branch_empty");
  }
  const flattenedCallCount = branches.reduce((count, branch) => count + branch.length, 0);
  if (flattenedCallCount !== calls.length) {
    return invalid("assignment_outside_independent_conditions");
  }
  return { ok: true, conditions, branches, flattenedCallCount };
}

function assignmentBranchesForChain(chain, calls, masked, resolveOperand) {
  const conditions = chain.branches.map((branch) => (
    conditionSpec(branch.condition, resolveOperand, branch.conditionStart)
  ));
  if (conditions.some((condition) => !condition)) {
    return invalid("condition_not_statically_supported");
  }
  const branches = chain.branches.map((branch) => assignmentSignatures(
    directCalls(calls, masked, branch.bodyStart, branch.bodyEnd, chain.depth + 1)
  ));
  if (!chain.elseBody) return invalid("assignment_else_branch_missing");
  branches.push(assignmentSignatures(
    directCalls(calls, masked, chain.elseBody.start, chain.elseBody.end, chain.depth + 1)
  ));
  if (branches.some((branch) => branch.length === 0)) {
    return invalid("assignment_branch_empty");
  }
  return {
    ok: true,
    conditions,
    branches,
    flattenedCallCount: branches.reduce((count, branch) => count + branch.length, 0)
  };
}

function assignmentSignatures(calls) {
  return calls.map((call) => `${call.target}:${call.valueSignature}`);
}

function sourceRowModel(source, resolved, canonicalTarget) {
  if (!source) return invalid("source_function_missing");
  const masked = maskStringsAndComments(source);
  const calls = legacyRowCalls(source, masked)
    .filter((call) => resolved.has(call.target))
    .map((call) => ({ ...call, target: canonicalTarget(call.target) }));
  if (!calls.length) return invalid("source_row_effects_missing");
  const candidate = selectSingleChain(source, masked, calls);
  if (!candidate.ok) {
    const attributesByState = new Map();
    for (const call of calls) {
      const key = `${call.target}:${attributeDimension(call.attribute)}`;
      if (!attributesByState.has(key)) attributesByState.set(key, new Set());
      attributesByState.get(key).add(call.attribute);
    }
    if (
      candidate.reason === "condition_chain_missing" &&
      [...attributesByState.values()].every((attributes) => attributes.size === 1)
    ) {
      return {
        ok: true,
        trivial: true,
        conditions: [],
        states: new Map([["always", applyRowCalls(calls)]])
      };
    }
    return candidate;
  }
  return rowModelForConditionalChain(candidate.chain, calls, masked, {
    allowPrelude: true,
    sourceMode: true,
    resolveOperand: buildOperandResolver(source, masked)
  });
}

function targetTrivialRowModel(functionText, targetIds) {
  const source = String(functionText || "");
  const masked = maskStringsAndComments(source);
  const functionBody = primaryFunctionBody(masked);
  if (!functionBody) return invalid("target_function_body_unparseable");
  const allCalls = targetCalls(source, "MKXFORM.setFieldAttr");
  if (allCalls.some((call) => call.target === undefined)) {
    return invalid("dynamic_set_field_attr_target");
  }
  const calls = allCalls.filter((call) => targetIds.has(call.target));
  if (!calls.length) return invalid("target_row_effects_missing");
  if (calls.some((call) => braceDepthAt(masked, call.index) !== functionBody.depth)) {
    return invalid("target_row_effect_not_top_level");
  }
  if (calls.some((call) => !Number.isInteger(call.attribute))) {
    return invalid("target_row_attribute_not_static");
  }
  const stateKeys = calls.map((call) => `${call.target}:${attributeDimension(call.attribute)}`);
  if (new Set(stateKeys).size !== stateKeys.length) {
    return invalid("target_row_state_enumerated");
  }
  return {
    ok: true,
    conditions: [],
    states: new Map([["always", applyRowCalls(calls)]])
  };
}

function targetConditionalRowModel(functionText, targetIds, expectedConditions) {
  const source = String(functionText || "");
  const masked = maskStringsAndComments(source);
  const functionBody = primaryFunctionBody(masked);
  if (!functionBody) return invalid("target_function_body_unparseable");
  const allCalls = targetCalls(source, "MKXFORM.setFieldAttr");
  if (allCalls.some((call) => call.target === undefined)) {
    return invalid("dynamic_set_field_attr_target");
  }
  if (expectedConditions.some((condition) => condition.kind === "or") &&
      allCalls.some((call) => !targetIds.has(call.target) || ![3, 4, 5, 6].includes(call.attribute))) {
    return invalid("additional_row_attribute_unproven");
  }
  const calls = allCalls.filter((call) => targetIds.has(call.target));
  if (!calls.length) return invalid("target_row_effects_missing");
  const candidate = selectSingleChain(source, masked, calls, functionBody.depth);
  if (!candidate.ok) return candidate;
  const model = rowModelForConditionalChain(candidate.chain, calls, masked, {
    allowPrelude: true,
    sourceMode: false,
    resolveOperand: buildOperandResolver(source, masked)
  });
  if (!model.ok) return model;
  if (!sameConditionSequence(expectedConditions, model.conditions)) {
    return invalid("target_row_condition_chain_changed", {
      expectedConditions,
      observedConditions: model.conditions
    });
  }
  return model;
}

function rowModelForConditionalChain(chain, calls, masked, options) {
  const conditions = chain.branches.map((branch) => (
    conditionSpec(branch.condition, options.resolveOperand, branch.conditionStart)
  ));
  if (conditions.some((condition) => !condition)) {
    return invalid("condition_not_statically_supported");
  }
  const block = enclosingBlock(masked, chain.start);
  if (!block) return invalid("condition_parent_block_unparseable");
  const prelude = options.allowPrelude
    ? directCalls(calls, masked, block.start + 1, chain.start, chain.depth)
    : [];
  const branchCalls = chain.branches.map((branch) => (
    directCalls(calls, masked, branch.bodyStart, branch.bodyEnd, chain.depth + 1)
  ));
  const elseCalls = chain.elseBody
    ? directCalls(calls, masked, chain.elseBody.start, chain.elseBody.end, chain.depth + 1)
    : [];
  const coveredCount = prelude.length + elseCalls.length +
    branchCalls.reduce((count, branch) => count + branch.length, 0);
  if (coveredCount !== calls.length) {
    return invalid("row_effect_outside_condition_chain");
  }
  if (branchCalls.some((branch) => branch.length === 0)) {
    return invalid("row_effect_branch_empty");
  }
  const allStateCalls = [...prelude, ...branchCalls.flat(), ...elseCalls];
  if (allStateCalls.some((call) => !Number.isInteger(call.attribute))) {
    return invalid(options.sourceMode
      ? "source_row_attribute_unparseable"
      : "target_row_attribute_not_static");
  }

  const states = new Map();
  conditions.forEach((condition, index) => {
    states.set(conditionKey(condition), applyRowCalls(prelude, branchCalls[index]));
  });
  if (chain.elseBody || prelude.length) {
    states.set("else", applyRowCalls(prelude, elseCalls));
  }
  return { ok: true, conditions, states };
}

function targetTernaryRowModel(functionText, targetIds, expectedConditions) {
  if (expectedConditions.some((condition) => condition.kind !== "eq")) {
    return invalid("ternary_mode_requires_equality_conditions");
  }
  const source = String(functionText || "");
  const masked = maskStringsAndComments(source);
  const functionBody = primaryFunctionBody(masked);
  if (!functionBody) return invalid("target_function_body_unparseable");
  const allCalls = targetCalls(source, "MKXFORM.setFieldAttr");
  if (allCalls.some((call) => call.target === undefined)) {
    return invalid("dynamic_set_field_attr_target");
  }
  const calls = allCalls.filter((call) => targetIds.has(call.target));
  if (!calls.length) return invalid("target_row_effects_missing");
  if (calls.some((call) => braceDepthAt(masked, call.index) !== functionBody.depth)) {
    return invalid("target_row_effect_not_top_level");
  }

  const resolveOperand = buildOperandResolver(source, masked);
  const aliases = conditionAliases(source, masked, functionBody.depth, resolveOperand);
  const expectedKeys = new Set(expectedConditions.map(conditionKey));
  const observedKeys = new Set([...aliases.values()].map(conditionKey));
  const missingKeys = [...expectedKeys].filter((key) => !observedKeys.has(key));
  if (
    missingKeys.length > 0 &&
    !guardedBinaryEqualityDomain(
      source,
      expectedConditions,
      observedKeys,
      resolveOperand
    )
  ) {
    return invalid("target_row_condition_alias_missing");
  }

  const compiledCalls = calls.map((call) => compileTernaryRowCall(call, aliases));
  if (compiledCalls.some((call) => !call)) {
    return invalid("target_row_ternary_unparseable");
  }
  const states = new Map();
  for (const condition of expectedConditions) {
    const key = conditionKey(condition);
    states.set(key, applyCompiledRowCalls(compiledCalls, key));
  }
  states.set("else", applyCompiledRowCalls(compiledCalls, "else"));
  return { ok: true, conditions: expectedConditions, states };
}

function compileTernaryRowCall(call, aliases) {
  const expression = String(call.attributeExpression || "").trim();
  if (/^[3-6]$/.test(expression)) {
    return { target: call.target, when: undefined, yes: Number(expression), no: Number(expression) };
  }
  const match = expression.match(/^([A-Za-z_$][\w$]*)\s*\?\s*([3-6])\s*:\s*([3-6])$/);
  const condition = match ? aliases.get(match[1]) : undefined;
  if (!condition) return undefined;
  const yes = Number(match[2]);
  const no = Number(match[3]);
  if (attributeDimension(yes) !== attributeDimension(no)) return undefined;
  return { target: call.target, when: conditionKey(condition), yes, no };
}

function applyCompiledRowCalls(calls, scenario) {
  const state = new Map();
  for (const call of calls) {
    const attribute = call.when === undefined || call.when === scenario ? call.yes : call.no;
    state.set(`${call.target}:${attributeDimension(attribute)}`, attribute);
  }
  return state;
}

function conditionAliases(source, masked, depth, resolveOperand) {
  const aliases = new Map();
  const pattern = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  for (const match of source.matchAll(pattern)) {
    if (!codeVisibleAt(masked, match.index) || braceDepthAt(masked, match.index) !== depth) continue;
    const condition = conditionSpec(match[2], resolveOperand, match.index);
    if (condition) aliases.set(match[1], condition);
  }
  return aliases;
}

function selectSingleChain(source, masked, calls, requiredDepth) {
  const candidates = conditionalChains(source, masked)
    .filter((chain) => requiredDepth === undefined || chain.depth === requiredDepth)
    .filter((chain) => chain.branches.some((branch) => (
      directCalls(calls, masked, branch.bodyStart, branch.bodyEnd, chain.depth + 1).length > 0
    )));
  if (candidates.length !== 1) {
    return invalid(candidates.length ? "multiple_condition_chains" : "condition_chain_missing", {
      candidateCount: candidates.length
    });
  }
  return { ok: true, chain: candidates[0] };
}

function conditionalChains(source, masked = maskStringsAndComments(source)) {
  const chains = [];
  for (let index = 0; index < masked.length; index += 1) {
    if (!isKeywordAt(masked, index, "if") || precededByElse(masked, index)) continue;
    const chain = parseConditionalChain(source, masked, index);
    if (chain) chains.push(chain);
  }
  return chains;
}

function parseConditionalChain(source, masked, start) {
  const branches = [];
  let branchStart = start;
  let end = start;
  while (branchStart >= 0) {
    const conditionOpen = skipWhitespace(masked, branchStart + 2);
    if (masked[conditionOpen] !== "(") return undefined;
    const conditionClose = findBalancedClose(masked, conditionOpen, "(", ")");
    if (conditionClose < 0) return undefined;
    const bodyOpen = skipWhitespace(masked, conditionClose + 1);
    if (masked[bodyOpen] !== "{") return undefined;
    const bodyClose = findBalancedClose(masked, bodyOpen, "{", "}");
    if (bodyClose < 0) return undefined;
    branches.push({
      condition: source.slice(conditionOpen + 1, conditionClose),
      conditionStart: conditionOpen + 1,
      bodyStart: bodyOpen + 1,
      bodyEnd: bodyClose
    });
    end = bodyClose + 1;

    const elseIndex = skipWhitespace(masked, bodyClose + 1);
    if (!isKeywordAt(masked, elseIndex, "else")) break;
    const afterElse = skipWhitespace(masked, elseIndex + 4);
    if (isKeywordAt(masked, afterElse, "if")) {
      branchStart = afterElse;
      continue;
    }
    if (masked[afterElse] !== "{") return undefined;
    const elseClose = findBalancedClose(masked, afterElse, "{", "}");
    if (elseClose < 0) return undefined;
    return {
      start,
      end: elseClose + 1,
      depth: braceDepthAt(masked, start),
      branches,
      elseBody: { start: afterElse + 1, end: elseClose }
    };
  }
  return { start, end, depth: braceDepthAt(masked, start), branches, elseBody: undefined };
}

function targetCalls(source, name) {
  const resolver = buildConditionOperandResolver(source);
  return analyzeScriptFunction(source).calls
    .filter((call) => call.name === name)
    .map((call) => {
      const args = parseCallArguments(source, call.index, call.name);
      return {
        index: call.index,
        target: args ? staticStringValue(args[0]) : undefined,
        value: args?.[1]?.trim(),
        valueSignature: args
          ? valueExpressionSignature(args[1], resolver, call.index, source)
          : undefined,
        attribute: args && /^[3-6]$/.test(args[1].trim()) ? Number(args[1].trim()) : undefined,
        attributeExpression: args?.[1]
      };
    });
}

function legacyAssignmentCalls(source, masked) {
  const calls = [];
  const resolver = buildConditionOperandResolver(source);
  const pattern = /\b[A-Za-z_$][\w$]*(?:\s*\[\s*0\s*\])?\s*\.\s*value\s*=\s*([^;\n]+)/g;
  for (const match of source.matchAll(pattern)) {
    if (!codeVisibleAt(masked, match.index)) continue;
    calls.push({
      index: match.index,
      value: match[1].trim(),
      valueSignature: valueExpressionSignature(match[1], resolver, match.index, source)
    });
  }
  return calls;
}

function legacyRowCalls(source, masked) {
  const calls = [];
  const pattern = /\bcommon_dom_row_set_show_required_reset\(\s*(["'`])([^"'`]+)\1\s*,\s*(true|false)\s*,\s*(true|false)\s*,\s*(true|false)\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    if (!codeVisibleAt(masked, match.index)) continue;
    calls.push({
      index: match.index,
      target: match[2],
      visible: match[3] === "true",
      required: match[4] === "true",
      reset: match[5] === "true",
      attributes: [match[3] === "true" ? 5 : 4, match[4] === "true" ? 3 : 6]
    });
  }
  return calls.flatMap((call) => call.attributes.map((attribute) => ({
    index: call.index,
    target: call.target,
    attribute,
    reset: call.reset
  })));
}

function directCalls(calls, masked, start, end, depth) {
  return calls.filter((call) => (
    call.index >= start && call.index < end && braceDepthAt(masked, call.index) === depth
  ));
}

function applyRowCalls(...groups) {
  const state = new Map();
  for (const call of groups.flat()) {
    state.set(`${call.target}:${attributeDimension(call.attribute)}`, call.attribute);
  }
  return state;
}

function compareScenarioStates(expectedStates, observedStates) {
  for (const [scenario, expected] of expectedStates) {
    const observed = observedStates.get(scenario);
    // A source branch may contain no row-helper call at all. Omitting the
    // corresponding target else block is semantically the same as an empty
    // else block, so only require an observed scenario when the source owns
    // row state in that branch.
    if (!observed) {
      if (scenario === "else" && expected.size === 0) continue;
      return { scenario, reason: "scenario_missing" };
    }
    for (const [key, value] of expected) {
      if (observed.get(key) !== value) {
        return {
          scenario,
          state: key,
          expected: value,
          observed: observed.get(key)
        };
      }
    }
  }
  return undefined;
}

function sameConditionSequence(left, right) {
  return left.length === right.length && left.every((condition, index) => (
    conditionKey(condition) === conditionKey(right[index])
  ));
}

function sameBranchAssignments(left, right) {
  return left.length === right.length && left.every((branch, index) => (
    branch.length === right[index].length &&
    branch.every((signature, assignmentIndex) => signature === right[index][assignmentIndex])
  ));
}

function buildOperandResolver(source, masked = maskStringsAndComments(source)) {
  void masked;
  return buildConditionOperandResolver(source);
}

function conditionSpec(expression, resolveOperand, beforeIndex) {
  const parsed = parseProvenanceCondition(expression, resolveOperand, { beforeIndex });
  return parsed && ["eq", "contains", "regex-set", "or"].includes(parsed.kind)
    ? parsed
    : undefined;
}

function guardedBinaryEqualityDomain(source, expectedConditions, observedKeys, resolveOperand) {
  const expectedOperands = new Set(expectedConditions.map((condition) => condition.operand));
  if (
    expectedConditions.length !== 2 ||
    expectedConditions.some((condition) => condition.kind !== "eq") ||
    expectedOperands.size !== 1 ||
    observedKeys.size !== 1 ||
    (
      !observedKeys.has(conditionKey(expectedConditions[0])) &&
      !observedKeys.has(conditionKey(expectedConditions[1]))
    )
  ) {
    return false;
  }
  const expectedValues = new Set(expectedConditions.map((condition) => String(condition.value)));
  const guard = String(source || "").match(
    /\bif\s*\(\s*([A-Za-z_$][\w$]*)\s*!==?\s*(["'`])([^"'`]+)\2\s*&&\s*\1\s*!==?\s*(["'`])([^"'`]+)\4\s*\)\s*return\b/
  );
  return guard !== null &&
    expectedValues.size === 2 &&
    expectedValues.has(guard[3]) &&
    expectedValues.has(guard[5]) &&
    resolveOperand?.(guard[1], { beforeIndex: guard.index }) === expectedConditions[0].operand;
}

function conditionKey(condition) {
  if (condition.kind === "or") return JSON.stringify(compoundConditionShape(condition));
  // Branch effects must retain the literal type and equality coercion as well.
  return JSON.stringify({
    operand: condition.operand,
    kind: condition.kind,
    value: condition.value,
    values: condition.values,
    predicate: condition.predicate
  });
}

function compoundConditionShape(condition) {
  return condition.kind === "or"
    ? {
        kind: "or", operand: condition.operand,
        left: compoundConditionShape(condition.left),
        right: compoundConditionShape(condition.right)
      }
    : {
        kind: condition.kind, value: condition.value, operand: condition.operand,
        predicate: condition.predicate, transforms: condition.transforms
      };
}

function attributeDimension(attribute) {
  if (attribute === 4 || attribute === 5) return "visible";
  if (attribute === 3 || attribute === 6) return "required";
  return "unknown";
}

function parseResidualAssignment(residual, resolver, source) {
  const evidence = String(residual?.evidence || "").trim();
  const match = evidence.match(/\.\s*value\s*=\s*([\s\S]+?)\s*;?$/);
  const value = match?.[1]?.trim();
  const evidenceIndex = String(source || "").indexOf(evidence);
  const beforeIndex = evidenceIndex < 0 ? undefined : evidenceIndex + evidence.length;
  return {
    target: typeof residual?.target === "string" && residual.target.trim()
      ? residual.target
      : undefined,
    valueSignature: valueExpressionSignature(value, resolver, beforeIndex, source)
  };
}

function parseCallArguments(source, callIndex, callName) {
  let index = callIndex + callName.length;
  while (/\s/.test(source[index] || "")) index += 1;
  if (source[index] !== "(") return undefined;
  const close = findBalancedClose(maskStringsAndComments(source), index, "(", ")");
  if (close < 0) return undefined;
  const args = [];
  let start = index + 1;
  let parenDepth = 1;
  let bracketDepth = 0;
  let braceDepth = 0;
  const masked = maskStringsAndComments(source);
  for (let cursor = index + 1; cursor < close; cursor += 1) {
    const char = masked[cursor];
    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    else if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "," && parenDepth === 1 && bracketDepth === 0 && braceDepth === 0) {
      args.push(source.slice(start, cursor).trim());
      start = cursor + 1;
    }
  }
  args.push(source.slice(start, close).trim());
  return args;
}

function valueExpressionSignature(expression, resolver, beforeIndex, source) {
  if (typeof expression !== "string" || !expression.trim()) return undefined;
  const text = expression.trim().replace(/;\s*$/, "").trim();
  const eventTrace = resolver?.trace?.(text, { beforeIndex });
  if (eventTrace?.origin === "event:value" && !eventTrace.transforms?.length) {
    return "event:value";
  }
  const trace = traceStaticFieldValueExpression(source, text, { resolver, beforeIndex });
  if (trace?.origin && (!trace.transforms || trace.transforms.length === 0)) {
    return `field:${trace.origin.slice(6)}`;
  }
  const stringValue = staticStringValue(text);
  if (stringValue !== undefined) return `string:${JSON.stringify(stringValue)}`;
  if (/^(?:true|false|null|undefined|-?(?:\d+(?:\.\d*)?|\.\d+))$/.test(text)) {
    return `primitive:${text}`;
  }
  return undefined;
}

function staticStringValue(expression) {
  if (typeof expression !== "string" || expression.length < 2) return undefined;
  const text = expression.trim();
  const quote = text[0];
  if (!["'", "\"", "`"].includes(quote) || text.at(-1) !== quote) return undefined;
  if (quote === "`" && text.includes("${")) return undefined;
  try {
    if (quote === "\"") return JSON.parse(text);
  } catch {
    return undefined;
  }
  let output = "";
  for (let index = 1; index < text.length - 1; index += 1) {
    if (text[index] !== "\\") {
      output += text[index];
      continue;
    }
    index += 1;
    if (index >= text.length - 1) return undefined;
    const escaped = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" }[text[index]];
    output += escaped === undefined ? text[index] : escaped;
  }
  return output;
}

function primaryFunctionBody(masked) {
  const match = /\bfunction\b[^\n{]*\([^)]*\)\s*\{/.exec(masked);
  if (!match) return undefined;
  const open = masked.indexOf("{", match.index);
  const close = findBalancedClose(masked, open, "{", "}");
  if (close < 0) return undefined;
  return { start: open + 1, end: close, depth: braceDepthAt(masked, open) + 1 };
}

function enclosingBlock(masked, index) {
  const stack = [];
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (masked[cursor] === "{") stack.push(cursor);
    else if (masked[cursor] === "}") stack.pop();
  }
  const start = stack.at(-1);
  if (start === undefined) return { start: -1, end: masked.length };
  const end = findBalancedClose(masked, start, "{", "}");
  return end < 0 ? undefined : { start, end };
}

function braceDepthAt(masked, index) {
  let depth = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (masked[cursor] === "{") depth += 1;
    else if (masked[cursor] === "}") depth -= 1;
  }
  return depth;
}

function maskStringsAndComments(source) {
  let output = "";
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        output += "\n";
      } else output += " ";
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        output += "  ";
        index += 1;
        blockComment = false;
      } else output += char === "\n" ? "\n" : " ";
      continue;
    }
    if (quote) {
      if (char === "\\") {
        output += "  ";
        index += 1;
      } else if (char === quote) {
        output += " ";
        quote = "";
      } else output += char === "\n" ? "\n" : " ";
      continue;
    }
    if (char === "/" && next === "/") {
      output += "  ";
      index += 1;
      lineComment = true;
    } else if (char === "/" && next === "*") {
      output += "  ";
      index += 1;
      blockComment = true;
    } else if (["'", "\"", "`"].includes(char)) {
      output += " ";
      quote = char;
    } else output += char;
  }
  return output;
}

function stripOuterParentheses(expression) {
  let text = expression;
  while (text.startsWith("(")) {
    const masked = maskStringsAndComments(text);
    const close = findBalancedClose(masked, 0, "(", ")");
    if (close !== text.length - 1) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

function findBalancedClose(text, openIndex, openChar, closeChar) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === openChar) depth += 1;
    else if (text[index] === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function skipWhitespace(text, index) {
  let cursor = index;
  while (/\s/.test(text[cursor] || "")) cursor += 1;
  return cursor;
}

function isKeywordAt(text, index, keyword) {
  return text.slice(index, index + keyword.length) === keyword &&
    !/[A-Za-z0-9_$]/.test(text[index - 1] || "") &&
    !/[A-Za-z0-9_$]/.test(text[index + keyword.length] || "");
}

function precededByElse(masked, index) {
  const prefix = masked.slice(0, index);
  return /\belse\s*$/.test(prefix);
}

function codeVisibleAt(masked, index) {
  return masked[index] !== " ";
}

function invalid(reason, details = {}) {
  return { ok: false, reason, ...details };
}
