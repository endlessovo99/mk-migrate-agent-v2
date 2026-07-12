export function createConditionExpressionParser(options) {
  const parseTerm = options?.parseTerm;
  const negateTerm = options?.negateTerm;
  if (typeof parseTerm !== "function" || typeof negateTerm !== "function") {
    throw new TypeError("condition expression parser requires parseTerm and negateTerm");
  }

  function parse(condition) {
    const text = stripEnclosingParentheses(String(condition || "").trim());
    if (!text) return undefined;

    const negatedGroup = parseNegatedGroup(text, parse, parseTerm, negateTerm);
    if (negatedGroup) return negatedGroup;

    const orParts = splitLogicalExpression(text, "||");
    if (orParts.length > 1) {
      const children = orParts.map(parse);
      if (children.every(Boolean)) return { type: "group", children, operator: "||", groupType: "OR" };
      return undefined;
    }

    const andParts = splitLogicalExpression(text, "&&");
    if (andParts.length > 1) {
      const children = andParts.map(parse);
      if (children.every(Boolean)) return { type: "group", children, operator: "&&", groupType: "AND" };
      return undefined;
    }

    const term = parseTerm(text);
    return term ? { type: "term", term } : undefined;
  }

  return parse;
}

export function collectConditionTerms(ast) {
  if (ast.type === "term") return [ast.term];
  return ast.children.flatMap(collectConditionTerms);
}

function parseNegatedGroup(text, parse, parseTerm, negateTerm) {
  if (!text.startsWith("!")) return undefined;
  const rest = text.slice(1).trim();
  if (isFullyWrappedInParentheses(rest)) {
    const parsed = parse(rest);
    return parsed ? negateConditionAst(parsed, negateTerm) : undefined;
  }
  const simple = parseTerm(rest);
  return simple ? { type: "term", term: negateTerm(simple) } : undefined;
}

function negateConditionAst(ast, negateTerm) {
  if (ast.type === "term") {
    return { type: "term", term: negateTerm(ast.term) };
  }
  const operator = ast.operator === "&&" ? "||" : "&&";
  return {
    type: "group",
    children: ast.children.map((child) => negateConditionAst(child, negateTerm)),
    operator,
    groupType: operator === "&&" ? "AND" : "OR"
  };
}

function stripEnclosingParentheses(text) {
  let result = text;
  while (isFullyWrappedInParentheses(result)) {
    result = result.slice(1, -1).trim();
  }
  return result;
}

function isFullyWrappedInParentheses(text) {
  if (!text.startsWith("(") || !text.endsWith(")")) return false;
  let quote = "";
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const previous = text[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && index < text.length - 1) return false;
  }
  return depth === 0;
}

function splitLogicalExpression(text, operator) {
  const parts = [];
  let quote = "";
  let depth = 0;
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const previous = text[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && text.startsWith(operator, index)) {
      parts.push(text.slice(start, index).trim());
      index += operator.length - 1;
      start = index + 1;
    }
  }

  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}
