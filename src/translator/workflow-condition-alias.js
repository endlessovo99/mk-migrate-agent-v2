/**
 * Recover stale legacy workflow field ids from the paired display condition.
 * EKP keeps both a machine condition and a display condition on each line. A
 * form field may be recreated under a new id while the workflow line retains
 * the old id, but its display token still carries the authoritative title.
 * Resolve only when that title identifies exactly one current form field.
 */
export function recoverWorkflowConditionFieldAliases(
  sourceCondition,
  displayCondition,
  knownFieldIds = [],
  titlesById = new Map()
) {
  const source = String(sourceCondition || "");
  const display = String(displayCondition || "");
  const known = new Set(
    [...knownFieldIds].map((fieldId) => normalizeKey(fieldId))
  );
  const sourceTokens = conditionTokens(source);
  const displayTokens = conditionTokens(display);
  if (!sourceTokens.length || sourceTokens.length !== displayTokens.length) {
    return source;
  }

  const idsByTitle = new Map();
  for (const [fieldId, title] of titlesById instanceof Map ? titlesById : []) {
    const normalizedTitle = normalizeKey(title);
    if (!known.has(normalizeKey(fieldId)) || !normalizedTitle) continue;
    if (!idsByTitle.has(normalizedTitle)) idsByTitle.set(normalizedTitle, []);
    idsByTitle.get(normalizedTitle).push(String(fieldId));
  }

  const replacements = new Map();
  sourceTokens.forEach((token, index) => {
    if (known.has(normalizeKey(token.value)) || token.value.includes(".")) return;
    const candidates = idsByTitle.get(normalizeKey(displayTokens[index].value)) || [];
    if (candidates.length === 1) replacements.set(token.start, candidates[0]);
  });
  if (!replacements.size) return source;

  let output = "";
  let cursor = 0;
  for (const token of sourceTokens) {
    output += source.slice(cursor, token.start);
    output += `$${replacements.get(token.start) || token.value}$`;
    cursor = token.end;
  }
  return output + source.slice(cursor);
}

function conditionTokens(value) {
  return [...String(value || "").matchAll(/\$([^$]+)\$/g)].map((match) => ({
    value: String(match[1] || "").trim(),
    start: match.index,
    end: match.index + match[0].length
  }));
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}
