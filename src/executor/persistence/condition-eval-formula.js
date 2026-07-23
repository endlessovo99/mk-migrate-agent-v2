import { collectConditionTerms } from "./condition-expression.js";

export function conditionAstUsesFieldSum(ast) {
  return collectConditionTerms(ast).some((term) => term?.expressionType === "fieldSumCompare");
}

export function canRenderEvalConditionFormula(ast) {
  return collectConditionTerms(ast).every(isEvalRenderableTerm);
}

export function renderEvalConditionFormula(ast, options = {}) {
  if (!ast || !options.templateId) return undefined;
  if (!canRenderEvalConditionFormula(ast)) return undefined;

  const script = renderEvalAst(ast, options, "script");
  const content = renderEvalAst(ast, options, "content");
  if (!script || !content) return undefined;
  return { script, content };
}

function isEvalRenderableTerm(term) {
  if (!term || typeof term !== "object") return false;
  if (term.expressionType === "fieldSumCompare") {
    return Array.isArray(term.fields) && term.fields.length === 2 && term.symbol;
  }
  if (["contains", "empty", "orgBelong", "orgFdNo"].includes(term.expressionType)) {
    return false;
  }
  return ["==", "!=", ">", ">=", "<", "<="].includes(term.symbol);
}

function renderEvalAst(ast, options, mode) {
  if (ast.type === "term") return renderEvalTerm(ast.term, options, mode);
  const joiner = ast.operator === "||" ? " || " : " && ";
  const parts = [];
  for (const child of ast.children || []) {
    const rendered = renderEvalAst(child, options, mode);
    if (!rendered) return undefined;
    parts.push(child.type === "group" ? `(${rendered})` : rendered);
  }
  return parts.join(joiner);
}

function renderEvalTerm(term, options, mode) {
  if (term.expressionType === "fieldSumCompare") {
    const left = resolveField(term.fields[0], options);
    const right = resolveField(term.fields[1], options);
    if (!left || !right) return undefined;
    return `${fieldRef(left, options, mode)} + ${fieldRef(right, options, mode)} ${term.symbol} ${formatEvalLiteral(term.value)}`;
  }

  const field = resolveField(term.field, options);
  if (!field) return undefined;
  return `${fieldRef(field, options, mode)} ${term.symbol} ${formatEvalLiteral(term.value)}`;
}

function resolveField(fieldId, options) {
  const id = String(fieldId || "").trim();
  if (!id) return undefined;
  if (typeof options.resolveField === "function") {
    const resolved = options.resolveField(id);
    if (!resolved?.id) return undefined;
    return {
      id: String(resolved.id),
      title: String(resolved.title || resolved.id)
    };
  }
  return { id, title: id };
}

function fieldRef(field, options, mode) {
  if (mode === "content") {
    return `$内置表单.${field.title}$`;
  }
  return `\${data.${options.templateId}-${field.id}}`;
}

function formatEvalLiteral(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const text = String(value ?? "");
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return text;
  return JSON.stringify(text);
}
