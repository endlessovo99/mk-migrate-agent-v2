import { buildJavaScriptBindingModel } from "./javascript-binding-provenance.js";

export function buildConditionOperandResolver(source, options = {}) {
  const text = String(source || "");
  const bindings = buildJavaScriptBindingModel(text, options);

  function resolveTrace(expression, context = {}, seen = new Set()) {
    const beforeIndex = Number.isInteger(context.beforeIndex) ? context.beforeIndex : text.length;
    const value = stripOuterParentheses(String(expression || "").trim());
    if (!value) return undefined;
    if (!bindings.ok) return undefined;

    const mkValue = value.match(/^MKXFORM\.getValue\(\s*(["'`])([^"'`]+)\1\s*\)$/);
    if (
      mkValue &&
      bindings.isUnshadowedGlobal("MKXFORM", beforeIndex) &&
      staticCapturedLiteral(mkValue[1], mkValue[2])
    ) {
      return { origin: `field:${mkValue[2]}`, transforms: [] };
    }
    const legacyValue = value.match(/^GetXFormField(?:Value)?ById\(\s*(["'`])([^"'`]+)\1\s*\)(?:\s*\[\s*0\s*\])?(?:\s*\.\s*value)?$/);
    const legacyGetter = value.match(/^(GetXFormField(?:Value)?ById)\s*\(/)?.[1];
    if (
      legacyValue &&
      bindings.isUnshadowedGlobal(legacyGetter, beforeIndex) &&
      staticCapturedLiteral(legacyValue[1], legacyValue[2])
    ) {
      return { origin: `field:${legacyValue[2]}`, transforms: [] };
    }
    const legacyJqueryValue = value.match(/^\$\(\s*(["'`])([\s\S]*)\1\s*\)\s*\.\s*val\(\s*\)$/);
    if (
      legacyJqueryValue &&
      bindings.isUnshadowedGlobal("$", beforeIndex) &&
      staticCapturedLiteral(legacyJqueryValue[1], legacyJqueryValue[2])
    ) {
      const selector = legacyJqueryValue[2].match(
        /^\s*\[\s*name\s*=\s*(?:["'])?extendDataFormInfo\.value\(\s*([A-Za-z0-9_.-]+)\s*\)(?:["'])?\s*\]\s*(?::checked)?\s*$/
      );
      if (selector) return { origin: `field:${selector[1]}`, transforms: [] };
    }

    const stringWrapper = value.match(/^String\(\s*([\s\S]+)\s*\)$/);
    if (stringWrapper && bindings.isUnshadowedGlobal("String", beforeIndex)) {
      return appendTransform(resolveTrace(stringWrapper[1], context, seen), "string");
    }
    const defaulted = value.match(/^([A-Za-z_$][\w$]*)\s*\|\|\s*(["'`])\2$/);
    if (defaulted) return appendTransform(resolveTrace(defaulted[1], context, seen), "default-empty");
    const normalizedArray = value.match(
      /^Array\.isArray\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\?\s*\1\s*\[\s*0\s*\]\s*:\s*\1$/
    );
    if (normalizedArray && bindings.isUnshadowedGlobal("Array", beforeIndex)) {
      return appendTransform(resolveTrace(normalizedArray[1], context, seen), "array-first");
    }
    const firstItem = value.match(/^([A-Za-z_$][\w$]*)\s*\[\s*0\s*\]$/);
    if (firstItem) return appendTransform(resolveTrace(firstItem[1], context, seen), "index-first");
    const normalizedNullable = value.match(
      /^([A-Za-z_$][\w$]*)\s*==\s*null\s*\?\s*(["'`])\2\s*:\s*String\(\s*\1\s*\)$/
    );
    if (normalizedNullable && bindings.isUnshadowedGlobal("String", beforeIndex)) {
      return appendTransform(
        appendTransform(resolveTrace(normalizedNullable[1], context, seen), "nullish-empty"),
        "string"
      );
    }

    if (!/^[A-Za-z_$][\w$]*$/.test(value)) return undefined;
    const useScope = bindings.scopeAt(beforeIndex);
    const binding = bindings.bindingAtUse(value, beforeIndex);
    if (!binding || binding.ambiguous || seen.has(binding.id)) return undefined;
    if (binding === bindings.eventBinding) {
      return bindings.stableEventUse(binding, useScope, beforeIndex)
        ? { origin: "event:value", transforms: [] }
        : undefined;
    }

    const declaration = bindings.stableInitializer(value, { beforeIndex });
    if (!declaration || declaration.binding !== binding) return undefined;
    const nextSeen = new Set(seen);
    nextSeen.add(binding.id);
    return resolveTrace(
      declaration.expression,
      { beforeIndex: declaration.expressionIndex },
      nextSeen
    );
  }

  function resolveOperand(expression, context = {}) {
    return resolveTrace(expression, context)?.origin;
  }
  resolveOperand.trace = (expression, context = {}) => resolveTrace(expression, context);
  resolveOperand.stableInitializer = (name, context = {}) => (
    bindings.ok ? bindings.stableInitializer(name, context) : undefined
  );
  resolveOperand.isUnshadowedGlobal = (name, beforeIndex) => (
    bindings.ok && bindings.isUnshadowedGlobal(name, beforeIndex)
  );
  resolveOperand.entrypoint = bindings.ok ? bindings.entrypoint : undefined;
  return resolveOperand;
}

export function parseProvenanceCondition(expression, resolveOperand, context = {}) {
  const text = stripOuterParentheses(String(expression || "").trim());
  if (!text || /^(?:true|false)$/.test(text)) return undefined;

  const negated = text.match(/^!\s*([\s\S]+)$/);
  const negatedTrace = negated ? operandTrace(resolveOperand, negated[1], context) : undefined;
  if (negatedTrace?.origin) {
    return {
      kind: "truthy",
      value: "falsy",
      operand: negatedTrace.origin,
      transforms: negatedTrace.transforms,
      predicate: "logical-not"
    };
  }

  const directTrace = operandTrace(resolveOperand, text, context);
  if (directTrace?.origin) {
    return {
      kind: "truthy",
      value: "truthy",
      operand: directTrace.origin,
      transforms: directTrace.transforms,
      predicate: "boolean-coercion"
    };
  }

  const regexTest = text.match(/^\/\[([^\]]+)\]\/[gimsuy]*\.test\(\s*([\s\S]+)\s*\)$/);
  const regexTrace = regexTest ? operandTrace(resolveOperand, regexTest[2], context) : undefined;
  if (regexTrace?.origin && /^[A-Za-z0-9]+$/.test(regexTest[1])) {
    return {
      kind: "regex-set",
      values: [...new Set([...regexTest[1]])],
      operand: regexTrace.origin,
      transforms: regexTrace.transforms,
      predicate: "regex-char-set",
      pattern: `[${regexTest[1]}]`
    };
  }

  const indexOf = text.match(/^([\s\S]+?)\.\s*indexOf\s*\(\s*(["'`])([^"'`]+)\2\s*\)\s*(?:>=\s*0|>\s*-1|!==?\s*-1)$/);
  const indexOfTrace = indexOf ? operandTrace(resolveOperand, indexOf[1], context) : undefined;
  if (indexOfTrace?.origin && staticCapturedLiteral(indexOf[2], indexOf[3])) {
    return {
      kind: "contains",
      value: indexOf[3],
      operand: indexOfTrace.origin,
      transforms: indexOfTrace.transforms,
      predicate: "indexOf"
    };
  }

  const includes = text.match(/^([\s\S]+?)\.\s*includes\s*\(\s*(["'`])([^"'`]+)\2\s*\)$/);
  const includesTrace = includes ? operandTrace(resolveOperand, includes[1], context) : undefined;
  if (includesTrace?.origin && staticCapturedLiteral(includes[2], includes[3])) {
    return {
      kind: "contains",
      value: includes[3],
      operand: includesTrace.origin,
      transforms: includesTrace.transforms,
      predicate: "includes"
    };
  }

  const equality = text.match(/^([\s\S]+?)\s*(={2,3})\s*(["'`])([^"'`]+)\3$/);
  const equalityTrace = equality ? operandTrace(resolveOperand, equality[1], context) : undefined;
  if (equalityTrace?.origin && staticCapturedLiteral(equality[3], equality[4])) {
    return {
      kind: "eq",
      value: equality[4],
      operand: equalityTrace.origin,
      transforms: equalityTrace.transforms,
      predicate: equality[2].length === 3 ? "strict-equality" : "loose-equality"
    };
  }

  const reversed = text.match(/^(["'`])([^"'`]+)\1\s*(={2,3})\s*([\s\S]+)$/);
  const reversedTrace = reversed ? operandTrace(resolveOperand, reversed[4], context) : undefined;
  if (reversedTrace?.origin && staticCapturedLiteral(reversed[1], reversed[2])) {
    return {
      kind: "eq",
      value: reversed[2],
      operand: reversedTrace.origin,
      transforms: reversedTrace.transforms,
      predicate: reversed[3].length === 3 ? "strict-equality" : "loose-equality"
    };
  }

  const numericEquality = text.match(/^([\s\S]+?)\s*(={2,3})\s*(-?(?:\d+(?:\.\d*)?|\.\d+))$/);
  const numericTrace = numericEquality
    ? operandTrace(resolveOperand, numericEquality[1], context)
    : undefined;
  if (numericTrace?.origin) {
    return {
      kind: "eq",
      value: numericEquality[3],
      operand: numericTrace.origin,
      transforms: numericTrace.transforms,
      predicate: numericEquality[2].length === 3
        ? "strict-numeric-equality"
        : "loose-numeric-equality"
    };
  }

  const reversedNumeric = text.match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(={2,3})\s*([\s\S]+)$/);
  const reversedNumericTrace = reversedNumeric
    ? operandTrace(resolveOperand, reversedNumeric[3], context)
    : undefined;
  if (reversedNumericTrace?.origin) {
    return {
      kind: "eq",
      value: reversedNumeric[1],
      operand: reversedNumericTrace.origin,
      transforms: reversedNumericTrace.transforms,
      predicate: reversedNumeric[2].length === 3
        ? "strict-numeric-equality"
        : "loose-numeric-equality"
    };
  }
  return undefined;
}

function operandTrace(resolveOperand, expression, context) {
  if (typeof resolveOperand?.trace === "function") {
    return resolveOperand.trace(expression, context);
  }
  const origin = resolveOperand?.(expression, context);
  return origin ? { origin, transforms: [] } : undefined;
}

function appendTransform(trace, transform) {
  return trace
    ? { ...trace, transforms: [...trace.transforms, transform] }
    : undefined;
}

function staticCapturedLiteral(quote, value) {
  return quote !== "`" || !String(value || "").includes("${");
}

function stripOuterParentheses(expression) {
  let text = expression;
  while (text.startsWith("(") && matchingClose(text, 0) === text.length - 1) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function matchingClose(text, openIndex) {
  let depth = 0;
  let quote = "";
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote && text[index - 1] !== "\\") quote = "";
      continue;
    }
    if (["'", "\"", "`"].includes(char)) quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return index;
  }
  return -1;
}
