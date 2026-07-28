import {
  directIdentifierCall,
  parseJavascriptProgram,
  valueChangeCallbacks
} from "./value-change-callbacks.js";

export const SAME_ROW_RADIO_SELECTION_BASIS =
  "deterministic-same-row-radio-selection";

export function sameRowRadioSelectionCandidates(source = {}, form = {}) {
  const text = String(source.javascript || "");
  const program = parseJavascriptProgram(text);
  if (!program) return [];

  const functions = new Map(
    program.body
      .filter((statement) =>
        statement.type === "FunctionDeclaration" &&
        statement.id?.type === "Identifier"
      )
      .map((statement) => [statement.id.name, statement])
  );
  const helpers = new Map();
  for (const [name, declaration] of functions) {
    const helper = sameRowRadioHelper(declaration);
    if (helper) helpers.set(name, helper);
  }
  if (!helpers.size) return [];

  const sourceRef = source.sourceRef || source.id;
  const candidates = [];
  for (const binding of valueChangeCallbacks(source, program)) {
    for (const statement of binding.statements) {
      const call = directIdentifierCall(statement.node);
      const helper = helpers.get(call?.callee?.name);
      if (
        !helper ||
        call.arguments?.length !== 2 ||
        !identifierNamed(call.arguments[0], binding.valueParam) ||
        !identifierNamed(call.arguments[1], binding.domParam)
      ) {
        continue;
      }

      const resolved = resolveHelperAgainstForm(helper, binding.controlId, form);
      if (!resolved) continue;
      const idStem = source.id || sourceRef || "script";
      candidates.push({
        id: `${idStem}.onChange.${binding.start}.same-row-radio.${statement.start}`,
        dedupeKey: [
          binding.sourceActionKey,
          SAME_ROW_RADIO_SELECTION_BASIS,
          resolved.tableId,
          resolved.targetFieldId,
          statement.start
        ].join(":"),
        index: binding.start,
        effectIndex: statement.start,
        sourceActionKey: binding.sourceActionKey,
        event: "onChange",
        scope: "control",
        controlId: binding.controlId,
        tableId: resolved.tableId,
        javascript: text.slice(binding.start, binding.end),
        function: renderOnChange(resolved),
        translationStatus: "mapped",
        coverage: { status: "translated", nativeRules: [], residuals: [] },
        functionMappings: [{
          source: "same-row radio checked-index selection",
          target: "detail control onChange + MKXFORM.updateControl",
          basis: SAME_ROW_RADIO_SELECTION_BASIS,
          reviewRequired: false
        }],
        source,
        sourceRefs: [sourceRef],
        semanticHints: {
          coveredCalculationRanges: [
            {
              sourceRef,
              name: helper.name,
              start: helper.start,
              end: helper.end
            },
            {
              sourceRef,
              name: `onChange:${binding.controlId}:${helper.name}`,
              start: statement.start,
              end: statement.end
            }
          ],
          coveredCallbackStatementRanges: [{
            sourceRef,
            start: statement.start,
            end: statement.end
          }],
          sourceCallback: {
            start: binding.start,
            end: binding.end,
            statements: binding.statements.map(({ start, end, code }) => ({
              start,
              end,
              code
            }))
          },
          sameRowRadioSelection: {
            tableId: resolved.tableId,
            triggerFieldId: binding.controlId,
            targetFieldId: resolved.targetFieldId,
            cases: resolved.cases
          }
        }
      });
    }
  }
  return candidates;
}

function sameRowRadioHelper(declaration) {
  const params = declaration.params || [];
  if (
    params.length < 2 ||
    params[0]?.type !== "Identifier" ||
    params[1]?.type !== "Identifier" ||
    declaration.body?.type !== "BlockStatement"
  ) {
    return undefined;
  }
  const statements = declaration.body.body.filter((statement) =>
    statement.type !== "EmptyStatement"
  );
  if (statements.length !== 2) return undefined;
  const alias = sameRowFieldAlias(statements[0], params[1].name);
  if (!alias || statements[1].type !== "IfStatement") return undefined;
  const cases = checkedCases(statements[1], params[0].name, alias.name);
  if (!cases?.length) return undefined;
  return {
    name: declaration.id.name,
    start: declaration.start,
    end: declaration.end,
    targetFieldId: alias.fieldId,
    cases
  };
}

function sameRowFieldAlias(statement, domParam) {
  if (
    statement?.type !== "VariableDeclaration" ||
    statement.declarations?.length !== 1
  ) {
    return undefined;
  }
  const declaration = statement.declarations[0];
  const call = declaration.init;
  if (
    declaration.id?.type !== "Identifier" ||
    call?.type !== "CallExpression" ||
    call.callee?.type !== "Identifier" ||
    call.callee.name !== "GetXFormSameRowFieldById" ||
    call.arguments?.length !== 2 ||
    !zeroIndexedIdentifier(call.arguments[0], domParam)
  ) {
    return undefined;
  }
  const fieldId = literalString(call.arguments[1]);
  return fieldId ? { name: declaration.id.name, fieldId } : undefined;
}

function checkedCases(root, valueParam, alias) {
  const cases = [];
  let branch = root;
  while (branch?.type === "IfStatement") {
    const sourceValue = equalityLiteral(branch.test, valueParam);
    const effect = checkedEffect(branch.consequent, alias);
    if (sourceValue === undefined || !effect) return undefined;
    cases.push({ sourceValue, ...effect });
    if (!branch.alternate) break;
    if (branch.alternate.type !== "IfStatement") return undefined;
    branch = branch.alternate;
  }
  return new Set(cases.map((entry) => entry.sourceValue)).size === cases.length
    ? cases
    : undefined;
}

function equalityLiteral(expression, valueParam) {
  if (
    expression?.type !== "BinaryExpression" ||
    !["==", "==="].includes(expression.operator)
  ) {
    return undefined;
  }
  if (identifierNamed(expression.left, valueParam)) {
    return literalString(expression.right);
  }
  if (identifierNamed(expression.right, valueParam)) {
    return literalString(expression.left);
  }
  return undefined;
}

function checkedEffect(statement, alias) {
  const statements = statement?.type === "BlockStatement"
    ? statement.body.filter((candidate) => candidate.type !== "EmptyStatement")
    : [statement];
  const assignments = statements.map((candidate) =>
    checkedAssignment(candidate, alias)
  );
  if (assignments.some((assignment) => !assignment)) return undefined;
  if (assignments.length === 1 && assignments[0].checked === true) {
    return { kind: "select", optionIndex: assignments[0].optionIndex };
  }
  if (
    assignments.length === 2 &&
    assignments[0].checked === true &&
    assignments[1].checked === false &&
    assignments[0].optionIndex === assignments[1].optionIndex
  ) {
    return { kind: "clear" };
  }
  return undefined;
}

function checkedAssignment(statement, alias) {
  const assignment = statement?.type === "ExpressionStatement"
    ? statement.expression
    : undefined;
  const checkedMember = assignment?.left;
  const indexed = checkedMember?.object;
  if (
    assignment?.type !== "AssignmentExpression" ||
    assignment.operator !== "=" ||
    checkedMember?.type !== "MemberExpression" ||
    checkedMember.computed ||
    checkedMember.property?.type !== "Identifier" ||
    checkedMember.property.name !== "checked" ||
    indexed?.type !== "MemberExpression" ||
    !indexed.computed ||
    !identifierNamed(indexed.object, alias) ||
    !Number.isInteger(indexed.property?.value) ||
    indexed.property.value < 0 ||
    typeof assignment.right?.value !== "boolean"
  ) {
    return undefined;
  }
  return {
    optionIndex: indexed.property.value,
    checked: assignment.right.value
  };
}

function resolveHelperAgainstForm(helper, triggerFieldId, form) {
  const matches = (form?.fields || []).filter((field) => {
    if (field?.type !== "detailTable") return false;
    const ids = new Set((field.columns || []).map((column) => column.id));
    return ids.has(triggerFieldId) && ids.has(helper.targetFieldId);
  });
  if (matches.length !== 1) return undefined;
  const table = matches[0];
  const trigger = table.columns.find((column) => column.id === triggerFieldId);
  const target = table.columns.find((column) => column.id === helper.targetFieldId);
  if (
    trigger?.type !== "radio" ||
    trigger.componentId !== "xform-radio" ||
    target?.type !== "radio" ||
    target.componentId !== "xform-radio"
  ) {
    return undefined;
  }
  const triggerValues = new Set((trigger.props?.options || []).map((option) =>
    String(option.value)
  ));
  const options = target.props?.options || [];
  const cases = [];
  for (const entry of helper.cases) {
    if (!triggerValues.has(entry.sourceValue)) return undefined;
    if (entry.kind === "clear") {
      cases.push({ sourceValue: entry.sourceValue, targetValue: "" });
      continue;
    }
    const targetValue = options[entry.optionIndex]?.value;
    if (typeof targetValue !== "string") return undefined;
    cases.push({
      sourceValue: entry.sourceValue,
      targetValue,
      optionIndex: entry.optionIndex
    });
  }
  return {
    tableId: table.id,
    targetFieldId: target.id,
    cases
  };
}

function renderOnChange(model) {
  const lines = [
    "function onChange(value, rowNum, parentRowNum) {",
    "  var selectedValue = Array.isArray(value) ? value[0] : value",
    "  selectedValue = selectedValue == null ? \"\" : String(selectedValue)"
  ];
  model.cases.forEach((entry, index) => {
    lines.push(
      `  ${index === 0 ? "if" : "else if"} (selectedValue === ${JSON.stringify(entry.sourceValue)}) {`,
      `    MKXFORM.updateControl(${JSON.stringify(`\${table:${model.tableId}}.${model.targetFieldId}`)}, rowNum, ${JSON.stringify(entry.targetValue)})`,
      "  }"
    );
  });
  lines.push("}");
  return lines.join("\n");
}

function zeroIndexedIdentifier(expression, name) {
  return expression?.type === "MemberExpression" &&
    expression.computed &&
    identifierNamed(expression.object, name) &&
    expression.property?.value === 0;
}

function identifierNamed(expression, name) {
  return expression?.type === "Identifier" && expression.name === name;
}

function literalString(expression) {
  return typeof expression?.value === "string" ? expression.value : undefined;
}
