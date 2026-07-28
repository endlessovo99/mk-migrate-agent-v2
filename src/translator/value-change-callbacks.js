import { parse } from "acorn";
import { inlineOnChangeSourceActionKey } from "./source-action-key.js";
import { provenPlatformValueChangeCallStarts } from "./sysform-form-rules.js";

export function parseJavascriptProgram(text) {
  try {
    return parse(String(text || ""), {
      ecmaVersion: "latest",
      sourceType: "script"
    });
  } catch {
    return undefined;
  }
}

export function valueChangeCallbacks(source = {}, program) {
  const text = String(source.javascript || "");
  const ast = program || parseJavascriptProgram(text);
  if (!ast) return [];
  const sourceRef = source.sourceRef || source.id;
  const provenStarts = provenPlatformValueChangeCallStarts(text);
  const bindings = [];

  for (const statement of ast.body) {
    const call = directIdentifierCall(statement);
    if (
      call?.callee?.name !== "AttachXFormValueChangeEventById" ||
      !provenStarts.has(call.start) ||
      call.arguments?.length !== 2
    ) {
      continue;
    }
    const controlId = literalString(call.arguments[0]);
    const callback = call.arguments[1];
    if (
      !controlId ||
      !["FunctionExpression", "ArrowFunctionExpression"].includes(callback?.type) ||
      callback.body?.type !== "BlockStatement" ||
      callback.params?.[0]?.type !== "Identifier" ||
      (callback.params?.[1] !== undefined &&
        callback.params[1]?.type !== "Identifier")
    ) {
      continue;
    }
    bindings.push({
      start: call.start,
      end: call.end,
      sourceActionKey: inlineOnChangeSourceActionKey(sourceRef, call.start),
      controlId,
      valueParam: callback.params[0].name,
      domParam: callback.params[1]?.name,
      statements: callback.body.body
        .filter((candidate) => candidate.type !== "EmptyStatement")
        .map((candidate) => ({
          node: candidate,
          start: candidate.start,
          end: candidate.end,
          code: text.slice(candidate.start, candidate.end)
        }))
    });
  }
  return bindings;
}

export function directValueChangeCallbackCallRange(
  source = {},
  bindingStart,
  functionName
) {
  const binding = valueChangeCallbacks(source)
    .find((candidate) => candidate.start === bindingStart);
  return binding?.statements.find((statement) =>
    directIdentifierCall(statement.node)?.callee?.name === functionName
  );
}

export function composeValueChangeCallbackCandidates(
  source = {},
  primaryCandidates = [],
  effectCandidates = []
) {
  if (!effectCandidates.length) return primaryCandidates;
  const primary = [...primaryCandidates];
  const additions = [...effectCandidates];
  const keys = new Set(effectCandidates.map((candidate) =>
    candidate.sourceActionKey
  ));

  for (const sourceActionKey of keys) {
    const effects = effectCandidates.filter((candidate) =>
      candidate.sourceActionKey === sourceActionKey
    );
    const callback = effects[0]?.semanticHints?.sourceCallback;
    if (!Array.isArray(callback?.statements)) continue;

    const related = [...primary, ...effects].filter((candidate) =>
      candidate.sourceActionKey === sourceActionKey
    );
    const covered = related.flatMap((candidate) =>
      candidate.semanticHints?.coveredCallbackStatementRanges || []
    );
    const uncovered = callback.statements.filter((statement) =>
      !covered.some((range) =>
        range.start <= statement.start && range.end >= statement.end
      )
    );
    const fallbackIndexes = primary
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) =>
        candidate.sourceActionKey === sourceActionKey &&
        candidate.translationStatus === undefined &&
        candidate.function === undefined &&
        candidate.functionMappings === undefined
      )
      .map(({ index }) => index);

    for (const index of fallbackIndexes.reverse()) primary.splice(index, 1);
    if (!uncovered.length) continue;

    const effect = effects[0];
    const evidence = uncovered.map((statement) => statement.code.trim()).join("\n");
    additions.push({
      id: `${source.id || "script"}.onChange.${callback.start}.callback-residual`,
      index: callback.start,
      effectIndex: uncovered[0].start,
      sourceActionKey,
      event: "onChange",
      scope: "control",
      controlId: effect.controlId,
      tableId: effect.tableId,
      javascript: evidence,
      translationStatus: "needs_review",
      coverage: {
        status: "uncovered",
        nativeRules: [],
        residuals: [{
          code: "script.residual.untranslated_callback_statement",
          type: "untranslatedCallbackStatement",
          message: "A source onChange callback statement is not covered by a deterministic translation.",
          target: effect.controlId,
          trigger: "onChange",
          evidence
        }]
      },
      source,
      sourceRefs: effect.sourceRefs
    });
  }

  return [...primary, ...additions];
}

export function directIdentifierCall(statement) {
  const expression = statement?.type === "ExpressionStatement"
    ? statement.expression
    : statement;
  return expression?.type === "CallExpression" &&
    expression.callee?.type === "Identifier"
    ? expression
    : undefined;
}

function literalString(expression) {
  return typeof expression?.value === "string" ? expression.value : undefined;
}
