export function normalizeRuleConditionText(value) {
  const source = String(value || "").trim();
  let quote = "";
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      result += char;
      if (char === quote && source[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      result += char;
      continue;
    }
    if (!/\s/.test(char)) result += char;
  }
  return result;
}
