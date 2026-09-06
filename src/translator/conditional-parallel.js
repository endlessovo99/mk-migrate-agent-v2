export function conditionalParallelSplitIds(sourceNodes, sourceNodeAttributes, normalizeParallelMode) {
  return new Set((sourceNodes || [])
    .filter((node) => {
      const attrs = sourceNodeAttributes(node);
      return String(node.sourceType || "").toLowerCase().includes("split") &&
        normalizeParallelMode(attrs.splitType) === "condition";
    })
    .map((node) => node.id));
}

export function isSupportedConditionalParallelCondition(value, knownFieldIds = []) {
  const known = new Set([...knownFieldIds].map(String));
  const parts = splitTopLevelOr(stripFullyWrappingParentheses(String(value || "").trim()));
  if (!parts.length) return false;
  return parts.every((part) => {
    const text = stripFullyWrappingParentheses(part.trim());
    const method = text.match(/^\$([^$]+)\$\s*\.\s*equals\s*\(\s*(["'])([^"']*)\2\s*\)$/i);
    const comparison = text.match(/^\$([^$]+)\$\s*={2,3}\s*(?:(["'])([^"']*)\2|(-?\d+(?:\.\d+)?))$/);
    const contains = text.match(
      /^\$(?:字符串|列表)\.包含\$\(\s*\$([^$]+)\$(?:\s*\.\s*getFdName\s*\(\s*\))?\s*,\s*(["'])([^"']*)\2\s*\)$/
    );
    const fieldId = method?.[1] || comparison?.[1] || contains?.[1];
    return Boolean(fieldId && known.has(fieldId));
  });
}

export function normalizeConditionalParallelMultiSelectCondition(value, fieldSpecs = new Map()) {
  const parts = splitTopLevelOr(stripFullyWrappingParentheses(String(value || "").trim()));
  if (!parts.length) return undefined;
  const normalized = [];
  for (const part of parts) {
    const text = stripFullyWrappingParentheses(part.trim());
    const match = text.match(
      /^\$([^$]+)\$\s*\.\s*contains\s*\(\s*(["'])([^"']*)\2\s*\)$/i
    );
    if (!match) return undefined;
    const fieldId = match[1].trim();
    const value = match[3];
    const spec = fieldSpecs instanceof Map ? fieldSpecs.get(fieldId) : undefined;
    if (
      !isMembershipFieldType(spec?.type) ||
      !(spec.optionValues instanceof Set) ||
      !spec.optionValues.has(value)
    ) return undefined;
    normalized.push(`$列表.包含$($${fieldId}$, ${JSON.stringify(value)})`);
  }
  return normalized.join(" || ");
}

function isMembershipFieldType(type) {
  return type === "multiSelect" || type === "checkbox";
}

function splitTopLevelOr(value) {
  const parts = [];
  let quote = "";
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (depth === 0 && value.startsWith("||", index)) {
      parts.push(value.slice(start, index));
      start = index + 2;
      index += 1;
    }
  }
  parts.push(value.slice(start));
  return depth === 0 && !quote && parts.every((part) => part.trim()) ? parts : [];
}

function stripFullyWrappingParentheses(value) {
  let text = String(value || "").trim();
  while (text.startsWith("(") && matchingOuterCloseIndex(text) === text.length - 1) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function matchingOuterCloseIndex(value) {
  let quote = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return -1;
    }
  }
  return -1;
}
