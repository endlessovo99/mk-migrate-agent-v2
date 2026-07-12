export const CREATOR_DEPT_NAME_CONTEXT_FIELD = "context.creatorDept.fdName";

export function translateLegacyConditionContextReferences(value, knownFieldIds = []) {
  const source = String(value || "");
  const known = new Set([...knownFieldIds].map((fieldId) => String(fieldId).toLowerCase()));
  let output = "";
  let quote = "";

  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (quote) {
      output += char;
      if (char === "\\" && index + 1 < source.length) {
        output += source[index + 1];
        index += 2;
        continue;
      }
      if (char === quote) quote = "";
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      index += 1;
      continue;
    }

    const reference = source.slice(index).match(/^\$(fdDepartment|部门)\$/i);
    if (!reference || known.has(reference[1].toLowerCase())) {
      output += char;
      index += 1;
      continue;
    }

    const suffix = source.slice(index + reference[0].length).match(
      /^\s*\.\s*getFdName\s*\(\s*\)/i
    );
    output += `$${CREATOR_DEPT_NAME_CONTEXT_FIELD}$`;
    index += reference[0].length + (suffix?.[0].length || 0);
  }
  return output;
}

export function conditionContextSemantic(fieldId) {
  if (String(fieldId || "").trim() !== CREATOR_DEPT_NAME_CONTEXT_FIELD) return undefined;
  return { source: "creatorDept", property: "fdName" };
}
